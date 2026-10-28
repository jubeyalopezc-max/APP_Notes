// Importar un PDF: cada página se vuelve el fondo de una hoja de la nota, para escribir encima.
import { PAGE_W, PAGE_H, pageTop } from './render.js';
import { uid } from './db.js';

const MAX_PAGES = 300;
const TARGET_PX = 1700;   // ancho de la imagen de cada página
const MARGIN = 24;

let lib = null;
const base = new URL('../vendor/pdfjs/', import.meta.url).href;

async function pdfjs() {
  if (!lib) {
    lib = await import('../vendor/pdfjs/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';
  }
  return lib;
}

/** Abre el archivo. Lanza un Error con un mensaje para la persona si no se puede. */
export async function openPdf(file) {
  const L = await pdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  try {
    return await L.getDocument({
      data, cMapUrl: base + 'cmaps/', cMapPacked: true,
      standardFontDataUrl: base + 'standard_fonts/', isEvalSupported: false,
    }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('Ese PDF tiene contraseña. Ábrelo en otra app, guárdalo sin contraseña e inténtalo de nuevo.');
    throw new Error('No se pudo abrir ese archivo. Revisa que sea un PDF.');
  }
}

// El texto más grande de la página suele ser su título (por ejemplo, el de una diapositiva).
function pageTitle(tc) {
  const items = tc.items.filter(i => i.str && i.str.trim());
  if (!items.length) return '';
  const size = i => Math.hypot(i.transform[0], i.transform[1]) || i.height || 0;
  const max = Math.max(...items.map(size));
  const big = items.filter(i => size(i) >= max * 0.9)
    .sort((a, b) => (Math.abs(b.transform[5] - a.transform[5]) > max * 0.3 ? b.transform[5] - a.transform[5] : a.transform[4] - b.transform[4]));
  let out = '', prev = null;
  for (const i of big) {
    if (prev) {
      const sameLine = Math.abs(prev.transform[5] - i.transform[5]) < max * 0.3;
      const gap = i.transform[4] - (prev.transform[4] + (prev.width || 0));
      out += sameLine && gap < max * 0.15 ? '' : ' ';
    }
    out += i.str;
    prev = i;
    if (out.length > 120) break;
  }
  const t = out.replace(/\s+/g, ' ').trim();
  // Un número suelto (número de página) no sirve como título.
  return /^[\d\s.\-–/]*$/.test(t) ? '' : t.slice(0, 90);
}

function pageText(tc) {
  return tc.items.map(i => (i.str || '') + (i.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' ').trim();
}

/**
 * Convierte las páginas del PDF en fondos de hoja, empezando en la hoja `startPage` (0 = primera).
 * Devuelve { items, pageCount, text, thumb, truncated }.
 */
export async function pdfToItems(doc, { startPage = 0, onProgress } = {}) {
  const total = doc.numPages;
  const n = Math.min(total, MAX_PAGES);
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  const items = [];
  const texts = [];
  let thumb = null;
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = Math.min(TARGET_PX / vp1.width, 2600 / vp1.height);
    const vp = page.getViewport({ scale });
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    const src = canvas.toDataURL('image/jpeg', 0.85);
    let title = '', text = '';
    try { const tc = await page.getTextContent(); title = pageTitle(tc); text = pageText(tc); } catch {}
    page.cleanup();

    // Ajustar la página dentro de la hoja; una diapositiva horizontal queda arriba y deja espacio para notas.
    const k = Math.min((PAGE_W - MARGIN * 2) / vp1.width, (PAGE_H - MARGIN * 2) / vp1.height);
    const w = vp1.width * k, h = vp1.height * k;
    const p = startPage + i - 1;
    items.push({ id: uid(), type: 'image', bg: true, src, title, x: (PAGE_W - w) / 2, y: pageTop(p) + MARGIN, w, h });
    if (text) texts.push(text);

    if (i === 1) {
      const t = document.createElement('canvas');
      t.width = 240; t.height = Math.round(240 * PAGE_H / PAGE_W);
      const tg = t.getContext('2d');
      tg.fillStyle = '#fff'; tg.fillRect(0, 0, t.width, t.height);
      const s = t.width / PAGE_W;
      tg.drawImage(canvas, (PAGE_W - w) / 2 * s, MARGIN * s, w * s, h * s);
      thumb = t.toDataURL('image/jpeg', 0.7);
    }
    onProgress && onProgress(i, n);
  }
  doc.destroy();
  return { items, pageCount: n, text: texts.join('\n').slice(0, 400000), thumb, truncated: total > MAX_PAGES };
}
