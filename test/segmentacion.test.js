'use strict';

// Pruebas: segmentación por ámbito y temática, enlaces de PDF, correo, audio y prompt.
// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { segmentReport, parseHead, resolveLinks, cleanLinks } = require('../src/report');
const { convertToHtml } = require('../src/mailer');
const { buildSections } = require('../src/audio');
const { extractPdfLinks } = require('../src/pdf-links');
const { buildUserPrompt } = require('../src/summarizer');

// Informe desordenado como los que Gemini entregó el 27-10-2026 (temáticas intercaladas),
// con un subtítulo suelto, una noticia sin clasificación y otra solo en el cuerpo.
const DESORDENADO = `INFORME DE NOTICIAS Y MERCADOS
Fecha: miércoles, 28 de octubre de 2026

ÍNDICE
1. Petróleo supera US$114 — Internacional — Economía y Finanzas — Semáforo: Alto
2. Senado aprueba reforma — Chile — Política — Semáforo: Medio
3. Colo-Colo gana el clásico — Chile — Deportes — Semáforo: Bajo
4. Banco Central mantiene la tasa — Chile — Economía y Finanzas — Semáforo: Alto
5. Lula anuncia ajuste fiscal — América Latina — Economía & Finanzas — Semáforo: Medio
6. Nueva ley de datos personales — Chile — Tecnología — Semáforo: Bajo
7. Inflación en Argentina baja — América Latina — Economía y Finanzas — Semáforo: Alto
8. Noticia sin clasificar — Semáforo: Bajo

CUERPO
Economía & Finanzas
1. Petróleo supera US$114 — Semáforo: Alto
El Brent superó los US$114.
(Fuente: x — y — z — Enlace: L1)

2. Senado aprueba reforma — Semáforo: Medio
La reforma pasa a tercer trámite.
(Fuente: x — y — z — Enlace: ninguno)

3. Colo-Colo gana el clásico — Semáforo: Bajo
Resultado del fin de semana.
(Fuente: x — y — z — Enlace: L3)

4. Banco Central mantiene la tasa — Semáforo: Alto
La tasa queda en 4,75%.
(Fuente: x — y — z — Enlace: L4)

5. Lula anuncia ajuste fiscal — Semáforo: Medio
Brasil ajusta.
(Fuente: x — y — z — Enlace: L5)

6. Nueva ley de datos personales — Semáforo: Bajo
Entra en vigencia.
(Fuente: x — y — z — Enlace: L6)

7. Inflación en Argentina baja — Semáforo: Alto
El IPC baja.
(Fuente: x — y — z — Enlace: L7)

8. Noticia sin clasificar — Semáforo: Bajo
Sin datos.
(Fuente: x — y — z — Enlace: ninguno)

9. Solo en cuerpo — Chile — Sociedad — Semáforo: Medio
Aparece solo aquí.
(Fuente: x — y — z — Enlace: L9)

ALERTAS DEL DÍA
1. Riesgo uno.
2. Riesgo dos.`;

const ORDEN = [
  ['Chile', 'Política', 'Senado aprueba reforma'],
  ['Chile', 'Economía y Finanzas', 'Banco Central mantiene la tasa'],
  ['Chile', 'Tecnología', 'Nueva ley de datos personales'],
  ['Chile', 'Sociedad', 'Solo en cuerpo'],
  ['Chile', 'Deportes', 'Colo-Colo gana el clásico'],
  ['América Latina', 'Economía y Finanzas', 'Inflación en Argentina baja'],
  ['América Latina', 'Economía y Finanzas', 'Lula anuncia ajuste fiscal'],
  ['Internacional', 'Economía y Finanzas', 'Petróleo supera US$114'],
  ['Internacional', 'Sociedad', 'Noticia sin clasificar'],
];

test('reordena por ámbito, temática y semáforo, y renumera índice y cuerpo igual', () => {
  const r = segmentReport(DESORDENADO);
  assert.ok(r.changed);
  const idx = r.text.slice(r.text.indexOf('ÍNDICE'), r.text.indexOf('CUERPO'));
  const body = r.text.slice(r.text.indexOf('CUERPO'), r.text.indexOf('ALERTAS'));
  ORDEN.forEach(([, , titulo], i) => {
    assert.match(idx, new RegExp(`^${i + 1}\\. ${titulo.replace(/[$]/g, '\\$')} — Semáforo`, 'm'));
    assert.match(body, new RegExp(`^${i + 1}\\. ${titulo.replace(/[$]/g, '\\$')} — Semáforo`, 'm'));
  });
  // Subtítulos de ámbito en orden fijo y una sola vez por sección
  assert.deepStrictEqual([...idx.matchAll(/^(CHILE|AMÉRICA LATINA|INTERNACIONAL)$/gm)].map((m) => m[1]), ['CHILE', 'AMÉRICA LATINA', 'INTERNACIONAL']);
  // Dentro de América Latina / Economía y Finanzas: Alto antes que Medio
  assert.ok(idx.indexOf('Inflación en Argentina') < idx.indexOf('Lula anuncia'));
  // El contenido viaja con su noticia, y las alertas no se tocan
  assert.match(body, /^2\. Banco Central mantiene la tasa — Semáforo: Alto\nLa tasa queda en 4,75%\.\n\(Fuente: x — y — z — Enlace: L4\)/m);
  assert.match(r.text, /ALERTAS DEL DÍA\n1\. Riesgo uno\.\n2\. Riesgo dos\./);
  assert.strictEqual(r.bodyOnly, 1);
  assert.ok(r.defaults >= 1);
});

test('es estable: procesar dos veces da el mismo informe', () => {
  const a = segmentReport(DESORDENADO);
  const b = segmentReport(a.text);
  assert.strictEqual(b.text, a.text);
  assert.strictEqual(b.changed, false);
  assert.strictEqual(b.defaults, 0);
});

test('un informe sin ÍNDICE o sin CUERPO no se modifica', () => {
  const t = 'Texto libre sin secciones';
  assert.strictEqual(segmentReport(t).text, t);
});

test('lee ámbito y temática con sinónimos y formato antiguo', () => {
  assert.deepStrictEqual(parseHead('Título — Nacional — Economía & Finanzas — Semáforo: Alto'),
    { title: 'Título', nivel: 'Alto', ambito: 'Chile', tema: 'Economía y Finanzas' });
  assert.deepStrictEqual(parseHead('Título largo — con guion — Tecnología — Semáforo: Bajo'),
    { title: 'Título largo — con guion', nivel: 'Bajo', ambito: null, tema: 'Tecnología' });
  assert.strictEqual(parseHead('Fed pausa — Internacional — Semáforo: Medio').ambito, 'Internacional');
});

test('correo: subtítulos, enlaces índice ↔ cuerpo con la nueva numeración y link original', () => {
  const seg = segmentReport(DESORDENADO).text;
  const map = new Map([['L1', 'https://ej.cl/p'], ['L3', 'https://ej.cl/c'], ['L4', 'https://ej.cl/bc'],
    ['L5', 'https://ej.cl/l'], ['L6', 'https://ej.cl/d'], ['L7', 'https://ej.cl/a'], ['L9', 'https://ej.cl/s']]);
  const h = convertToHtml(resolveLinks(seg, map).text);
  assert.deepStrictEqual([...h.matchAll(/class="ambito">([^<]+)/g)].map((m) => m[1]).slice(0, 3), ['Chile', 'América Latina', 'Internacional']);
  const ida = [...h.matchAll(/href="#noticia-(\d+)"/g)].map((m) => +m[1]);
  const anclas = [...h.matchAll(/id="noticia-(\d+)"/g)].map((m) => +m[1]);
  const vuelta = [...h.matchAll(/class="volver" href="#idx-(\d+)"/g)].map((m) => +m[1]);
  assert.deepStrictEqual(ida, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepStrictEqual(anclas, ida);
  assert.deepStrictEqual(vuelta, ida);
  // Banco Central quedó como noticia 2 y su link original es el suyo
  assert.match(h, /id="noticia-2"[\s\S]*?href="https:\/\/ej\.cl\/bc" target="_blank"/);
  assert.strictEqual([...h.matchAll(/class="original"/g)].length, 7);
});

test('audio: un capítulo por ámbito y temática con noticias Alto o Medio, sin URL', () => {
  const seg = resolveLinks(segmentReport(DESORDENADO).text, new Map([['L4', 'https://ej.cl/bc']])).text;
  const S = buildSections(seg, 'miércoles 28 de octubre de 2026');
  assert.deepStrictEqual(S.secciones.map((x) => x.titulo), [
    'Alertas del día', 'Chile, Política', 'Chile, Economía y Finanzas', 'Chile, Sociedad',
    'América Latina, Economía y Finanzas', 'Internacional, Economía y Finanzas',
  ]);
  assert.doesNotMatch(S.secciones.map((x) => x.texto).join(' '), /https?:|ej\.cl/);
});

test('audio de un resumen antiguo (sin segmentar): "Internacional" no se duplica en el capítulo', () => {
  const viejo = 'ÍNDICE\n1. Fed pausa — Internacional — Semáforo: Alto\n2. Senado aprueba — Política — Semáforo: Medio\n'
    + 'CUERPO\n1. Fed pausa — Semáforo: Alto\nTexto.\n2. Senado aprueba — Semáforo: Medio\nTexto.\nALERTAS DEL DÍA\n1. Riesgo.';
  assert.deepStrictEqual(buildSections(viejo, 'x').secciones.map((x) => x.titulo), ['Alertas del día', 'Internacional', 'Política']);
});

/** PDF mínimo con un texto y una anotación de enlace sobre él. */
function pdfConEnlace(texto, url) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R] >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Type /Annot /Subtype /Link /Rect [45 690 400 715] /Border [0 0 0] /A << /S /URI /URI (${url}) >> >>`,
  ];
  const stream = `BT /F1 12 Tf 50 700 Td (${texto}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

test('PDF: lee el enlace de cada titular (anotaciones) con su texto', async () => {
  const links = await extractPdfLinks(pdfConEnlace('Banco Central mantiene la tasa', 'https://www.df.cl/bc'));
  assert.deepStrictEqual(links, [{ text: 'Banco Central mantiene la tasa', url: 'https://www.df.cl/bc' }]);
  // Se suman a los del cuerpo y se deduplican por URL
  const all = cleanLinks([{ text: 'Banco Central mantiene la tasa', url: 'https://www.df.cl/bc' }, ...links,
    { text: 'Darse de baja de esta lista', url: 'https://x.cl/unsubscribe' }]);
  assert.strictEqual(all.length, 1);
});

test('prompt: ámbito y temática, 4-5 líneas para Bajo y enlace en todas las noticias', () => {
  const { prompt } = buildUserPrompt([{ subject: 's', from: 'f', date: 'd', body: 'b', links: [{ text: 'Titular de prueba', url: 'https://ej.cl/t' }] }]);
  assert.match(prompt, /Ámbito: Chile \/ América Latina \/ Internacional/);
  assert.match(prompt, /Temática: Política \/ Economía y Finanzas \/ Empresas y Negocios \/ Energía y Minería \/ Tecnología \/ Sociedad \/ Deportes/);
  assert.match(prompt, /Semáforo es Bajo: 4-5 líneas/);
  assert.match(prompt, /TODAS las noticias, también las de semáforo Bajo/);
  assert.match(prompt, /\[L1\] Titular de prueba/);
});
