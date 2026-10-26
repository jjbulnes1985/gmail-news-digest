'use strict';

// Pruebas: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { normalizeNumbering, extractLinks, resolveLinks } = require('../src/report');
const { convertToHtml } = require('../src/mailer');
const { parseReport, themeMap } = require('../src/audio');

// Extracto del informe real del 25-10-2026 (Gemini escribió "N." en vez de números)
const REPORTE_N = `ÍNDICE
N. AFP alistan contraofensiva técnica y jurídica ante cuestionamientos por caída del Fondo E — Economía & Finanzas — Semáforo: Alto
N. Polémica por rebaja de condenas a delitos sexuales contra menores por Ministro Fernando Rabat — Política — Semáforo: Alto
N. Cobreloa vuelve a la cima de la Primera B a una fecha del final — Deportes — Semáforo: Bajo

CUERPO
N. AFP alistan contraofensiva técnica y jurídica ante cuestionamientos por caída del Fondo E — Semáforo: Alto
Las AFP se preparan para una contraofensiva técnica y jurídica.
(Fuente: PwC Chile presenta — "El Líbero" <ellibero@ellibero.cl> — Sun, 25 Oct 2026 — Enlace: L2)

N. Cobreloa vuelve a la cima de la Primera B a una fecha del final — Semáforo: Bajo
Cobreloa derrotó a Rangers.
(Fuente: PwC Chile presenta — "El Líbero" <ellibero@ellibero.cl> — Sun, 25 Oct 2026 — Enlace: ninguno)

N. Polémica por rebaja de condenas a delitos sexuales contra menores por el Ministro Rabat — Semáforo: Alto
El Ministro enfrenta una crisis política.
(Fuente: PwC Chile presenta — "El Líbero" <ellibero@ellibero.cl> — Sun, 25 Oct 2026 — Enlace: L99)

ALERTAS DEL DÍA
- La crisis de las AFP eleva la incertidumbre.
- Riesgo de inestabilidad política.`;

test('renumera los marcadores "N." y empareja el cuerpo con el índice por título', () => {
  const { text, fixed } = normalizeNumbering(REPORTE_N);
  assert.ok(fixed >= 6);
  assert.match(text, /^1\. AFP alistan .* — Economía & Finanzas/m);
  assert.match(text, /^2\. Polémica/m);
  assert.match(text, /^3\. Cobreloa .* — Deportes/m);
  const cuerpo = text.slice(text.indexOf('CUERPO'));
  assert.match(cuerpo, /^1\. AFP/m);
  assert.match(cuerpo, /^3\. Cobreloa/m);
  assert.match(cuerpo, /^2\. Polémica/m); // título algo distinto: coincide por prefijo
  assert.doesNotMatch(text, /^N\. /m);
});

test('un informe ya numerado no cambia', () => {
  const ok = '1. Uno — Política — Semáforo: Bajo\nCUERPO\n1. Uno — Semáforo: Bajo';
  assert.deepStrictEqual(normalizeNumbering('ÍNDICE\n' + ok), { text: 'ÍNDICE\n' + ok, fixed: 0 });
});

test('HTML: índice → desarrollo, desarrollo → titular y desarrollo → noticia original', () => {
  const linkMap = new Map([['L2', 'https://ellibero.cl/afp?a=1&b=2']]);
  const { text, resolved, dropped } = resolveLinks(normalizeNumbering(REPORTE_N).text, linkMap);
  assert.strictEqual(resolved, 1);
  assert.strictEqual(dropped, 1);
  assert.doesNotMatch(text, /Enlace: (ninguno|L99)/);
  const html = convertToHtml(text);
  for (const n of [1, 2, 3]) {
    assert.match(html, new RegExp(`<a href="#noticia-${n}">`));
    assert.match(html, new RegExp(`id="noticia-${n}"`));
    assert.match(html, new RegExp(`href="#idx-${n}">Volver al titular`));
  }
  assert.match(html, /<a class="original" href="https:\/\/ellibero\.cl\/afp\?a=1&amp;b=2">Ver noticia original<\/a>/);
  assert.strictEqual((html.match(/Ver noticia original/g) || []).length, 1);
  assert.doesNotMatch(html, /Enlace:/);
});

test('convertToHtml renumera aunque reciba el texto sin procesar', () => {
  const html = convertToHtml(REPORTE_N);
  assert.match(html, /<a href="#noticia-3">/);
  assert.match(html, /id="noticia-3"/);
});

test('audio: encuentra noticias y alertas con viñeta tras renumerar', () => {
  const text = normalizeNumbering(REPORTE_N).text;
  const { alerts, items } = parseReport(text);
  assert.strictEqual(alerts.length, 2);
  assert.deepStrictEqual(items.map((i) => i.n).sort(), ['1', '2', '3']);
  assert.strictEqual(themeMap(text).theme.get('3'), 'Deportes');
});

test('extractLinks: titulares, contexto para "Leer más" y descarte de enlaces que no son noticias', () => {
  const html = `
    <h2><a href="https://www.df.cl/empresas/america-movil-ciadi?utm=x&amp;y=1">América Móvil activa vía Ciadi contra el Estado chileno</a></h2>
    <p>Aseguradoras demandan a Cencosud por US$ 10,8 millones tras incendio <a href="https://www.df.cl/cencosud">Leer más</a></p>
    <a href="https://www.df.cl/cencosud">Leer más</a>
    <a href="https://www.facebook.com/df">Síguenos en Facebook</a>
    <a href="https://www.df.cl/unsubscribe?id=1">Darse de baja</a>
    <a href="mailto:a@b.cl">Escríbenos a nuestro correo</a>
    <a href="https://www.df.cl/x"><img src="logo.png"></a>`;
  const links = extractLinks(html);
  assert.strictEqual(links.length, 2);
  assert.deepStrictEqual(links[0], { text: 'América Móvil activa vía Ciadi contra el Estado chileno', url: 'https://www.df.cl/empresas/america-movil-ciadi?utm=x&y=1' });
  assert.match(links[1].text, /Cencosud .* \(Leer más\)$/);
});

test('extractLinks: correo solo texto con URL escrita', () => {
  const links = extractLinks('', 'Inditex supera a Santander en bolsa: https://ex.com/inditex\nhttps://ex.com/sin-texto');
  assert.deepStrictEqual(links, [{ text: 'Inditex supera a Santander en bolsa:', url: 'https://ex.com/inditex' }]);
});

test('extractLinks: etiqueta corta de cita ("El Mercurio B8") lleva el texto previo y list-manage no se descarta', () => {
  const html = '<p>Las AFP alistan una contraofensiva técnica y jurídica ( <a href="https://us.list-manage.com/abc?e=1">El Mercurio B8</a> )</p><a href="https://us.list-manage.com/z">update subscription preferences</a>';
  const links = extractLinks(html);
  assert.strictEqual(links.length, 1);
  assert.match(links[0].text, /contraofensiva técnica y jurídica \( \(El Mercurio B8\)$/);
});
