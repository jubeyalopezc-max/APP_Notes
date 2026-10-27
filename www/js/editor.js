import {
  PAGE_W, PAGE_H, PAGE_GAP, pageTop, PAPERS, drawPaper, drawItem, bounds, hits, translated,
} from './render.js';
import { recognize, describeShape } from './shapes.js';
import { uid } from './db.js';

const PEN_COLORS = ['#18202E', '#2D55E0', '#D9442F', '#1E9E5A', '#7A4BD6', '#E08A12'];
const HL_COLORS = ['#FFE14D', '#7EF29A', '#FF9EC7', '#8FD3FF', '#FFB86B'];
const SIZES = {
  pen: [2.2, 4, 7.5],
  hl: [16, 26, 40],
  eraser: [10, 24, 50],
  text: [22, 30, 44],
};
const HOLD_MS = 550;

const $ = s => document.querySelector(s);

function loadSettings() {
  const def = {
    tool: 'pen',
    pen: { color: PEN_COLORS[0], size: 1 },
    hl: { color: HL_COLORS[0], size: 1 },
    eraser: { size: 1 },
    text: { color: PEN_COLORS[0], size: 1 },
    fingerDraw: true,
    fingerDrawSetByUser: false,
  };
  try { return { ...def, ...JSON.parse(localStorage.getItem('np-settings') || '{}') }; }
  catch { return def; }
}
function saveSettings(s) { try { localStorage.setItem('np-settings', JSON.stringify(s)); } catch {} }

export function createEditor({ onSave, onClose, toast }) {
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

  function fitWidth() {
    view.s = Math.min((W - 32) / PAGE_W, 1.4);
    view.ox = (W - PAGE_W * view.s) / 2;
    view.oy = 20;
  }

  function clampView() {
    const s = view.s;
    if (PAGE_W * s <= W) view.ox = (W - PAGE_W * s) / 2;
    else view.ox = Math.min(40, Math.max(W - PAGE_W * s - 40, view.ox));
    const maxOy = 80, minOy = Math.min(maxOy, H - docH() * s - 140);
    view.oy = Math.min(maxOy, Math.max(minOy, view.oy));
  }

  function toDoc(cx, cy) {
    const r = stage.getBoundingClientRect();
    return { x: (cx - r.left - view.ox) / view.s, y: (cy - r.top - view.oy) / view.s };
  }
  function toScreen(x, y) { return { x: x * view.s + view.ox, y: y * view.s + view.oy }; }

  function zoomAt(sx, sy, factor) {
    const ns = Math.min(6, Math.max(0.25, view.s * factor));
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
    const css = getComputedStyle(document.documentElement);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = css.getPropertyValue('--desk').trim() || '#E4E8EF';
    ctx.fillRect(0, 0, W, H);
    if (!note) return;
    const { s, ox, oy } = view;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    const vy0 = -oy / s, vy1 = (H - oy) / s, vx0 = -ox / s, vx1 = (W - ox) / s;
    for (let i = 0; i < pages; i++) {
      const t = pageTop(i);
      if (t > vy1 || t + PAGE_H < vy0) continue;
      ctx.fillStyle = 'rgba(20,35,60,0.10)';
      ctx.fillRect(3, t + 5, PAGE_W, PAGE_H);
      drawPaper(ctx, t, paper, false);
    }
    for (const it of items) {
      if (editingText && it === editingText.item) continue;
      const b = bounds(it);
      if (b.y1 < vy0 || b.y0 > vy1 || b.x1 < vx0 || b.x0 > vx1) continue;
      drawItem(ctx, it, redraw);
    }
  }

  function paintLive() {
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
    if (action && action.kind === 'erase' && action.at) {
      lctx.beginPath();
      lctx.arc(action.at.x, action.at.y, action.r, 0, Math.PI * 2);
      lctx.lineWidth = 1.5 / view.s;
      lctx.strokeStyle = 'rgba(24,32,46,0.55)';
      lctx.stroke();
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
    redraw();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 900);
  }

  async function save() {
    clearTimeout(saveTimer);
    if (!note || !dirty) return;
    dirty = false;
    await onSave(note, { items, pages, paper }, thumbnail());
  }

  function thumbnail() {
    const c = document.createElement('canvas');
    const k = 240 / PAGE_W;
    c.width = 240; c.height = Math.round(PAGE_H * k);
    const g = c.getContext('2d');
    g.scale(k, k);
    drawPaper(g, 0, paper, false);
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
  const canResize = () => selected.length === 1 && (selected[0].type === 'image' || selected[0].type === 'text');

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
      if (types && !types.includes(it.type)) continue;
      if (hits(it, x, y, 10 / view.s)) return it;
    }
    return null;
  }

  // ---------- Texto ----------
  function startText(x, y, existing) {
    finishText();
    const conf = S.text;
    const item = existing || { id: uid(), type: 'text', x, y: y - SIZES.text[conf.size] * 0.65, w: Math.min(520, PAGE_W - x - 30), text: '', size: SIZES.text[conf.size], color: conf.color };
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
      const it = { id: uid(), type: 'image', src, x: Math.max(20, center.x - iw / 2), y: center.y - ih / 2, w: iw, h: ih };
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
        const hit = topItemAt(p.x, p.y, ['image', 'text', 'shape']);
        if (hit) { setSelection([hit]); startDrag(p); }
        else { setSelection([]); Object.assign(action, { kind: 'lasso', pts: [p] }); }
      }
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
    const keep = items.filter(it => it.type === 'image' || it.type === 'text' || !hits(it, p.x, p.y, r));
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
    const r = stage.getBoundingClientRect();
    if (e.ctrlKey) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
    else { view.oy -= e.deltaY; view.ox -= e.deltaX; clampView(); }
    if (editingText) editingText.place();
    redraw();
  }, { passive: false });

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
        b.setAttribute('aria-label', ['Fino', 'Medio', 'Grueso'][i]);
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
    else if ((k === 'delete' || k === 'backspace') && selected.length) selBar.querySelector('[data-act=del]').click();
  });

  // ---------- API ----------
  return {
    open(meta, content) {
      note = meta;
      items = (content && content.items) || [];
      pages = (content && content.pages) || 1;
      paper = meta.paper || 'lines';
      undoStack = []; redoStack = []; selected = []; dirty = false; action = null;
      updateUndoButtons();
      updateFingerButton();
      setTool(S.tool === 'image' ? 'pen' : S.tool);
      requestAnimationFrame(() => { resize(); fitWidth(); clampView(); redraw(); });
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
    addPage,
    save,
    get isOpen() { return !!note; },
    deselect() { if (selected.length) { setSelection([]); return true; } if (editingText) { finishText(); return true; } return false; },
  };
}

export { PAPERS };
