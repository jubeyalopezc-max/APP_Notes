// Gráfica de funciones en un canvas: se arrastra para moverla, se pellizca (o rueda) para acercar,
// y doble toque para volver a la vista inicial.
export const PLOT_COLORS = ['#2D55E0', '#D93838', '#14915F', '#B5650B', '#8A3FD1'];

export function createPlot(canvas, { fns, shade = null, points = [], dark = false, x0 = null, x1 = null }) {
  const ctx = canvas.getContext('2d');
  let view = null, init = null;

  function autoView() {
    let a = x0 ?? -10, b = x1 ?? 10;
    const xs = points.map(p => p.x).filter(isFinite);
    if (shade) xs.push(shade.a, shade.b);
    if (xs.length && x0 == null) {
      const lo = Math.min(...xs), hi = Math.max(...xs), span = Math.max(hi - lo, 2);
      a = lo - span * 0.6; b = hi + span * 0.6;
    }
    // y: percentiles de los valores (los saltos a infinito no deben aplastar la gráfica)
    const ys = [];
    for (const { f } of fns) for (let k = 0; k <= 200; k++) { const y = f(a + (b - a) * k / 200); if (isFinite(y)) ys.push(y); }
    for (const p of points) if (isFinite(p.y)) ys.push(p.y);
    ys.sort((u, v) => u - v);
    let lo = -6, hi = 6;
    if (ys.length > 4) {
      lo = ys[Math.floor(ys.length * 0.04)]; hi = ys[Math.ceil(ys.length * 0.96) - 1];
      if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.15;
      lo -= pad; hi += pad;
      if (lo > 0 && lo < (hi - lo) * 0.5) lo = -(hi - lo) * 0.08;
      if (hi < 0 && -hi < (hi - lo) * 0.5) hi = (hi - lo) * 0.08;
    }
    return { a, b, lo, hi };
  }

  function size() {
    const r = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    return { w: r.width, h: r.height, dpr };
  }

  function niceStep(span, px) {
    const raw = span / Math.max(2, px / 70);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }
  const fmt = v => { const s = Math.abs(v) < 1e-10 ? '0' : Math.abs(v) >= 1e5 || Math.abs(v) < 1e-3 ? v.toExponential(0) : String(+v.toPrecision(4)); return s.replace('-', '−'); };

  function draw() {
    const { w, h, dpr } = size();
    if (!view) view = init = autoView();
    const { a, b, lo, hi } = view;
    const X = x => (x - a) / (b - a) * w, Y = y => h - (y - lo) / (hi - lo) * h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const col = dark ? { bg: '#1E2533', grid: '#2C3547', axis: '#8B97AB', txt: '#9AA6BA' } : { bg: '#FFFFFF', grid: '#E8ECF2', axis: '#5F6C82', txt: '#5F6C82' };
    ctx.fillStyle = col.bg; ctx.fillRect(0, 0, w, h);
    // cuadrícula
    const sx = niceStep(b - a, w), sy = niceStep(hi - lo, h);
    ctx.lineWidth = 1; ctx.strokeStyle = col.grid; ctx.beginPath();
    for (let x = Math.ceil(a / sx) * sx; x <= b; x += sx) { ctx.moveTo(Math.round(X(x)) + 0.5, 0); ctx.lineTo(Math.round(X(x)) + 0.5, h); }
    for (let y = Math.ceil(lo / sy) * sy; y <= hi; y += sy) { ctx.moveTo(0, Math.round(Y(y)) + 0.5); ctx.lineTo(w, Math.round(Y(y)) + 0.5); }
    ctx.stroke();
    // ejes
    const ax = Math.min(Math.max(Y(0), 0), h), ay = Math.min(Math.max(X(0), 0), w);
    ctx.strokeStyle = col.axis; ctx.lineWidth = 1.4; ctx.beginPath();
    ctx.moveTo(0, ax); ctx.lineTo(w, ax); ctx.moveTo(ay, 0); ctx.lineTo(ay, h); ctx.stroke();
    ctx.fillStyle = col.txt; ctx.font = '12px "Atkinson Hyperlegible", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let x = Math.ceil(a / sx) * sx; x <= b; x += sx) if (Math.abs(x) > sx / 2) ctx.fillText(fmt(x), X(x), Math.min(ax + 4, h - 16));
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let y = Math.ceil(lo / sy) * sy; y <= hi; y += sy) if (Math.abs(y) > sy / 2) ctx.fillText(fmt(y), Math.max(ay - 5, 30), Y(y));
    // área de la integral definida
    if (shade && fns[0]) {
      const f = fns[0].f, n = 160;
      ctx.beginPath(); ctx.moveTo(X(shade.a), Y(0));
      for (let k = 0; k <= n; k++) { const x = shade.a + (shade.b - shade.a) * k / n, y = f(x); ctx.lineTo(X(x), Y(isFinite(y) ? Math.max(Math.min(y, hi * 4), lo * 4) : 0)); }
      ctx.lineTo(X(shade.b), Y(0)); ctx.closePath();
      ctx.fillStyle = (fns[0].color || PLOT_COLORS[0]) + '33'; ctx.fill();
    }
    // curvas (se cortan en los saltos, como 1/x)
    fns.forEach(({ f, color }, idx) => {
      ctx.strokeStyle = color || PLOT_COLORS[idx % PLOT_COLORS.length]; ctx.lineWidth = 2.4; ctx.lineJoin = 'round';
      ctx.beginPath();
      const n = Math.ceil(w * 1.5);
      let pen = false, py = null;
      for (let k = 0; k <= n; k++) {
        const x = a + (b - a) * k / n, y = f(x);
        if (!isFinite(y)) { pen = false; continue; }
        const yy = Y(y);
        if (pen && py != null && Math.abs(yy - py) > h * 1.5) pen = false;
        if (!pen) { ctx.moveTo(k / n * w, yy); pen = true; } else ctx.lineTo(k / n * w, yy);
        py = yy;
      }
      ctx.stroke();
    });
    for (const p of points) {
      if (!isFinite(p.x) || !isFinite(p.y)) continue;
      ctx.fillStyle = col.bg; ctx.strokeStyle = p.color || '#18202E'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  // Gestos
  const ptrs = new Map();
  let start = null;
  const toWorld = (px, py, vw) => { const r = canvas.getBoundingClientRect(); return { x: vw.a + (px - r.left) / r.width * (vw.b - vw.a), y: vw.hi - (py - r.top) / r.height * (vw.hi - vw.lo) }; };
  canvas.addEventListener('pointerdown', e => {
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    start = { view: { ...view }, pts: new Map([...ptrs].map(([k, v]) => [k, { ...v }])) };
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId) || !start) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = canvas.getBoundingClientRect(), v0 = start.view;
    const ids = [...ptrs.keys()].filter(k => start.pts.has(k));
    if (ids.length >= 2) {
      const [p, q] = ids.map(k => ptrs.get(k)), [p0, q0] = ids.map(k => start.pts.get(k));
      const d0 = Math.hypot(q0.x - p0.x, q0.y - p0.y) || 1, d1 = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const k = d0 / d1;
      const c0 = toWorld((p0.x + q0.x) / 2, (p0.y + q0.y) / 2, v0);
      const cx = ((p.x + q.x) / 2 - r.left) / r.width, cy = ((p.y + q.y) / 2 - r.top) / r.height;
      const W = (v0.b - v0.a) * k, H = (v0.hi - v0.lo) * k;
      view = { a: c0.x - cx * W, b: c0.x + (1 - cx) * W, hi: c0.y + cy * H, lo: c0.y - (1 - cy) * H };
    } else if (ids.length === 1) {
      const p = ptrs.get(ids[0]), p0 = start.pts.get(ids[0]);
      const dx = (p.x - p0.x) / r.width * (v0.b - v0.a), dy = (p.y - p0.y) / r.height * (v0.hi - v0.lo);
      view = { a: v0.a - dx, b: v0.b - dx, lo: v0.lo + dy, hi: v0.hi + dy };
    }
    draw();
  });
  const up = e => {
    ptrs.delete(e.pointerId);
    start = ptrs.size ? { view: { ...view }, pts: new Map([...ptrs].map(([k, v]) => [k, { ...v }])) } : null;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const k = Math.exp(e.deltaY * 0.0015), c = toWorld(e.clientX, e.clientY, view);
    view = { a: c.x + (view.a - c.x) * k, b: c.x + (view.b - c.x) * k, lo: c.y + (view.lo - c.y) * k, hi: c.y + (view.hi - c.y) * k };
    draw();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { view = { ...init }; draw(); });

  draw();
  return {
    redraw: draw,
    reset() { view = { ...init }; draw(); },
    zoom(k) { const cx = (view.a + view.b) / 2, cy = (view.lo + view.hi) / 2; view = { a: cx + (view.a - cx) * k, b: cx + (view.b - cx) * k, lo: cy + (view.lo - cy) * k, hi: cy + (view.hi - cy) * k }; draw(); },
    setDark(d) { dark = d; draw(); },
    toDataURL: () => canvas.toDataURL('image/png'),
  };
}
