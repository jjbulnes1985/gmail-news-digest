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
  try {
    const data = JSON.parse(fs.readFileSync(LAST_RUN_PATH, 'utf-8'));
    if (data.lastRunAt) {
      log('INFO', `Usando última ejecución exitosa: ${new Date(data.lastRunAt).toISOString()}`);
      return Math.floor(data.lastRunAt / 1000);
    }
  } catch (_) { /* no existe, usar fallback */ }
  log('INFO', `Sin registro previo. Usando ventana de ${fallbackHours} horas.`);
  return buildAfterEpoch(fallbackHours);
}

/**
 * Guarda el timestamp de la ejecución exitosa actual en last_run.json.
 */
function saveLastRun() {
  fs.writeFileSync(LAST_RUN_PATH, JSON.stringify({ lastRunAt: Date.now() }, null, 2));
  log('INFO', 'Timestamp de última ejecución guardado en last_run.json');
}

module.exports = { stripHtml, log, formatDate, buildAfterEpoch, getLastRunEpoch, saveLastRun };
