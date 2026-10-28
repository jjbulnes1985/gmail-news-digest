'use strict';

/**
 * pdf-links.js — Enlaces de un PDF (anotaciones de tipo Link) con el texto que cubren.
 *
 * Valor Diario (e-press) llega como PDF con un enlace al artículo original en cada
 * titular. pdf-parse solo entrega el texto, así que esos enlaces se perdían: el
 * 26, 27 y 28-10-2026 entre 21 y 25 noticias por día salieron sin "Ver noticia
 * original". Aquí se leen las anotaciones con el pdf.js que ya trae pdf-parse y se
 * les asigna el texto que queda bajo cada rectángulo de enlace.
 */

let pdfjs = null;
function loadPdfjs() {
  if (pdfjs) return pdfjs;
  // Misma versión de pdf.js que usa pdf-parse por defecto (sin dependencias nuevas)
  pdfjs = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
  if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = undefined;
  pdfjs.disableWorker = true;
  return pdfjs;
}

/** Texto (en orden de lectura) de los ítems que caen dentro del rectángulo. */
function textInRect(items, rect, pad = 2) {
  const [x1, y1, x2, y2] = [Math.min(rect[0], rect[2]) - pad, Math.min(rect[1], rect[3]) - pad,
    Math.max(rect[0], rect[2]) + pad, Math.max(rect[1], rect[3]) + pad];
  const inside = items.filter((it) => {
    const x = it.transform[4], y = it.transform[5];
    const w = it.width || 0;
    const h = Math.abs(it.transform[3]) || it.height || 0;
    // Punto medio del ítem dentro del rectángulo
    const cx = x + w / 2, cy = y + h / 3;
    return cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2;
  });
  inside.sort((a, b) => (Math.abs(b.transform[5] - a.transform[5]) > 2 ? b.transform[5] - a.transform[5] : a.transform[4] - b.transform[4]));
  return inside.map((it) => it.str).join(' ').replace(/\s+/g, ' ').replace(/^[•·\-\s]+/, '').trim();
}

/**
 * @param {Buffer} buffer - PDF
 * @returns {Promise<{text: string, url: string}[]>} enlaces con el texto que cubren
 */
async function extractPdfLinks(buffer) {
  const lib = loadPdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(buffer) });
  const out = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const [annots, content] = await Promise.all([page.getAnnotations(), page.getTextContent()]);
      const items = (content.items || []).filter((it) => it.str && it.str.trim());
      for (const a of annots) {
        const url = a.url || a.unsafeUrl;
        if (!url || !/^https?:\/\//i.test(url) || !a.rect) continue;
        const text = textInRect(items, a.rect);
        out.push({ text, url });
      }
    }
  } finally {
    if (doc.destroy) await doc.destroy();
  }
  return out;
}

module.exports = { extractPdfLinks, textInRect };
