'use strict';

/**
 * index.js — Punto de entrada principal.
 * Modos de ejecución:
 *   npm start        → inicia el scheduler (cron, proceso persistente)
 *   npm run now      → ejecuta el pipeline una vez de forma inmediata y sale
 *   npm run auth     → solo realiza la autorización OAuth2 (primera vez)
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');
const { authorize, getEmails, getLatestDigest } = require('./gmail');
const { summarize }            = require('./summarizer');
const { sendDigest, sendAudioOnly } = require('./mailer');
const { generateAudio }        = require('./audio');
const { publishPodcast, dmyToISO } = require('./podcast');
const { log, saveLastRun, santiagoDate, getLastRunDate } = require('./utils');

// Idempotencia: un solo informe por día calendario de Santiago. Los disparos
// posteriores del mismo día (respaldos de GitHub, reintentos) se omiten solos.

// Leer flags de línea de comandos
const args      = process.argv.slice(2);
const RUN_NOW   = args.includes('--run-now');
const AUTH_ONLY = args.includes('--auth-only');
const AUDIO_ONLY = args.includes('--audio-only');

/**
 * Ejecuta el pipeline completo:
 * 1. Lee emails de Gmail
 * 2. Genera resumen con Claude
 * 3. Envía el resumen por email
 *
 * Cada etapa registra su error y lo relanza: el proceso termina con código 1,
 * GitHub marca la corrida como fallida (y avisa por email) y el siguiente
 * disparo de respaldo vuelve a intentar.
 */
async function runDigest() {
  const startedAt = Date.now();
  log('INFO', '═══════════════════════════════════════════════');
  log('INFO', 'Iniciando ciclo de resumen de noticias...');
  log('INFO', '═══════════════════════════════════════════════');

  // ─── Check de idempotencia: evitar envío duplicado ────────────────────────
  const today       = santiagoDate(startedAt);
  const lastRunDate = getLastRunDate();
  if (lastRunDate === today) {
    log('INFO', `Ya se envió el informe de hoy (${today}, hora de Santiago). Omitiendo para evitar duplicado.`);
    return;
  }

  // ─── Etapa 1: Autenticación y lectura de Gmail ───────────────────────────
  let emails;
  try {
    const auth = await authorize();
    emails = await getEmails(auth);
  } catch (err) {
    log('ERROR', `Fallo en lectura de Gmail: ${err.message}`);
    throw err;
  }

  if (emails.length === 0) {
    log('INFO', 'Sin noticias nuevas en el período configurado. Finalizando ciclo.');
    return;
  }

  log('INFO', `${emails.length} email(s) listos para procesar.`);

  // ─── Etapa 2: Generación del resumen con Claude ──────────────────────────
  let summary;
  try {
    summary = await summarize(emails);
  } catch (err) {
    log('ERROR', `Fallo en generación del resumen con Gemini: ${err.message}`);
    throw err;
  }

  // ─── Etapa 3: Envío del resumen por email ────────────────────────────────
  try {
    // Audio opcional: nunca bloquea el envío; si falla, el correo sale sin adjunto
    const dateLabel = new Date(startedAt).toLocaleDateString('es-CL', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Santiago',
    });
    const audio = await generateAudio(summary, dateLabel);
    // Podcast por secciones (nunca lanza ni bloquea el correo)
    const podcast = await publishPodcast(audio, today);
    await sendDigest(summary, audio, podcast);
  } catch (err) {
    log('ERROR', `Fallo en envío del email: ${err.message}`);
    throw err;
  }

  saveLastRun(startedAt);
  log('INFO', 'Ciclo completado exitosamente.');
}

// ─── Selector de modo de ejecución ──────────────────────────────────────────

/**
 * Modo --audio-only: regenera y envía SOLO el audio del último resumen enviado.
 * No genera un resumen nuevo, no toca last_run.json y no afecta el envío diario.
 */
async function runAudioOnly() {
  const auth = await authorize();
  const digest = await getLatestDigest(auth);
  const [d, m, y] = digest.dateDMY.split('/').map(Number);
  const dateLabel = new Date(Date.UTC(y, m - 1, d, 15)).toLocaleDateString('es-CL', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Santiago',
  });
  const audio = await generateAudio(digest.text, dateLabel);
  if (!audio.ok) throw new Error(`audio no generado: ${audio.reason}`);
  await publishPodcast(audio, dmyToISO(digest.dateDMY));
  await sendAudioOnly(audio, digest.dateDMY);
  log('INFO', `Audio del ${digest.dateDMY} enviado${audio.partial ? ' (parcial)' : ''}.`);
}

if (AUDIO_ONLY) {
  log('INFO', 'Modo: solo audio (--audio-only).');
  runAudioOnly()
    .then(() => process.exit(0))
    .catch((err) => {
      log('ERROR', `Error en modo solo audio: ${err.message}`);
      process.exit(1);
    });

} else if (AUTH_ONLY) {
  // Modo: solo autorización OAuth2 (primera configuración)
  log('INFO', 'Modo: autorización OAuth2 únicamente.');
  authorize()
    .then(() => {
      log('INFO', 'Autorización completada. Ya podés ejecutar npm start o npm run now.');
      process.exit(0);
    })
    .catch((err) => {
      log('ERROR', `Error durante la autorización: ${err.message}`);
      process.exit(1);
    });

} else if (RUN_NOW) {
  // Modo: ejecución inmediata (sin esperar el cron)
  log('INFO', 'Modo: ejecución inmediata (--run-now).');
  runDigest()
    .then(() => process.exit(0))
    .catch((err) => {
      log('ERROR', `Error inesperado: ${err.message}`);
      process.exit(1);
    });

} else {
  // Modo: scheduler con cron (proceso persistente)
  const schedule = process.env.CRON_SCHEDULE || '0 7 * * 1-5';
  const timezone = process.env.CRON_TIMEZONE || 'America/Buenos_Aires';

  // Validar la expresión cron antes de registrarla
  if (!cron.validate(schedule)) {
    log('ERROR', `La expresión CRON_SCHEDULE es inválida: "${schedule}"`);
    process.exit(1);
  }

  log('INFO', `Modo: scheduler iniciado.`);
  log('INFO', `  Horario:   "${schedule}"`);
  log('INFO', `  Zona horaria: ${timezone}`);
  log('INFO', 'Esperando próxima ejecución... (Ctrl+C para detener)');

  cron.schedule(schedule, () => {
    runDigest().catch((err) => {
      log('ERROR', `Error inesperado en el cron: ${err.message}`);
    });
  }, {
    timezone,
  });
}
