// Lápiz mágico: convierte un trazo a mano en una figura limpia.
// Entrada: arreglo de puntos {x, y}. Salida: figura o null si no se parece a ninguna.
// Figuras: line, arrow, polyline (abierta), polygon (cerrada), ellipse.

const TAU = Math.PI * 2;
const SNAP_DEG = 7;

const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function pathLength(p) {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += d(p[i - 1], p[i]);
  return L;
}

function bbox(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of p) {
    if (q.x < x0) x0 = q.x; if (q.y < y0) y0 = q.y;
    if (q.x > x1) x1 = q.x; if (q.y > y1) y1 = q.y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

export function resample(p, n) {
  const L = pathLength(p);
  if (L === 0 || p.length < 2) return p.slice();
  const step = L / (n - 1);
  const out = [{ x: p[0].x, y: p[0].y }];
  let acc = 0;
  const pts = p.map(q => ({ x: q.x, y: q.y }));
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = d(a, b);
    if (acc + seg >= step && seg > 0) {
      const t = (step - acc) / seg;
      const q = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
      out.push(q);
      pts.splice(i, 0, q);
      acc = 0;
    } else {
      acc += seg;
    }
  }
  while (out.length < n) out.push({ ...p[p.length - 1] });
  return out.slice(0, n);
}

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return d(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function rdp(p, eps) {
  if (p.length < 3) return p.slice();
  let max = 0, idx = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const dd = segDist(p[i], p[0], p[p.length - 1]);
    if (dd > max) { max = dd; idx = i; }
  }
  if (max > eps) {
    const l = rdp(p.slice(0, idx + 1), eps);
    const r = rdp(p.slice(idx), eps);
    return l.slice(0, -1).concat(r);
  }
  return [p[0], p[p.length - 1]];
}

// Endereza ángulos cercanos a horizontal / vertical.
function snapAngle(a, b) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  const len = d(a, b);
  for (const target of [-180, -90, 0, 90, 180]) {
    if (Math.abs(ang - target) < SNAP_DEG) {
      const r = target * Math.PI / 180;
      return { x: a.x + Math.cos(r) * len, y: a.y + Math.sin(r) * len };
    }
  }
  return { ...b };
}

function snapPolyEdges(v, closed) {
  // Si un lado es casi horizontal o vertical, iguala las coordenadas de sus extremos.
  const out = v.map(q => ({ ...q }));
  const n = out.length;
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = out[i], b = out[(i + 1) % n];
    const ang = Math.abs(Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI);
    if (ang < SNAP_DEG || ang > 180 - SNAP_DEG) { const y = (a.y + b.y) / 2; a.y = y; b.y = y; }
    else if (Math.abs(ang - 90) < SNAP_DEG) { const x = (a.x + b.x) / 2; a.x = x; b.x = x; }
  }
  return out;
}

function angleAt(prev, cur, next) {
  const a1 = Math.atan2(prev.y - cur.y, prev.x - cur.x);
  const a2 = Math.atan2(next.y - cur.y, next.x - cur.x);
  let a = Math.abs(a1 - a2);
  if (a > Math.PI) a = TAU - a;
  return a * 180 / Math.PI;
}

function fitEllipse(p) {
  let cx = 0, cy = 0;
  for (const q of p) { cx += q.x; cy += q.y; }
  cx /= p.length; cy /= p.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const q of p) {
    const x = q.x - cx, y = q.y - cy;
    sxx += x * x; syy += y * y; sxy += x * y;
  }
  sxx /= p.length; syy /= p.length; sxy /= p.length;
  let rot = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const c = Math.cos(-rot), s = Math.sin(-rot);
  let vx = 0, vy = 0;
  const local = p.map(q => {
    const x = q.x - cx, y = q.y - cy;
    const lx = x * c - y * s, ly = x * s + y * c;
    vx += lx * lx; vy += ly * ly;
    return { x: lx, y: ly };
  });
  let rx = Math.sqrt(2 * vx / p.length), ry = Math.sqrt(2 * vy / p.length);
  if (rx < 1 || ry < 1) return null;
  let err = 0;
  for (const q of local) {
    const r = Math.hypot(q.x / rx, q.y / ry);
    err += Math.abs(r - 1) * Math.min(rx, ry);
  }
  err /= local.length;
  // Cobertura angular: que el trazo rodee el centro.
  const bins = new Array(12).fill(0);
  for (const q of local) {
    const a = (Math.atan2(q.y / ry, q.x / rx) + TAU) % TAU;
    bins[Math.floor(a / TAU * 12) % 12] = 1;
  }
  const coverage = bins.reduce((a, b) => a + b, 0) / 12;
  return { cx, cy, rx, ry, rot, err, coverage };
}

function polyError(p, v) {
  let e = 0;
  for (const q of p) {
    let m = Infinity;
    for (let i = 0; i < v.length; i++) m = Math.min(m, segDist(q, v[i], v[(i + 1) % v.length]));
    e += m;
  }
  return e / p.length;
}

function closedVertices(p, diag) {
  // Empieza por el punto más lejano al centro (siempre es una esquina en un polígono).
  let cx = 0, cy = 0;
  for (const q of p) { cx += q.x; cy += q.y; }
  cx /= p.length; cy /= p.length;
  let far = 0, fi = 0;
  p.forEach((q, i) => { const dd = Math.hypot(q.x - cx, q.y - cy); if (dd > far) { far = dd; fi = i; } });
  const ring = p.slice(fi).concat(p.slice(0, fi));
  ring.push({ ...ring[0] });
  let v = rdp(ring, diag * 0.075);
  v.pop();
  // Une vértices muy cercanos.
  const merged = [];
  for (const q of v) {
    const last = merged[merged.length - 1];
    if (last && d(last, q) < diag * 0.1) { last.x = (last.x + q.x) / 2; last.y = (last.y + q.y) / 2; }
    else merged.push({ ...q });
  }
  if (merged.length > 2 && d(merged[0], merged[merged.length - 1]) < diag * 0.1) merged.pop();
  // Quita vértices casi rectos (ángulo > 155°).
  let changed = true;
  while (changed && merged.length > 3) {
    changed = false;
    for (let i = 0; i < merged.length; i++) {
      const a = merged[(i - 1 + merged.length) % merged.length], b = merged[i], c = merged[(i + 1) % merged.length];
      if (angleAt(a, b, c) > 155) { merged.splice(i, 1); changed = true; break; }
    }
  }
  return merged;
}

function cleanQuad(v) {
  const angles = v.map((q, i) => angleAt(v[(i + 3) % 4], q, v[(i + 1) % 4]));
  const rectish = angles.every(a => Math.abs(a - 90) < 20);
  if (rectish) {
    // Rectángulo: orientación promedio de los lados, módulo 90°.
    let sx = 0, sy = 0;
    for (let i = 0; i < 4; i++) {
      const a = v[i], b = v[(i + 1) % 4];
      const ang = Math.atan2(b.y - a.y, b.x - a.x) * 4;
      sx += Math.cos(ang); sy += Math.sin(ang);
    }
    let rot = Math.atan2(sy, sx) / 4;
    if (Math.abs(rot * 180 / Math.PI) < SNAP_DEG) rot = 0;
    const cx = v.reduce((s, q) => s + q.x, 0) / 4, cy = v.reduce((s, q) => s + q.y, 0) / 4;
    const c = Math.cos(-rot), s = Math.sin(-rot);
    const loc = v.map(q => ({ x: (q.x - cx) * c - (q.y - cy) * s, y: (q.x - cx) * s + (q.y - cy) * c }));
    const hw = loc.reduce((a, q) => a + Math.abs(q.x), 0) / 4;
    const hh = loc.reduce((a, q) => a + Math.abs(q.y), 0) / 4;
    const c2 = Math.cos(rot), s2 = Math.sin(rot);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({ x: cx + x * c2 - y * s2, y: cy + x * s2 + y * c2 }));
  }
  // Rombo: diagonales casi horizontales / verticales.
  const d1 = Math.atan2(v[2].y - v[0].y, v[2].x - v[0].x) * 180 / Math.PI;
  const d2 = Math.atan2(v[3].y - v[1].y, v[3].x - v[1].x) * 180 / Math.PI;
  const axisish = a => [0, 90, 180, -90, -180].some(t => Math.abs(a - t) < 12);
  if (axisish(d1) && axisish(d2)) {
    const b = bbox(v);
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    return [{ x: cx, y: b.y0 }, { x: b.x1, y: cy }, { x: cx, y: b.y1 }, { x: b.x0, y: cy }];
  }
  return snapPolyEdges(v, true);
}

function maybeRegular(v) {
  const n = v.length;
  const cx = v.reduce((s, q) => s + q.x, 0) / n, cy = v.reduce((s, q) => s + q.y, 0) / n;
  const r = v.map(q => Math.hypot(q.x - cx, q.y - cy));
  const mean = r.reduce((a, b) => a + b, 0) / n;
  const cv = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / n) / mean;
  if (cv > 0.14) return snapPolyEdges(v, true);
  // Mantiene el orden de los vértices y reparte ángulos iguales.
  const a0 = Math.atan2(v[0].y - cy, v[0].x - cx);
  const dir = Math.sign(signedArea(v)) || 1;
  return v.map((_, i) => {
    const a = a0 + dir * i * TAU / n;
    return { x: cx + Math.cos(a) * mean, y: cy + Math.sin(a) * mean };
  });
}

function signedArea(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function detectArrow(p) {
  const s = p[0];
  let far = 0, ti = 0;
  p.forEach(q => { far = Math.max(far, d(s, q)); });
  ti = p.findIndex(q => d(s, q) >= far * 0.97);
  if (ti < p.length * 0.4 || ti >= p.length - 2) return null;
  const shaft = p.slice(0, ti + 1);
  const head = p.slice(ti);
  const tip = p[ti];
  const shaftLen = pathLength(shaft);
  if (far / shaftLen < 0.9) return null;
  const headLen = pathLength(head);
  if (headLen < far * 0.06 || headLen > far * 0.9) return null;
  if (head.some(q => d(q, tip) > far * 0.45)) return null;
  // La punta debe "devolverse" hacia el inicio.
  const ux = (tip.x - s.x) / far, uy = (tip.y - s.y) / far;
  const back = head.reduce((m, q) => Math.min(m, (q.x - tip.x) * ux + (q.y - tip.y) * uy), 0);
  if (back > -far * 0.04) return null;
  return { kind: 'arrow', pts: [{ ...s }, snapAngle(s, tip)] };
}

function finishEllipse(ell) {
  let { cx, cy, rx, ry, rot } = ell;
  if (Math.min(rx, ry) / Math.max(rx, ry) > 0.86) {
    const r = (rx + ry) / 2;
    return { kind: 'ellipse', cx, cy, rx: r, ry: r, rot: 0 };
  }
  const deg = ((rot * 180 / Math.PI) % 180 + 180) % 180;
  if (deg < SNAP_DEG || deg > 180 - SNAP_DEG) rot = 0;
  else if (Math.abs(deg - 90) < SNAP_DEG) rot = Math.PI / 2;
  return { kind: 'ellipse', cx, cy, rx, ry, rot };
}

// Decide entre óvalo y polígono para un trazo cerrado (ya remuestreado).
function classifyClosed(rp, diag, ell) {
  const v = closedVertices(rp, diag);
  const pErr = v.length >= 3 ? polyError(rp, v) / diag : Infinity;
  const eErr = ell && ell.coverage > 0.8 ? ell.err / diag : Infinity;

  let useEllipse;
  if (v.length >= 3 && v.length <= 4) useEllipse = eErr < pErr * 0.7;
  else if (v.length >= 5 && v.length <= 6) useEllipse = eErr < pErr * 1.3;
  else useEllipse = true;

  if (useEllipse && eErr < 0.06) return finishEllipse(ell);
  if (!useEllipse && pErr < 0.045) {
    let pts;
    if (v.length === 3) pts = snapPolyEdges(v, true);
    else if (v.length === 4) pts = cleanQuad(v);
    else pts = maybeRegular(v);
    return { kind: 'polygon', pts };
  }
  return null;
}

// Quita ganchos en las puntas: el lapicito que se hace al apoyar o levantar el lápiz.
function trimHooks(rp) {
  const n = rp.length, w = 2, lim = Math.floor(n * 0.14);
  const dir = i => Math.atan2(rp[i + w].y - rp[i].y, rp[i + w].x - rp[i].x);
  const turn = (a, b) => { let t = Math.abs(a - b) % TAU; return t > Math.PI ? TAU - t : t; };
  let s = 0, e = n - 1;
  for (let i = lim; i >= w; i--) if (turn(dir(i - w), dir(i)) > 1.05) { s = i; break; }
  for (let i = n - 1 - lim; i <= n - 1 - 2 * w; i++) if (turn(dir(i), dir(i + w)) > 1.05) { e = i + w; break; }
  return e - s > n * 0.6 ? rp.slice(s, e + 1) : rp;
}

// Ajuste de cónica por mínimos cuadrados: sirve aunque al arco le falte un pedazo.
function fitConic(p) {
  let mx = 0, my = 0;
  for (const q of p) { mx += q.x; my += q.y; }
  mx /= p.length; my /= p.length;
  let sc = 0;
  for (const q of p) sc = Math.max(sc, Math.abs(q.x - mx), Math.abs(q.y - my));
  if (sc < 1) return null;
  const A = Array.from({ length: 5 }, () => new Array(6).fill(0));
  for (const q of p) {
    const x = (q.x - mx) / sc, y = (q.y - my) / sc;
    const row = [x * x, x * y, y * y, x, y];
    for (let i = 0; i < 5; i++) { for (let j = 0; j < 5; j++) A[i][j] += row[i] * row[j]; A[i][5] += row[i]; }
  }
  for (let c = 0; c < 5; c++) {
    let piv = c;
    for (let r = c + 1; r < 5; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < 5; r++) if (r !== c) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 6; k++) A[r][k] -= f * A[c][k];
    }
  }
  const [a, b, c, dd, e] = A.map((r, i) => r[5] / r[i]);
  if (b * b - 4 * a * c >= 0) return null; // no es una elipse
  const det = 4 * a * c - b * b;
  const x0 = (b * e - 2 * c * dd) / det, y0 = (b * dd - 2 * a * e) / det;
  const f0 = a * x0 * x0 + b * x0 * y0 + c * y0 * y0 + dd * x0 + e * y0 - 1;
  const rot = 0.5 * Math.atan2(b, a - c);
  const co = Math.cos(rot), si = Math.sin(rot);
  const l1 = a * co * co + b * co * si + c * si * si;
  const l2 = a * si * si - b * co * si + c * co * co;
  if (-f0 / l1 <= 0 || -f0 / l2 <= 0) return null;
  const rx = Math.sqrt(-f0 / l1) * sc, ry = Math.sqrt(-f0 / l2) * sc;
  const cx = mx + x0 * sc, cy = my + y0 * sc;
  // Error medio (sin contar el 10 % peor, por si queda algún temblor) y cobertura angular.
  const cr = Math.cos(-rot), sr = Math.sin(-rot);
  const res = [], bins = new Array(12).fill(0);
  for (const q of p) {
    const x = q.x - cx, y = q.y - cy;
    const lx = x * cr - y * sr, ly = x * sr + y * cr;
    res.push(Math.abs(Math.hypot(lx / rx, ly / ry) - 1) * Math.min(rx, ry));
    bins[Math.floor(((Math.atan2(ly / ry, lx / rx) + TAU) % TAU) / TAU * 12) % 12] = 1;
  }
  res.sort((u, v) => u - v);
  const keep = res.slice(0, Math.ceil(res.length * 0.9));
  const err = keep.reduce((u, v) => u + v, 0) / keep.length;
  return { cx, cy, rx, ry, rot, err, coverage: bins.reduce((u, v) => u + v, 0) / 12 };
}

// Ángulo acumulado que recorre el trazo alrededor de un centro, punto a punto.
function windingAngles(p, cx, cy) {
  const out = [0];
  let prev = Math.atan2(p[0].y - cy, p[0].x - cx), acc = 0;
  for (let i = 1; i < p.length; i++) {
    const a = Math.atan2(p[i].y - cy, p[i].x - cx);
    let da = a - prev;
    if (da > Math.PI) da -= TAU; else if (da < -Math.PI) da += TAU;
    acc += da; prev = a; out.push(acc);
  }
  return out;
}

function loopShape(rp0, diag) {
  const rp = trimHooks(rp0);
  const b = bbox(rp);
  const W = windingAngles(rp, b.x0 + b.w / 2, b.y0 + b.h / 2);
  const total = Math.abs(W[W.length - 1]);
  // Debe girar siempre hacia el mismo lado (una "S" o un garabato no).
  let back = 0;
  for (let i = 1; i < W.length; i++) {
    const da = (W[i] - W[i - 1]) * Math.sign(W[W.length - 1]);
    if (da < 0) back -= da;
  }
  if (back > 0.6) return null;

  if (total >= TAU * 0.97) {
    // Dio la vuelta completa o se pasó: se queda con una vuelta y se trata como cerrada.
    const sgn = Math.sign(W[W.length - 1]);
    let cut = W.findIndex(a => a * sgn >= TAU);
    if (cut < 0) cut = W.length - 1;
    const one = resample(rp.slice(0, cut + 1), 96);
    const ob = bbox(one), od = Math.hypot(ob.w, ob.h);
    const r = classifyClosed(one, od, fitEllipse(one));
    if (r) return r;
    const ell = fitConic(one);
    if (ell && ell.err / od < 0.05) return finishEllipse(ell);
    return null;
  }
  if (total >= TAU * 0.7) {
    // Le falta un pedazo: solo se completa si el arco es claramente un círculo u óvalo.
    const ell = fitConic(rp);
    // ¿Tiene esquinas? Entonces es un polígono abierto (un cuadrado o triángulo sin cerrar).
    const v = rdp(rp, diag * 0.06);
    if (v.length >= 4 && v.length <= 8) {
      let pe = 0;
      for (const q of rp) {
        let m = Infinity;
        for (let i = 0; i < v.length - 1; i++) m = Math.min(m, segDist(q, v[i], v[i + 1]));
        pe += m;
      }
      pe /= rp.length;
      if (!ell || pe < ell.err * 0.8) {
        const r = classifyClosed(rp, diag, null);
        return r && r.kind === 'polygon' ? r : null;
      }
    }
    if (!ell || ell.coverage < 0.66 || ell.err / diag > 0.035) return null;
    // Que la figura completada no sea mucho más grande que lo que se dibujó.
    if (Math.max(ell.rx, ell.ry) * 2 > diag * 1.15) return null;
    return finishEllipse(ell);
  }
  return null;
}

export function recognize(raw) {
  const p = [];
  for (const q of raw) if (!p.length || d(p[p.length - 1], q) > 0.5) p.push({ x: q.x, y: q.y });
  if (p.length < 4) return null;
  const L = pathLength(p);
  const b = bbox(p);
  const diag = Math.hypot(b.w, b.h);
  if (L < 14 || diag < 10) return null;
  const s = p[0], e = p[p.length - 1];
  const gap = d(s, e);

  // Línea recta
  if (gap / L > 0.94) return { kind: 'line', pts: [{ ...s }, snapAngle(s, e)] };

  const arrow = detectArrow(p);
  if (arrow) return arrow;

  const closed = gap < diag * 0.22 || gap / L < 0.1;
  let rp = resample(p, 96);

  if (closed) {
    const r = classifyClosed(rp, diag, fitEllipse(rp));
    if (r) return r;
  }

  // Trazo que da la vuelta pero no cierra bien: quedó un hueco, se pasó del inicio
  // o tiene ganchos en las puntas. Se recorta y se vuelve a intentar como figura cerrada.
  const loop = loopShape(rp, diag);
  if (loop) return loop;
  if (closed) return null;

  // Abierta: líneas quebradas (por ejemplo, ejes en "L" o un zigzag).
  const v = rdp(p, diag * 0.06);
  if (v.length >= 3 && v.length <= 5) {
    let err = 0;
    for (const q of rp) {
      let m = Infinity;
      for (let i = 0; i < v.length - 1; i++) m = Math.min(m, segDist(q, v[i], v[i + 1]));
      err += m;
    }
    err /= rp.length;
    const segs = v.slice(1).map((q, i) => d(v[i], q));
    // Un trazo curvo gana vértices al bajar la tolerancia; uno de rectas no.
    const fine = rdp(p, diag * 0.025).length;
    if (err / diag < 0.025 && Math.min(...segs) > diag * 0.12 && fine <= v.length + 1) {
      return { kind: 'polyline', pts: snapPolyEdges(v, false) };
    }
  }
  return null;
}

export const SHAPE_NAMES = {
  line: 'línea', arrow: 'flecha', polyline: 'líneas', ellipse: 'círculo', polygon: 'polígono',
};

export function describeShape(sh) {
  if (sh.kind === 'ellipse') return sh.rx === sh.ry ? 'círculo' : 'óvalo';
  if (sh.kind === 'polygon') {
    const n = sh.pts.length;
    if (n === 3) return 'triángulo';
    if (n === 4) return 'cuadrilátero';
    return ['', '', '', '', '', 'pentágono', 'hexágono'][n] || 'polígono';
  }
  return SHAPE_NAMES[sh.kind];
}
