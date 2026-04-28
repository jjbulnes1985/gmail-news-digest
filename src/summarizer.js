'use strict';

/**
 * summarizer.js — Genera el resumen de noticias usando Gemini (con fallback automático de modelos)
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { log } = require('./utils');

const SYSTEM_PROMPT = `Eres un analista de noticias y mercados especializado en inversionistas de Latinoamérica.
Tu tarea es procesar una lista de correos del label "noticias" y generar un informe diario.
Reglas:
- No inventes información. Si algo no está claro, márcalo explícitamente con [DATO NO CONFIRMADO].
- Detecta riesgos antes de mencionar fortalezas.
- Tono institucional, profesional y objetivo.
- No omitas ninguna noticia aunque sea breve.`;

// Modelos en orden de preferencia. Si el primero falla, se intenta el siguiente.
const MODEL_FALLBACKS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
];

const RETRY_DELAY_MS = 30 * 1000; // 30 segundos entre reintentos del mismo modelo

/**
 * Genera el informe de noticias a partir de un array de emails.
 * Intenta cada modelo de MODEL_FALLBACKS en orden hasta que uno funcione.
 *
 * @param {Array<{subject: string, from: string, date: string, body: string}>} emails
 * @returns {Promise<string>} Texto del informe generado por Gemini
 */
async function summarize(emails) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  const today = new Date().toLocaleDateString('es-AR', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });

  let userPrompt = `Fecha de análisis: ${today}\n\n`;
  userPrompt += `A continuación se presentan ${emails.length} correo(s) del label "noticias":\n\n`;

  emails.forEach((email, i) => {
    userPrompt += `--- EMAIL ${i + 1} ---\n`;
    userPrompt += `Asunto: ${email.subject}\n`;
    userPrompt += `De: ${email.from}\n`;
    userPrompt += `Fecha: ${email.date}\n`;
    userPrompt += `Contenido:\n${email.body}\n\n`;
  });

  userPrompt += `--- FIN DE CORREOS ---\n\n`;
  userPrompt += `Genera un informe con este formato exacto:\n\n`;

  userPrompt += `ÍNDICE\n`;
  userPrompt += `Agrupa las noticias por temática (Política / Economía & Finanzas / Internacional / `;
  userPrompt += `Empresas & Negocios / Tecnología / Energía & Minería / Sociedad / Deportes).\n`;
  userPrompt += `IMPORTANTE: usa numeración CONTINUA para todas las noticias de todas las secciones. `;
  userPrompt += `NO reinicies el número al cambiar de sección. Ejemplo: si Política termina en 11, `;
  userPrompt += `Economía & Finanzas empieza en 12.\n`;
  userPrompt += `Para cada noticia: número, título, temática, semáforo (Alto/Medio/Bajo).\n\n`;

  userPrompt += `CUERPO\n`;
  userPrompt += `Para cada noticia, usando el MISMO número continuo del ÍNDICE:\n`;
  userPrompt += `N°. [Título] — Semáforo: [Alto/Medio/Bajo]\n`;
  userPrompt += `Resumen de 4-5 líneas continuas que incluya: actores clave, hecho principal, `;
  userPrompt += `contexto y consecuencias para mercados o inversiones en LatAm.\n`;
  userPrompt += `(Fuente: {subject} — {from} — {date})\n\n`;

  userPrompt += `Al final, incluir una sección "ALERTAS DEL DÍA" con máximo 3 puntos `;
  userPrompt += `sobre los riesgos o movimientos más relevantes del informe.`;

  log('INFO', `Enviando ${emails.length} email(s) a Gemini para generar el resumen...`);

  let lastError;

  for (const modelName of MODEL_FALLBACKS) {
    log('INFO', `Intentando con modelo: ${modelName}`);

    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: { maxOutputTokens: 65536 },
    });

    // 2 intentos por modelo con 30s de espera entre ellos
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await model.generateContent(userPrompt);
        const text = result.response.text();

        if (!text) throw new Error('Gemini devolvió una respuesta vacía.');

        log('INFO', `Resumen generado con ${modelName}.`);
        return text;
      } catch (err) {
        lastError = err;
        const isQuotaError = err.message.includes('limit: 0');
        if (isQuotaError) {
          log('WARN', `${modelName} sin cuota disponible. Saltando al siguiente modelo...`);
          break; // no reintentar si no hay cuota, pasar al siguiente modelo
        }
        if (attempt < 2) {
          log('WARN', `${modelName} intento ${attempt}/2 fallido: ${err.message}. Reintentando en ${RETRY_DELAY_MS / 1000}s...`);
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        } else {
          log('WARN', `${modelName} agotó sus intentos. Saltando al siguiente modelo...`);
        }
      }
    }
  }

  throw lastError;
}

module.exports = { summarize };
