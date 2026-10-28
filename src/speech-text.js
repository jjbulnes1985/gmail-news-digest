'use strict';

/**
 * speech-text.js — Prepara texto para lectura en voz alta en español.
 *
 * Los motores de voz (en especial Piper) leen mal "US$", "%", fechas numéricas y
 * decimales con coma. Esta función convierte cifras a palabras de forma
 * determinista (sin IA), sin cambiar el contenido:
 *   "US$114"      → "ciento catorce dólares"
 *   "US$ 1.200 millones" → "mil doscientos millones de dólares"
 *   "$985,75"     → "novecientos ochenta y cinco coma setenta y cinco pesos"
 *   "0,5%"        → "cero coma cinco por ciento"
 *   "22/10/2026"  → "veintidós de octubre de dos mil veintiséis"
 *   "EE.UU."      → "Estados Unidos"
 */

const UNIDADES = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve',
  'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis',
  'veintisiete', 'veintiocho', 'veintinueve'];
const DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos',
  'setecientos', 'ochocientos', 'novecientos'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre',
  'octubre', 'noviembre', 'diciembre'];

/** 0..999 en palabras. */
function below1000(n) {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  const c = Math.floor(n / 100), r = n % 100;
  let out = c ? CENTENAS[c] : '';
  if (r) {
    let rr;
    if (r < 30) rr = UNIDADES[r];
    else {
      const d = Math.floor(r / 10), u = r % 10;
      rr = DECENAS[d] + (u ? ` y ${UNIDADES[u]}` : '');
    }
    out = out ? `${out} ${rr}` : rr;
  }
  return out;
}

/** Apócope de "uno" al final: "veintiuno" → "veintiún", "uno" → "un". */
function apocope(w) {
  return w.replace(/veintiuno$/, 'veintiún').replace(/(^|\s)uno$/, '$1un');
}

/**
 * Entero no negativo en palabras (hasta 999.999.999.999).
 * @param {number} n
 * @param {boolean} beforeNoun - true si sigue un sustantivo ("un dólar", "veintiún millones")
 */
function intToWords(n, beforeNoun = false) {
  if (!Number.isFinite(n) || n < 0 || n > 999999999999) return String(n);
  if (n === 0) return 'cero';
  const millones = Math.floor(n / 1e6), resto = n % 1e6;
  const miles = Math.floor(resto / 1000), unidades = resto % 1000;
  const parts = [];
  if (millones) {
    if (millones === 1) parts.push('un millón');
    else {
      // millones > 999 → "mil doscientos millones"
      const mm = Math.floor(millones / 1000), mu = millones % 1000;
      let w = '';
      if (mm) w = mm === 1 ? 'mil' : `${apocope(below1000(mm))} mil`;
      if (mu) w = w ? `${w} ${apocope(below1000(mu))}` : apocope(below1000(mu));
      parts.push(`${w} millones`);
    }
  }
  if (miles) parts.push(miles === 1 ? 'mil' : `${apocope(below1000(miles))} mil`);
  if (unidades) {
    const w = below1000(unidades);
    parts.push(beforeNoun ? apocope(w) : w);
  }
  return parts.join(' ');
}

/** "41.199,85" (formato chileno) → { int: 41199, dec: "85" } */
function parseNumber(str) {
  const s = str.trim();
  let intPart = s, dec = '';
  const m = s.match(/^([\d.]+),(\d+)$/);
  if (m) { intPart = m[1]; dec = m[2]; }
  // Puntos como separador de miles solo si los grupos son de 3 dígitos
  if (/^\d{1,3}(\.\d{3})+$/.test(intPart)) intPart = intPart.replace(/\./g, '');
  else if (/^\d+\.\d+$/.test(intPart) && !dec) { // decimal con punto (formato anglosajón)
    const [a, b] = intPart.split('.'); intPart = a; dec = b;
  }
  return { int: parseInt(intPart.replace(/\./g, ''), 10), dec };
}

/** Número (con decimales) en palabras: "0,5" → "cero coma cinco"; "2,05" → "dos coma cero cinco". */
function numberToWords(str, beforeNoun = false) {
  const { int, dec } = parseNumber(str);
  if (!Number.isFinite(int)) return str;
  let w = intToWords(int, beforeNoun && !dec);
  if (dec) {
    const lead = dec.match(/^0+/);
    const rest = dec.replace(/^0+/, '');
    const decWords = (lead ? 'cero '.repeat(lead[0].length).trim() + (rest ? ' ' : '') : '')
      + (rest ? intToWords(parseInt(rest, 10), beforeNoun) : '');
    w += ` coma ${decWords}`;
  }
  return w;
}

const NUM = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?|\d+\.\d+`;
const SCALE = String.raw`(?:\s*(mil millones|millones|millón|billones|mil|MM))?`;

function scaleWord(sc, n) {
  if (!sc) return '';
  if (sc === 'MM') return n === 1 ? 'millón' : 'millones';
  return sc;
}

/**
 * Normaliza texto para voz. No inventa ni elimina contenido: solo cambia la forma
 * de cifras, símbolos y siglas, y quita marcas de formato.
 */
function normalizeForSpeech(input) {
  let t = String(input || '');

  // Formato y símbolos sin lectura (las URL nunca se leen)
  t = t.replace(/https?:\/\/\S+/g, ' ');
  t = t.replace(/\*\*/g, '').replace(/[*#_`]/g, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/[“”«»"]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');

  // Siglas y abreviaturas frecuentes
  t = t.replace(/\bEE\.\s?UU\.?/g, 'Estados Unidos')
    .replace(/\bp\.\s?p\./g, 'puntos porcentuales')
    .replace(/\bpbs?\b|\bbps\b/g, 'puntos base')
    .replace(/\bN°\s*/g, 'número ')
    .replace(/\bkm\b/g, 'kilómetros')
    .replace(/\s&\s/g, ' y ');

  // Fechas dd/mm/aaaa, dd-mm-aaaa o dd.mm.aaaa
  t = t.replace(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g, (m, d, mo, y) => {
    const mi = parseInt(mo, 10) - 1;
    if (mi < 0 || mi > 11) return m;
    const dd = parseInt(d, 10);
    return `${dd === 1 ? 'primero' : intToWords(dd)} de ${MESES[mi]} de ${intToWords(parseInt(y, 10))}`;
  });

  // Monedas: US$ / USD / $ (pesos), con escala opcional
  t = t.replace(new RegExp(String.raw`(?:US\$|USD|U\$S)\s?(${NUM})${SCALE}`, 'g'), (m, num, sc) => {
    const { int } = parseNumber(num);
    if (sc) return `${numberToWords(num, true)} ${scaleWord(sc, int)} de dólares`;
    return `${numberToWords(num, true)} ${int === 1 && !parseNumber(num).dec ? 'dólar' : 'dólares'}`;
  });
  t = t.replace(new RegExp(String.raw`\$\s?(${NUM})${SCALE}`, 'g'), (m, num, sc) => {
    const { int } = parseNumber(num);
    if (sc) return `${numberToWords(num, true)} ${scaleWord(sc, int)} de pesos`;
    return `${numberToWords(num, true)} ${int === 1 && !parseNumber(num).dec ? 'peso' : 'pesos'}`;
  });
  t = t.replace(/\bUF\b/g, 'U F');

  // Porcentajes: "0,5%", "65 %"
  t = t.replace(new RegExp(String.raw`(${NUM})\s?%`, 'g'), (m, num) => `${numberToWords(num)} por ciento`);

  // Ordinales abreviados: 1er, 3er, 2do, 4to
  const ORD_AP = { 1: 'primer', 2: 'segundo', 3: 'tercer', 4: 'cuarto', 5: 'quinto', 6: 'sexto', 7: 'séptimo', 8: 'octavo', 9: 'noveno', 10: 'décimo' };
  const ORD_F = { 1: 'primera', 2: 'segunda', 3: 'tercera', 4: 'cuarta', 5: 'quinta', 6: 'sexta', 7: 'séptima', 8: 'octava', 9: 'novena', 10: 'décima' };
  t = t.replace(/\b(\d{1,2})(ra|da|ta|va|na|ma)\b/g, (m, n) => ORD_F[+n] || m);
  t = t.replace(/\b(\d{1,2})(?:er|ro|do|to|vo|no|mo)\b/g, (m, n) => ORD_AP[+n] || m);

  // Ordinales simples: 1°, 2º
  const ORD = ['', 'primero', 'segundo', 'tercero', 'cuarto', 'quinto', 'sexto', 'séptimo', 'octavo', 'noveno', 'décimo'];
  t = t.replace(/\b(\d{1,2})\s?[°º]/g, (m, n) => (ORD[+n] ? ORD[+n] : `número ${intToWords(+n)}`));

  // Números restantes (con escala opcional "1.200 millones")
  t = t.replace(new RegExp(String.raw`(?<![\w.,])(${NUM})${SCALE}(?![\w])`, 'g'), (m, num, sc) => {
    if (sc) return `${numberToWords(num, true)} ${scaleWord(sc, parseNumber(num).int)}`;
    return numberToWords(num);
  });

  return t.replace(/[ \t]+/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
}

module.exports = { normalizeForSpeech, intToWords, numberToWords };
