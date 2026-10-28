'use strict';

/**
 * summarizer.js — Genera el resumen de noticias usando Gemini (con fallback automático de modelos)
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { log } = require('./utils');
const { isUnavailable, discoverModel, recordChange } = require('./models');
const { normalizeNumbering, resolveLinks, segmentReport } = require('./report');

const SYSTEM_PROMPT = `Eres un analista de noticias y mercados para inversionistas de Latinoamérica.
Reglas:
- No inventes información. Si algo no está claro, márcalo con [DATO NO CONFIRMADO].
- Detecta riesgos antes de fortalezas.
- Tono institucional, profesional, objetivo.
- No omitas ninguna noticia, aunque sea breve.`;

// Lista preferida. Si un modelo deja de estar disponible (404 o retirado) se descarta;
// si se descartan todos, se elige un reemplazo vía /v1beta/models (src/models.js).
const MODEL_FALLBACKS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];
// gemini-2.5-pro se retiró del fallback: la API respondió (21-10-2026) que ya no está
// disponible para esta cuenta. Ante errores 503 por alta demanda, en vez de un tercer
// modelo se hace una segunda vuelta completa tras una pausa más larga.
const ROUNDS = 2;
const ROUND_PAUSE_MS = parseInt(process.env.SUMMARY_ROUND_PAUSE_MS, 10) || 90 * 1000;

const RETRY_DELAY_MS = parseInt(process.env.SUMMARY_RETRY_DELAY_MS, 10) || 30 * 1000;
// Límites de ENTRADA. Antes era 6.000 caracteres por correo: el 22-10-2026, 5 de 12
// correos (El Mercurio, El Líbero, CoStar, Bloomberg Línea, Criteria) superaban ese
// tope y cerca del 60% de su texto no llegaba a Gemini, por eso faltaban noticias.
const MAX_BODY_CHARS  = 30000;  // tope por correo (incluye el texto de PDFs adjuntos)
const MAX_TOTAL_CHARS = 400000; // tope total del bloque de correos (~100-130 mil tokens)
const MAX_OUTPUT_TOKENS = 65536; // máximo de Gemini 2.5; el "thinking" también consume de este total
const THINKING_BUDGET = 2048;    // acota el razonamiento interno para que no se coma la salida
const MAX_TOTAL_LINKS = 1500;    // tope de enlaces listados a Gemini (todos los correos)

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
 * Lista de enlaces de cada correo con IDs cortos (L1, L2, ...). Gemini responde con el
 * ID y no con la URL: las URL de los boletines son largas y un modelo puede alterarlas.
 * @returns {{blocks: string[], linkMap: Map<string,string>}}
 */
function buildLinkCatalog(emails) {
  const perEmail = Math.max(10, Math.min(80, Math.floor(MAX_TOTAL_LINKS / Math.max(1, emails.length))));
  const linkMap = new Map();
  const blocks = emails.map((e) => {
    const links = (e.links || []).slice(0, perEmail);
    if (!links.length) return '';
    const rows = links.map((l) => {
      const id = `L${linkMap.size + 1}`;
      linkMap.set(id, l.url);
      return `[${id}] ${l.text}`;
    });
    return `Enlaces del correo (titular o texto del enlace; usa solo el ID):\n${rows.join('\n')}\n`;
  });
  return { blocks, linkMap };
}

/**
 * Construye el prompt del usuario a partir de los emails.
 * @returns {{prompt: string, linkMap: Map<string,string>}}
 */
function buildUserPrompt(emails) {
  const today = new Date().toLocaleDateString('es-CL', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Santiago', // el runner corre en UTC
  });

  const limit = perEmailLimit(emails);
  const truncated = emails.filter((e) => e.body && e.body.length > limit).length;
  log('INFO', `Tope por correo: ${limit} caracteres; ${truncated} de ${emails.length} correo(s) recortado(s).`);

  const { blocks, linkMap } = buildLinkCatalog(emails);
  log('INFO', `Enlaces listados a Gemini: ${linkMap.size}.`);

  const emailsBlock = emails.map((e, i) => (
    `--- EMAIL ${i + 1} ---\n` +
    `Asunto: ${e.subject}\n` +
    `De: ${e.from}\n` +
    `Fecha: ${e.date}\n` +
    `Contenido:\n${truncateBody(e.body, limit)}\n` +
    blocks[i]
  )).join('\n');

  const prompt = `Fecha: ${today}
Procesa los siguientes ${emails.length} correos y genera un informe con el formato exacto indicado abajo.

${emailsBlock}
--- FIN DE CORREOS ---

FORMATO DE SALIDA (texto plano: sin asteriscos, almohadillas ni otro formato markdown; cada noticia empieza en su propia línea con su número arábigo seguido de punto: "1.", "2.", "3."... Nunca escribas la letra "N" en lugar del número).

ÍNDICE
Clasifica cada noticia con un ÁMBITO y una TEMÁTICA, usando solo estos valores exactos:
- Ámbito: Chile / América Latina / Internacional. "América Latina" es la región sin Chile; "Internacional" es el resto del mundo, incluido EE.UU. Una noticia de otro país con efecto directo en Chile sigue siendo de su país de origen.
- Temática: Política / Economía y Finanzas / Empresas y Negocios / Energía y Minería / Tecnología / Sociedad / Deportes.
Ordena por ámbito (Chile, América Latina, Internacional), dentro de cada ámbito por temática en el orden de la lista, y dentro de cada temática Alto, Medio y luego Bajo.
IMPORTANTE: numeración CONTINUA a lo largo de todo el índice (no reiniciar por sección).
Formato por noticia: "[número]. [Título] — [Ámbito] — [Temática] — Semáforo: [Alto/Medio/Bajo]"
Ejemplo: "12. Banco Central mantiene la tasa en 4,75% — Chile — Economía y Finanzas — Semáforo: Medio"

CUERPO
Para cada noticia, usando el MISMO número del ÍNDICE:
[número]. [Título] — Semáforo: [Alto/Medio/Bajo]   (mismo número y mismo título que en el ÍNDICE)
- Si Semáforo es Alto o Medio: desarrolla 7-9 líneas continuas, profundizando en actores clave, hecho principal, contexto (antecedentes relevantes), cifras o datos concretos si están disponibles, y un análisis más detallado de las consecuencias para mercados o inversiones en LatAm (impacto sectorial, riesgo/oportunidad, plazo esperado).
- Si Semáforo es Bajo: 4-5 líneas con lo esencial (actores, hecho) y una línea adicional de contexto: un antecedente o la implicancia para inversionistas en LatAm, sin repetir el título.
(Fuente: {subject} — {from} — {date} — Enlace: [ID])
  En "Enlace" va el ID (por ejemplo L27) del enlace de ESA noticia, tomado de la lista "Enlaces del correo" del mismo correo de origen. Aplica a TODAS las noticias, también las de semáforo Bajo. Los PDF adjuntos (por ejemplo Valor Diario) también traen su lista de enlaces por titular: úsala. Si ningún enlace corresponde claramente a esa noticia, escribe "Enlace: ninguno". Nunca escribas URL ni inventes IDs.

ALERTAS DEL DÍA
Máximo 3 puntos con los riesgos o movimientos más relevantes, numerados "1.", "2.", "3.".`;

  return { prompt, linkMap };
}

/**
 * Ajustes deterministas al informe: números en vez de marcadores "N." y URL reales
 * en vez de los IDs de enlace.
 */
function postProcess(text, linkMap) {
  const num = normalizeNumbering(text);
  if (num.fixed) log('WARN', `El informe traía marcadores en vez de números: ${num.fixed} línea(s) renumerada(s).`);
  const seg = segmentReport(num.text);
  log('INFO', `Segmentación: ${Object.entries(seg.counts).map(([k, v]) => `${k} ${v}`).join('; ') || 'sin cambios'}${seg.changed ? ' (reordenado y renumerado)' : ''}.`);
  if (seg.defaults) log('WARN', `${seg.defaults} noticia(s) sin ámbito o temática válidos; se asignaron ${'Internacional'} / ${'Sociedad'}.`);
  if (seg.bodyOnly || seg.indexOnly) log('WARN', `Descalce índice-cuerpo: ${seg.bodyOnly} noticia(s) solo en el cuerpo, ${seg.indexOnly} solo en el índice.`);
  const links = resolveLinks(seg.text, linkMap);
  log('INFO', `Enlaces a la noticia original: ${links.resolved}${links.dropped ? ` (${links.dropped} ID(s) inexistente(s) descartado(s))` : ''}.`);
  return links.text;
}

/**
 * Genera el informe de noticias. Intenta cada modelo de MODEL_FALLBACKS en orden.
 *
 * @param {Array<{subject: string, from: string, date: string, body: string}>} emails
 * @returns {Promise<string>} Texto del informe generado por Gemini
 */
async function summarize(emails) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const { prompt: userPrompt, linkMap } = buildUserPrompt(emails);

  log('INFO', `Enviando ${emails.length} email(s) a Gemini para generar el resumen...`);

  let lastError;
  const models = [...MODEL_FALLBACKS];
  const unavailable = new Set();
  let discovered = false;
  for (let round = 1; round <= ROUNDS; round++) {
    if (round > 1) {
      log('WARN', `Vuelta ${round - 1} sin éxito. Esperando ${ROUND_PAUSE_MS / 1000}s antes de la vuelta ${round}/${ROUNDS}...`);
      await new Promise((r) => setTimeout(r, ROUND_PAUSE_MS));
    }
    for (let idx = 0; idx < models.length; idx++) {
      const modelName = models[idx];
      if (unavailable.has(modelName)) continue;
      log('INFO', `Intentando con modelo: ${modelName} (vuelta ${round}/${ROUNDS})`);
      const generationConfig = { maxOutputTokens: MAX_OUTPUT_TOKENS };
      // thinkingBudget es propio de la familia 2.5; un modelo de reemplazo más nuevo
      // podría rechazarlo, por eso solo se envía a los 2.5.
      if (/^gemini-2\.5/.test(modelName)) generationConfig.thinkingConfig = { thinkingBudget: THINKING_BUDGET };
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: SYSTEM_PROMPT,
        generationConfig,
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
          return postProcess(text, linkMap);
        } catch (err) {
          lastError = err;
          // Modelo retirado o inexistente: se descarta sin reintentar. Si ya no queda
          // ninguno preferido, se descubre un reemplazo (una vez por corrida).
          if (isUnavailable(err)) {
            unavailable.add(modelName);
            log('WARN', `${modelName} no está disponible (${err.message.slice(0, 160)}). Se descarta.`);
            if (!discovered && models.every((m) => unavailable.has(m))) {
              discovered = true;
              const alt = await discoverModel('text', [...unavailable]);
              if (alt) { models.push(alt); recordChange('texto', alt, MODEL_FALLBACKS); }
            }
            break;
          }
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

module.exports = { summarize, buildUserPrompt, postProcess };
