'use strict';

/**
 * summarizer.js — Genera el resumen de noticias usando la API de Claude (Anthropic)
 */

const Anthropic = require('@anthropic-ai/sdk');
const { log } = require('./utils');

// Prompt de sistema: define el rol y las reglas del analista
const SYSTEM_PROMPT = `Eres un analista de noticias y mercados especializado en inversionistas de Latinoamérica.
Tu tarea es procesar una lista de correos del label "noticias" y generar un informe diario.
Reglas:
- No inventes información. Si algo no está claro, márcalo explícitamente con [DATO NO CONFIRMADO].
- Detecta riesgos antes de mencionar fortalezas.
- Tono institucional, profesional y objetivo.
- No omitas ninguna noticia aunque sea breve.`;

/**
 * Genera el informe de noticias a partir de un array de emails.
 * Hace UNA sola llamada a la API de Claude con todos los emails concatenados.
 *
 * @param {Array<{subject: string, from: string, date: string, body: string}>} emails
 * @returns {Promise<string>} Texto del informe generado por Claude
 */
async function summarize(emails) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Fecha de análisis en formato legible en español
  const today = new Date().toLocaleDateString('es-AR', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });

  // Construir el prompt de usuario con todos los emails
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

  // Instrucciones de formato del informe
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

  log('INFO', `Enviando ${emails.length} email(s) a Claude para generar el resumen...`);

  // Llamada a la API de Claude
  const message = await client.messages.create({
    model:      'claude-opus-4-5',
    max_tokens: 4000,
    system:     SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: userPrompt },
    ],
  });

  // Verificar que la respuesta contiene texto
  if (!message.content || message.content.length === 0) {
    throw new Error('La API de Claude devolvió una respuesta vacía.');
  }

  const firstBlock = message.content[0];
  if (firstBlock.type !== 'text') {
    throw new Error(`Tipo de respuesta inesperado de Claude: ${firstBlock.type}`);
  }

  log('INFO', `Resumen generado. Tokens usados — entrada: ${message.usage.input_tokens}, salida: ${message.usage.output_tokens}`);

  return firstBlock.text;
}

module.exports = { summarize };
