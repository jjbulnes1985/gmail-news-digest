'use strict';

/**
 * utils.js — Funciones auxiliares reutilizables sin dependencias externas
 */

/**
 * Convierte HTML a texto plano preservando la estructura de párrafos.
 * @param {string} html - Contenido HTML a convertir
 * @returns {string} Texto plano limpio
 */
function stripHtml(html) {
  if (!html) return '';

  let text = html;

  // Reemplazar etiquetas de bloque por saltos de línea antes de eliminar tags
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n');
  text = text.replace(/<p[^>]*>/gi, '\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<div[^>]*>/gi, '\n');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '• ');
  text = text.replace(/<\/tr>/gi, '\n');

  // Eliminar todas las etiquetas HTML restantes
  text = text.replace(/<[^>]*>/g, '');

  // Decodificar entidades HTML comunes
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&apos;/g, "'");
  text = text.replace(/&#x27;/g, "'");
  text = text.replace(/&hellip;/g, '...');
  text = text.replace(/&mdash;/g, '—');
  text = text.replace(/&ndash;/g, '–');

  // Colapsar múltiples líneas vacías en una sola
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/**
 * Registra un mensaje en consola con timestamp y nivel de severidad.
 * @param {'INFO'|'WARN'|'ERROR'} level - Nivel del log
 * @param {string} message - Mensaje a registrar
 */
function log(level, message) {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${timestamp}] [${level}] ${message}`;

  if (level === 'ERROR') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

/**
 * Formatea una fecha como DD/MM/YYYY.
 * @param {Date|string} date - Fecha a formatear
 * @returns {string} Fecha en formato DD/MM/YYYY
 */
function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const day   = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year  = d.getFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * Calcula el timestamp Unix (segundos) para usar en queries de Gmail con `after:`.
 * @param {number} hoursBack - Cantidad de horas hacia atrás desde ahora
 * @returns {number} Timestamp en segundos
 */
function buildAfterEpoch(hoursBack) {
  return Math.floor((Date.now() - hoursBack * 3600 * 1000) / 1000);
}

const fs   = require('fs');
const path = require('path');
const LAST_RUN_PATH = path.join(__dirname, '..', 'last_run.json');

/**
 * Devuelve el timestamp Unix (segundos) desde la última ejecución exitosa.
 * Si no existe registro previo, cae al fallback de horas configurado.
 * @param {number} fallbackHours - Horas hacia atrás si no hay registro previo
 * @returns {number} Timestamp en segundos
 */
function getLastRunEpoch(fallbackHours) {
  const maxEpoch = buildAfterEpoch(fallbackHours);
  try {
    const data = JSON.parse(fs.readFileSync(LAST_RUN_PATH, 'utf-8'));
    if (data.lastRunAt) {
      const lastRunEpoch = Math.floor(data.lastRunAt / 1000);
      // Nunca retroceder más allá del límite de horas configurado
      const result = Math.max(lastRunEpoch, maxEpoch);
      log('INFO', `Usando última ejecución exitosa: ${new Date(result * 1000).toISOString()}`);
      return result;
    }
  } catch (_) { /* no existe, usar fallback */ }
  log('INFO', `Sin registro previo. Usando ventana de ${fallbackHours} horas.`);
  return maxEpoch;
}

/**
 * Guarda el timestamp de la ejecución exitosa actual en last_run.json.
 * Se usa la hora de INICIO de la corrida: los correos que llegan mientras
 * corre el pipeline quedan para el informe siguiente en vez de perderse.
 * @param {number} startedAt - Epoch en ms en que empezó la corrida
 */
function saveLastRun(startedAt) {
  const payload = { lastRunAt: startedAt, lastRunDate: santiagoDate(startedAt) };
  fs.writeFileSync(LAST_RUN_PATH, JSON.stringify(payload, null, 2));
  log('INFO', 'Timestamp de última ejecución guardado en last_run.json');
}

/**
 * Fecha calendario (AAAA-MM-DD) en America/Santiago para un epoch en ms.
 * Se usa para el control anti-duplicado: un informe por día calendario de Chile,
 * sin importar a qué hora corrió el anterior.
 * @param {number} epochMs
 * @returns {string}
 */
function santiagoDate(epochMs) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(epochMs));
}

/**
 * Devuelve la fecha (AAAA-MM-DD, Santiago) del último envío exitoso, o null.
 * Compatible con last_run.json antiguos que solo tienen lastRunAt.
 * @returns {string|null}
 */
function getLastRunDate() {
  try {
    const data = JSON.parse(fs.readFileSync(LAST_RUN_PATH, 'utf-8'));
    if (data.lastRunDate) return data.lastRunDate;
    if (data.lastRunAt) return santiagoDate(data.lastRunAt);
  } catch (_) { /* no existe o ilegible */ }
  return null;
}

module.exports = {
  stripHtml, log, formatDate, buildAfterEpoch, getLastRunEpoch, saveLastRun,
  santiagoDate, getLastRunDate,
};
