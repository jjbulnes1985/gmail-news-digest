'use strict';

/**
 * mailer.js — Formatea el resumen de Claude como HTML y lo envía por SMTP
 */

const nodemailer = require('nodemailer');
const dns        = require('dns');
const { promisify } = require('util');
const dnsLookup  = promisify(dns.lookup);
const { log, santiagoDateDMY } = require('./utils');
const { getChanges } = require('./models');
const { normalizeNumbering, readHeader } = require('./report');

/**
 * Convierte el texto plano del resumen (con secciones ÍNDICE / CUERPO / ALERTAS)
 * en HTML formateado para email.
 * @param {string} text - Texto del resumen generado por Claude
 * @returns {string} HTML completo del email
 */
function convertToHtml(text) {
  // Defensivo: si llegan marcadores "N." en vez de números, sin esto no hay enlaces
  const lines = normalizeNumbering(text).text.split('\n');
  let html = '';
  let section = '';          // 'indice' | 'cuerpo' | 'alertas' | ''
  let hasBodyAnchors = false;
  let currentNews = null;     // número de la noticia del cuerpo que se está escribiendo
  const indexNums = new Set(); // números que tienen titular en el índice

  // Colorea el semáforo
  const badgeSemaforo = (linea) => linea
    .replace(/Semáforo:\s*Alto/gi,  'Semáforo: <span class="alto">Alto</span>')
    .replace(/Semáforo:\s*Medio/gi, 'Semáforo: <span class="medio">Medio</span>')
    .replace(/Semáforo:\s*Bajo/gi,  'Semáforo: <span class="bajo">Bajo</span>');

  // Convierte **negrita** (markdown que a veces devuelve Gemini) en <strong>; quita # sueltos
  const inline = (raw) => badgeSemaforo(
    escapeHtml(raw.replace(/^#+\s*/, ''))
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*\*/g, '')
  );

  // Texto del encabezado sin asteriscos ni almohadillas, para reconocer secciones
  const plain = (raw) => raw.replace(/[*#]/g, '').trim();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') { html += '<br>'; continue; }

    const p = plain(line);

    // Encabezados de sección principal (con o sin **)
    if (/^(ÍNDICE|INDICE)$/i.test(p)) {
      section = 'indice';
      html += '<h2><a name="indice" id="indice"></a>ÍNDICE</h2>\n';
      continue;
    }
    if (/^CUERPO$/i.test(p)) { section = 'cuerpo'; html += '<h2>CUERPO</h2>\n'; continue; }
    if (/^ALERTAS DEL D[IÍ]A$/i.test(p)) { section = 'alertas'; html += '<h2>ALERTAS DEL DÍA</h2>\n'; continue; }

    if (/^---+$/.test(line)) { html += '<hr>\n'; continue; }

    // Subtítulos de ámbito ("CHILE") y de temática ("Política") en índice y cuerpo
    if (section === 'indice' || section === 'cuerpo') {
      const h = readHeader(line);
      if (h && h.ambito) { html += `<h3 class="ambito">${escapeHtml(h.ambito)}</h3>\n`; continue; }
      if (h && h.tema) { html += `<h4 class="tema">${escapeHtml(h.tema)}</h4>\n`; continue; }
    }

    // Noticia numerada: "N. Título — ... — Semáforo: X"
    const m = p.match(/^N?°?\s*(\d+)[\.\)]\s/);
    if (m) {
      const n = m[1];
      if (section === 'indice') {
        // Título del índice enlazado a su desarrollo en el cuerpo; lleva su propia ancla
        // ("idx-N") para que el desarrollo pueda volver exactamente a este titular
        indexNums.add(n);
        html += `<p class="idx"><a name="idx-${n}" id="idx-${n}"></a><a href="#noticia-${n}">${inline(line)}</a></p>\n`;
        continue;
      }
      if (section === 'cuerpo') {
        hasBodyAnchors = true;
        currentNews = n;
        html += `<p class="titular"><a name="noticia-${n}" id="noticia-${n}"></a>${inline(line)}</p>\n`;
        continue;
      }
      html += `<p>${inline(line)}</p>\n`;
      continue;
    }

    // Fuente: cierra el bloque de la noticia con un link de vuelta a SU titular en el
    // índice (no al comienzo), para seguir leyendo desde donde se iba. Si ese titular
    // no está en el índice, el link vuelve al comienzo del índice.
    // Si trae "Enlace: URL" (resuelto en summarizer.js), la URL se cambia por un link
    // "Ver noticia original".
    if (/^\(Fuente:/i.test(p)) {
      const lm = line.match(/\s*[—–-]\s*Enlace:\s*(https?:\/\/[^\s)]+)/i);
      const fuente = lm ? line.replace(lm[0], '').replace(/[*#]/g, '').trim() : p;
      html += `<p class="fuente">${escapeHtml(fuente)}`;
      if (lm) html += ` · <a class="original" href="${escapeHtml(lm[1])}" target="_blank" rel="noopener">Ver noticia original</a>`;
      if (section === 'cuerpo' && hasBodyAnchors) {
        const target = currentNews && indexNums.has(currentNews) ? `idx-${currentNews}` : 'indice';
        html += ` · <a class="volver" href="#${target}">Volver al titular</a>`;
      }
      html += '</p>\n';
      continue;
    }

    // Subtítulos de temática en el índice (ej: "Política") y resto del contenido
    html += `<p>${inline(line)}</p>\n`;
  }

  return html;
}

/**
 * Escapa caracteres especiales de HTML para evitar inyección.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Envía el resumen de noticias por email.
 * @param {string} summaryText - Texto plano del resumen generado por Claude
 * @returns {Promise<void>}
 */
const GMAIL_SAFE_BYTES = 18 * 1000 * 1000; // 25 MB codificados ÷ 4/3 (base64), con margen

/** Nombre de archivo del audio: "Resumen-Noticias-23-10-2026.mp3". */
function audioFilename(dateDMY, ext) { return `Resumen-Noticias-${dateDMY.replace(/\//g, '-')}.${ext}`; }

/**
 * Reparte los archivos de audio: los que caben junto al correo principal y los que
 * van en un segundo correo (si MP3 + M4A superan el tope de Gmail).
 */
function splitAudioFiles(audio, dateDMY, budget = GMAIL_SAFE_BYTES) {
  const main = []; const extra = [];
  let used = 0;
  for (const f of (audio && audio.ok && audio.files) || []) {
    const att = { filename: audioFilename(dateDMY, f.ext), path: f.path, contentType: f.contentType };
    if (used + f.bytes <= budget) { main.push(att); used += f.bytes; } else extra.push(att);
  }
  return { main, extra };
}

/** Línea de capítulos para el cuerpo del correo (Gmail no muestra capítulos al reproducir). */
function chaptersHtml(audio) {
  if (!audio || !audio.chapters || !audio.chapters.length) return '';
  return `<br><span class="capitulos">Capítulos: ${audio.chapters.map((c) => `${escapeHtml(c.titulo)} ${c.inicio}`).join(' · ')}</span>`;
}

async function sendDigest(summaryText, audio = null, { subjectPrefix = '' } = {}) {
  const today = santiagoDateDMY(Date.now()); // fecha de Chile, no la del runner (UTC)

  // Convertir el texto a HTML con estilos de email
  let bodyHtml = convertToHtml(summaryText);
  // Si en esta corrida se cambió de modelo automáticamente, se informa al pie
  const modelChangesHtml = getChanges().map((c) => `<br>${escapeHtml(c)}`).join('');
  const { main: audioMain, extra: audioExtra } = splitAudioFiles(audio, today);
  const formatos = (atts) => atts.map((a) => a.filename.split('.').pop().toUpperCase()).join(' y ');
  const dondeAudio = audioExtra.length
    ? `${formatos(audioMain)} adjunto; ${formatos(audioExtra)} en un segundo correo por el límite de tamaño de Gmail`
    : `${formatos(audioMain)} adjunto${audioMain.length > 1 ? 's' : ''}`;
  if (audio && audio.ok && audio.partial) {
    bodyHtml = `<p class="audio-nota">🎧 Audio PARCIAL con índice y capítulos (${audio.minutes.toFixed(0)} min aprox.; ${dondeAudio}): ${escapeHtml(audio.coverage)}. Motivo: ${escapeHtml(audio.reason)}${chaptersHtml(audio)}</p>\n` + bodyHtml;
  } else if (audio && audio.ok) {
    bodyHtml = `<p class="audio-nota">🎧 Resumen en audio con índice y capítulos (alertas, noticias Alto y Medio; ${audio.minutes.toFixed(0)} min aprox.; ${dondeAudio}).${chaptersHtml(audio)}</p>\n` + bodyHtml;
  } else if (audio && audio.reason) {
    bodyHtml = `<p class="audio-nota">Audio no disponible hoy: ${escapeHtml(audio.reason)}</p>\n` + bodyHtml;
  }

  // Plantilla HTML completa del email
  const htmlEmail = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Resumen Noticias — ${today}</title>
  <style>
    body {
      font-family: Georgia, 'Times New Roman', Times, serif;
      max-width: 700px;
      margin: 0 auto;
      padding: 24px;
      color: #1a1a1a;
      line-height: 1.7;
      background-color: #ffffff;
    }
    h1 {
      font-size: 22px;
      border-bottom: 2px solid #333;
      padding-bottom: 10px;
      margin-bottom: 20px;
    }
    h2 {
      font-size: 17px;
      margin-top: 30px;
      margin-bottom: 10px;
      color: #1a1a2e;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-left: 4px solid #333;
      padding-left: 10px;
    }
    hr {
      border: none;
      border-top: 1px solid #ddd;
      margin: 16px 0;
    }
    p {
      margin: 6px 0;
    }
    a { color: #1a4d8f; }
    .idx a { color: #1a1a1a; text-decoration: none; border-bottom: 1px dotted #1a4d8f; }
    .titular { margin-top: 18px; font-weight: bold; }
    .volver, .original { font-style: normal; font-size: 11px; }
    .capitulos { font-size: 12px; color: #444; }
    .ambito { font-size: 15px; margin: 22px 0 6px; padding: 4px 8px; background: #1a1a2e; color: #ffffff; letter-spacing: 0.5px; text-transform: uppercase; font-family: Arial, sans-serif; }
    .tema { font-size: 14px; margin: 12px 0 4px; color: #1a4d8f; border-bottom: 1px solid #dde3ec; font-family: Arial, sans-serif; }
    .audio-nota { font-family: Arial, sans-serif; font-size: 13px; background: #f3f6fa; border-left: 3px solid #1a4d8f; padding: 8px 10px; }
    .fuente {
      font-size: 12px;
      color: #666;
      font-style: italic;
      margin-top: 2px;
      margin-bottom: 12px;
    }
    .alto {
      background-color: #c0392b;
      color: #ffffff;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 12px;
      font-family: Arial, sans-serif;
      font-weight: bold;
    }
    .medio {
      background-color: #e67e22;
      color: #ffffff;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 12px;
      font-family: Arial, sans-serif;
      font-weight: bold;
    }
    .bajo {
      background-color: #27ae60;
      color: #ffffff;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 12px;
      font-family: Arial, sans-serif;
      font-weight: bold;
    }
    .footer {
      margin-top: 40px;
      font-size: 11px;
      color: #999;
      border-top: 1px solid #eee;
      padding-top: 12px;
      font-family: Arial, sans-serif;
    }
  </style>
</head>
<body>
  <h1>📰 Resumen de Noticias — ${today}</h1>
  ${bodyHtml}
  <div class="footer">
    Generado automáticamente por gmail-news-digest · ${today}${modelChangesHtml}
  </div>
</body>
</html>`;

  const mailOptions = {
    from:    `"Resumen Noticias" <${process.env.SMTP_USER}>`,
    to:      process.env.DIGEST_RECIPIENT,
    subject: `${subjectPrefix}📰 Resumen Noticias — ${today}`,
    html:    htmlEmail,
    text:    summaryText,
    attachments: audioMain,
  };

  await deliver(mailOptions);
  if (audioExtra.length) await sendExtraAudio(audioExtra, today, audio);
}

/** Segundo correo con el formato de audio que no cupo junto al principal. */
async function sendExtraAudio(attachments, dateDMY, audio) {
  const text = `Audio del Resumen Noticias del ${dateDMY} en ${attachments.map((a) => a.filename.split('.').pop().toUpperCase()).join(' y ')} (con índice hablado y capítulos; ${audio.minutes.toFixed(0)} min aprox.).`;
  await deliver({
    from:    `"Resumen Noticias" <${process.env.SMTP_USER}>`,
    to:      process.env.DIGEST_RECIPIENT,
    subject: `🎧 Audio Resumen Noticias — ${dateDMY} (${attachments.map((a) => a.filename.split('.').pop().toUpperCase()).join(', ')})`,
    text,
    html:    `<p style="font-family:Arial,sans-serif;font-size:14px">${escapeHtml(text)}${chaptersHtml(audio)}</p>`,
    attachments,
  });
}

/**
 * Envía un correo por SMTP con 3 intentos (10 s entre ellos).
 * @param {object} mailOptions - opciones de nodemailer
 */
async function deliver(mailOptions) {
  // Configurar transporte SMTP
  // IMPORTANTE: secure: false + port 587 = STARTTLS (correcto para Gmail)
  //             secure: true  + port 465 = SSL implícito (alternativa)
  const smtpHostname = process.env.SMTP_HOST || 'smtp.gmail.com';
  const smtpPort     = parseInt(process.env.SMTP_PORT, 10) || 587;

  // Pre-resolver hostname a IP usando el resolver del OS (mismo que usa nslookup)
  let smtpHost = smtpHostname;
  try {
    const result = await dnsLookup(smtpHostname, { family: 4 });
    smtpHost = result.address;
    log('INFO', `SMTP resuelto: ${smtpHostname} → ${smtpHost}`);
  } catch (dnsErr) {
    log('WARN', `DNS pre-resolve falló, usando hostname directo: ${dnsErr.message}`);
  }

  const transporter = nodemailer.createTransport({
    host:   smtpHost,
    port:   smtpPort,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: { servername: smtpHostname }, // necesario para TLS cuando se usa IP
    connectionTimeout: 30000,
    greetingTimeout:   15000,
    socketTimeout:     30000,
  });

  // 3 intentos con 10s de espera entre ellos
  const MAX_MAIL_RETRIES = 3;
  let lastMailError;
  for (let attempt = 1; attempt <= MAX_MAIL_RETRIES; attempt++) {
    try {
      await transporter.sendMail(mailOptions);
      log('INFO', `Email enviado a ${process.env.DIGEST_RECIPIENT} con asunto: "${mailOptions.subject}"`);
      return;
    } catch (err) {
      lastMailError = err;
      if (attempt < MAX_MAIL_RETRIES) {
        log('WARN', `Intento SMTP ${attempt}/${MAX_MAIL_RETRIES} fallido: ${err.message}. Reintentando en 10s...`);
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
    }
  }
  throw lastMailError;
}

/**
 * Envía SOLO el audio (modo --audio-only), para regenerar el audio de un día en que falló.
 * Si MP3 + M4A superan el tope de Gmail, van en dos correos.
 */
async function sendAudioOnly(audio, dateDMY) {
  if (!audio || !audio.ok) throw new Error(`no hay audio que enviar: ${audio && audio.reason}`);
  const { main, extra } = splitAudioFiles(audio, dateDMY);
  const extraTxt = audio.partial ? ` Audio PARCIAL: ${audio.coverage}. Motivo: ${audio.reason}` : '';
  const text = `Audio del Resumen Noticias del ${dateDMY} con índice hablado y capítulos (alertas, noticias Alto y Medio; ${audio.minutes.toFixed(0)} min aprox.).${extraTxt}`;
  await deliver({
    from:    `"Resumen Noticias" <${process.env.SMTP_USER}>`,
    to:      process.env.DIGEST_RECIPIENT,
    subject: `🎧 Audio Resumen Noticias — ${dateDMY}`,
    text,
    html:    `<p style="font-family:Arial,sans-serif;font-size:14px">${escapeHtml(text)}${chaptersHtml(audio)}</p>`,
    attachments: main,
  });
  if (extra.length) await sendExtraAudio(extra, dateDMY, audio);
}

module.exports = { sendDigest, sendAudioOnly, convertToHtml, splitAudioFiles };
