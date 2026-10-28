'use strict';

/**
 * report.js — Ajustes deterministas sobre el informe de Gemini y extracción de enlaces.
 *
 * 1. normalizeNumbering: el 25-10-2026 Gemini escribió la letra "N." en vez del número
 *    de cada noticia (copió el marcador del formato). Sin números el correo salió sin
 *    enlaces índice ↔ cuerpo y el audio sin secciones. Aquí se renumera el informe.
 * 2. extractLinks: enlaces de cada correo de origen (titular + URL) para que Gemini
 *    indique, por ID, el enlace de cada noticia; resolveLinks cambia el ID por la URL.
 */

const PLACEHOLDER = /^([*#\s]*)(?:N|N°|Nº|#|X)\s*([\.\)])\s+/;
const NUMBERED    = /^([*#\s]*)(?:\d+|N|N°|Nº|#|X)\s*([\.\)])\s+/;

const plain = (s) => s.replace(/[*#]/g, '').trim();

/** Clave de comparación de títulos: minúsculas, sin tildes ni signos. */
function titleKey(rest) {
  const title = plain(rest).split(/\s+[—–]\s+|\s+-\s+Semáforo/i)[0];
  return title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sectionOf(line) {
  const p = plain(line);
  if (/^(ÍNDICE|INDICE)$/i.test(p)) return 'indice';
  if (/^CUERPO$/i.test(p)) return 'cuerpo';
  if (/^ALERTAS DEL D[IÍ]A$/i.test(p)) return 'alertas';
  return null;
}

/**
 * Si el informe trae marcadores ("N.") en lugar de números, renumera: el ÍNDICE en
 * orden correlativo, cada noticia del CUERPO con el número de su titular en el índice
 * (por título; si no coincide, el siguiente correlativo) y las alertas 1, 2, 3.
 * Un informe ya numerado se devuelve sin cambios.
 * @param {string} text
 * @returns {{text: string, fixed: number}}
 */
function normalizeNumbering(text) {
  const lines = text.split('\n');
  let section = '';
  let hasPlaceholder = false;
  for (const l of lines) {
    section = sectionOf(l) || section;
    if (section && PLACEHOLDER.test(l.trim())) { hasPlaceholder = true; break; }
  }
  if (!hasPlaceholder) return { text, fixed: 0 };

  const byTitle = new Map();
  const keys = [];
  let idx = 0; let lastBody = 0; let alert = 0; let fixed = 0;
  section = '';
  const out = lines.map((line) => {
    const sec = sectionOf(line);
    if (sec) { section = sec; return line; }
    const t = line.trim();
    const m = t.match(NUMBERED);
    if (!m || !section) return line;
    const rest = t.slice(m[0].length);
    let n;
    if (section === 'indice') {
      n = ++idx;
      const k = titleKey(rest);
      if (k && !byTitle.has(k)) { byTitle.set(k, n); keys.push(k); }
    } else if (section === 'cuerpo') {
      const k = titleKey(rest);
      n = byTitle.get(k);
      if (!n && k.length >= 12) {
        const pre = k.slice(0, 30);
        const hit = keys.find((x) => x.startsWith(pre) || pre.startsWith(x.slice(0, 30)));
        if (hit) n = byTitle.get(hit);
      }
      if (!n) n = lastBody + 1;
      lastBody = n;
    } else {
      n = ++alert;
    }
    fixed++;
    return `${m[1]}${n}${m[2]} ${rest}`;
  });
  return { text: out.join('\n'), fixed };
}

// ─── Enlaces de los correos de origen ──────────────────────────────────────

const decodeEntities = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#x27;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&hellip;/g, '...')
  .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

const toText = (html) => decodeEntities(html
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// Enlaces que no son noticias: baja, preferencias, redes sociales, tiendas, legales
const SKIP_URL  = /^mailto:|unsubscribe|desuscri|optout|opt-out|preferenc|facebook\.com|twitter\.com|\/\/(www\.)?x\.com|linkedin\.com|instagram\.com|youtube\.com|youtu\.be|whatsapp|wa\.me|t\.me\/|tiktok\.com|apps\.apple\.com|play\.google\.com|spotify\.com|privacy|privacidad/i;
const SKIP_TEXT = /desuscrib|darse de baja|dar de baja|cancelar (la )?suscrip|unsubscribe|preferencias|ver (este correo )?en (el |tu )?navegador|versi[oó]n web|view (this email )?in (your )?browser|pol[ií]tica de privacidad|t[eé]rminos|compartir|^share|suscr[ií]bete|env[ií]anos|contacta|escucha en|hazte miembro|why did i get this|subscription|^(facebook|twitter|linkedin|instagram|youtube|whatsapp|x)$/i;
// Textos genéricos o muy cortos ("Leer más", "El Mercurio B8"): se completan con el
// texto que los precede, para que Gemini sepa a qué noticia corresponden
const GENERIC = /^(leer|ver|seguir leyendo|lee|sigue leyendo|read|continuar|m[aá]s|aqu[ií]|click|clic|haz clic|nota|link|enlace|art[ií]culo)\b.{0,30}$/i;

const MAX_LABEL = 140;

/**
 * Enlaces de noticias de un correo. Usa la parte HTML (anclas <a>); si no hay HTML,
 * toma las URL escritas en el texto plano.
 * @param {string} html
 * @param {string} plainText
 * @param {number} max - tope de enlaces por correo
 * @returns {{text: string, url: string}[]}
 */
function extractLinks(html, plainText = '', max = 80) {
  const found = [];
  if (html) {
    const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
      const href = (m[1].match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (!href) continue;
      const url = decodeEntities(href.trim());
      let label = toText(m[2]);
      if (!label) continue; // ancla de imagen
      if (GENERIC.test(label) || (label.length < 25 && label.split(' ').length <= 3)) {
        const before = toText(html.slice(Math.max(0, m.index - 2000), m.index));
        const ctx = before.slice(-100).replace(/^\S*\s/, '');
        if (ctx) label = `${ctx} (${label})`;
      }
      found.push({ text: label, url });
    }
  } else if (plainText) {
    for (const line of plainText.split('\n')) {
      const urls = line.match(/https?:\/\/[^\s<>()\[\]"]+/g);
      if (!urls) continue;
      const label = line.replace(/https?:\/\/[^\s<>()\[\]"]+/g, ' ').replace(/[<>\[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
      for (const url of urls) found.push({ text: label, url });
    }
  }

  return cleanLinks(found, max);
}

/**
 * Filtra y deduplica enlaces {text, url}: descarta bajas, redes, tiendas, textos
 * genéricos o muy cortos, y repetidos. Se usa para los enlaces del HTML, del texto
 * plano y de los PDF adjuntos.
 * @param {{text: string, url: string}[]} found
 * @param {number} max
 */
function cleanLinks(found, max = 80) {
  const out = [];
  const seenUrl = new Set(); const seenText = new Set();
  for (const { text, url } of found) {
    if (!/^https?:\/\//i.test(url) || SKIP_URL.test(url)) continue;
    const label = text.length > MAX_LABEL ? text.slice(0, MAX_LABEL - 1) + '…' : text;
    if (label.length < 8 || SKIP_TEXT.test(label)) continue;
    const tk = label.toLowerCase();
    if (seenUrl.has(url) || seenText.has(tk)) continue;
    seenUrl.add(url); seenText.add(tk);
    out.push({ text: label, url });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Cambia "Enlace: L12" por la URL real. Un ID inexistente, "ninguno" o un ID suelto
 * en el texto se quitan, para no mostrar enlaces inventados.
 * @param {string} text
 * @param {Map<string,string>} linkMap - ID → URL
 * @returns {{text: string, resolved: number, dropped: number}}
 */
function resolveLinks(text, linkMap) {
  let resolved = 0; let dropped = 0;
  const out = text
    .replace(/\s*[—–-]?\s*Enlace:\s*\[?\s*(L\d+|ninguno|no disponible|n\/a|sin enlace)\s*\]?/gi, (all, id) => {
      const url = linkMap.get(id.toUpperCase());
      if (url) { resolved++; return ` — Enlace: ${url}`; }
      if (/^L\d+$/i.test(id)) dropped++;
      return '';
    })
    .replace(/\s*\[(L\d+)\]/g, () => '');
  return { text: out, resolved, dropped };
}

// ─── Segmentación por ámbito y temática ────────────────────────────────────
//
// Gemini no respeta de forma estable el orden pedido (el 27-10-2026 el índice tuvo
// 38 tramos de temáticas intercaladas). Aquí el código reordena y renumera el índice
// y el cuerpo según un orden fijo, y escribe los subtítulos de ámbito y temática.

const AMBITOS = ['Chile', 'América Latina', 'Internacional'];
const TEMAS = ['Política', 'Economía y Finanzas', 'Empresas y Negocios', 'Energía y Minería', 'Tecnología', 'Sociedad', 'Deportes'];
const NIVELES = ['Alto', 'Medio', 'Bajo'];
const DEFAULT_AMBITO = 'Internacional';
const DEFAULT_TEMA = 'Sociedad';

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[*#:]/g, '').replace(/\s+/g, ' ').trim();

const AMBITO_SYN = new Map([
  ['chile', 'Chile'], ['nacional', 'Chile'], ['nacionales', 'Chile'], ['local', 'Chile'],
  ['america latina', 'América Latina'], ['latinoamerica', 'América Latina'], ['latam', 'América Latina'],
  ['region', 'América Latina'], ['regional', 'América Latina'], ['sudamerica', 'América Latina'], ['iberoamerica', 'América Latina'],
  ['internacional', 'Internacional'], ['internacionales', 'Internacional'], ['mundo', 'Internacional'], ['global', 'Internacional'], ['exterior', 'Internacional'],
]);
const TEMA_SYN = new Map([
  ['politica', 'Política'],
  ['economia y finanzas', 'Economía y Finanzas'], ['economia & finanzas', 'Economía y Finanzas'], ['economia', 'Economía y Finanzas'], ['finanzas', 'Economía y Finanzas'], ['mercados', 'Economía y Finanzas'],
  ['empresas y negocios', 'Empresas y Negocios'], ['empresas & negocios', 'Empresas y Negocios'], ['empresas', 'Empresas y Negocios'], ['negocios', 'Empresas y Negocios'],
  ['energia y mineria', 'Energía y Minería'], ['energia & mineria', 'Energía y Minería'], ['energia', 'Energía y Minería'], ['mineria', 'Energía y Minería'],
  ['tecnologia', 'Tecnología'], ['tech', 'Tecnología'], ['innovacion', 'Tecnología'],
  ['sociedad', 'Sociedad'], ['social', 'Sociedad'], ['salud', 'Sociedad'], ['educacion', 'Sociedad'], ['cultura', 'Sociedad'], ['medio ambiente', 'Sociedad'],
  ['deportes', 'Deportes'], ['deporte', 'Deportes'],
]);
const mapAmbito = (s) => AMBITO_SYN.get(fold(s)) || null;
const mapTema = (s) => TEMA_SYN.get(fold(s)) || null;
const ambitoHeader = (a) => a.toUpperCase();

/** ¿Es una línea de subtítulo (ámbito o temática), sin contenido de noticia? */
function isHeaderLine(line) {
  const p = plain(line);
  if (!p || p.length > 40 || /[.]$/.test(p)) return false;
  return !!(mapAmbito(p) || mapTema(p) || fold(p) === 'internacional');
}

/**
 * Lee un subtítulo: en MAYÚSCULAS es ámbito ("CHILE", "INTERNACIONAL"); si no, temática
 * ("Política"), y si no calza como temática, ámbito. Devuelve null si no es subtítulo.
 */
function readHeader(line) {
  if (!isHeaderLine(line)) return null;
  const p = plain(line);
  const upper = p === p.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(p);
  if (upper && mapAmbito(p)) return { ambito: mapAmbito(p) };
  if (mapTema(p)) return { tema: mapTema(p) };
  if (mapAmbito(p)) return { ambito: mapAmbito(p) };
  return null;
}

/** Separa "Título — Ámbito — Temática — Semáforo: X" en sus partes. */
function parseHead(rest) {
  const segs = plain(rest).split(/\s+[—–]\s+/);
  const iSem = segs.findIndex((x) => /^Sem[aá]foro\s*:/i.test(x));
  let nivel = null;
  let before = segs;
  if (iSem >= 0) {
    const m = segs[iSem].match(/(Alto|Medio|Bajo)/i);
    nivel = m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : null;
    before = segs.slice(0, iSem);
  }
  let ambito = null; let tema = null;
  // Desde el final: temática y luego ámbito, si calzan con el vocabulario
  if (before.length > 1 && mapTema(before[before.length - 1])) tema = mapTema(before.pop());
  else if (before.length > 1 && mapAmbito(before[before.length - 1])) ambito = mapAmbito(before.pop());
  if (!ambito && before.length > 1 && mapAmbito(before[before.length - 1])) ambito = mapAmbito(before.pop());
  return { title: before.join(' — ').trim(), nivel, ambito, tema };
}

/**
 * Reordena y renumera el informe por ámbito → temática → semáforo, con subtítulos.
 * Un informe sin ÍNDICE o sin CUERPO se devuelve sin cambios.
 * @param {string} text - informe ya con números (después de normalizeNumbering)
 * @returns {{text: string, changed: boolean, counts: Object<string, number>, defaults: number, bodyOnly: number, indexOnly: number}}
 */
function segmentReport(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const iIdx = lines.findIndex((l) => sectionOf(l) === 'indice');
  const iBody = lines.findIndex((l) => sectionOf(l) === 'cuerpo');
  const iAl = lines.findIndex((l) => sectionOf(l) === 'alertas');
  const empty = { text, changed: false, counts: {}, defaults: 0, bodyOnly: 0, indexOnly: 0 };
  if (iIdx < 0 || iBody < 0 || iBody < iIdx) return empty;
  const bodyEnd = iAl > iBody ? iAl : lines.length;

  const NUM = /^[*#\s]*(\d+)\s*[\.\)]\s+(.*)$/;
  // Índice
  // Los subtítulos (ámbito / temática) también clasifican: así un informe ya
  // segmentado se vuelve a procesar sin perder su clasificación.
  const withHeaders = (ctx, info) => ({ ...info, ambito: info.ambito || ctx.ambito || null, tema: info.tema || ctx.tema || null });
  const track = (ctx, l) => {
    const h = readHeader(l);
    if (!h) return false;
    if (h.ambito) { ctx.ambito = h.ambito; ctx.tema = null; } else ctx.tema = h.tema;
    return true;
  };
  const index = new Map(); const indexOrder = [];
  const ictx = {};
  for (const l of lines.slice(iIdx + 1, iBody)) {
    if (track(ictx, l)) continue;
    const m = l.trim().match(NUM);
    if (!m) continue;
    const n = +m[1];
    if (!index.has(n)) { index.set(n, withHeaders(ictx, parseHead(m[2]))); indexOrder.push(n); }
  }
  // Cuerpo
  const body = new Map(); const bodyOrder = [];
  let cur = null;
  const bctx = {};
  for (const l of lines.slice(iBody + 1, bodyEnd)) {
    if (track(bctx, l)) continue;            // subtítulos (de Gemini o de una pasada anterior)
    const m = l.trim().match(NUM);
    if (m && !body.has(+m[1])) {
      cur = { n: +m[1], head: withHeaders(bctx, parseHead(m[2])), content: [] };
      body.set(cur.n, cur); bodyOrder.push(cur.n);
      continue;
    }
    if (!cur) continue;
    cur.content.push(l.replace(/\s+$/, ''));
  }
  if (!indexOrder.length && !bodyOrder.length) return empty;

  // Entradas: todas las del índice + las del cuerpo que no estén en el índice
  let defaults = 0;
  const entries = [];
  const add = (n, info, inIndex) => {
    let ambito = info.ambito; let tema = info.tema;
    const b = body.get(n);
    if (!ambito && b && b.head.ambito) ambito = b.head.ambito;
    if (!tema && b && b.head.tema) tema = b.head.tema;
    if (!ambito || !tema) defaults++;
    entries.push({
      n, inIndex, title: info.title || (b && b.head.title) || '',
      nivel: info.nivel || (b && b.head.nivel) || null,
      ambito: ambito || DEFAULT_AMBITO, tema: tema || DEFAULT_TEMA, body: b,
    });
  };
  indexOrder.forEach((n) => add(n, index.get(n), true));
  let bodyOnly = 0;
  bodyOrder.filter((n) => !index.has(n)).forEach((n) => { bodyOnly++; add(n, body.get(n).head, false); });
  const indexOnly = indexOrder.filter((n) => !body.has(n)).length;

  const lvl = (x) => (NIVELES.indexOf(x) < 0 ? 3 : NIVELES.indexOf(x));
  const sorted = [...entries].sort((a, b) =>
    (AMBITOS.indexOf(a.ambito) - AMBITOS.indexOf(b.ambito))
    || (TEMAS.indexOf(a.tema) - TEMAS.indexOf(b.tema))
    || (lvl(a.nivel) - lvl(b.nivel))
    || (a.n - b.n));
  sorted.forEach((e, i) => { e.nuevo = i + 1; });
  const changed = sorted.some((e, i) => e.n !== i + 1) || entries.length !== indexOrder.length;

  const head = (e) => `${e.nuevo}. ${e.title}${e.nivel ? ` — Semáforo: ${e.nivel}` : ''}`;
  const grouped = (render) => {
    const out = []; let a = null; let t = null;
    for (const e of sorted) {
      if (e.ambito !== a) { out.push('', ambitoHeader(e.ambito)); a = e.ambito; t = null; }
      if (e.tema !== t) { out.push(e.tema); t = e.tema; }
      out.push(...render(e));
    }
    return out;
  };

  const counts = {};
  for (const e of sorted) { const k = `${e.ambito} / ${e.tema}`; counts[k] = (counts[k] || 0) + 1; }

  const pre = lines.slice(0, iIdx);
  while (pre.length && !pre[pre.length - 1].trim()) pre.pop();
  const out = [
    ...pre, ...(pre.length ? [''] : []),
    'ÍNDICE',
    ...grouped((e) => (e.inIndex ? [head(e)] : [head(e)])),
    '', 'CUERPO',
    ...grouped((e) => {
      if (!e.body) return [];
      const content = [...e.body.content];
      while (content.length && !content[content.length - 1].trim()) content.pop();
      while (content.length && !content[0].trim()) content.shift();
      return [head(e), ...content, ''];
    }),
    ...(iAl > iBody ? ['', ...lines.slice(iAl)] : []),
  ];
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n'), changed, counts, defaults, bodyOnly, indexOnly };
}

module.exports = {
  normalizeNumbering, extractLinks, cleanLinks, resolveLinks, titleKey,
  segmentReport, parseHead, isHeaderLine, readHeader, mapAmbito, mapTema, AMBITOS, TEMAS,
};
