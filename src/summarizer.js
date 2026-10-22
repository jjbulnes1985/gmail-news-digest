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
];
// gemini-2.5-pro se retiró del fallback: la API respondió (21-10-2026) que ya no está
// disponible para esta cuenta. Ante errores 503 por alta demanda, en vez de un tercer
// modelo se hace una segunda vuelta completa tras una pausa más larga.
const ROUNDS = 2;
const ROUND_PAUSE_MS = 90 * 1000;

const RETRY_DELAY_MS = 30 * 1000;
// Límites de ENTRADA. Antes era 6.000 caracteres por correo: el 22-10-2026, 5 de 12
// correos (El Mercurio, El Líbero, CoStar, Bloomberg Línea, Criteria) superaban ese
// tope y cerca del 60% de su texto no llegaba a Gemini, por eso faltaban noticias.
const MAX_BODY_CHARS  = 30000;  // tope por correo (incluye el texto de PDFs adjuntos)
const MAX_TOTAL_CHARS = 400000; // tope total del bloque de correos (~100-130 mil tokens)
const MAX_OUTPUT_TOKENS = 65536; // máximo de Gemini 2.5; el "thinking" también consume de este total
const THINKING_BUDGET = 2048;    // acota el razonamiento interno para que no se coma la salida

/**
 * Trunca el cuerpo si excede MAX_BODY_CHARS, dejando marca visible.
 */
function truncateBody(body, limit = MAX_BODY_CHARS) {
  if (!body || body.length <= limit) return body || '';
  return body.slice(0, limit) + `\n[...truncado ${body.length - limit} caracteres]`;
}

/**
 * Tope por correo para este lote: MAX_BODY_CHARS, o menos si la suma excede MAX_TOTAL_CHARS.
 */
function perEmailLimit(emails) {
  const total = emails.reduce((acc, e) => acc + (e.body ? e.body.length : 0), 0);
  if (total <= MAX_TOTAL_CHARS) return MAX_BODY_CHARS;
  return Math.max(6000, Math.min(MAX_BODY_CHARS, Math.floor(MAX_TOTAL_CHARS / Math.max(1, emails.length))));
}

/**
 * Construye el prompt del usuario a partir de los emails.
 */
function buildUserPrompt(emails) {
  const today = new Date().toLocaleDateString('es-CL', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Santiago', // el runner corre en UTC
  });

  const limit = perEmailLimit(emails);
  const truncated = emails.filter((e) => e.body && e.body.length > limit).length;
  log('INFO', `Tope por correo: ${limit} caracteres; ${truncated} de ${emails.length} correo(s) recortado(s).`);

  const emailsBlock = emails.map((e, i) => (
    `--- EMAIL ${i + 1} ---\n` +
    `Asunto: ${e.subject}\n` +
    `De: ${e.from}\n` +
    `Fecha: ${e.date}\n` +
    `Contenido:\n${truncateBody(e.body, limit)}\n`
  )).join('\n');

  return `Fecha: ${today}
Procesa los siguientes ${emails.length} correos y genera un informe con el formato exacto indicado abajo.

${emailsBlock}
--- FIN DE CORREOS ---

FORMATO DE SALIDA (texto plano: sin asteriscos, almohadillas ni otro formato markdown; cada noticia empieza en su propia línea con "N."):

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
  for (let round = 1; round <= ROUNDS; round++) {
    if (round > 1) {
      log('WARN', `Vuelta ${round - 1} sin éxito. Esperando ${ROUND_PAUSE_MS / 1000}s antes de la vuelta ${round}/${ROUNDS}...`);
      await new Promise((r) => setTimeout(r, ROUND_PAUSE_MS));
    }
    for (const modelName of MODEL_FALLBACKS) {
      log('INFO', `Intentando con modelo: ${modelName} (vuelta ${round}/${ROUNDS})`);
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          thinkingConfig: { thinkingBudget: THINKING_BUDGET },
        },
      });

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const result = await model.generateContent(userPrompt);
          const text = result.response.text();
          if (!text) throw new Error('Gemini devolvió una respuesta vacía.');

          // Gemini corta en silencio al llegar al límite de tokens: text() devuelve el
          // fragmento sin error. Un informe cortado no se envía; se prueba otro modelo.
          const finishReason = result.response.candidates?.[0]?.finishReason;
          if (finishReason && finishReason !== 'STOP') {
            throw new Error(`respuesta incompleta (finishReason=${finishReason}, ${text.length} caracteres)`);
          }
          if (!/ALERTAS DEL D[IÍ]A/i.test(text)) {
            throw new Error('respuesta incompleta (falta la sección ALERTAS DEL DÍA)');
          }

          log('INFO', `Resumen generado con ${modelName} (${text.length} caracteres).`);
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
  }

  throw lastError;
}

module.exports = { summarize };
