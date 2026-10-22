'use strict';

/**
 * models.js — Cambio automático de modelo cuando uno deja de estar disponible.
 *
 * Regla: solo se cambia de modelo ante 404, o un 400/403 cuyo mensaje indique que el
 * modelo no existe, fue retirado o no está disponible (caso gemini-2.5-pro, 21-10-2026).
 * Los 429/503 (cuota o saturación) NO cambian el modelo: se reintenta con el mismo.
 *
 * Si todos los modelos preferidos de una etapa quedan descartados, se consulta
 * GET /v1beta/models y se elige el más reciente que cumpla los criterios de la etapa.
 * Nunca se inventan nombres: solo los preferidos o los que devuelve la API.
 */

const { log } = require('./utils');

const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const UNAVAILABLE_RE = /not found|no longer available|not available|not supported|unsupported|deprecated|retired|does not exist|is not found/i;

// Cambios de modelo ocurridos en esta corrida (se informan al pie del correo)
const changes = [];

/**
 * ¿El error indica que el modelo no está disponible (y no un problema transitorio)?
 * @param {Error & {status?: number}} err
 */
function isUnavailable(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  const status = err.status || (msg.match(/\[(\d{3})[^\]]*\]/) || [])[1] * 1 || (msg.match(/HTTP (\d{3})/) || [])[1] * 1;
  if (status === 404) return true;
  if ((status === 400 || status === 403) && UNAVAILABLE_RE.test(msg)) return true;
  return false;
}

/** Lista los modelos visibles para la API key (paginando). */
async function listModels() {
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const url = `${MODELS_ENDPOINT}?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, {
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
      signal: AbortSignal.timeout(30 * 1000),
    });
    if (!res.ok) throw new Error(`no se pudo listar modelos (HTTP ${res.status})`);
    const data = await res.json();
    out.push(...(data.models || []));
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  return out;
}

/** Clave de orden por versión: [mayor, menor, ...]; "preview"/"exp" pesan menos ante empate. */
function versionKey(name) {
  const m = name.match(/gemini-(\d+(?:\.\d+)*)/i);
  const nums = m ? m[1].split('.').map(Number) : [0];
  const preview = /preview|exp/i.test(name) ? 0 : 1;
  return { nums, preview };
}

function compareDesc(a, b) {
  const ka = versionKey(a), kb = versionKey(b);
  for (let i = 0; i < Math.max(ka.nums.length, kb.nums.length); i++) {
    const d = (kb.nums[i] || 0) - (ka.nums[i] || 0);
    if (d) return d;
  }
  return kb.preview - ka.preview;
}

/**
 * Elige un modelo de reemplazo desde la API.
 * @param {'text'|'tts'} kind
 * @param {string[]} exclude - modelos ya descartados
 * @returns {Promise<string|null>}
 */
async function discoverModel(kind, exclude = []) {
  try {
    const models = await listModels();
    const ex = new Set(exclude.map((x) => x.replace(/^models\//, '')));
    const names = models
      .filter((m) => {
        const n = String(m.name || '').replace(/^models\//, '');
        const methods = m.supportedGenerationMethods || [];
        if (!n.startsWith('gemini-') || ex.has(n)) return false;
        if (kind === 'tts') return /tts/i.test(n) && /flash/i.test(n);
        return /flash/i.test(n) && !/tts|image|live|embedding|preview|audio|native/i.test(n)
          && methods.includes('generateContent');
      })
      .map((m) => String(m.name).replace(/^models\//, ''))
      .sort(compareDesc);
    return names[0] || null;
  } catch (err) {
    log('WARN', `Descubrimiento de modelos (${kind}) falló: ${err.message}`);
    return null;
  }
}

/** Registra un cambio de modelo para el log y el pie del correo. */
function recordChange(stage, replacement, replaced) {
  const line = `Modelo de ${stage} cambiado automáticamente: ${replacement} reemplaza a ${replaced.join(', ')}`;
  log('WARN', line);
  changes.push(line);
}

function getChanges() { return [...changes]; }

module.exports = { isUnavailable, listModels, discoverModel, recordChange, getChanges, compareDesc };
