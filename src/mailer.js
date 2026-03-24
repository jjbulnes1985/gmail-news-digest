'use strict';

/**
 * mailer.js — Formatea el resumen de Claude como HTML y lo envía por SMTP
 */

const nodemailer = require('nodemailer');
const { log, formatDate } = require('./utils');

/**
 * Convierte el texto plano del resumen (con secciones ÍNDICE / CUERPO / ALERTAS)
 * en HTML formateado para email.
 * @param {string} text - Texto del resumen generado por Claude
 * @returns {string} HTML completo del email
 */
function convertToHtml(text) {
  const lines = text.split('\n');
  let html = '';

  // Función para colorear el semáforo en el HTML
  const badgeSemaforo = (linea) => {
    return linea
      .replace(/Semáforo:\s*Alto/gi,  'Semáforo: <span class="alto">Alto</span>')
      .replace(/Semáforo:\s*Medio/gi, 'Semáforo: <span class="medio">Medio</span>')
      .replace(/Semáforo:\s*Bajo/gi,  'Semáforo: <span class="bajo">Bajo</span>');
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line === '') {
      // Línea vacía: separador visual
      html += '<br>';
      continue;
    }

    // Encabezados de sección principal
    if (/^(ÍNDICE|INDICE|CUERPO|ALERTAS DEL DÍA|ALERTAS DEL DIA)$/i.test(line)) {
      html += `<h2>${line}</h2>\n`;
      continue;
    }

    // Separadores horizontales
    if (/^---+$/.test(line)) {
      html += '<hr>\n';
      continue;
    }

    // Líneas de artículo con semáforo (ej: "1. Título — Semáforo: Alto")
    if (/^N?°?\s*\d+[\.\)]\s/.test(line) || /^•\s/.test(line)) {
      html += `<p>${badgeSemaforo(escapeHtml(line))}</p>\n`;
      continue;
    }

    // Fuente (líneas que comienzan con "(Fuente:")
    if (/^\(Fuente:/i.test(line)) {
      html += `<p class="fuente">${escapeHtml(line)}</p>\n`;
      continue;
    }

    // Resto del contenido como párrafo normal (con badge de semáforo si corresponde)
    html += `<p>${badgeSemaforo(escapeHtml(line))}</p>\n`;
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
async function sendDigest(summaryText) {
  const today = formatDate(new Date());

  // Convertir el texto a HTML con estilos de email
  const bodyHtml = convertToHtml(summaryText);

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
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: false, // false para STARTTLS en puerto 587
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const mailOptions = {
    from:    `"Resumen Noticias" <${process.env.SMTP_USER}>`,
    to:      process.env.DIGEST_RECIPIENT,
    subject: `📰 Resumen Noticias — ${today}`,
    html:    htmlEmail,
    // Versión texto plano como fallback para clientes que no soportan HTML
    text:    summaryText,
  };

  await transporter.sendMail(mailOptions);
  log('INFO', `Email enviado a ${process.env.DIGEST_RECIPIENT} con asunto: "${mailOptions.subject}"`);
}

module.exports = { sendDigest };
