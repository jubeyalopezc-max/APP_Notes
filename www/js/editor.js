import {
  PAGE_W, PAGE_H, PAGE_GAP, pageTop, PAPERS, drawPaper, drawPaperArea, drawItem, bounds, hits, translated, MARK_W, MARK_H, textLines, setInkDark,
} from './render.js';
import { recognize, describeShape } from './shapes.js';
import { uid } from './db.js';

const PEN_COLORS = ['#18202E', '#2D55E0', '#D9442F', '#1E9E5A', '#7A4BD6', '#E08A12'];
const HL_COLORS = ['#FFE14D', '#7EF29A', '#FF9EC7', '#8FD3FF', '#FFB86B'];
const SIZES = {
  pen: [2.2, 4, 7.5],
  hl: [16, 26, 40],
  eraser: [10, 24, 50],
  text: [22, 32, 46],   // normal, subtítulo, título (los dos últimos van al índice)
};
const HOLD_MS = 550;

const $ = s => document.querySelector(s);

function loadSettings() {
  const def = {
    tool: 'pen',
    pen: { color: PEN_COLORS[0], size: 1 },
    hl: { color: HL_COLORS[0], size: 1 },
    eraser: { size: 1 },
    text: { color: PEN_COLORS[0], size: 0 },
    fingerDraw: true,
    fingerDrawSetByUser: false,
    showMap: window.innerWidth > 700,
    studyMode: 'cover',   // herramienta Estudio: 'cover' (tapar) o 'card' (tarjeta)
    coverHl: false,       // en modo Estudiar, tapar también lo resaltado
  };
  try { return { ...def, ...JSON.parse(localStorage.getItem('np-settings') || '{}') }; }
  catch { return def; }
}
function saveSettings(s) { try { localStorage.setItem('np-settings', JSON.stringify(s)); } catch {} }

export function createEditor({ onSave, onClose, toast, askMark, onCapture, isDarkPaper }) {
  const darkPaper = () => !!(isDarkPaper && isDarkPaper());
  const stage = $('#stage');
  const cvMain = $('#cv-main');
  const cvLive = $('#cv-live');
  const ctx = cvMain.getContext('2d');
  const lctx = cvLive.getContext('2d');
  const selBar = $('#sel-bar');
  const imgInput = $('#img-input');

  const S = loadSettings();
  let note = null;          // datos de la nota abierta
  let items = [];
  let pages = 1;
  let paper = 'lines';
  let layout = 'pages';     // 'pages' (hojas) o 'canvas' (lienzo libre)
  let prevView = null;      // vista antes de "Ver todo", para volver
  let anim = null;
  let undoStack = [], redoStack = [];
  let view = { s: 1, ox: 0, oy: 0 };
  let W = 0, H = 0, dpr = 1;
  let dirty = false, saveTimer = null, drawQueued = false;

  // Estado de interacción
  const pointers = new Map();
  let action = null;        // {kind: 'draw'|'erase'|'lasso'|'drag'|'resize'|'gesture', ...}
  let penActive = false;
  let selected = [];
  let editingText = null;   // {item, el}

  // ---------- Vista ----------
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = stage.getBoundingClientRect();
    W = r.width; H = r.height;
    for (const c of [cvMain, cvLive]) {
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
      c.style.width = W + 'px'; c.style.height = H + 'px';
    }
    clampView();
    redraw();
  }

  const docH = () => pages * PAGE_H + (pages - 1) * PAGE_GAP;

  function contentBounds() {
    if (!items.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) {
      const b = bounds(it);
      if (b.x0 < x0) x0 = b.x0; if (b.y0 < y0) y0 = b.y0; if (b.x1 > x1) x1 = b.x1; if (b.y1 > y1) y1 = b.y1;
    }
    return { x0, y0, x1, y1 };
  }

  // Todo lo que hay en la nota: las hojas (si hay) más lo dibujado.
  function docBounds() {
    const c = contentBounds();
    if (layout === 'pages') {
      const b = { x0: 0, y0: 0, x1: PAGE_W, y1: docH() };
      if (c) { b.x0 = Math.min(b.x0, c.x0); b.y0 = Math.min(b.y0, c.y0); b.x1 = Math.max(b.x1, c.x1); b.y1 = Math.max(b.y1, c.y1); }
      return b;
    }
    return c || { x0: 0, y0: 0, x1: PAGE_W, y1: PAGE_W * 0.7 };
  }

  // Escala para ver todo con margen.
  function fitScale(b) {
    return Math.min((W - 48) / Math.max(1, b.x1 - b.x0), (H - 48) / Math.max(1, b.y1 - b.y0));
  }
  // El zoom mínimo siempre permite ver la nota completa, y un poco más.
  const minScale = () => Math.max(0.02, Math.min(0.25, fitScale(docBounds()) * 0.8));

  function fitWidth() {
    if (layout === 'canvas') {
      const c = contentBounds();
      view.s = 1;
      view.ox = c ? 24 - c.x0 : 24;
      view.oy = c ? 24 - c.y0 : 24;
      return;
    }
    view.s = Math.min((W - 32) / PAGE_W, 1.4);
    view.ox = (W - PAGE_W * view.s) / 2;
    view.oy = 20;
  }

  function viewForAll() {
    const b = docBounds();
    const s = Math.min(fitScale(b), layout === 'canvas' ? 1.5 : 1.4);
    return { s, ox: (W - (b.x1 - b.x0) * s) / 2 - b.x0 * s, oy: (H - (b.y1 - b.y0) * s) / 2 - b.y0 * s };
  }

  function clampView() {
    const s = view.s;
    if (layout === 'canvas') {
      // Lienzo libre: el centro de la pantalla puede ir hasta bien lejos de lo dibujado.
      const b = docBounds();
      const m = Math.max(1500, W / s, H / s);
      view.ox = Math.min(W / 2 - (b.x0 - m) * s, Math.max(W / 2 - (b.x1 + m) * s, view.ox));
      view.oy = Math.min(H / 2 - (b.y0 - m) * s, Math.max(H / 2 - (b.y1 + m) * s, view.oy));
      return;
    }
    if (PAGE_W * s <= W) view.ox = (W - PAGE_W * s) / 2;
    else view.ox = Math.min(40, Math.max(W - PAGE_W * s - 40, view.ox));
    const dh = docH() * s;
    if (dh < H - 160) view.oy = (H - dh) / 2;
    else {
      const maxOy = 80, minOy = Math.min(maxOy, H - dh - 140);
      view.oy = Math.min(maxOy, Math.max(minOy, view.oy));
    }
  }

  function animateTo(target) {
    cancelAnimationFrame(anim);
    const from = { ...view };
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t0 = performance.now(), dur = reduce ? 0 : 280;
    const step = now => {
      const t = dur ? Math.min(1, (now - t0) / dur) : 1;
      const e = 1 - Math.pow(1 - t, 3);
      // Interpolación en escala logarítmica para que el zoom se sienta parejo.
      const s = Math.exp(Math.log(from.s) + (Math.log(target.s) - Math.log(from.s)) * e);
      const fx = (W / 2 - from.ox) / from.s, fy = (H / 2 - from.oy) / from.s;
      const tx = (W / 2 - target.ox) / target.s, ty = (H / 2 - target.oy) / target.s;
      const cx = fx + (tx - fx) * e, cy = fy + (ty - fy) * e;
      view = { s, ox: W / 2 - cx * s, oy: H / 2 - cy * s };
      if (editingText) editingText.place();
      paint(); paintLive();
      if (t < 1) anim = requestAnimationFrame(step);
      else { view = { ...target }; clampView(); redraw(); }
    };
    anim = requestAnimationFrame(step);
  }

  // ---------- Vista de todas las páginas ----------
  const ov = $('#overview'), ovGrid = $('#ov-grid');
  function openOverview() {
    finishText();
    setSelection([]);
    ov.hidden = false;
    renderOverview();
    updateZoomUI();
  }
  function closeOverview() { ov.hidden = true; updateZoomUI(); redraw(); }
  function renderOverview() {
    const cur = currentPage();
    $('#ov-sub').textContent = `${pages} página${pages === 1 ? '' : 's'}. Toca una para ir a ella.`;
    // Columnas: las más grandes posibles que dejen ver todas las páginas sin desplazarse.
    const gw = ovGrid.clientWidth - 40, gh = ovGrid.clientHeight - 110;
    const n = pages + 1;
    let best = 130;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const w = Math.min((gw - (cols - 1) * 18) / cols, ((gh - (rows - 1) * 22) / rows - 28) * PAGE_W / PAGE_H);
      if (w > best) best = w;
    }
    const tw = Math.max(130, Math.min(360, best));
    ovGrid.style.gridTemplateColumns = `repeat(auto-fill, ${Math.floor(tw)}px)`;
    ovGrid.innerHTML = '';
    const pr = window.devicePixelRatio || 1;
    let pending = false;
    for (let i = 0; i < pages; i++) {
      const b = document.createElement('button');
      b.className = 'ov-page';
      b.setAttribute('aria-current', String(i + 1 === cur));
      b.setAttribute('aria-label', `Ir a la página ${i + 1}`);
      const c = document.createElement('canvas');
      c.width = Math.round(tw * pr); c.height = Math.round(tw * pr * PAGE_H / PAGE_W);
      const g = c.getContext('2d');
      const k = c.width / PAGE_W, top = pageTop(i);
      g.scale(k, k); g.translate(0, -top);
      const dk = darkPaper();
      drawPaper(g, top, paper, dk, k);
      g.beginPath(); g.rect(0, top, PAGE_W, PAGE_H); g.clip();
      setInkDark(dk);
      for (const it of items) {
        const bb = bounds(it);
        if (bb.y1 < top || bb.y0 > top + PAGE_H) continue;
        drawItem(g, it, () => { if (!pending) { pending = true; setTimeout(() => !ov.hidden && renderOverview(), 50); } });
      }
      setInkDark(false);
      const lbl = document.createElement('span');
      lbl.textContent = i + 1;
      b.append(c, lbl);
      b.onclick = () => goToPage(i);
      ovGrid.appendChild(b);
    }
    const add = document.createElement('button');
    add.className = 'ov-add';
    add.innerHTML = '<svg><use href="#i-plus"/></svg>Agregar página';
    add.onclick = () => { addPage(); closeOverview(); };
    ovGrid.appendChild(add);
  }
  function goToPage(i) {
    closeOverview();
    const s = Math.min((W - 32) / PAGE_W, 1.4);
    view = { s, ox: (W - PAGE_W * s) / 2, oy: 16 - pageTop(i) * s };
    clampView();
    redraw();
  }
  $('#ov-close').onclick = closeOverview;

  function showAll() {
    if (layout === 'pages') { ov.hidden ? openOverview() : closeOverview(); return; }
    if (prevView) { const v = prevView; prevView = null; updateZoomUI(); animateTo(v); return; }
    prevView = { ...view };
    updateZoomUI();
    animateTo(viewForAll());
  }

  function zoomButton(factor) {
    prevView = null;
    const ns = Math.min(6, Math.max(minScale(), view.s * factor));
    const k = ns / view.s;
    animateTo({ s: ns, ox: W / 2 - (W / 2 - view.ox) * k, oy: H / 2 - (H / 2 - view.oy) * k });
  }

  function resetZoom() {
    prevView = null;
    if (layout === 'pages') {
      // Ajusta la hoja al ancho conservando la zona que se está viendo.
      const cy = (H / 2 - view.oy) / view.s;
      const s = Math.min((W - 32) / PAGE_W, 1.4);
      animateTo({ s, ox: (W - PAGE_W * s) / 2, oy: H / 2 - cy * s });
    } else {
      const cx = (W / 2 - view.ox) / view.s, cy = (H / 2 - view.oy) / view.s;
      animateTo({ s: 1, ox: W / 2 - cx, oy: H / 2 - cy });
    }
  }

  function toDoc(cx, cy) {
    const r = stage.getBoundingClientRect();
    return { x: (cx - r.left - view.ox) / view.s, y: (cy - r.top - view.oy) / view.s };
  }
  function toScreen(x, y) { return { x: x * view.s + view.ox, y: y * view.s + view.oy }; }

  function zoomAt(sx, sy, factor) {
    const ns = Math.min(6, Math.max(minScale(), view.s * factor));
    const k = ns / view.s;
    view.ox = sx - (sx - view.ox) * k;
    view.oy = sy - (sy - view.oy) * k;
    view.s = ns;
    clampView();
  }

  // ---------- Dibujo ----------
  function redraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; paint(); paintLive(); });
  }

  function paint() {
    const dk = darkPaper();
    setInkDark(dk);
    try { paintInner(dk); } finally { setInkDark(false); }
  }

  function paintInner(dk) {
    const css = getComputedStyle(document.documentElement);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = css.getPropertyValue('--desk').trim() || '#E4E8EF';
    ctx.fillRect(0, 0, W, H);
    if (!note) return;
    const { s, ox, oy } = view;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    const vy0 = -oy / s, vy1 = (H - oy) / s, vx0 = -ox / s, vx1 = (W - ox) / s;
    if (layout === 'canvas') drawPaperArea(ctx, vx0, vy0, vx1, vy1, paper, s, dk);
    for (let i = 0; layout === 'pages' && i < pages; i++) {
      const t = pageTop(i);
      if (t > vy1 || t + PAGE_H < vy0) continue;
      ctx.fillStyle = 'rgba(20,35,60,0.10)';
      ctx.fillRect(3, t + 5, PAGE_W, PAGE_H);
      drawPaper(ctx, t, paper, dk, s);
    }
    for (const it of items) {
      if (editingText && it === editingText.item) continue;
      const b = bounds(it);
      if (b.y1 < vy0 || b.y0 > vy1 || b.x1 < vx0 || b.x0 > vx1) continue;
      drawItem(ctx, it, redraw);
    }
    drawCovers(ctx, vx0, vy0, vx1, vy1);
    updateZoomUI();
    paintMinimap();
    if (!ixPanel.hidden) markCurrent();
  }

  // ---------- Zoom y mapa ----------
  const zPct = $('#z-pct'), zAll = $('#z-all'), zMap = $('#z-map');
  const mm = $('#minimap'), mmCv = $('#mm-cv'), mmLabel = $('#mm-label');
  const mmCtx = mmCv.getContext('2d');
  const mmBase = document.createElement('canvas');
  let mmStale = true, mmLast = 0, mmTimer = null, mmMap = null, mmKey = '';

  function updateZoomUI() {
    zPct.textContent = Math.round(view.s * 100) + '%';
    const on = layout === 'pages' ? !ov.hidden : !!prevView;
    zAll.querySelector('.lbl').textContent = on ? 'Volver' : 'Ver todo';
    zAll.setAttribute('aria-pressed', String(on));
    zMap.setAttribute('aria-pressed', String(!!S.showMap));
  }

  function currentPage() {
    const cy = (H / 2 - view.oy) / view.s;
    return Math.max(1, Math.min(pages, Math.floor(cy / (PAGE_H + PAGE_GAP)) + 1));
  }

  function paintMinimap() {
    mm.hidden = !S.showMap || !note || !ov.hidden;
    if (mm.hidden) return;
    const b = { ...docBounds() };
    if (layout === 'canvas') {
      // En el lienzo libre el mapa incluye también la zona que se está viendo.
      b.x0 = Math.min(b.x0, -view.ox / view.s); b.y0 = Math.min(b.y0, -view.oy / view.s);
      b.x1 = Math.max(b.x1, (W - view.ox) / view.s); b.y1 = Math.max(b.y1, (H - view.oy) / view.s);
      const key = [b.x0, b.y0, b.x1, b.y1].map(Math.round).join();
      if (key !== mmKey) { mmKey = key; mmStale = true; mmLast = 0; }
    }
    const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
    const maxW = W < 600 ? 120 : 176, maxH = Math.min(260, H * 0.42);
    const k = Math.min(maxW / bw, maxH / bh);
    const mw = Math.max(40, Math.round(bw * k)), mh = Math.max(40, Math.round(bh * k));
    const pr = window.devicePixelRatio || 1;
    if (mmCv.width !== Math.round(mw * pr) || mmCv.height !== Math.round(mh * pr)) {
      mmCv.width = Math.round(mw * pr); mmCv.height = Math.round(mh * pr);
      mmCv.style.width = mw + 'px'; mmCv.style.height = mh + 'px';
      mmStale = true;
    }
    mmMap = { k, x0: b.x0, y0: b.y0, mw, mh };
    // El contenido del mapa se vuelve a dibujar como máximo 3 veces por segundo.
    const now = performance.now();
    if (mmStale && now - mmLast > 300) {
      mmStale = false; mmLast = now;
      mmBase.width = mmCv.width; mmBase.height = mmCv.height;
      const g = mmBase.getContext('2d');
      g.setTransform(k * pr, 0, 0, k * pr, -b.x0 * k * pr, -b.y0 * k * pr);
      const dk = darkPaper();
      if (layout === 'canvas') drawPaperArea(g, b.x0, b.y0, b.x1, b.y1, 'blank', k, dk);
      else for (let i = 0; i < pages; i++) { g.fillStyle = dk ? '#1E2533' : '#fff'; g.fillRect(0, pageTop(i), PAGE_W, PAGE_H); }
      setInkDark(dk);
      for (const it of items) drawItem(g, it, () => { mmStale = true; redraw(); });
      setInkDark(false);
    } else if (mmStale) {
      clearTimeout(mmTimer);
      mmTimer = setTimeout(redraw, 320);
    }
    mmCtx.setTransform(1, 0, 0, 1, 0, 0);
    mmCtx.clearRect(0, 0, mmCv.width, mmCv.height);
    mmCtx.drawImage(mmBase, 0, 0);
    // Rectángulo de lo que se ve en pantalla.
    mmCtx.setTransform(pr, 0, 0, pr, 0, 0);
    const vx = (-view.ox / view.s - b.x0) * k, vy = (-view.oy / view.s - b.y0) * k;
    const vw = W / view.s * k, vh = H / view.s * k;
    mmCtx.fillStyle = 'rgba(45,85,224,0.12)';
    mmCtx.strokeStyle = '#2D55E0';
    mmCtx.lineWidth = 2;
    mmCtx.fillRect(vx, vy, vw, vh);
    mmCtx.strokeRect(vx + 1, vy + 1, Math.max(4, vw - 2), Math.max(4, vh - 2));
    mmLabel.textContent = layout === 'pages' ? `Página ${currentPage()} de ${pages}` : 'Lienzo completo';
  }

  // Tocar o arrastrar en el mapa lleva la vista a ese punto.
  let mmDrag = false;
  function mmMove(e) {
    if (!mmMap) return;
    const r = mmCv.getBoundingClientRect();
    const x = (e.clientX - r.left) / mmMap.k + mmMap.x0, y = (e.clientY - r.top) / mmMap.k + mmMap.y0;
    prevView = null;
    view.ox = W / 2 - x * view.s; view.oy = H / 2 - y * view.s;
    clampView();
    if (editingText) editingText.place();
    redraw();
  }
  mmCv.addEventListener('pointerdown', e => { mmDrag = true; try { mmCv.setPointerCapture(e.pointerId); } catch {} mmMove(e); });
  mmCv.addEventListener('pointermove', e => { if (mmDrag) mmMove(e); });
  mmCv.addEventListener('pointerup', () => { mmDrag = false; });
  mmCv.addEventListener('pointercancel', () => { mmDrag = false; });

  $('#z-in').onclick = () => zoomButton(1.25);
  $('#z-out').onclick = () => zoomButton(0.8);
  zPct.onclick = resetZoom;
  zAll.onclick = showAll;
  zMap.onclick = () => { S.showMap = !S.showMap; saveSettings(S); mmStale = true; redraw(); };

  function paintLive() {
    setInkDark(darkPaper());
    try { paintLiveInner(); } finally { setInkDark(false); }
  }

  function paintLiveInner() {
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.clearRect(0, 0, W, H);
    lctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.ox, dpr * view.oy);
    if (action && action.kind === 'draw') {
      drawItem(lctx, action.shape ? shapeItem(action.shape, action) : liveStroke(), redraw);
    }
    if (action && action.kind === 'lasso' && action.pts.length > 1) {
      lctx.save();
      lctx.setLineDash([8 / view.s, 7 / view.s]);
      lctx.lineWidth = 1.6 / view.s;
      lctx.strokeStyle = '#2D55E0';
      lctx.fillStyle = 'rgba(45,85,224,0.06)';
      lctx.beginPath();
      action.pts.forEach((q, i) => i ? lctx.lineTo(q.x, q.y) : lctx.moveTo(q.x, q.y));
      lctx.closePath(); lctx.fill(); lctx.stroke();
      lctx.restore();
    }
    if (action && action.kind === 'rect') {
      const r = normRect(action.start, action.cur);
      lctx.save();
      lctx.setLineDash([8 / view.s, 6 / view.s]);
      lctx.lineWidth = 2 / view.s;
      lctx.strokeStyle = action.mode === 'card' ? '#B07800' : subjectColor();
      lctx.fillStyle = action.mode === 'card' ? 'rgba(255,217,59,0.22)' : hexA(subjectColor(), 0.18);
      lctx.fillRect(r.x, r.y, r.w, r.h);
      lctx.strokeRect(r.x, r.y, r.w, r.h);
      lctx.restore();
    }
    if (action && action.kind === 'erase' && action.at) {
      lctx.beginPath();
      lctx.arc(action.at.x, action.at.y, action.r, 0, Math.PI * 2);
      lctx.lineWidth = 1.5 / view.s;
      lctx.strokeStyle = 'rgba(24,32,46,0.55)';
      lctx.stroke();
    }
    if (flash) {
      const t = (performance.now() - flash.t0) / 1300;
      if (t >= 1) flash = null;
      else if (t > 0) {
        const a = t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8;
        const b = flash.b, pad = 12;
        lctx.save();
        lctx.fillStyle = `rgba(255,217,59,${0.38 * a})`;
        lctx.strokeStyle = `rgba(224,150,0,${0.9 * a})`;
        lctx.lineWidth = 2.5 / view.s;
        lctx.beginPath();
        lctx.roundRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + pad * 2, b.y1 - b.y0 + pad * 2, 10);
        lctx.fill(); lctx.stroke();
        lctx.restore();
      }
    }
    placeSelBar();
    if (selected.length) {
      const b = selBounds();
      lctx.save();
      lctx.setLineDash([7 / view.s, 6 / view.s]);
      lctx.lineWidth = 1.8 / view.s;
      lctx.strokeStyle = '#2D55E0';
      lctx.strokeRect(b.x0 - 6, b.y0 - 6, b.x1 - b.x0 + 12, b.y1 - b.y0 + 12);
      lctx.setLineDash([]);
      if (canResize()) {
        lctx.fillStyle = '#FFD93B';
        lctx.strokeStyle = '#18202E';
        lctx.beginPath();
        lctx.arc(b.x1 + 6, b.y1 + 6, 11 / view.s, 0, Math.PI * 2);
        lctx.fill(); lctx.stroke();
      }
      lctx.restore();
    }
  }

  function currentStyle() {
    const t = S.tool === 'magic' ? 'pen' : S.tool;
    const conf = S[t];
    return { color: conf.color, width: SIZES[t][conf.size] };
  }

  function liveStroke(a = action) {
    return { type: 'stroke', tool: a.tool === 'hl' ? 'hl' : 'pen', color: a.color, width: a.width, pts: a.pts };
  }
  function shapeItem(sh, a) {
    return { id: uid(), type: 'shape', ...sh, color: a.color, width: a.width };
  }

  // ---------- Historial ----------
  function snapshot() { return { items: items.slice(), pages }; }
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > 80) undoStack.shift();
    redoStack = [];
    updateUndoButtons();
  }
  function restore(st) { items = st.items; pages = st.pages; selected = []; clampView(); changed(); }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot()); restore(undoStack.pop()); updateUndoButtons();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot()); restore(redoStack.pop()); updateUndoButtons();
  }
  function updateUndoButtons() {
    $('#ed-undo').disabled = !undoStack.length;
    $('#ed-redo').disabled = !redoStack.length;
  }

  function changed() {
    dirty = true;
    coverCache = null;
    mmStale = true;
    if (!ixPanel.hidden) renderIndex();
    redraw();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 900);
  }

  async function save() {
    clearTimeout(saveTimer);
    if (!note || !dirty) return;
    dirty = false;
    await onSave(note, { items, pages, paper }, thumbnail(), outline());
  }

  function thumbnail() {
    const c = document.createElement('canvas');
    const k = 240 / PAGE_W;
    c.width = 240; c.height = Math.round(PAGE_H * k);
    const g = c.getContext('2d');
    if (layout === 'canvas') {
      // Miniatura del lienzo: todo lo dibujado, centrado.
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      const b = contentBounds();
      if (b) {
        const pad = 30, bw = b.x1 - b.x0 + pad * 2, bh = b.y1 - b.y0 + pad * 2;
        const kk = Math.min(c.width / bw, c.height / bh, 0.5);
        g.translate((c.width - bw * kk) / 2, (c.height - bh * kk) / 2);
        g.scale(kk, kk);
        g.translate(pad - b.x0, pad - b.y0);
        for (const it of items) drawItem(g, it, () => {});
      }
      return c.toDataURL('image/jpeg', 0.7);
    }
    g.scale(k, k);
    drawPaper(g, 0, paper, false, k);
    for (const it of items) { const b = bounds(it); if (b.y0 < PAGE_H) drawItem(g, it, () => {}); }
    return c.toDataURL('image/jpeg', 0.7);
  }

  // ---------- Selección ----------
  function selBounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of selected) {
      const b = bounds(it);
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
    }
    return { x0, y0, x1, y1 };
  }
  const canResize = () => selected.length === 1 && ['image', 'text', 'cover'].includes(selected[0].type);

  function placeSelBar() {
    if (!selected.length || (action && (action.kind === 'drag' || action.kind === 'resize'))) { selBar.hidden = true; return; }
    const b = selBounds();
    const p = toScreen((b.x0 + b.x1) / 2, b.y0);
    selBar.hidden = false;
    const bw = selBar.offsetWidth;
    selBar.style.left = Math.max(8, Math.min(W - bw - 8, p.x - bw / 2)) + 'px';
    selBar.style.top = Math.max(8, p.y - 64) + 'px';
  }

  function setSelection(list) { selected = list; redraw(); }

  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  function lassoSelect(poly) {
    const res = items.filter(it => {
      if (it.type === 'mark' || it.bg) return false;
      if (it.type === 'stroke') {
        let n = 0, k = 0;
        for (let i = 0; i < it.pts.length; i += 3 * 3) { n++; if (pointInPoly(it.pts[i], it.pts[i + 1], poly)) k++; }
        return n && k / n >= 0.6;
      }
      const b = bounds(it);
      return pointInPoly((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, poly);
    });
    setSelection(res);
  }

  function topItemAt(x, y, types) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.bg) continue; // las páginas de un PDF importado no se seleccionan
      if (types && !types.includes(it.type)) continue;
      if (hits(it, x, y, 10 / view.s)) return it;
    }
    return null;
  }

  // ---------- Texto ----------
  function startText(x, y, existing) {
    finishText();
    const conf = S.text;
    const item = existing || { id: uid(), type: 'text', x, y: y - SIZES.text[conf.size] * 0.65, w: layout === 'canvas' ? 520 : Math.min(520, PAGE_W - x - 30), text: '', size: SIZES.text[conf.size], color: conf.color };
    if (item.w < 120) item.w = 120;
    const el = document.createElement('textarea');
    el.className = 'text-edit';
    el.value = item.text;
    el.setAttribute('aria-label', 'Texto');
    stage.appendChild(el);
    editingText = { item, el, isNew: !existing };
    const place = () => {
      const p = toScreen(item.x, item.y);
      el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
      el.style.width = item.w * view.s + 'px';
      el.style.fontSize = item.size * view.s + 'px';
      el.style.color = item.color;
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    };
    editingText.place = place;
    el.addEventListener('input', place);
    el.addEventListener('blur', () => setTimeout(finishText, 0));
    place();
    redraw();
    setTimeout(() => el.focus(), 30);
  }

  function finishText() {
    if (!editingText) return;
    const { item, el, isNew } = editingText;
    editingText = null;
    const text = el.value.replace(/\s+$/, '');
    el.remove();
    if (isNew && text) { pushUndo(); items.push({ ...item, text }); changed(); }
    else if (!isNew && text !== item.text) {
      pushUndo();
      const i = items.indexOf(item);
      if (text) items[i] = { ...item, text }; else items.splice(i, 1);
      changed();
    } else redraw();
  }

  // ---------- Imágenes ----------
  function pickImage() { imgInput.value = ''; imgInput.click(); }

  imgInput.addEventListener('change', async () => {
    const f = imgInput.files && imgInput.files[0];
    if (!f) return;
    try {
      const { src, w, h } = await loadImageFile(f);
      const center = toDoc(stage.getBoundingClientRect().left + W / 2, stage.getBoundingClientRect().top + H / 2);
      const maxW = PAGE_W * 0.7;
      const k = Math.min(1, maxW / w, (PAGE_H * 0.6) / h);
      const iw = w * k, ih = h * k;
      const it = { id: uid(), type: 'image', src, x: layout === 'canvas' ? center.x - iw / 2 : Math.max(20, center.x - iw / 2), y: center.y - ih / 2, w: iw, h: ih };
      pushUndo();
      items.push(it);
      changed();
      setTool('select');
      setSelection([it]);
      toast('Imagen insertada. Arrástrala o usa el punto amarillo para cambiar su tamaño.');
    } catch {
      toast('No se pudo abrir la imagen. Prueba con otra foto.');
    }
  });

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 1800;
        const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        const png = file.type === 'image/png' && c.width * c.height < 900 * 900;
        resolve({ src: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.86), w: c.width, h: c.height });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(); };
      img.src = url;
    });
  }

  // ---------- Entrada (lápiz, dedo, mouse) ----------
  function isEraserButton(e) { return e.pointerType === 'pen' && ((e.buttons & 32) || (e.buttons & 2)); }

  function pressureOf(e) {
    if (e.pointerType === 'pen') return Math.max(0.05, Math.min(1, e.pressure || 0.5));
    return 0.5;
  }

  function onDown(e) {
    if (e.pointerType === 'pen') {
      penActive = true;
      if (!S.fingerDrawSetByUser && S.fingerDraw) {
        S.fingerDraw = false; saveSettings(S); updateFingerButton();
        toast('Lápiz detectado: ahora el dedo mueve la página y la palma no raya.');
      }
    }
    if (editingText && e.target !== editingText.el) { finishText(); if (S.tool === 'text') return; }

    if (e.pointerType === 'touch') {
      // Mientras el lápiz está en uso, se ignoran los toques (palma).
      if (penActive && action && action.kind !== 'gesture') return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
      const touchDraws = S.fingerDraw && !penActive;
      if (!touchDraws || pointers.size > 1) {
        if (action && action.kind === 'draw') action = null; // se cancela el trazo si entra un segundo dedo
        startGesture();
        return;
      }
    }
    if (e.pointerType === 'mouse' && e.button === 1) { startGesture(e); return; }
    try { cvLive.setPointerCapture(e.pointerId); } catch {}
    const p = toDoc(e.clientX, e.clientY);
    const tool = isEraserButton(e) ? 'eraser' : S.tool;
    const mk = markAt(p);
    if (mk && tool !== 'eraser') { action = null; editMark(mk); return; }
    if (studying) {
      const c = coverAt(p);
      if (c) { action = null; toggleReveal(c); return; }
    }
    action = { pointerId: e.pointerId, type: e.pointerType };

    if (tool === 'pen' || tool === 'magic' || tool === 'hl') {
      if (selected.length) setSelection([]);
      const st = currentStyle();
      Object.assign(action, {
        kind: 'draw', tool, color: st.color, width: st.width,
        pts: [p.x, p.y, pressureOf(e)], raw: [{ x: p.x, y: p.y }],
        last: { x: e.clientX, y: e.clientY }, shape: null,
      });
      if (tool === 'pen') armHold();
    } else if (tool === 'eraser') {
      const r = SIZES.eraser[S.eraser.size] / 2;
      Object.assign(action, { kind: 'erase', r, before: snapshot(), changed: false, at: p });
      eraseAt(p);
    } else if (tool === 'select') {
      const b = selected.length ? selBounds() : null;
      const handleR = 26 / view.s;
      if (b && canResize() && Math.hypot(p.x - b.x1 - 6, p.y - b.y1 - 6) < handleR) {
        pushUndo();
        Object.assign(action, { kind: 'resize', start: p, idx: items.indexOf(selected[0]), orig: selected[0] });
      } else if (b && p.x > b.x0 - 10 && p.x < b.x1 + 10 && p.y > b.y0 - 10 && p.y < b.y1 + 10) {
        startDrag(p);
      } else {
        const hit = topItemAt(p.x, p.y, ['image', 'text', 'shape', 'cover']);
        if (hit) { setSelection([hit]); startDrag(p); }
        else { setSelection([]); Object.assign(action, { kind: 'lasso', pts: [p] }); }
      }
    } else if (tool === 'study') {
      if (selected.length) setSelection([]);
      Object.assign(action, { kind: 'rect', mode: S.studyMode, start: p, cur: p });
    } else if (tool === 'text') {
      const hit = topItemAt(p.x, p.y, ['text']);
      action = null;
      startText(p.x, p.y, hit);
    }
    redraw();
  }

  function startDrag(p) {
    pushUndo();
    const idx = selected.map(it => items.indexOf(it));
    Object.assign(action, { kind: 'drag', start: p, idx, orig: selected.slice(), moved: false });
  }

  let holdTimer = null;
  function armHold() {
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      if (!action || action.kind !== 'draw' || action.shape) return;
      const sh = recognize(action.raw);
      if (sh) {
        action.shape = sh;
        if (navigator.vibrate) navigator.vibrate(12);
        paintLive();
      }
    }, HOLD_MS);
  }

  function onMove(e) {
    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, { ...pointers.get(e.pointerId), x: e.clientX, y: e.clientY });
      if (action && action.kind === 'gesture') { moveGesture(); return; }
    }
    if (!action || action.pointerId !== e.pointerId) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    if (action.kind === 'draw') {
      if (action.shape) return;
      for (const ev of (evs.length ? evs : [e])) {
        const p = toDoc(ev.clientX, ev.clientY);
        const n = action.pts.length;
        if (Math.hypot(p.x - action.pts[n - 3], p.y - action.pts[n - 2]) < 0.6 / view.s) continue;
        action.pts.push(p.x, p.y, pressureOf(ev));
        action.raw.push(p);
      }
      if (action.tool === 'pen' && Math.hypot(e.clientX - action.last.x, e.clientY - action.last.y) > 5) {
        action.last = { x: e.clientX, y: e.clientY };
        armHold();
      }
      paintLive();
    } else if (action.kind === 'erase') {
      for (const ev of (evs.length ? evs : [e])) eraseAt(toDoc(ev.clientX, ev.clientY));
      action.at = toDoc(e.clientX, e.clientY);
      paintLive();
    } else if (action.kind === 'lasso') {
      action.pts.push(toDoc(e.clientX, e.clientY));
      paintLive();
    } else if (action.kind === 'rect') {
      action.cur = toDoc(e.clientX, e.clientY);
      paintLive();
    } else if (action.kind === 'drag') {
      const p = toDoc(e.clientX, e.clientY);
      const dx = p.x - action.start.x, dy = p.y - action.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 1) action.moved = true;
      const next = action.orig.map((it, k) => {
        const t = translated(it, dx, dy);
        items[action.idx[k]] = t;
        return t;
      });
      selected = next;
      redraw();
    } else if (action.kind === 'resize') {
      const p = toDoc(e.clientX, e.clientY);
      const o = action.orig;
      let t;
      if (o.type === 'image') {
        const w = Math.max(40, o.w + (p.x - action.start.x));
        t = { ...o, w, h: w * o.h / o.w };
      } else if (o.type === 'cover') {
        t = { ...o, w: Math.max(24, o.w + (p.x - action.start.x)), h: Math.max(18, o.h + (p.y - action.start.y)) };
      } else {
        t = { ...o, w: Math.max(100, o.w + (p.x - action.start.x)) };
      }
      items[action.idx] = t;
      selected = [t];
      redraw();
    }
  }

  function onUp(e) {
    if (pointers.has(e.pointerId)) {
      const ptr = pointers.get(e.pointerId);
      pointers.delete(e.pointerId);
      if (action && action.kind === 'gesture') {
        endGesture(ptr);
        return;
      }
    }
    if (e.pointerType === 'pen') penActive = false;
    if (!action || action.pointerId !== e.pointerId) return;
    clearTimeout(holdTimer);
    const a = action;
    action = null;
    if (a.kind === 'draw') commitStroke(a);
    else if (a.kind === 'erase') {
      if (a.changed) { undoStack.push(a.before); redoStack = []; updateUndoButtons(); changed(); }
    } else if (a.kind === 'lasso') {
      if (a.pts.length > 4) lassoSelect(a.pts);
    } else if (a.kind === 'drag') {
      if (a.moved) changed(); else { undoStack.pop(); updateUndoButtons(); }
    } else if (a.kind === 'resize') changed();
    else if (a.kind === 'rect') finishRect(a);
    redraw();
  }

  function commitStroke(a) {
    const stroke = { id: uid(), ...liveStroke(a) };
    let shape = a.shape;
    if (!shape && a.tool === 'magic') {
      shape = recognize(a.raw);
      if (!shape && a.raw.length > 3) toast('No reconocí una figura; quedó tu trazo a mano.');
    }
    pushUndo();
    items.push(stroke);
    if (shape) {
      // Primero se guarda el trazo original: "Deshacer" lo recupera.
      pushUndo();
      items[items.length - 1] = shapeItem(shape, a);
      toast(`Figura: ${describeShape(shape)}. Deshacer recupera tu trazo.`);
    }
    changed();
  }

  function eraseAt(p) {
    const r = action.r;
    const keep = items.filter(it => it.type === 'image' || it.type === 'text' || it.type === 'mark' || it.type === 'cover' || !hits(it, p.x, p.y, r));
    if (keep.length !== items.length) { items = keep; action.changed = true; redraw(); }
  }

  // Gestos: un dedo mueve, dos dedos mueven y hacen zoom. Toque con dos dedos = deshacer.
  function startGesture() {
    const pts = [...pointers.values()];
    action = { kind: 'gesture', start: performance.now(), maxCount: pts.length, travel: 0, ...gestureState(pts) };
  }
  function gestureState(pts) {
    if (pts.length >= 2) {
      const [a, b] = pts;
      return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y), n: 2 };
    }
    return { cx: pts[0].x, cy: pts[0].y, dist: 0, n: 1 };
  }
  function moveGesture() {
    const pts = [...pointers.values()];
    if (!pts.length) return;
    const g = gestureState(pts);
    action.maxCount = Math.max(action.maxCount, pts.length);
    if (g.n !== action.n) { Object.assign(action, g); return; }
    const r = stage.getBoundingClientRect();
    const dx = g.cx - action.cx, dy = g.cy - action.cy;
    action.travel += Math.abs(dx) + Math.abs(dy);
    if (action.travel > 18) prevView = null;
    view.ox += dx; view.oy += dy;
    if (g.n === 2 && action.dist > 0) zoomAt(g.cx - r.left, g.cy - r.top, g.dist / action.dist);
    clampView();
    Object.assign(action, g);
    if (editingText) editingText.place();
    redraw();
  }
  function endGesture() {
    if (pointers.size) { Object.assign(action, gestureState([...pointers.values()])); return; }
    const quick = performance.now() - action.start < 280 && action.travel < 18;
    if (quick && action.maxCount === 2) { undo(); toast('Deshecho'); }
    action = null;
  }

  cvLive.addEventListener('pointerdown', onDown);
  cvLive.addEventListener('pointermove', onMove);
  cvLive.addEventListener('pointerup', onUp);
  cvLive.addEventListener('pointercancel', e => {
    pointers.delete(e.pointerId);
    if (action && action.pointerId === e.pointerId) { action = null; redraw(); }
    if (action && action.kind === 'gesture' && !pointers.size) action = null;
  });
  cvLive.addEventListener('contextmenu', e => e.preventDefault());
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    prevView = null;
    const r = stage.getBoundingClientRect();
    if (e.ctrlKey) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
    else { view.oy -= e.deltaY; view.ox -= e.deltaX; clampView(); }
    if (editingText) editingText.place();
    redraw();
  }, { passive: false });


  // ---------- Índice y marcadores ----------
  const ixPanel = $('#index-panel'), ixList = $('#ix-list'), ixBtn = $('#ed-index');
  let flash = null, lastMarkColor = null;

  const pageOf = y => Math.max(1, Math.min(pages, Math.floor(y / (PAGE_H + PAGE_GAP)) + 1));

  // Índice automático: marcadores, títulos y subtítulos con teclado, e imágenes, en orden de lectura.
  function outline() {
    const out = [];
    for (const it of items) {
      if (it.type === 'mark') {
        const r = it.region;
        out.push({ kind: 'mark', id: it.id, title: it.title || '', color: it.color, snap: it.snap || null, x: r ? r.x0 : it.x, y: r ? r.y0 : it.y });
      } else if (it.type === 'text' && it.size >= 32 && it.text.trim()) {
        out.push({ kind: it.size >= 46 ? 'h1' : 'h2', id: it.id, title: it.text.trim().split('\n')[0].slice(0, 90), x: it.x, y: it.y });
      } else if (it.type === 'image' && it.bg) {
        if (it.title) out.push({ kind: 'pdf', id: it.id, title: it.title, x: it.x, y: it.y });
      } else if (it.type === 'image') {
        out.push({ kind: 'image', id: it.id, src: it.src, x: it.x, y: it.y });
      }
    }
    for (const e of out) e.page = layout === 'pages' ? pageOf(e.y) : null;
    // Elementos casi a la misma altura se ordenan de izquierda a derecha.
    out.sort((a, b) => (a.page || 0) - (b.page || 0) || (Math.abs(a.y - b.y) > 24 ? a.y - b.y : a.x - b.x));
    return out;
  }

  function toggleIndex(on = ixPanel.hidden) {
    ixPanel.hidden = !on;
    ixBtn.setAttribute('aria-pressed', String(on));
    stage.classList.toggle('ix-open', on);
    if (on) { if (!ov.hidden) closeOverview(); renderIndex(); }
    redraw();
  }

  function renderIndex() {
    const list = outline();
    ixList.innerHTML = '';
    if (!list.some(e => e.kind !== 'image')) {
      const p = document.createElement('p');
      p.className = 'ix-empty';
      p.textContent = 'Esta nota todavía no tiene títulos ni marcadores.';
      ixList.appendChild(p);
    }
    const groups = layout === 'pages' ? Array.from({ length: pages }, (_, i) => i + 1) : [null];
    for (const pg of groups) {
      if (pg !== null) {
        const h = document.createElement('button');
        h.className = 'ix-page';
        h.dataset.y = pageTop(pg - 1);
        h.textContent = `Página ${pg}`;
        h.onclick = () => jumpTo({ x: 0, y: pageTop(pg - 1) + 20 }, null);
        ixList.appendChild(h);
      }
      for (const e of list) if (e.page === pg) ixList.appendChild(entryEl(e));
    }
    markCurrent();
  }

  function entryEl(e) {
    const row = document.createElement('div');
    row.className = 'ix-row ' + e.kind;
    row.dataset.y = e.y;
    const b = document.createElement('button');
    b.className = 'ix-item';
    if (e.kind === 'mark') {
      row.style.setProperty('--c', e.color);
      const flag = document.createElement('span'); flag.className = 'ix-flag';
      const body = document.createElement('span'); body.className = 'ix-body';
      if (e.title || !e.snap) { const t = document.createElement('span'); t.className = 'ix-title'; t.textContent = e.title || 'Marcador'; body.appendChild(t); }
      if (e.snap) { const im = new Image(); im.src = e.snap; im.alt = e.title ? '' : 'Título escrito a mano'; im.className = 'ix-snap'; body.appendChild(im); }
      b.append(flag, body);
    } else if (e.kind === 'image') {
      const im = new Image(); im.src = e.src; im.alt = ''; im.className = 'ix-thumb';
      const t = document.createElement('span'); t.className = 'ix-title'; t.textContent = 'Imagen';
      b.append(im, t);
    } else {
      const t = document.createElement('span'); t.className = 'ix-title'; t.textContent = e.title;
      b.appendChild(t);
    }
    b.onclick = () => jumpTo(e, e.id);
    row.appendChild(b);
    if (e.kind === 'mark') {
      const ed = document.createElement('button');
      ed.className = 'icon-btn small';
      ed.setAttribute('aria-label', 'Editar marcador');
      ed.innerHTML = '<svg><use href="#i-dots"/></svg>';
      ed.onclick = () => { const mk = items.find(it => it.id === e.id); if (mk) editMark(mk); };
      row.appendChild(ed);
    }
    return row;
  }

  // Resalta en el índice la sección que se está viendo.
  function markCurrent() {
    const y = (-view.oy + H * 0.3) / view.s;
    let cur = null;
    for (const el of ixList.querySelectorAll('[data-y]')) {
      el.removeAttribute('aria-current');
      if (+el.dataset.y <= y) cur = el;
    }
    if (cur) cur.setAttribute('aria-current', 'true');
  }

  function jumpTo(pos, id, instant) {
    if (!ov.hidden) closeOverview();
    prevView = null;
    let target;
    if (layout === 'pages') {
      const s = Math.min((W - 32) / PAGE_W, 1.4);
      target = { s, ox: (W - PAGE_W * s) / 2, oy: 28 - (pos.y - 24) * s };
    } else {
      const s = Math.max(view.s, 0.8);
      target = { s, ox: 48 - (pos.x - 40) * s, oy: 48 - (pos.y - 40) * s };
    }
    const it = id && items.find(x => x.id === id);
    if (it || pos.w) {
      let b = !it ? { x0: pos.x, y0: pos.y, x1: pos.x + pos.w, y1: pos.y + pos.h } : it.type === 'mark' ? (it.region || { x0: it.x, y0: it.y, x1: layout === 'pages' ? PAGE_W - 40 : it.x + 500, y1: it.y + MARK_H }) : bounds(it);
      flash = { b, t0: performance.now() + (instant ? 150 : 300) };
      const loop = () => { paintLive(); if (flash) requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }
    if (W < 900 && !ixPanel.hidden) toggleIndex(false);
    if (instant) { view = target; clampView(); redraw(); }
    else animateTo(target);
  }

  function markAt(p) {
    const tol = 6 / view.s;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type === 'mark' && p.x >= it.x - tol && p.x <= it.x + MARK_W + tol && p.y >= it.y - tol && p.y <= it.y + MARK_H + tol) return it;
    }
    return null;
  }

  async function addMarkHere() {
    let y = (-view.oy + 36) / view.s;
    const x = layout === 'pages' ? 0 : (-view.ox + 24) / view.s;
    if (layout === 'pages') {
      // Que el marcador quede dentro de una hoja, no en el espacio entre dos.
      const i = Math.max(0, Math.min(pages - 1, Math.floor(y / (PAGE_H + PAGE_GAP))));
      const top = pageTop(i);
      if (y > top + PAGE_H - MARK_H - 8) y = i + 1 < pages ? pageTop(i + 1) + 16 : top + PAGE_H - MARK_H - 8;
      if (y < top + 8) y = top + 8;
    }
    const r = await askMark({ isNew: true, title: '', color: lastMarkColor });
    if (!r) return;
    lastMarkColor = r.color;
    pushUndo();
    items.push({ id: uid(), type: 'mark', x, y, title: r.title, color: r.color });
    changed();
    toast('Marcador agregado al índice');
  }

  // Recorte de lo seleccionado, para mostrar un título escrito a mano en el índice.
  function snapshotOf(list, b) {
    const pad = 8, bw = b.x1 - b.x0 + pad * 2, bh = b.y1 - b.y0 + pad * 2;
    const k = Math.min(2, 120 / bh, 640 / bw);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bw * k)); c.height = Math.max(1, Math.round(bh * k));
    const g = c.getContext('2d');
    g.scale(k, k); g.translate(pad - b.x0, pad - b.y0);
    for (const it of list) drawItem(g, it, () => {});
    return c.toDataURL('image/png');
  }

  async function markSelection() {
    const sel = selected.filter(it => it.type !== 'mark');
    if (!sel.length) return;
    const b = selBounds();
    const onlyText = sel.length === 1 && sel[0].type === 'text';
    const snap = onlyText ? null : snapshotOf(sel, b);
    const r = await askMark({ isNew: true, title: onlyText ? sel[0].text.trim().split('\n')[0].slice(0, 80) : '', color: lastMarkColor, snap });
    if (!r) return;
    lastMarkColor = r.color;
    pushUndo();
    items.push({
      id: uid(), type: 'mark', title: r.title, color: r.color, snap,
      x: layout === 'pages' ? 0 : b.x0 - MARK_W - 12, y: b.y0, region: { ...b },
    });
    setSelection([]);
    changed();
    toast('Marcado. Ya aparece en el índice.');
  }

  async function editMark(mk) {
    const r = await askMark({ isNew: false, title: mk.title, color: mk.color, snap: mk.snap });
    if (!r) return;
    const i = items.indexOf(mk);
    if (i < 0) return;
    pushUndo();
    if (r.action === 'del') { items.splice(i, 1); toast('Marcador eliminado'); }
    else { items[i] = { ...mk, title: r.title, color: r.color }; lastMarkColor = r.color; }
    changed();
  }

  ixBtn.onclick = () => toggleIndex();
  $('#ix-close').onclick = () => toggleIndex(false);
  $('#ix-mark').onclick = addMarkHere;


  // ---------- Estudio: tapar partes y crear tarjetas ----------
  const studyBtn = $('#ed-study'), studyBar = $('#study-bar'), studyCount = $('#study-count');
  const captureHint = $('#capture-hint');
  let studying = false;
  const revealed = new Set();
  let captureCancel = null;

  function subjectColor() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--subject').trim();
    return /^#[0-9a-f]{6}$/i.test(v) ? v : '#2D55E0';
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function normRect(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  // Bloques que tapan: los dibujados con la herramienta y, si se pide, lo resaltado.
  // Agranda un bloque para que tape completo lo que toca: los trazos que quedan en buena parte
  // dentro, y las palabras y renglones completos del texto escrito con teclado.
  const measure = document.createElement('canvas').getContext('2d');
  function fitCover(r) {
    let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
    const inside = (x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    for (const it of items) {
      if (it.bg || it.type === 'mark' || it.type === 'cover' || it.type === 'image') continue;
      const b = bounds(it);
      if (b.x1 < r.x || b.x0 > r.x + r.w || b.y1 < r.y || b.y0 > r.y + r.h) continue;
      if (it.type === 'text') {
        const lines = textLines(measure, it);
        const lh = it.size * 1.3;
        lines.forEach((ln, i) => {
          const ly0 = it.y + i * lh, ly1 = ly0 + lh;
          const ov = Math.min(ly1, r.y + r.h) - Math.max(ly0, r.y);
          if (ov < lh * 0.25) return;
          let cx = it.x;
          for (const word of ln.split(' ')) {
            const ww = measure.measureText(word).width;
            const wov = Math.min(cx + ww, r.x + r.w) - Math.max(cx, r.x);
            if (word && wov > ww * 0.4) {
              x0 = Math.min(x0, cx); x1 = Math.max(x1, cx + ww);
              y0 = Math.min(y0, ly0); y1 = Math.max(y1, ly1);
            }
            cx += ww + measure.measureText(' ').width;
          }
        });
        continue;
      }
      if (it.type === 'stroke') {
        if (it.tool === 'hl') continue;
        let n = 0, k = 0;
        for (let i = 0; i < it.pts.length; i += 3) { n++; if (inside(it.pts[i], it.pts[i + 1])) k++; }
        if (!n || k / n < 0.3) continue;
      } else if (it.type === 'shape') {
        const area = Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
        const ix = Math.max(0, Math.min(b.x1, r.x + r.w) - Math.max(b.x0, r.x)) * Math.max(0, Math.min(b.y1, r.y + r.h) - Math.max(b.y0, r.y));
        if (ix / area < 0.3) continue;
      }
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
    }
    const pad = 4;
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  }

  let coverCache = null;
  function coverList() {
    const key = `${studying}|${S.coverHl}|${items.length}`;
    if (coverCache && coverCache.key === key) return coverCache.list;
    const list = items.filter(it => it.type === 'cover')
      .map(c => (studying ? { ...c, ...fitCover(c) } : c));
    if (studying && S.coverHl) {
      for (const it of items) {
        if (it.type !== 'stroke' || it.tool !== 'hl') continue;
        const b = bounds(it);
        list.push({ id: it.id, type: 'cover', virtual: true, ...fitCover({ x: b.x0 + 2, y: b.y0 + 2, w: b.x1 - b.x0 - 4, h: b.y1 - b.y0 - 4 }) });
      }
    }
    coverCache = { key, list };
    return list;
  }

  function coverAt(p) {
    const list = coverList();
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) return c;
    }
    return null;
  }

  function drawCovers(g, vx0, vy0, vx1, vy1) {
    const col = subjectColor();
    for (const c of coverList()) {
      if (c.y + c.h < vy0 || c.y > vy1 || c.x + c.w < vx0 || c.x > vx1) continue;
      const hidden = studying && !revealed.has(c.id);
      const r = Math.min(10, c.w / 4, c.h / 4);
      g.save();
      g.beginPath();
      g.roundRect(c.x, c.y, c.w, c.h, r);
      if (hidden) {
        g.fillStyle = col;
        g.fill();
        g.clip();
        g.strokeStyle = 'rgba(255,255,255,0.16)';
        g.lineWidth = 6;
        g.beginPath();
        for (let d = -c.h; d < c.w; d += 22) { g.moveTo(c.x + d, c.y + c.h); g.lineTo(c.x + d + c.h, c.y); }
        g.stroke();
        if (c.h > 26 && c.w > 26) {
          const fs = Math.min(c.h * 0.55, 46);
          g.fillStyle = 'rgba(255,255,255,0.92)';
          g.font = `800 ${fs}px "Bricolage Grotesque", sans-serif`;
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText('?', c.x + c.w / 2, c.y + c.h / 2 + fs * 0.04);
        }
      } else {
        g.fillStyle = studying ? 'rgba(0,0,0,0)' : hexA(col, 0.10);
        g.fill();
        g.setLineDash([9 / view.s, 7 / view.s]);
        g.lineWidth = 2 / view.s;
        g.strokeStyle = hexA(col, studying ? 0.55 : 0.8);
        g.stroke();
      }
      g.restore();
    }
  }

  function toggleReveal(c) {
    if (revealed.has(c.id)) revealed.delete(c.id); else revealed.add(c.id);
    updateStudyBar();
    redraw();
  }

  function updateStudyBar() {
    const n = coverList().length;
    const r = coverList().filter(c => revealed.has(c.id)).length;
    studyCount.textContent = n ? `Destapadas ${r} de ${n}` : 'No hay partes tapadas';
    $('#study-hl').checked = !!S.coverHl;
  }

  function toggleStudy(on = !studying) {
    studying = on;
    coverCache = null;
    revealed.clear();
    studyBtn.setAttribute('aria-pressed', String(on));
    studyBar.hidden = !on;
    stage.classList.toggle('studying', on);
    if (on) {
      finishText();
      setSelection([]);
      if (!ov.hidden) closeOverview();
      if (!coverList().length) toast('Tapa partes con la herramienta Estudio, o activa “Tapar lo resaltado”.', { long: true });
    }
    updateStudyBar();
    redraw();
  }

  // Imagen de una zona de la nota (tinta, imágenes y páginas de PDF), para una tarjeta.
  function captureRegion(r) {
    const pad = 8;
    const x0 = r.x - pad, y0 = r.y - pad, bw = r.w + pad * 2, bh = r.h + pad * 2;
    const k = Math.min(3, 1000 / bw, 1000 / bh);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bw * k)); c.height = Math.max(1, Math.round(bh * k));
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.scale(k, k); g.translate(-x0, -y0);
    for (const it of items) {
      if (it.type === 'mark' || it.type === 'cover') continue;
      const b = bounds(it);
      if (b.x1 < x0 || b.x0 > x0 + bw || b.y1 < y0 || b.y0 > y0 + bh) continue;
      drawItem(g, it, () => {});
    }
    return c.toDataURL('image/jpeg', 0.88);
  }

  function finishRect(a) {
    const r = normRect(a.start, a.cur);
    if (r.w < 14 / view.s * 2 || r.h < 10 / view.s * 2) {
      toast(a.mode === 'card' ? 'Arrastra un rectángulo sobre lo que va en la tarjeta.' : 'Arrastra un rectángulo sobre lo que quieres tapar.');
      return;
    }
    if (a.mode === 'cover') {
      pushUndo();
      items.push({ id: uid(), type: 'cover', ...fitCover(r) });
      changed();
      return;
    }
    const img = captureRegion(r);
    const ref = { x: r.x, y: r.y, w: r.w, h: r.h, page: layout === 'pages' ? pageOf(r.y) : null };
    onCapture && onCapture({ img, ref });
  }

  function setCaptureHint(text, onCancel) {
    captureCancel = onCancel || null;
    captureHint.hidden = !text;
    if (text) {
      captureHint.querySelector('span').textContent = text;
      if (S.tool !== 'study' || S.studyMode !== 'card') { S.studyMode = 'card'; setTool('study'); }
    }
  }
  captureHint.querySelector('button').onclick = () => { const f = captureCancel; setCaptureHint(null); f && f(); };

  studyBtn.onclick = () => toggleStudy();
  $('#study-hide').onclick = () => { revealed.clear(); updateStudyBar(); redraw(); };
  $('#study-show').onclick = () => { coverList().forEach(c => revealed.add(c.id)); updateStudyBar(); redraw(); };
  $('#study-done').onclick = () => toggleStudy(false);
  $('#study-hl').onchange = e => { S.coverHl = e.target.checked; saveSettings(S); revealed.clear(); updateStudyBar(); redraw(); };

  // ---------- Barra de herramientas ----------
  function setTool(t) {
    if (t === 'image') { pickImage(); return; }
    finishText();
    S.tool = t; saveSettings(S);
    if (t !== 'select') setSelection([]);
    document.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
    renderOptions();
  }

  function renderOptions() {
    const t = S.tool === 'magic' ? 'pen' : S.tool;
    const sw = $('#swatches'), sz = $('#sizes');
    sw.innerHTML = ''; sz.innerHTML = '';
    if (t === 'study') {
      const seg = document.createElement('div');
      seg.className = 'seg seg-tool';
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Qué hacer con el rectángulo');
      for (const [mode, label] of [['cover', 'Tapar'], ['card', 'Crear tarjeta']]) {
        const b = document.createElement('button');
        b.textContent = label;
        b.setAttribute('aria-pressed', String(S.studyMode === mode));
        b.onclick = () => { S.studyMode = mode; saveSettings(S); renderOptions(); };
        seg.appendChild(b);
      }
      const hint = document.createElement('span');
      hint.className = 'tool-hint';
      hint.textContent = S.studyMode === 'card' ? 'Arrastra sobre la pregunta o la respuesta' : 'Arrastra sobre lo que quieres tapar';
      sw.append(seg, hint);
      $('#tool-options').hidden = false;
      return;
    }
    const colors = t === 'hl' ? HL_COLORS : (t === 'pen' || t === 'text') ? PEN_COLORS : null;
    if (colors) {
      for (const c of colors) {
        const b = document.createElement('button');
        b.className = 'swatch';
        b.style.setProperty('--c', c);
        b.setAttribute('aria-label', 'Color ' + c);
        b.setAttribute('aria-pressed', String(S[t].color === c));
        b.onclick = () => { S[t].color = c; saveSettings(S); recolorSelection(c); renderOptions(); };
        sw.appendChild(b);
      }
      const custom = document.createElement('label');
      custom.className = 'swatch custom';
      custom.title = 'Otro color';
      const inp = document.createElement('input');
      inp.type = 'color'; inp.value = S[t].color.length === 7 ? S[t].color : '#000000';
      inp.setAttribute('aria-label', 'Elegir otro color');
      inp.oninput = () => { S[t].color = inp.value; saveSettings(S); custom.style.setProperty('--c', inp.value); };
      inp.onchange = () => { recolorSelection(inp.value); renderOptions(); };
      if (!colors.includes(S[t].color)) { custom.style.setProperty('--c', S[t].color); custom.setAttribute('aria-pressed', 'true'); }
      custom.appendChild(inp);
      sw.appendChild(custom);
    }
    if (SIZES[t]) {
      SIZES[t].forEach((v, i) => {
        const b = document.createElement('button');
        b.className = 'size';
        b.setAttribute('aria-label', (t === 'text' ? ['Texto normal', 'Subtítulo', 'Título'] : ['Fino', 'Medio', 'Grueso'])[i]);
        b.title = b.getAttribute('aria-label');
        b.setAttribute('aria-pressed', String(S[t].size === i));
        const dot = document.createElement('span');
        const px = t === 'hl' ? [8, 12, 16][i] : t === 'eraser' ? [8, 13, 19][i] : t === 'text' ? [10, 14, 19][i] : [4, 7, 11][i];
        dot.style.width = dot.style.height = px + 'px';
        if (t === 'text') { dot.className = 'aa'; dot.textContent = 'A'; dot.style.fontSize = px + 'px'; dot.style.width = dot.style.height = 'auto'; }
        b.appendChild(dot);
        b.onclick = () => { S[t].size = i; saveSettings(S); renderOptions(); };
        sz.appendChild(b);
      });
    }
    $('#tool-options').hidden = !colors && !SIZES[t];
  }

  function recolorSelection(c) {
    if (!selected.length) return;
    const targets = selected.filter(it => it.type !== 'image');
    if (!targets.length) return;
    pushUndo();
    selected = selected.map(it => {
      if (it.type === 'image') return it;
      const t = { ...it, color: c };
      items[items.indexOf(it)] = t;
      return t;
    });
    changed();
  }

  function updateFingerButton() {
    const b = $('#ed-finger');
    b.setAttribute('aria-pressed', String(S.fingerDraw));
    b.title = S.fingerDraw ? 'El dedo dibuja' : 'El dedo mueve la página';
    b.querySelector('.lbl').textContent = S.fingerDraw ? 'Dedo dibuja' : 'Dedo mueve';
  }

  document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#ed-undo').onclick = undo;
  $('#ed-redo').onclick = redo;
  $('#ed-finger').onclick = () => {
    S.fingerDraw = !S.fingerDraw; S.fingerDrawSetByUser = true; saveSettings(S); updateFingerButton();
    toast(S.fingerDraw ? 'Ahora el dedo dibuja.' : 'Ahora el dedo mueve la página; dibuja con el lápiz.');
  };
  $('#add-page').onclick = addPage;
  selBar.addEventListener('click', e => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'del') { pushUndo(); const set = new Set(selected); items = items.filter(it => !set.has(it)); setSelection([]); changed(); }
    if (act === 'mark') markSelection();
    if (act === 'dup') {
      pushUndo();
      const copies = selected.map(it => ({ ...translated(it, 30, 30), id: uid() }));
      items.push(...copies); setSelection(copies); changed();
    }
  });

  function addPage() {
    pushUndo();
    pages++;
    changed();
    clampView();
    view.oy = Math.min(view.oy, -(pageTop(pages - 1) * view.s) + 40);
    clampView();
    redraw();
    toast(`Página ${pages} agregada`);
  }

  window.addEventListener('resize', () => { if (note) resize(); });
  document.addEventListener('keydown', e => {
    if (!note || editingText) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); }
    else if ((e.ctrlKey || e.metaKey) && k === '0') { e.preventDefault(); showAll(); }
    else if ((e.ctrlKey || e.metaKey) && (k === '+' || k === '=')) { e.preventDefault(); zoomButton(1.25); }
    else if ((e.ctrlKey || e.metaKey) && k === '-') { e.preventDefault(); zoomButton(0.8); }
    else if ((k === 'delete' || k === 'backspace') && selected.length) selBar.querySelector('[data-act=del]').click();
  });

  // ---------- API ----------
  return {
    open(meta, content, focus) {
      note = meta;
      items = (content && content.items) || [];
      pages = (content && content.pages) || 1;
      paper = meta.paper || 'lines';
      layout = meta.layout || 'pages';
      prevView = null; mmStale = true; ov.hidden = true;
      $('#add-page').hidden = layout !== 'pages';
      undoStack = []; redoStack = []; selected = []; dirty = false; action = null;
      studying = false; revealed.clear(); studyBar.hidden = true; studyBtn.setAttribute('aria-pressed', 'false');
      stage.classList.remove('studying'); captureHint.hidden = true;
      updateUndoButtons();
      updateFingerButton();
      setTool(S.tool === 'image' ? 'pen' : S.tool);
      ixPanel.hidden = true; ixBtn.setAttribute('aria-pressed', 'false');
      stage.classList.remove('ix-open');
      requestAnimationFrame(() => {
        resize(); fitWidth(); clampView();
        if (focus) jumpTo(focus, focus.id, true);
        redraw();
      });
    },
    async close() {
      finishText();
      await save();
      note = null;
      items = [];
      selBar.hidden = true;
    },
    setPaper(p) { paper = p; note.paper = p; dirty = true; changed(); },
    get paper() { return paper; },
    get layout() { return layout; },
    get pageCount() { return pages; },
    refresh() { mmStale = true; if (!ov.hidden) renderOverview(); redraw(); },
    setCaptureHint,
    get studying() { return studying; },
    get isEmpty() { return !items.length; },
    // Agrega páginas de un PDF importado (ya convertidas) al final de la nota.
    appendPdf(bgItems, count, replaceFirst) {
      pushUndo();
      items = [...bgItems, ...items];
      pages = replaceFirst ? Math.max(pages, count) : pages + count;
      changed();
      clampView();
      redraw();
    },
    showAll,
    addPage,
    save,
    get isOpen() { return !!note; },
    deselect() { if (!captureHint.hidden) { captureHint.querySelector('button').click(); return true; } if (studying) { toggleStudy(false); return true; } if (!ixPanel.hidden) { toggleIndex(false); return true; } if (!ov.hidden) { closeOverview(); redraw(); return true; } if (selected.length) { setSelection([]); return true; } if (editingText) { finishText(); return true; } return false; },
  };
}

export { PAPERS };
