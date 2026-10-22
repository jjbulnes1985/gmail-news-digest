'use strict';

/**
 * mailer.js — Formatea el resumen de Claude como HTML y lo envía por SMTP
 */

const nodemailer = require('nodemailer');
const dns        = require('dns');
const { promisify } = require('util');
const dnsLookup  = promisify(dns.lookup);
const { log, santiagoDateDMY } = require('./utils');

/**
 * Convierte el texto plano del resumen (con secciones ÍNDICE / CUERPO / ALERTAS)
 * en HTML formateado para email.
 * @param {string} text - Texto del resumen generado por Claude
 * @returns {string} HTML completo del email
 */
function convertToHtml(text) {
  const lines = text.split('\n');
  let html = '';
  let section = '';          // 'indice' | 'cuerpo' | 'alertas' | ''
  let hasBodyAnchors = false;

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

    // Noticia numerada: "N. Título — ... — Semáforo: X"
    const m = p.match(/^N?°?\s*(\d+)[\.\)]\s/);
    if (m) {
      const n = m[1];
      if (section === 'indice') {
        // Título del índice enlazado a su desarrollo en el cuerpo
        html += `<p class="idx"><a href="#noticia-${n}">${inline(line)}</a></p>\n`;
        continue;
      }
      if (section === 'cuerpo') {
        hasBodyAnchors = true;
        html += `<p class="titular"><a name="noticia-${n}" id="noticia-${n}"></a>${inline(line)}</p>\n`;
        continue;
      }
      html += `<p>${inline(line)}</p>\n`;
      continue;
    }

    // Fuente: cierra el bloque de la noticia con un link de vuelta al índice
    if (/^\(Fuente:/i.test(p)) {
      html += `<p class="fuente">${escapeHtml(p)}`;
      if (section === 'cuerpo' && hasBodyAnchors) {
        html += ` · <a class="volver" href="#indice">Volver al índice</a>`;
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
async function sendDigest(summaryText, audio = null) {
  const today = santiagoDateDMY(Date.now()); // fecha de Chile, no la del runner (UTC)

  // Convertir el texto a HTML con estilos de email
  let bodyHtml = convertToHtml(summaryText);
  if (audio && audio.ok) {
    bodyHtml = `<p class="audio-nota">🎧 Resumen en audio adjunto (alertas, noticias Alto y Medio; ${audio.minutes.toFixed(0)} min aprox.).</p>\n` + bodyHtml;
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
    .volver { font-style: normal; font-size: 11px; }
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
    Generado automáticamente por gmail-news-digest · ${today}
  </div>
</body>
</html>`;

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

  const mailOptions = {
    from:    `"Resumen Noticias" <${process.env.SMTP_USER}>`,
    to:      process.env.DIGEST_RECIPIENT,
    subject: `📰 Resumen Noticias — ${today}`,
    html:    htmlEmail,
    text:    summaryText,
    attachments: (audio && audio.ok)
      ? [{ filename: `Resumen-Noticias-${today.replace(/\//g, '-')}.mp3`, path: audio.path, contentType: 'audio/mpeg' }]
      : [],
  };

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

module.exports = { sendDigest, convertToHtml };
