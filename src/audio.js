'use strict';

/**
 * audio.js — Resumen en audio con índice hablado y capítulos (MP3 + M4A).
 *
 * Contenido: alertas del día + noticias Alto y Medio, agrupadas por temática
 * (una sección por temática, en el orden en que aparecen en el índice; dentro de
 * cada una, Alto antes que Medio). El audio parte con un saludo y un ÍNDICE
 * HABLADO que dice en qué minuto empieza cada sección, y lleva CAPÍTULOS
 * (metadatos) en ambos formatos.
 *
 * Motores de voz:
 *   - Piper (local, sin cuotas; voz es_MX-claude-high) por defecto, si está instalado.
 *   - Gemini TTS (Interactions API) como respaldo, con las reglas de cuota del plan
 *     gratuito (3 solicitudes por minuto y 10 por día por modelo).
 * AUDIO_ENGINE=auto|piper|gemini elige el motor (auto = Piper si está disponible).
 *
 * El texto se normaliza para lectura (cifras, US$, %, fechas en palabras) con
 * speech-text.js. El audio NUNCA bloquea el envío del correo: ante cualquier error
 * generateAudio devuelve { ok: false, reason } y el correo sale con el motivo.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');
const { log } = require('./utils');
const { isUnavailable, discoverModel, recordChange } = require('./models');
const { normalizeForSpeech } = require('./speech-text');

const TTS_ENDPOINT   = 'https://generativelanguage.googleapis.com/v1beta/interactions';
// Modelos vigentes según la documentación de Gemini (consultada el 22-10-2026).
// Primero el Lite (más barato y rápido); si falla, el Flash.
const TTS_MODELS     = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts']; // lista preferida
const VOICE          = process.env.TTS_VOICE || 'Kore';
const STYLE          = 'lectura de noticiero en español, tono sobrio y claro, ritmo moderado';
const SAMPLE_RATE    = 24000;          // PCM 16 bits, mono (formato documentado de salida)
// El plan gratuito de Gemini TTS permite 3 solicitudes por minuto (error HTTP 429 del
// 23-10-2026). Por eso las noticias se AGRUPAN en pocos fragmentos grandes y las
// solicitudes se espacian según AUDIO_RPM. Con 45.000 caracteres son ~9 solicitudes.
const MAX_CHUNK_CHARS = parseInt(process.env.AUDIO_CHUNK_CHARS, 10) || 5000;
const AUDIO_RPM      = parseFloat(process.env.AUDIO_RPM) || 3;
const MIN_INTERVAL_MS = Math.ceil(60000 / AUDIO_RPM) + 1000;   // 3 RPM → una solicitud cada 21 s
const CONCURRENCY    = 2;               // el espaciado manda; 2 permite solapar generaciones largas
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const CHARS_PER_SECOND = 15;            // supuesto de ritmo de lectura (900 por minuto), solo para alertas
const BUDGET_MS      = parseInt(process.env.AUDIO_BUDGET_MS, 10) || 12 * 60 * 1000; // al plazo se abortan también las llamadas en curso
const MP3_BITRATE    = '40k';          // voz mono: 18 MB por hora
const MP3_FALLBACK_BITRATE = '32k';    // re-codificación si el MP3 excede el tope
// Gmail limita el mensaje CODIFICADO a 25 MB y base64 infla 4/3: 25 × 3/4 = 18,75 MB.
// Tope del MP3 con margen: 18 MB (18.000.000 bytes).
const MAX_MP3_BYTES  = parseInt(process.env.AUDIO_MAX_MP3_BYTES, 10) || 18 * 1000 * 1000;
const PAUSE_SECONDS  = 1.2;            // silencio entre secciones (y tras el índice)
const M4A_BITRATE    = '48k';          // AAC mono para voz: ~21,6 MB por hora
const ENGINE         = (process.env.AUDIO_ENGINE || 'auto').toLowerCase();
const PIPER_PYTHON   = process.env.PIPER_PYTHON || 'python3';
const PIPER_VOICE    = process.env.PIPER_VOICE || path.join(__dirname, '..', 'voz', 'es_MX-claude-high.onnx');
const PIPER_TIMEOUT_MS = 8 * 60 * 1000; // por sección
const PIPER_CONCURRENCY = Math.max(1, Math.min(2, os.cpus().length));

// ─── Construcción del guion ────────────────────────────────────────────────

const clean = (s) => s
  .replace(/\*\*/g, '')
  .replace(/[*#]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Extrae del informe las alertas y las noticias Alto y Medio del CUERPO.
 * @param {string} text - Informe completo generado por Gemini
 * @returns {{alerts: string[], items: {n:string, level:string, title:string, body:string}[]}}
 */
function parseReport(text) {
  const t = text.replace(/\r/g, '');
  const upper = t.toUpperCase();
  const iBody = upper.search(/^[*\s#]*CUERPO[*\s]*$/m);
  const iAlerts = upper.search(/^[*\s#]*ALERTAS DEL D[IÍ]A[*\s]*$/m);
  const body   = iBody >= 0 ? t.slice(iBody, iAlerts > iBody ? iAlerts : undefined) : '';
  const alertsBlock = iAlerts >= 0 ? t.slice(iAlerts) : '';

  const items = [];
  const chunks = body.split(/\n(?=[\s*]*\d+[\.\)]\s)/);
  for (const chunk of chunks) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const head = clean(lines[0]);
    const m = head.match(/^(\d+)[\.\)]\s+(.*?)\s*(?:—|–|-)\s*Semáforo:\s*(Alto|Medio|Bajo)/i);
    if (!m) continue;
    const bodyLines = lines.slice(1).filter((l) => !/^\(?Fuente:/i.test(clean(l)));
    items.push({ n: m[1], level: m[3][0].toUpperCase() + m[3].slice(1).toLowerCase(), title: m[2], body: clean(bodyLines.join(' ')) });
  }

  const alerts = alertsBlock.split('\n').slice(1)
    .map((l) => clean(l))
    .filter((l) => /^\d+[\.\)]\s/.test(l))
    .map((l) => l.replace(/^\d+[\.\)]\s*/, ''));

  return { alerts, items };
}

/**
 * Mapa número de noticia → temática, leído del ÍNDICE ("N. Título — Temática — Semáforo: X").
 * Si una línea no trae temática, se usa el último subtítulo de sección visto ("Política").
 * @returns {{theme: Map<string,string>, order: string[]}}
 */
function themeMap(text) {
  const t = text.replace(/\r/g, '');
  const iBody = t.toUpperCase().search(/^[*\s#]*CUERPO[*\s]*$/m);
  const idx = iBody > 0 ? t.slice(0, iBody) : '';
  const theme = new Map();
  const order = [];
  let header = null;
  for (const raw of idx.split('\n')) {
    const line = clean(raw);
    if (!line) continue;
    const m = line.match(/^(\d+)[\.\)]\s+(.*)$/);
    if (!m) {
      if (!/^(ÍNDICE|INDICE|INFORME|FECHA)/i.test(line) && line.length < 40 && !/[.:]$/.test(line)) header = line;
      continue;
    }
    const segs = m[2].split(/\s+[—–-]\s+/);
    let th = null;
    const iSem = segs.findIndex((x) => /^Semáforo:/i.test(x));
    if (iSem >= 2) th = segs[iSem - 1];
    th = (th || header || 'Otras noticias').trim();
    theme.set(m[1], th);
    if (!order.includes(th)) order.push(th);
  }
  return { theme, order };
}

/**
 * Secciones para el audio: "Alertas del día" + una por temática con sus noticias
 * Alto y Medio (Alto primero). Textos ya normalizados para voz.
 * @returns {{saludo: string, secciones: {titulo: string, texto: string}[], counts: object}}
 */
function buildSections(text, dateLabel) {
  const { alerts, items } = parseReport(text);
  const { theme, order } = themeMap(text);
  const keep = items.filter((i) => i.level === 'Alto' || i.level === 'Medio');
  const counts = {
    alerts: alerts.length,
    alto: keep.filter((i) => i.level === 'Alto').length,
    medio: keep.filter((i) => i.level === 'Medio').length,
  };
  const secciones = [];
  if (alerts.length) {
    secciones.push({
      titulo: 'Alertas del día',
      texto: ['Alertas del día.', ...alerts.map((a, k) => `Alerta ${k + 1}. ${a}`)].join('\n\n'),
    });
  }
  const themes = [...order];
  for (const i of keep) { const th = theme.get(i.n) || 'Otras noticias'; if (!themes.includes(th)) themes.push(th); }
  for (const th of themes) {
    const news = keep.filter((i) => (theme.get(i.n) || 'Otras noticias') === th)
      .sort((x, y) => (x.level === y.level ? +x.n - +y.n : (x.level === 'Alto' ? -1 : 1)));
    if (!news.length) continue;
    const titulo = th.replace(/\s*&\s*/g, ' y ');
    secciones.push({
      titulo,
      texto: [`${titulo}.`, ...news.map((i) => `Noticia ${i.n}. ${i.title}. ${i.body}`)].join('\n\n'),
    });
  }
  const saludo = `Resumen de noticias del ${dateLabel}. Incluye ${counts.alerts} alertas del día, `
    + `${counts.alto} noticias de prioridad alta y ${counts.medio} de prioridad media, en ${secciones.length} secciones.`;
  return {
    saludo: normalizeForSpeech(saludo),
    secciones: secciones.map((x) => ({ titulo: x.titulo, texto: normalizeForSpeech(x.texto) })),
    counts,
  };
}

/** Divide un texto largo en piezas de hasta `max` caracteres, por párrafos y oraciones. */
function splitText(text, max = MAX_CHUNK_CHARS) {
  const pieces = [];
  for (const para of text.split(/\n{2,}/)) {
    if (para.length <= max) { pieces.push(para); continue; }
    let cur = '';
    for (const sent of para.split(/(?<=[\.\!\?])\s+/)) {
      if (cur && (cur.length + 1 + sent.length) > max) { pieces.push(cur); cur = sent; }
      else cur = cur ? `${cur} ${sent}` : sent;
    }
    if (cur) pieces.push(cur);
  }
  const out = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && (cur.length + 2 + p.length) > max) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

/** "minuto 3 con 20" / "segundo 45" (luego se normaliza a palabras). */
function marcaHablada(seg) {
  const total = Math.round(seg);
  const m = Math.floor(total / 60), s2 = total % 60;
  return m ? `minuto ${m} con ${s2}` : `segundo ${s2}`;
}

/** "m:ss" para mostrar en el correo. */
function mmss(seg) {
  const total = Math.round(seg);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// ─── Audio ─────────────────────────────────────────────────────────────────

/**
 * Devuelve el PCM crudo: si viene en WAV (RIFF), extrae el bloque "data".
 */
function toPcm(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'data') return buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
      off += 8 + size + (size % 2);
    }
    throw new Error('WAV sin bloque data');
  }
  return buf;
}

/** Reúne recursivamente todos los bloques de audio en base64 de la respuesta, en orden. */
function collectAudio(obj, acc = []) {
  if (!obj || typeof obj !== 'object') return acc;
  if (obj.type === 'audio' && typeof obj.data === 'string') acc.push(obj.data);
  else if (obj.inlineData && typeof obj.inlineData.data === 'string') acc.push(obj.inlineData.data); // forma generateContent
  else for (const v of Object.values(obj)) collectAudio(v, acc);
  return acc;
}

/**
 * Devuelve el ÚLTIMO bloque de audio, como indica la documentación de la Interactions API.
 * Si hay varios, se avisa en el log (podrían ser fragmentos consecutivos).
 */
function findAudioData(obj) {
  const blocks = collectAudio(obj);
  if (blocks.length > 1) log('WARN', `La respuesta de voz trajo ${blocks.length} bloques de audio; se usa el último.`);
  return blocks.length ? blocks[blocks.length - 1] : null;
}

async function ttsOnce(model, text, signal) {
  const res = await fetch(TTS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      model,
      input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: STYLE }] }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: VOICE }] },
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    const err = new Error(`HTTP ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  const data = findAudioData(await res.json());
  if (!data) throw new Error('respuesta sin audio');
  return toPcm(Buffer.from(data, 'base64'));
}

/** Espera interrumpible por el plazo global. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('presupuesto de tiempo agotado'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('presupuesto de tiempo agotado')); }, { once: true });
  });
}

/**
 * Un fragmento con reintentos. El modelo cambia SOLO si no está disponible (isUnavailable);
 * ante 429/503 se reintenta el mismo. Si todos los preferidos quedan descartados, se
 * descubre un reemplazo vía /v1beta/models (una sola vez por corrida, compartido).
 */
/**
 * Espera el próximo turno libre según AUDIO_RPM (compartido entre trabajadores).
 * Garantiza que dos solicitudes nunca empiecen con menos de MIN_INTERVAL_MS de diferencia.
 */
async function waitForSlot(state, signal) {
  const now = Date.now();
  const start = Math.max(now, state.nextSlot);
  state.nextSlot = start + MIN_INTERVAL_MS;
  if (start > now) await sleep(start - now, signal);
}

/** Segundos que la API pide esperar ("Please retry in 4s"), o null. */
function retryAfterSeconds(err) {
  const m = String(err && err.message || '').match(/retry in\s*([\d.]+)\s*s/i);
  return m ? parseFloat(m[1]) : null;
}

async function ttsChunk(text, state, signal) {
  let lastErr;
  for (let idx = 0; idx < state.models.length; idx++) {
    const model = state.models[idx];
    if (state.unavailable.has(model)) continue;
    for (let attempt = 1; attempt <= 6; attempt++) {
      if (signal.aborted) throw new Error('presupuesto de tiempo agotado');
      try {
        await waitForSlot(state, signal);
        const pcm = await ttsOnce(model, text, signal);
        state.usedModels.add(model);
        return pcm;
      } catch (err) {
        if (signal.aborted) throw new Error('presupuesto de tiempo agotado');
        lastErr = err;
        // Cuota DIARIA agotada (plan gratuito: 10 solicitudes por día por modelo, medido el
        // 23-10-2026): no se reintenta hoy con este modelo; se pasa al siguiente, que tiene
        // su propia cuota. Si se agotan todos, el error corta y queda el audio parcial.
        if (err.status === 429 && /per day|daily|RPD/i.test(err.message)) {
          if (!state.unavailable.has(model)) {
            log('WARN', `Cuota diaria de voz agotada en ${model}; se pasa al siguiente modelo.`);
            state.unavailable.add(model);
            state.quotaExhausted.add(model);
          }
          lastErr = new Error(`cuota diaria de voz agotada (${[...state.quotaExhausted].join(', ')}): ${err.message.slice(0, 160)}`);
          break;
        }
        // Límite por minuto: espera lo que pide la API (o un intervalo) y reintenta el mismo modelo.
        if (err.status === 429) {
          const wait = ((retryAfterSeconds(err) || MIN_INTERVAL_MS / 1000) + 1) * 1000;
          log('WARN', `Voz ${model}: límite por minuto, espero ${(wait / 1000).toFixed(0)} s (intento ${attempt}/6).`);
          state.nextSlot = Math.max(state.nextSlot, Date.now() + wait);
          continue;
        }
        if (isUnavailable(err)) {
          log('WARN', `Modelo de voz ${model} no disponible: ${err.message.slice(0, 160)}. Se descarta.`);
          state.unavailable.add(model);
          if (state.models.every((m) => state.unavailable.has(m)) && !state.discovery
              && !state.models.every((m) => state.quotaExhausted.has(m))) {
            state.discovery = discoverModel('tts', [...state.unavailable]).then((alt) => {
              if (alt) { state.models.push(alt); recordChange('voz', alt, TTS_MODELS); }
              return alt;
            });
          }
          if (state.discovery) await state.discovery;
          break; // siguiente modelo de la lista (incluido el descubierto)
        }
        if (attempt < 3) { await sleep(5000 * attempt, signal); continue; } // 503 u otro: espera creciente
        break; // tras 3 errores no transitorios, siguiente modelo
      }
    }
  }
  throw lastErr || new Error('sin modelos de voz disponibles');
}

/**
 * Ruta de ffmpeg: el binario estático que trae la dependencia npm @ffmpeg-installer/ffmpeg
 * (no depende de apt, que el 23-10-2026 se quedó colgado más de 9 minutos en GitHub
 * Actions); si no está, se usa el ffmpeg del sistema.
 */
function ffmpegPath() {
  try { return require('@ffmpeg-installer/ffmpeg').path; } catch (_) { return 'ffmpeg'; }
}

// ─── Motor Piper (local) ────────────────────────────────────────────────────

let piperChecked = null;
/** ¿Piper y la voz están disponibles? (se verifica una vez por corrida) */
function piperAvailable() {
  if (piperChecked !== null) return piperChecked;
  const voiceOk = fs.existsSync(PIPER_VOICE) && fs.existsSync(`${PIPER_VOICE}.json`);
  const r = spawnSync(PIPER_PYTHON, ['-c', 'import piper'], { stdio: 'ignore', timeout: 30000 });
  piperChecked = voiceOk && r.status === 0;
  if (!piperChecked) log('WARN', `Piper no disponible (voz ${voiceOk ? 'ok' : 'no encontrada en ' + PIPER_VOICE}, módulo ${r.status === 0 ? 'ok' : 'no instalado'}).`);
  return piperChecked;
}

function piperSampleRate() {
  try { return JSON.parse(fs.readFileSync(`${PIPER_VOICE}.json`, 'utf-8')).audio.sample_rate || 22050; }
  catch (_) { return 22050; }
}

/** Texto → PCM s16le mono con Piper (--output-raw). */
function piperSynth(text, signal) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PIPER_PYTHON, ['-m', 'piper', '-m', PIPER_VOICE, '--output-raw', '--sentence-silence', '0.35'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; let err = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Piper excedió el tiempo por sección')); }, PIPER_TIMEOUT_MS);
    const onAbort = () => { proc.kill('SIGKILL'); reject(new Error('presupuesto de tiempo agotado')); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const pcm = Buffer.concat(out);
      if (code !== 0 || !pcm.length) return reject(new Error(`Piper terminó con código ${code}: ${err.slice(-200)}`));
      resolve(pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm);
    });
    proc.stdin.end(text, 'utf-8');
  });
}

/** Ejecuta tareas con concurrencia limitada, conservando el orden. */
async function pool(tasks, n) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (next < tasks.length) { const k = next++; results[k] = await tasks[k](); }
  }));
  return results;
}

// ─── Motores: interfaz común ────────────────────────────────────────────────

/**
 * Sintetiza todas las secciones. Devuelve PCM por sección (las que se lograron, en
 * orden y contiguas desde el inicio) y la función para sintetizar el índice.
 */
async function synthPiperAll(secciones, signal) {
  const pcms = await pool(secciones.map((sec) => () => piperSynth(sec.texto, signal)), PIPER_CONCURRENCY);
  return { sampleRate: piperSampleRate(), pcms, failure: null, synthOne: (t) => piperSynth(t, signal), engine: 'Piper (es_MX-claude-high)', maxIndexIters: 5 };
}

async function synthGeminiAll(secciones, signal) {
  const state = { models: [...TTS_MODELS], unavailable: new Set(), quotaExhausted: new Set(), discovery: null, nextSlot: 0, usedModels: new Set() };
  // Piezas de todas las secciones, en orden, con espaciado según la cuota por minuto
  const pieces = [];
  secciones.forEach((sec, si) => splitText(sec.texto).forEach((txt) => pieces.push({ si, txt })));
  const results = new Array(pieces.length);
  let next = 0; let failure = null;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pieces.length) }, async () => {
    while (!failure && next < pieces.length) {
      const k = next++;
      try { results[k] = await ttsChunk(pieces[k].txt, state, signal); }
      catch (err) { failure = failure || err; }
    }
  }));
  // Solo secciones completas y contiguas desde el inicio
  const pcms = [];
  for (let si = 0; si < secciones.length; si++) {
    const own = pieces.map((p, k) => ({ p, k })).filter((x) => x.p.si === si);
    if (!own.every((x) => results[x.k])) break;
    pcms.push(Buffer.concat(own.map((x) => results[x.k])));
  }
  if (state.usedModels.size) log('INFO', `Modelo(s) de voz usados: ${[...state.usedModels].join(', ')}.`);
  return {
    sampleRate: SAMPLE_RATE, pcms, failure: pcms.length < secciones.length ? (failure || new Error('secciones incompletas')) : null,
    synthOne: (t) => ttsChunk(t, state, signal), engine: 'Gemini TTS', maxIndexIters: 2,
  };
}

// ─── Salida: índice hablado, capítulos y codificación ───────────────────────

/** Escapa texto para el formato FFMETADATA1. */
function metaEscape(v) { return String(v).replace(/([=;#\\\n])/g, '\\$1'); }

/** Codifica PCM a MP3 y M4A con capítulos. Devuelve rutas y tamaños. */
function encodeOutputs(pcmPath, sampleRate, metaPath, dir, mp3Bitrate = MP3_BITRATE, m4aBitrate = M4A_BITRATE) {
  const ff = ffmpegPath();
  const input = ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', pcmPath,
    '-i', metaPath, '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1'];
  const mp3 = path.join(dir, 'resumen.mp3');
  const m4a = path.join(dir, 'resumen.m4a');
  execFileSync(ff, [...input, '-c:a', 'libmp3lame', '-b:a', mp3Bitrate, '-id3v2_version', '3', mp3]);
  execFileSync(ff, [...input, '-c:a', 'aac', '-b:a', m4aBitrate, '-movflags', '+faststart', m4a]);
  return { mp3, m4a, mp3Bytes: fs.statSync(mp3).size, m4aBytes: fs.statSync(m4a).size };
}

/**
 * Genera el audio con índice hablado y capítulos. Nunca lanza.
 * @returns {Promise<{ok:boolean, reason?:string, partial?:boolean, coverage?:string, minutes?:number,
 *   files?:{path:string, filename:string, contentType:string, bytes:number}[], chapters?:{titulo:string, inicio:string}[], engine?:string}>}
 */
async function generateAudio(reportText, dateLabel) {
  if (String(process.env.AUDIO_ENABLED || 'true').toLowerCase() === 'false') {
    return { ok: false, reason: 'audio desactivado (AUDIO_ENABLED=false)' };
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUDGET_MS);
  try {
    const { saludo, secciones, counts } = buildSections(reportText, dateLabel);
    const chars = secciones.reduce((a, x) => a + x.texto.length, 0);
    log('INFO', `Audio: ${counts.alerts} alertas, ${counts.alto} Alto, ${counts.medio} Medio; ${secciones.length} secciones, ${chars} caracteres.`);
    if (!secciones.length) return { ok: false, reason: 'no se encontraron alertas ni noticias Alto o Medio en el informe' };

    // 1) Secciones: Piper si está disponible; si falla, Gemini
    let r = null;
    const wantPiper = ENGINE === 'piper' || (ENGINE === 'auto' && piperAvailable());
    if (wantPiper) {
      try { r = await synthPiperAll(secciones, controller.signal); }
      catch (err) {
        if (controller.signal.aborted) throw err;
        log('WARN', `Piper falló (${err.message.slice(0, 160)}); se usa Gemini TTS.`);
      }
    }
    if (!r) r = await synthGeminiAll(secciones, controller.signal);
    if (!r.pcms.length) throw r.failure || new Error('sin audio');
    const incl = secciones.slice(0, r.pcms.length);
    const durs = r.pcms.map((b) => b.length / 2 / r.sampleRate);
    log('INFO', `Motor de voz: ${r.engine}. Secciones: ${incl.map((x, k) => `${x.titulo} ${mmss(durs[k])}`).join(', ')}.`);

    // 2) Índice hablado: los minutos dependen del largo del propio índice → se itera
    let indicePcm = null; let largo = 20; let prevText = null;
    for (let it = 0; it < r.maxIndexIters; it++) {
      const inicios = []; let t = largo + PAUSE_SECONDS;
      for (const d of durs) { inicios.push(t); t += d + PAUSE_SECONDS; }
      const texto = normalizeForSpeech(`${saludo}\n\nÍndice. `
        + incl.map((x, k) => `${x.titulo}, ${marcaHablada(inicios[k])}.`).join(' '));
      if (texto === prevText && indicePcm) break;
      try {
        indicePcm = await r.synthOne(texto);
      } catch (err) {
        if (controller.signal.aborted) throw err;
        // Sin cuota o error en el índice: se conserva el índice anterior si lo hay; si no,
        // el audio sale sin índice hablado (los capítulos se mantienen).
        log('WARN', `Índice hablado no generado (${err.message.slice(0, 120)}); ${indicePcm ? 'se usa la versión anterior' : 'el audio sale sin índice hablado'}.`);
        if (!r.failure && !indicePcm) r.failure = new Error(`índice hablado no generado: ${err.message.slice(0, 120)}`);
        break;
      }
      prevText = texto;
      const nuevo = indicePcm.length / 2 / r.sampleRate;
      if (Math.abs(nuevo - largo) < 0.5) { largo = nuevo; break; }
      largo = nuevo;
    }
    clearTimeout(timer);

    // 3) Concatenar índice + secciones con pausas; capítulos con las duraciones REALES
    const pause = Buffer.alloc(Math.round(r.sampleRate * PAUSE_SECONDS) * 2);
    const parts = indicePcm ? [indicePcm, pause] : [];
    const chapters = indicePcm ? [{ titulo: 'Índice', start: 0 }] : [];
    let pos = indicePcm ? (indicePcm.length + pause.length) / 2 / r.sampleRate : 0;
    incl.forEach((x, k) => { chapters.push({ titulo: x.titulo, start: pos }); parts.push(r.pcms[k], pause); pos += durs[k] + PAUSE_SECONDS; });
    const pcm = Buffer.concat(parts);
    const total = pcm.length / 2 / r.sampleRate;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-'));
    const pcmPath = path.join(dir, 'resumen.pcm');
    fs.writeFileSync(pcmPath, pcm);
    let meta = `;FFMETADATA1\ntitle=${metaEscape(`Resumen de Noticias ${dateLabel}`)}\nartist=Resumen Noticias\n`;
    chapters.forEach((c, i) => {
      const end = i + 1 < chapters.length ? chapters[i + 1].start : total;
      meta += `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(c.start * 1000)}\nEND=${Math.round(end * 1000)}\ntitle=${metaEscape(c.titulo)}\n`;
    });
    const metaPath = path.join(dir, 'meta.txt');
    fs.writeFileSync(metaPath, meta, 'utf-8');

    let enc = encodeOutputs(pcmPath, r.sampleRate, metaPath, dir);
    if (enc.mp3Bytes > MAX_MP3_BYTES || enc.m4aBytes > MAX_MP3_BYTES) {
      log('WARN', `Archivos sobre el tope (${(enc.mp3Bytes / 1e6).toFixed(1)} y ${(enc.m4aBytes / 1e6).toFixed(1)} MB); re-codificando a 32 kbps.`);
      enc = encodeOutputs(pcmPath, r.sampleRate, metaPath, dir, MP3_FALLBACK_BITRATE, '32k');
    }
    const files = [];
    if (enc.mp3Bytes <= MAX_MP3_BYTES) files.push({ path: enc.mp3, ext: 'mp3', contentType: 'audio/mpeg', bytes: enc.mp3Bytes });
    if (enc.m4aBytes <= MAX_MP3_BYTES) files.push({ path: enc.m4a, ext: 'm4a', contentType: 'audio/mp4', bytes: enc.m4aBytes });
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    log('INFO', `Audio generado: ${(total / 60).toFixed(1)} min, ${chapters.length} capítulos, MP3 ${(enc.mp3Bytes / 1e6).toFixed(1)} MB, M4A ${(enc.m4aBytes / 1e6).toFixed(1)} MB, en ${secs} s.`);
    if (!files.length) return { ok: false, reason: 'los archivos de audio exceden el tope de 18 MB (límite de 25 MB de Gmail con codificación base64)' };

    const out = {
      ok: true, minutes: total / 60, files, engine: r.engine,
      chapters: chapters.map((c) => ({ titulo: c.titulo, inicio: mmss(c.start) })),
    };
    if (r.failure) {
      out.partial = true;
      out.coverage = `incluye ${incl.length} de ${secciones.length} secciones (hasta ${incl[incl.length - 1].titulo})${indicePcm ? '' : ', sin índice hablado'}`;
      out.reason = r.failure.message.slice(0, 200);
      log('WARN', `Audio parcial: ${out.coverage}. Motivo: ${out.reason}`);
    }
    return out;
  } catch (err) {
    log('WARN', `Audio no generado tras ${((Date.now() - started) / 1000).toFixed(0)} s: ${err.message}`);
    return { ok: false, reason: err.message.slice(0, 200) };
  } finally {
    clearTimeout(timer);
    controller.abort(); // detiene cualquier proceso o llamada que siga en curso
  }
}

module.exports = { generateAudio, buildSections, themeMap, splitText, parseReport, toPcm, findAudioData, marcaHablada, MAX_MP3_BYTES };
