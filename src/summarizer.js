'use strict';

/**
 * summarizer.js — Genera el resumen de noticias usando Gemini (con fallback automático de modelos)
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { log } = require('./utils');

const SYSTEM_PROMPT = `Eres un analista de noticias y mercados para inversionistas de Latinoamérica.
Reglas:
- No inventes información. Si algo no está claro, márcalo con [DATO NO CONFIRMADO].
- Detecta riesgos antes de fortalezas.
- Tono institucional, profesional, objetivo.
- No omitas ninguna noticia, aunque sea breve.`;

const MODEL_FALLBACKS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
];

const RETRY_DELAY_MS = 30 * 1000;
const MAX_BODY_CHARS = 6000; // cap por email para evitar tokens excesivos en PDFs largos
const MAX_OUTPUT_TOKENS = 24576; // margen extra por el mayor detalle en noticias Alto/Medio

/**
 * Trunca el cuerpo si excede MAX_BODY_CHARS, dejando marca visible.
 */
function truncateBody(body) {
  if (!body || body.length <= MAX_BODY_CHARS) return body || '';
  return body.slice(0, MAX_BODY_CHARS) + `\n[...truncado ${body.length - MAX_BODY_CHARS} caracteres]`;
}

/**
 * Construye el prompt del usuario a partir de los emails.
 */
function buildUserPrompt(emails) {
  const today = new Date().toLocaleDateString('es-AR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const emailsBlock = emails.map((e, i) => (
    `--- EMAIL ${i + 1} ---\n` +
    `Asunto: ${e.subject}\n` +
    `De: ${e.from}\n` +
    `Fecha: ${e.date}\n` +
    `Contenido:\n${truncateBody(e.body)}\n`
  )).join('\n');

  return `Fecha: ${today}
Procesa los siguientes ${emails.length} correos y genera un informe con el formato exacto indicado abajo.

${emailsBlock}
--- FIN DE CORREOS ---

FORMATO DE SALIDA:

ÍNDICE
Agrupa las noticias por temática en este orden: Política / Economía & Finanzas / Internacional / Empresas & Negocios / Tecnología / Energía & Minería / Sociedad / Deportes.
IMPORTANTE: numeración CONTINUA a lo largo de todo el índice (no reiniciar por sección). Ej: si Política termina en 11, Economía empieza en 12.
Formato por noticia: "N. [Título] — [Temática] — Semáforo: [Alto/Medio/Bajo]"

CUERPO
Para cada noticia, usando el MISMO número del ÍNDICE:
N. [Título] — Semáforo: [Alto/Medio/Bajo]
- Si Semáforo es Alto o Medio: desarrolla 7-9 líneas continuas, profundizando en actores clave, hecho principal, contexto (antecedentes relevantes), cifras o datos concretos si están disponibles, y un análisis más detallado de las consecuencias para mercados o inversiones en LatAm (impacto sectorial, riesgo/oportunidad, plazo esperado).
- Si Semáforo es Bajo: resumen breve de 3-4 líneas con lo esencial (actores, hecho, contexto mínimo).
(Fuente: {subject} — {from} — {date})

ALERTAS DEL DÍA
Máximo 3 puntos con los riesgos o movimientos más relevantes.`;
}

/**
 * Genera el informe de noticias. Intenta cada modelo de MODEL_FALLBACKS en orden.
 *
 * @param {Array<{subject: string, from: string, date: string, body: string}>} emails
 * @returns {Promise<string>} Texto del informe generado por Gemini
 */
async function summarize(emails) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const userPrompt = buildUserPrompt(emails);

  log('INFO', `Enviando ${emails.length} email(s) a Gemini para generar el resumen...`);

  let lastError;
  for (const modelName of MODEL_FALLBACKS) {
    log('INFO', `Intentando con modelo: ${modelName}`);
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    });

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await model.generateContent(userPrompt);
        const text = result.response.text();
        if (!text) throw new Error('Gemini devolvió una respuesta vacía.');
        log('INFO', `Resumen generado con ${modelName}.`);
        return text;
      } catch (err) {
        lastError = err;
        if (err.message.includes('limit: 0')) {
          log('WARN', `${modelName} sin cuota disponible. Saltando al siguiente modelo...`);
          break;
        }
        if (attempt < 2) {
          log('WARN', `${modelName} intento ${attempt}/2 fallido: ${err.message}. Reintentando en ${RETRY_DELAY_MS / 1000}s...`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        } else {
          log('WARN', `${modelName} agotó sus intentos. Saltando al siguiente modelo...`);
        }
      }
    }
  }

  throw lastError;
}

module.exports = { summarize };
