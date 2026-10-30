// Exportar notas a PDF.
import { PAGE_W, PAGE_H, pageTop, drawPaper, drawPaperArea, drawItem, bounds, getImage, setInkDark } from './render.js';
import { buildPdf } from './pdf.js';

const PT_W = 595.28;              // A4 en puntos
const PT = PT_W / PAGE_W;         // puntos por unidad de página
const RES = 1.45;                 // píxeles por unidad (unos 175 ppp)

function loadImages(items) {
  return Promise.all(items.filter(i => i.type === 'image').map(it => new Promise(res => {
    const img = getImage(it, () => {});
    if (img.complete) return res();
    img.addEventListener('load', res, { once: true });
    img.addEventListener('error', res, { once: true });
  })));
}

async function jpeg(canvas) {
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.86));
  return new Uint8Array(await blob.arrayBuffer());
}

function footer(g, top, text, pageLabel, dark) {
  g.save();
  g.font = '17px "Atkinson Hyperlegible", sans-serif';
  g.fillStyle = dark ? '#7D889C' : '#8A94A6';
  g.textBaseline = 'alphabetic';
  const t = text.length > 70 ? text.slice(0, 68) + '…' : text;
  g.fillText(t, 40, top + PAGE_H - 22);
  g.textAlign = 'right';
  g.fillText(pageLabel, PAGE_W - 40, top + PAGE_H - 22);
  g.restore();
}

// La tinta se dibuja con los colores de las hojas oscuras si el PDF sale oscuro.
function drawInk(g, it, dark) {
  setInkDark(dark);
  try { drawItem(g, it, () => {}); } finally { setInkDark(false); }
}

// Una nota → páginas listas para el PDF, y sus entradas del índice.
// dark: hojas oscuras y tinta clara, igual que se ve en la pantalla con el tema oscuro.
async function renderNote(meta, content, onPage, dark = false) {
  const items = (content && content.items) || [];
  const ink = items.filter(it => it.type !== 'mark'); // las cintas de marcador no se imprimen
  const paper = meta.paper || 'lines';
  await loadImages(items);
  const out = [];
  const entries = [];

  if ((meta.layout || 'pages') === 'canvas') {
    let b = null;
    for (const it of ink) {
      const bb = bounds(it);
      b = b ? { x0: Math.min(b.x0, bb.x0), y0: Math.min(b.y0, bb.y0), x1: Math.max(b.x1, bb.x1), y1: Math.max(b.y1, bb.y1) } : { ...bb };
    }
    b = b || { x0: 0, y0: 0, x1: PAGE_W, y1: PAGE_W * 0.7 };
    const pad = 50;
    const x0 = b.x0 - pad, y0 = b.y0 - pad, bw = b.x1 - b.x0 + pad * 2, bh = b.y1 - b.y0 + pad * 2;
    const k = Math.min(RES, 4000 / bw, 4000 / bh);
    const c = document.createElement('canvas');
    c.width = Math.round(bw * k); c.height = Math.round(bh * k);
    const g = c.getContext('2d');
    g.scale(k, k); g.translate(-x0, -y0);
    drawPaperArea(g, x0, y0, x0 + bw, y0 + bh, paper, k, dark);
    for (const it of ink) drawInk(g, it, dark);
    const pt = Math.min(PT, 14000 / bw, 14000 / bh);
    out.push({ jpeg: await jpeg(c), pxW: c.width, pxH: c.height, w: bw * pt, h: bh * pt });
    for (const e of meta.outline || []) entries.push({ ...e, page: 0, yPt: (e.y - y0) * pt });
    onPage && onPage();
    return { pages: out, entries };
  }

  const n = (content && content.pages) || 1;
  for (let i = 0; i < n; i++) {
    const top = pageTop(i);
    const c = document.createElement('canvas');
    c.width = Math.round(PAGE_W * RES); c.height = Math.round(PAGE_H * RES);
    const g = c.getContext('2d');
    g.scale(RES, RES); g.translate(0, -top);
    drawPaper(g, top, paper, dark, RES);
    g.save();
    g.beginPath(); g.rect(0, top, PAGE_W, PAGE_H); g.clip();
    for (const it of ink) {
      const bb = bounds(it);
      if (bb.y1 < top || bb.y0 > top + PAGE_H) continue;
      drawInk(g, it, dark);
    }
    g.restore();
    footer(g, top, meta.title, n > 1 ? `${i + 1} de ${n}` : '', dark);
    out.push({ jpeg: await jpeg(c), pxW: c.width, pxH: c.height, w: PT_W, h: PAGE_H * PT });
    onPage && onPage();
  }
  for (const e of meta.outline || []) {
    const p = Math.max(1, Math.min(n, e.page || 1)) - 1;
    entries.push({ ...e, page: p, yPt: Math.max(0, (e.y - pageTop(p) - 16) * PT) });
  }
  return { pages: out, entries };
}

const entryTitle = e => e.title || (e.kind === 'mark' ? 'Título escrito a mano' : 'Sin título');

// Portada de una materia: nombre y lista de notas con su página.
async function coverPage(subject, notes, startPages, dark = false) {
  const C = dark ? { bg: '#1E2533', ink: '#E8EDF5', muted: '#9AA6BA', rule: '#2F394B' } : { bg: '#fff', ink: '#18202E', muted: '#5F6C82', rule: '#DCE1EA' };
  await Promise.all([
    document.fonts && document.fonts.load('800 70px "Bricolage Grotesque"'),
    document.fonts && document.fonts.load('400 26px "Atkinson Hyperlegible"'),
  ]);
  const c = document.createElement('canvas');
  c.width = Math.round(PAGE_W * RES); c.height = Math.round(PAGE_H * RES);
  const g = c.getContext('2d');
  g.scale(RES, RES);
  g.fillStyle = C.bg; g.fillRect(0, 0, PAGE_W, PAGE_H);
  g.fillStyle = subject.color; g.fillRect(0, 0, 26, PAGE_H);
  g.fillStyle = C.ink;
  g.font = '800 64px "Bricolage Grotesque", sans-serif';
  let name = subject.name;
  while (g.measureText(name).width > PAGE_W - 170 && name.length > 4) name = name.slice(0, -2);
  if (name !== subject.name) name += '…';
  g.fillText(name, 90, 190);
  g.fillStyle = subject.color; g.fillRect(90, 214, Math.min(PAGE_W - 180, g.measureText(name).width), 8);
  g.font = '24px "Atkinson Hyperlegible", sans-serif';
  g.fillStyle = C.muted;
  const d = new Date().toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
  g.fillText(`${notes.length} nota${notes.length === 1 ? '' : 's'}. Exportado el ${d}.`, 90, 270);
  let y = 370;
  g.font = '700 26px "Atkinson Hyperlegible", sans-serif';
  notes.forEach((n, i) => {
    if (y > PAGE_H - 90) return;
    g.fillStyle = C.ink;
    g.textAlign = 'left';
    let t = n.title;
    while (g.measureText(t).width > PAGE_W - 300 && t.length > 4) t = t.slice(0, -2);
    if (t !== n.title) t += '…';
    g.fillText(t, 90, y);
    g.textAlign = 'right';
    g.fillStyle = C.muted;
    g.fillText(String(startPages[i] + 1), PAGE_W - 90, y);
    g.strokeStyle = C.rule; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(90, y + 22); g.lineTo(PAGE_W - 90, y + 22); g.stroke();
    y += 62;
  });
  if (y > PAGE_H - 90 && notes.length) {
    g.textAlign = 'left'; g.fillStyle = C.muted; g.font = '22px "Atkinson Hyperlegible", sans-serif';
    g.fillText('El índice completo está en el panel de marcadores del PDF.', 90, PAGE_H - 50);
  }
  return { jpeg: await jpeg(c), pxW: c.width, pxH: c.height, w: PT_W, h: PAGE_H * PT };
}

/**
 * list: [{ meta, content }] en orden.  subject: si se exporta una materia completa (agrega portada).
 * Devuelve un Blob con el PDF.
 */
export async function exportPdf(list, { title, subject, onProgress, dark = false }) {
  if (document.fonts) await document.fonts.ready;
  const total = list.reduce((a, x) => a + ((x.meta.layout || 'pages') === 'canvas' ? 1 : (x.content && x.content.pages) || 1), 0);
  let done = 0;
  const tick = () => { done++; onProgress && onProgress(done, total); };
  const pages = [];
  const outline = [];
  const starts = [];
  const offset = subject ? 1 : 0;
  // Las páginas de inicio se calculan antes para la portada.
  let acc = 0;
  for (const x of list) { starts.push(acc + offset); acc += (x.meta.layout || 'pages') === 'canvas' ? 1 : (x.content && x.content.pages) || 1; }

  for (let i = 0; i < list.length; i++) {
    const { meta, content } = list[i];
    const r = await renderNote(meta, content, tick, dark);
    const first = pages.length + offset;
    pages.push(...r.pages);
    const kids = r.entries.map(e => ({ title: entryTitle(e), page: first + e.page, y: e.yPt }));
    // Subtítulos debajo del título anterior.
    const tree = [];
    for (const k of kids) {
      const e = r.entries[kids.indexOf(k)];
      const parent = tree[tree.length - 1];
      if (e.kind === 'h2' && parent && parent._kind === 'h1') (parent.children = parent.children || []).push(k);
      else { k._kind = e.kind; tree.push(k); }
    }
    if (list.length > 1) outline.push({ title: meta.title, page: first, y: 0, children: tree });
    else outline.push(...tree);
  }
  if (subject) pages.unshift(await coverPage(subject, list.map(x => x.meta), starts, dark));
  return buildPdf(pages, outline, title);
}

export function safeFileName(s) {
  return (s || 'NotesPro').replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70) || 'NotesPro';
}
