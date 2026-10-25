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

module.exports = { normalizeNumbering, extractLinks, resolveLinks, titleKey };
