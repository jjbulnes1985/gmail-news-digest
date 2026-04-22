'use strict';

/**
 * summarizer.js — Genera el resumen de noticias usando Groq (Llama 3.3 70B)
 */

const Groq = require('groq-sdk');
const { log } = require('./utils');

const SYSTEM_PROMPT = `Eres un analista de noticias y mercados especializado en inversionistas de Latinoamérica.
Tu tarea es procesar una lista de correos del label "noticias" y generar un informe diario.
Reglas:
- No inventes información. Si algo no está claro, márcalo explícitamente con [DATO NO CONFIRMADO].
- Detecta riesgos antes de mencionar fortalezas.
- Tono institucional, profesional y objetivo.
- No omitas ninguna noticia aunque sea breve.`;

/**
 * Genera el informe de noticias a partir de un array de emails.
 * Hace UNA sola llamada a la API de Groq con todos los emails concatenados.
 *
 * @param {Array<{subject: string, from: string, date: string, body: string}>} emails
 * @returns {Promise<string>} Texto del informe generado por Groq
 */
async function summarize(emails) {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const today = new Date().toLocaleDateString('es-AR', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });

  let userPrompt = `Fecha de análisis: ${today}\n\n`;
  userPrompt += `A continuación se presentan ${emails.length} correo(s) del label "noticias":\n\n`;

  const MAX_BODY_CHARS = 3000;
  emails.forEach((email, i) => {
    const body = email.body.length > MAX_BODY_CHARS
      ? email.body.slice(0, MAX_BODY_CHARS) + '\n[...contenido truncado...]'
      : email.body;
    userPrompt += `--- EMAIL ${i + 1} ---\n`;
    userPrompt += `Asunto: ${email.subject}\n`;
    userPrompt += `De: ${email.from}\n`;
    userPrompt += `Fecha: ${email.date}\n`;
    userPrompt += `Contenido:\n${body}\n\n`;
  });

  userPrompt += `--- FIN DE CORREOS ---\n\n`;
  userPrompt += `Genera un informe con este formato exacto:\n\n`;

  userPrompt += `ÍNDICE\n`;
  userPrompt += `Agrupa las noticias por temática (Política / Economía & Finanzas / Internacional / `;
  userPrompt += `Empresas & Negocios / Tecnología / Energía & Minería / Sociedad / Deportes).\n`;
  userPrompt += `Para cada noticia: número, título, temática, semáforo (Alto/Medio/Bajo).\n\n`;

  userPrompt += `CUERPO\n`;
  userPrompt += `Para cada noticia:\n`;
  userPrompt += `N°. [Título] — Semáforo: [Alto/Medio/Bajo]\n`;
  userPrompt += `Resumen de 4-5 líneas continuas que incluya: actores clave, hecho principal, `;
  userPrompt += `contexto y consecuencias para mercados o inversiones en LatAm.\n`;
  userPrompt += `(Fuente: {subject} — {from} — {date})\n\n`;

  userPrompt += `Al final, incluir una sección "ALERTAS DEL DÍA" con máximo 3 puntos `;
  userPrompt += `sobre los riesgos o movimientos más relevantes del informe.`;

  log('INFO', `Enviando ${emails.length} email(s) a Groq para generar el resumen...`);

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2 * 60 * 1000;

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userPrompt },
        ],
        max_tokens: 32768,
      });

      const text = completion.choices[0]?.message?.content;
      if (!text) throw new Error('Groq devolvió una respuesta vacía.');

      log('INFO', 'Resumen generado por Groq.');
      return text;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        log('WARN', `Intento ${attempt}/${MAX_RETRIES} fallido: ${err.message}. Reintentando en ${RETRY_DELAY_MS / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  throw lastError;
}

module.exports = { summarize };
