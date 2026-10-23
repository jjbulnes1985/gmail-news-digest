'use strict';

/**
 * audio.js — Genera un resumen en audio (MP3) a partir del informe escrito.
 *
 * Contenido: alertas del día + noticias con semáforo Alto + noticias Medio.
 * Motor: Gemini TTS vía Interactions API (misma GEMINI_API_KEY del resumen).
 * Se generan fragmentos por noticia, se concatena el PCM y ffmpeg lo codifica a MP3.
 *
 * El audio NUNCA bloquea el envío del correo: ante cualquier error o si se excede
 * el presupuesto de tiempo, generateAudio devuelve { ok: false, reason } y el
 * correo sale sin adjunto, indicando el motivo.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { log } = require('./utils');
const { isUnavailable, discoverModel, recordChange } = require('./models');

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
const PAUSE_SECONDS  = 0.7;            // silencio entre noticias

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
 * Arma la lista ordenada de textos a locutar (cada uno será un fragmento de audio).
 */
function buildScript(text, dateLabel) {
  const { alerts, items } = parseReport(text);
  const alto  = items.filter((i) => i.level === 'Alto');
  const medio = items.filter((i) => i.level === 'Medio');
  const parts = [];

  parts.push(`Resumen de noticias del ${dateLabel}. Incluye ${alerts.length} alertas del día, ` +
    `${alto.length} noticias de prioridad alta y ${medio.length} de prioridad media.`);
  if (alerts.length) {
    parts.push('Alertas del día.');
    alerts.forEach((a, k) => parts.push(`Alerta ${k + 1}. ${a}`));
  }
  if (alto.length) {
    parts.push('Noticias de prioridad alta.');
    alto.forEach((i) => parts.push(`Noticia ${i.n}. ${i.title}. ${i.body}`));
  }
  if (medio.length) {
    parts.push('Noticias de prioridad media.');
    medio.forEach((i) => parts.push(`Noticia ${i.n}. ${i.title}. ${i.body}`));
  }
  parts.push('Fin del resumen.');

  // 1) Divide las partes demasiado largas por oraciones.
  const pieces = [];
  for (const p of parts) {
    if (p.length <= MAX_CHUNK_CHARS) { pieces.push(p); continue; }
    let cur = '';
    for (const s of p.split(/(?<=[\.\!\?])\s+/)) {
      if ((cur + ' ' + s).length > MAX_CHUNK_CHARS && cur) { pieces.push(cur); cur = s; }
      else cur = cur ? `${cur} ${s}` : s;
    }
    if (cur) pieces.push(cur);
  }

  // 2) AGRUPA piezas consecutivas hasta MAX_CHUNK_CHARS (menos solicitudes a la API).
  //    Se separan con párrafo para que la voz haga una pausa entre noticias.
  //    Cada fragmento guarda la última noticia o alerta que incluye (para audio parcial).
  const chunks = [];
  const labels = [];
  let cur = '';
  let lastLabel = 'la introducción';
  for (const piece of pieces) {
    const m = piece.match(/^(Noticia \d+|Alerta \d+)\./);
    if (cur && (cur.length + 2 + piece.length) > MAX_CHUNK_CHARS) {
      chunks.push(cur); labels.push(lastLabel); cur = '';
    }
    cur = cur ? `${cur}\n\n${piece}` : piece;
    if (m) lastLabel = m[1].replace('Noticia', 'la noticia').replace('Alerta', 'la alerta');
  }
  if (cur) { chunks.push(cur); labels.push(lastLabel); }

  return { chunks, labels, counts: { alerts: alerts.length, alto: alto.length, medio: medio.length } };
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

/** Codifica PCM a MP3 con ffmpeg. */
function encodeMp3(pcmPath, mp3Path, bitrate) {
  execFileSync(ffmpegPath(), ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1',
    '-i', pcmPath, '-codec:a', 'libmp3lame', '-b:a', bitrate, mp3Path]);
  return fs.statSync(mp3Path).size;
}

/**
 * Genera el MP3. Nunca lanza: devuelve { ok, path?, minutes?, reason? }.
 * @param {string} reportText - Informe escrito
 * @param {string} dateLabel  - Fecha legible para la introducción (ej: "jueves 22 de octubre de 2026")
 */
async function generateAudio(reportText, dateLabel) {
  if (String(process.env.AUDIO_ENABLED || 'true').toLowerCase() === 'false') {
    return { ok: false, reason: 'audio desactivado (AUDIO_ENABLED=false)' };
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUDGET_MS);
  const state = { models: [...TTS_MODELS], unavailable: new Set(), quotaExhausted: new Set(), discovery: null, nextSlot: 0, usedModels: new Set() };
  try {
    const built = buildScript(reportText, dateLabel);
    const { counts } = built;
    // Continuación: omite los primeros N fragmentos ya enviados (modo solo-audio, input "omitir")
    const skip = Math.max(0, parseInt(process.env.AUDIO_SKIP_CHUNKS, 10) || 0);
    if (skip >= built.chunks.length) return { ok: false, reason: `nada que generar: se pidió omitir ${skip} de ${built.chunks.length} fragmentos` };
    const chunks = built.chunks.slice(skip);
    const labels = built.labels.slice(skip);
    const startLabel = skip ? built.labels[skip - 1] : null;
    if (skip) log('INFO', `Continuación: se omiten ${skip} fragmentos (ya enviados hasta ${startLabel}).`);
    const chars = chunks.reduce((a, c) => a + c.length, 0);
    log('INFO', `Audio: ${counts.alerts} alertas, ${counts.alto} Alto, ${counts.medio} Medio; ${chunks.length} fragmentos, ${chars} caracteres; ${AUDIO_RPM} solicitudes por minuto.`);
    if (counts.alto + counts.medio + counts.alerts === 0) {
      return { ok: false, reason: 'no se encontraron alertas ni noticias Alto o Medio en el informe' };
    }

    const results = new Array(chunks.length);
    let next = 0;
    let failure = null; // si un fragmento falla, los demás trabajadores se detienen
    const worker = async () => {
      while (!failure && next < chunks.length) {
        const k = next++;
        try {
          results[k] = await ttsChunk(chunks[k], state, controller.signal);
          const got = results[k].length / 2 / SAMPLE_RATE;
          const expected = chunks[k].length / CHARS_PER_SECOND;
          if (got < expected * 0.4) {
            log('WARN', `Fragmento ${k + 1}: ${got.toFixed(0)} s de audio para ${chunks[k].length} caracteres (se esperaban ~${expected.toFixed(0)} s); posible audio cortado.`);
          }
        } catch (err) {
          failure = failure || err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
    clearTimeout(timer);
    if (state.usedModels.size) log('INFO', `Modelo(s) de voz usados: ${[...state.usedModels].join(', ')}.`);

    // Audio parcial: si algo falló, se usa el tramo inicial completo (alertas y noticias
    // en orden de prioridad) en vez de perder todo el audio.
    let usable = results.length;
    for (let k = 0; k < results.length; k++) { if (!results[k]) { usable = k; break; } }
    if (failure && usable === 0) throw failure;
    const partial = usable < results.length;
    if (partial) {
      log('WARN', `Audio parcial: ${usable} de ${results.length} fragmentos (hasta ${labels[usable - 1]}). Motivo: ${failure ? failure.message : 'fragmentos faltantes'}`);
    }

    const silence = Buffer.alloc(Math.round(SAMPLE_RATE * PAUSE_SECONDS) * 2);
    const pcm = Buffer.concat(results.slice(0, usable).flatMap((b) => [b, silence]));
    const minutes = pcm.length / 2 / SAMPLE_RATE / 60;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-'));
    const pcmPath = path.join(dir, 'resumen.pcm');
    const mp3Path = path.join(dir, 'resumen.mp3');
    fs.writeFileSync(pcmPath, pcm);
    let bytes = encodeMp3(pcmPath, mp3Path, MP3_BITRATE);
    let bitrate = MP3_BITRATE;
    if (bytes > MAX_MP3_BYTES) {
      log('WARN', `MP3 de ${(bytes / 1e6).toFixed(1)} MB supera el tope de ${(MAX_MP3_BYTES / 1e6).toFixed(1)} MB; re-codificando a ${MP3_FALLBACK_BITRATE}.`);
      bytes = encodeMp3(pcmPath, mp3Path, MP3_FALLBACK_BITRATE);
      bitrate = MP3_FALLBACK_BITRATE;
    }
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    log('INFO', `Audio generado: ${minutes.toFixed(1)} min, ${(bytes / 1e6).toFixed(1)} MB a ${bitrate}, en ${secs} s.`);
    if (bytes > MAX_MP3_BYTES) {
      return { ok: false, reason: `MP3 de ${(bytes / 1e6).toFixed(1)} MB excede el tope de ${(MAX_MP3_BYTES / 1e6).toFixed(1)} MB (límite de 25 MB de Gmail con codificación base64)` };
    }
    if (partial) {
      return {
        ok: true, partial: true, path: mp3Path, minutes, ...(skip ? { continuationAfter: startLabel } : {}),
        coverage: `incluye hasta ${labels[usable - 1]} (${usable} de ${results.length} fragmentos)`,
        reason: (failure ? failure.message : 'fragmentos faltantes').slice(0, 200),
      };
    }
    return { ok: true, path: mp3Path, minutes, ...(skip ? { continuationAfter: startLabel } : {}) };
  } catch (err) {
    log('WARN', `Audio no generado tras ${((Date.now() - started) / 1000).toFixed(0)} s: ${err.message}`);
    return { ok: false, reason: err.message.slice(0, 200) };
  } finally {
    clearTimeout(timer);
    controller.abort(); // detiene cualquier llamada que siga en curso
  }
}

module.exports = { generateAudio, buildScript, parseReport, toPcm, findAudioData, MAX_MP3_BYTES };
