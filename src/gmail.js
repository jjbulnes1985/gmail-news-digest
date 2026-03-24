'use strict';

/**
 * gmail.js — Autenticación OAuth2 con Gmail y lectura de emails del label configurado
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const { google } = require('googleapis');
const pdfParse = require('pdf-parse');
const { stripHtml, log, buildAfterEpoch } = require('./utils');

// Permisos de solo lectura (principio de mínimo privilegio)
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

// Rutas relativas al directorio raíz del proyecto (un nivel arriba de src/)
const CREDENTIALS_PATH = path.join(__dirname, '..', 'credentials', 'oauth2.json');
const TOKEN_PATH       = path.join(__dirname, '..', 'tokens', 'token.json');

/**
 * Lee y autentica el cliente OAuth2.
 * Si no existe token.json, lanza el flujo interactivo de autorización.
 * @returns {Promise<google.auth.OAuth2>} Cliente autenticado
 */
async function authorize() {
  // Leer el archivo de credenciales descargado de Google Cloud Console
  let credentials;
  try {
    credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  } catch (err) {
    throw new Error(
      `No se pudo leer ${CREDENTIALS_PATH}. ` +
      'Descargá las credenciales OAuth2 desde Google Cloud Console y guardálas como credentials/oauth2.json'
    );
  }

  // Las credenciales de "Desktop App" vienen bajo la clave "installed"
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  // Escuchar renovaciones de token para mantener token.json actualizado
  oAuth2Client.on('tokens', (tokens) => {
    let existingTokens = {};
    try {
      existingTokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    } catch (_) { /* si no existe, se crea desde cero */ }

    const updatedTokens = { ...existingTokens, ...tokens };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(updatedTokens, null, 2));
    log('INFO', 'Token OAuth2 actualizado automáticamente.');
  });

  // Intentar cargar el token guardado
  try {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    oAuth2Client.setCredentials(token);
    log('INFO', 'Token OAuth2 cargado desde archivo.');
  } catch (_) {
    // No existe token.json → iniciar flujo de autorización interactivo
    log('INFO', 'No se encontró token.json. Iniciando flujo de autorización...');
    await getNewToken(oAuth2Client);
  }

  return oAuth2Client;
}

/**
 * Guía al usuario por el flujo de autorización OAuth2 de consola (primera vez).
 * @param {google.auth.OAuth2} oAuth2Client
 */
async function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline', // solicita refresh_token para poder renovar sin interacción
    scope: SCOPES,
  });

  console.log('\n─────────────────────────────────────────────────────');
  console.log('AUTORIZACIÓN REQUERIDA');
  console.log('─────────────────────────────────────────────────────');
  console.log('1. Abrí esta URL en tu navegador:\n');
  console.log('   ' + authUrl);
  console.log('\n2. Autorizá la aplicación con tu cuenta de Gmail.');
  console.log('3. Copiá el código de autorización que aparece.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const code = await new Promise((resolve) => {
    rl.question('Pegá el código de autorización aquí: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);

  // Crear directorio tokens/ si no existe y guardar el token
  fs.mkdirSync(path.join(__dirname, '..', 'tokens'), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  log('INFO', `Token guardado en ${TOKEN_PATH}`);
}

/**
 * Decodifica una cadena en formato base64url (usado por la API de Gmail).
 * Difiere del base64 estándar: usa '-' en lugar de '+' y '_' en lugar de '/'.
 * @param {string} data - Cadena en base64url
 * @returns {string} Texto decodificado en UTF-8
 */
function decodeBase64Url(data) {
  return Buffer.from(
    data.replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  ).toString('utf-8');
}

/**
 * Extrae el cuerpo de texto de un payload de Gmail (recursivo para mensajes multipart).
 * Prioriza text/plain; cae a text/html si es el único disponible.
 * @param {object} payload - payload del mensaje de Gmail
 * @returns {string} Texto plano del cuerpo del email
 */
function parseBody(payload) {
  if (!payload) return '';

  // Caso 1: el payload tiene partes (mensaje multipart)
  if (payload.parts && payload.parts.length > 0) {
    let plainText = '';
    let htmlText  = '';

    for (const part of payload.parts) {
      const mimeType = (part.mimeType || '').toLowerCase();

      if (mimeType === 'text/plain' && part.body && part.body.data) {
        // Preferimos text/plain
        plainText = decodeBase64Url(part.body.data);
      } else if (mimeType === 'text/html' && part.body && part.body.data) {
        // Guardamos HTML como fallback
        htmlText = decodeBase64Url(part.body.data);
      } else if (mimeType.startsWith('multipart/')) {
        // Recursión para multipart anidados (ej: multipart/mixed que contiene multipart/alternative)
        const nested = parseBody(part);
        if (nested) plainText = plainText || nested;
      }
    }

    if (plainText) return plainText;
    if (htmlText)  return stripHtml(htmlText);
    return '';
  }

  // Caso 2: el payload es una parte simple
  if (payload.body && payload.body.data) {
    const mimeType = (payload.mimeType || '').toLowerCase();
    const decoded  = decodeBase64Url(payload.body.data);

    if (mimeType === 'text/html') return stripHtml(decoded);
    return decoded; // text/plain u otro tipo
  }

  return '';
}

/**
 * Extrae adjuntos PDF de un payload de Gmail y devuelve su texto concatenado.
 * @param {object} gmail - Cliente de Gmail
 * @param {string} messageId - ID del mensaje
 * @param {object} payload - payload del mensaje
 * @returns {Promise<string>} Texto extraído de los PDFs
 */
async function extractPdfAttachments(gmail, messageId, payload) {
  const pdfTexts = [];

  async function processParts(parts) {
    if (!parts) return;
    for (const part of parts) {
      const mimeType = (part.mimeType || '').toLowerCase();

      if (mimeType === 'application/pdf' && part.body) {
        try {
          let data = part.body.data;

          // Si el PDF está en un attachment separado, descargarlo
          if (!data && part.body.attachmentId) {
            const attachment = await gmail.users.messages.attachments.get({
              userId: 'me',
              messageId,
              id: part.body.attachmentId,
            });
            data = attachment.data.data;
          }

          if (data) {
            const buffer = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
            const parsed = await pdfParse(buffer);
            if (parsed.text && parsed.text.trim()) {
              const filename = part.filename || 'adjunto.pdf';
              pdfTexts.push(`[PDF: ${filename}]\n${parsed.text.trim()}`);
              log('INFO', `PDF procesado: ${filename}`);
            }
          }
        } catch (err) {
          log('WARN', `No se pudo leer PDF adjunto: ${err.message}`);
        }
      } else if (part.parts) {
        await processParts(part.parts);
      }
    }
  }

  await processParts(payload.parts);
  return pdfTexts.join('\n\n');
}

/**
 * Lee los emails del label configurado en Gmail.
 * @param {google.auth.OAuth2} auth - Cliente OAuth2 autenticado
 * @returns {Promise<Array<{subject, from, date, body}>>} Lista de emails
 */
async function getEmails(auth) {
  const gmail = google.gmail({ version: 'v1', auth });

  const gmailLabel   = process.env.GMAIL_LABEL    || 'noticias';
  const hoursBack    = parseInt(process.env.HOURS_LOOKBACK, 10) || 24;
  const maxResults   = parseInt(process.env.MAX_EMAILS_PER_RUN, 10) || 30;
  const afterEpoch   = buildAfterEpoch(hoursBack);

  const query = `label:${gmailLabel} after:${afterEpoch}`;
  log('INFO', `Buscando emails con query: "${query}" (máx. ${maxResults})`);

  // Listar IDs de mensajes que coinciden con la búsqueda
  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
  });

  const messages = listResponse.data.messages;
  if (!messages || messages.length === 0) {
    return [];
  }

  log('INFO', `${messages.length} mensaje(s) encontrado(s). Descargando contenido...`);

  // Descargar el contenido completo de cada mensaje
  const emails = [];
  for (const msg of messages) {
    try {
      const msgResponse = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });

      const payload = msgResponse.data.payload;
      const headers = payload.headers || [];

      // Extraer encabezados relevantes (insensible a mayúsculas)
      const getHeader = (name) => {
        const h = headers.find(
          (h) => h.name.toLowerCase() === name.toLowerCase()
        );
        return h ? h.value : '';
      };

      const subject = getHeader('Subject') || '(Sin asunto)';
      const from    = getHeader('From')    || '(Desconocido)';
      const date    = getHeader('Date')    || '';

      // Extraer cuerpo del mensaje
      let body = parseBody(payload);

      // Extraer texto de adjuntos PDF (si los hay)
      const pdfText = await extractPdfAttachments(gmail, msg.id, payload);
      if (pdfText) {
        body = body ? `${body}\n\n${pdfText}` : pdfText;
      }

      emails.push({ subject, from, date, body });
    } catch (err) {
      log('WARN', `No se pudo leer el mensaje ${msg.id}: ${err.message}`);
    }
  }

  return emails;
}

module.exports = { authorize, getEmails };
