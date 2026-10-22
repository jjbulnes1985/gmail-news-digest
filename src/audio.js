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

const TTS_ENDPOINT   = 'https://generativelanguage.googleapis.com/v1beta/interactions';
// Modelos vigentes según la documentación de Gemini (consultada el 22-10-2026).
// Primero el Lite (más barato y rápido); si falla, el Flash.
const TTS_MODELS     = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'];
const VOICE          = process.env.TTS_VOICE || 'Kore';
const STYLE          = 'lectura de noticiero en español, tono sobrio y claro, ritmo moderado';
const SAMPLE_RATE    = 24000;          // PCM 16 bits, mono (formato documentado de salida)
const MAX_CHUNK_CHARS = 2500;          // fragmentos cortos: menos riesgo de rechazo o corte
const CONCURRENCY    = 4;
const BUDGET_MS      = parseInt(process.env.AUDIO_BUDGET_MS, 10) || 10 * 60 * 1000;
const MP3_BITRATE    = '40k';          // voz mono: ~18 MB por hora, bajo el límite de 25 MB de Gmail
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
    const m = head.match(/^(\d+)[\.\)]\s+(.*?)\s*(?:—|-)\s*Semáforo:\s*(Alto|Medio|Bajo)/i);
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

  // Divide fragmentos largos por oraciones para no exceder MAX_CHUNK_CHARS
  const out = [];
  for (const p of parts) {
    if (p.length <= MAX_CHUNK_CHARS) { out.push(p); continue; }
    let cur = '';
    for (const s of p.split(/(?<=[\.\!\?])\s+/)) {
      if ((cur + ' ' + s).length > MAX_CHUNK_CHARS && cur) { out.push(cur); cur = s; }
      else cur = cur ? `${cur} ${s}` : s;
    }
    if (cur) out.push(cur);
  }
  return { chunks: out, counts: { alerts: alerts.length, alto: alto.length, medio: medio.length } };
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

/** Busca recursivamente el primer bloque de audio en base64 de la respuesta. */
function findAudioData(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'audio' && typeof obj.data === 'string') return obj.data;
  if (obj.inlineData && typeof obj.inlineData.data === 'string') return obj.inlineData.data; // forma generateContent
  for (const v of Object.values(obj)) {
    const found = findAudioData(v);
    if (found) return found;
  }
  return null;
}

async function ttsOnce(model, text) {
  const res = await fetch(TTS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      model,
      input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: STYLE }] }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: VOICE }] },
    }),
    signal: AbortSignal.timeout(120 * 1000),
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

/** Un fragmento con reintentos y cambio de modelo. */
async function ttsChunk(text, deadline) {
  let lastErr;
  for (const model of TTS_MODELS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (Date.now() > deadline) throw new Error('presupuesto de tiempo agotado');
      try {
        return await ttsOnce(model, text);
      } catch (err) {
        lastErr = err;
        if (err.status === 404 || err.status === 400 || err.status === 403) break; // modelo no disponible: siguiente
        await new Promise((r) => setTimeout(r, 5000 * attempt)); // 429/503: espera creciente
      }
    }
  }
  throw lastErr;
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
  const deadline = started + BUDGET_MS;
  try {
    const { chunks, counts } = buildScript(reportText, dateLabel);
    const chars = chunks.reduce((a, c) => a + c.length, 0);
    log('INFO', `Audio: ${counts.alerts} alertas, ${counts.alto} Alto, ${counts.medio} Medio; ${chunks.length} fragmentos, ${chars} caracteres.`);
    if (counts.alto + counts.medio + counts.alerts === 0) {
      return { ok: false, reason: 'no se encontraron alertas ni noticias Alto o Medio en el informe' };
    }

    const results = new Array(chunks.length);
    let next = 0;
    let failed = false; // si un fragmento falla, los demás trabajadores se detienen
    const worker = async () => {
      while (!failed && next < chunks.length) {
        const k = next++;
        try {
          results[k] = await ttsChunk(chunks[k], deadline);
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));

    const silence = Buffer.alloc(Math.round(SAMPLE_RATE * PAUSE_SECONDS) * 2);
    const pcm = Buffer.concat(results.flatMap((b) => [b, silence]));
    const minutes = pcm.length / 2 / SAMPLE_RATE / 60;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-'));
    const pcmPath = path.join(dir, 'resumen.pcm');
    const mp3Path = path.join(dir, 'resumen.mp3');
    fs.writeFileSync(pcmPath, pcm);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1',
      '-i', pcmPath, '-codec:a', 'libmp3lame', '-b:a', MP3_BITRATE, mp3Path]);

    const mb = fs.statSync(mp3Path).size / 1024 / 1024;
    log('INFO', `Audio generado: ${minutes.toFixed(1)} min, ${mb.toFixed(1)} MB, en ${((Date.now() - started) / 1000).toFixed(0)} s.`);
    if (mb > 24) return { ok: false, reason: `MP3 de ${mb.toFixed(1)} MB excede el límite de adjuntos de Gmail` };
    return { ok: true, path: mp3Path, minutes };
  } catch (err) {
    log('WARN', `Audio no generado: ${err.message}`);
    return { ok: false, reason: err.message.slice(0, 200) };
  }
}

module.exports = { generateAudio, buildScript, parseReport, toPcm, findAudioData };
