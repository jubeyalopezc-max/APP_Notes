// Dibujo de páginas y elementos. Todo se guarda en coordenadas de página.
// Página: 1000 × 1414 unidades (proporción A4), separadas por PAGE_GAP.

export const PAGE_W = 1000;
export const PAGE_H = 1414;
export const PAGE_GAP = 36;

export const pageTop = i => i * (PAGE_H + PAGE_GAP);

const pathCache = new WeakMap();
const boxCache = new WeakMap();
const imgCache = new Map();

export const PAPERS = {
  lines: 'Rayado',
  grid: 'Cuadriculado',
  dots: 'Puntos',
  blank: 'En blanco',
};

export function drawPaper(ctx, top, paper, dark) {
  ctx.fillStyle = dark ? '#1E2533' : '#FFFFFF';
  ctx.fillRect(0, top, PAGE_W, PAGE_H);
  const line = dark ? 'rgba(160,180,215,0.16)' : 'rgba(70,110,180,0.17)';
  ctx.lineWidth = 1.2;
  if (paper === 'lines') {
    ctx.strokeStyle = line;
    ctx.beginPath();
    for (let y = top + 120; y < top + PAGE_H - 30; y += 36) { ctx.moveTo(40, y); ctx.lineTo(PAGE_W - 40, y); }
    ctx.stroke();
    ctx.strokeStyle = dark ? 'rgba(240,120,130,0.30)' : 'rgba(220,70,80,0.30)';
    ctx.beginPath(); ctx.moveTo(110, top); ctx.lineTo(110, top + PAGE_H); ctx.stroke();
  } else if (paper === 'grid') {
    ctx.strokeStyle = line;
    ctx.beginPath();
    for (let x = 28; x < PAGE_W; x += 32) { ctx.moveTo(x, top); ctx.lineTo(x, top + PAGE_H); }
    for (let y = top + 27; y < top + PAGE_H; y += 32) { ctx.moveTo(0, y); ctx.lineTo(PAGE_W, y); }
    ctx.stroke();
  } else if (paper === 'dots') {
    ctx.fillStyle = dark ? 'rgba(170,190,225,0.35)' : 'rgba(70,100,150,0.38)';
    for (let x = 28; x < PAGE_W; x += 32)
      for (let y = top + 27; y < top + PAGE_H; y += 32) ctx.fillRect(x - 1.4, y - 1.4, 2.8, 2.8);
  }
}

// Fondo del lienzo libre: el patrón se repite en toda el área visible.
export function drawPaperArea(ctx, x0, y0, x1, y1, paper, s) {
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  const step = paper === 'lines' ? 36 : 32;
  if (paper === 'blank' || step * s < 7) return; // muy lejos: el patrón solo estorba
  const line = 'rgba(70,110,180,0.17)';
  ctx.lineWidth = 1.2 / Math.max(s, 0.6);
  const fx = Math.floor(x0 / step) * step, fy = Math.floor(y0 / step) * step;
  if (paper === 'lines' || paper === 'grid') {
    ctx.strokeStyle = line;
    ctx.beginPath();
    for (let y = fy; y < y1; y += step) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    if (paper === 'grid') for (let x = fx; x < x1; x += step) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    ctx.stroke();
  } else if (paper === 'dots') {
    ctx.fillStyle = 'rgba(70,100,150,0.38)';
    const r = 1.4 / Math.max(s, 0.6);
    for (let x = fx; x < x1; x += step) for (let y = fy; y < y1; y += step) ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
}

// Contorno relleno de un trazo con grosor variable según la presión.
function strokeOutline(it) {
  const P = it.pts;
  const n = P.length / 3;
  const path = new Path2D();
  const base = it.width;
  const rad = i => Math.max(0.35, base * 0.5 * (0.3 + 1.05 * Math.pow(P[i * 3 + 2], 0.75)));
  if (n === 1) { path.arc(P[0], P[1], rad(0), 0, Math.PI * 2); return path; }
  // Suavizado ligero de posición.
  const xs = [], ys = [], rs = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    xs.push((P[a * 3] + 2 * P[i * 3] + P[b * 3]) / 4);
    ys.push((P[a * 3 + 1] + 2 * P[i * 3 + 1] + P[b * 3 + 1]) / 4);
    rs.push((rad(a) + 2 * rad(i) + rad(b)) / 4);
  }
  xs[0] = P[0]; ys[0] = P[1]; xs[n - 1] = P[(n - 1) * 3]; ys[n - 1] = P[(n - 1) * 3 + 1];
  const L = [], R = [], ang = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let tx = xs[b] - xs[a], ty = ys[b] - ys[a];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    const nx = -ty, ny = tx;
    L.push([xs[i] + nx * rs[i], ys[i] + ny * rs[i]]);
    R.push([xs[i] - nx * rs[i], ys[i] - ny * rs[i]]);
    ang.push(Math.atan2(ny, nx));
  }
  path.moveTo(L[0][0], L[0][1]);
  for (let i = 1; i < n; i++) path.lineTo(L[i][0], L[i][1]);
  path.arc(xs[n - 1], ys[n - 1], rs[n - 1], ang[n - 1], ang[n - 1] - Math.PI, true);
  for (let i = n - 1; i >= 0; i--) path.lineTo(R[i][0], R[i][1]);
  path.arc(xs[0], ys[0], rs[0], ang[0] + Math.PI, ang[0], true);
  path.closePath();
  return path;
}

function centerline(it) {
  const P = it.pts;
  const path = new Path2D();
  path.moveTo(P[0], P[1]);
  const n = P.length / 3;
  if (n === 1) { path.lineTo(P[0] + 0.1, P[1]); return path; }
  for (let i = 1; i < n - 1; i++) {
    const mx = (P[i * 3] + P[(i + 1) * 3]) / 2, my = (P[i * 3 + 1] + P[(i + 1) * 3 + 1]) / 2;
    path.quadraticCurveTo(P[i * 3], P[i * 3 + 1], mx, my);
  }
  path.lineTo(P[(n - 1) * 3], P[(n - 1) * 3 + 1]);
  return path;
}

function shapePath(it) {
  const path = new Path2D();
  if (it.kind === 'ellipse') {
    path.ellipse(it.cx, it.cy, it.rx, it.ry, it.rot || 0, 0, Math.PI * 2);
    return path;
  }
  const p = it.pts;
  path.moveTo(p[0].x, p[0].y);
  for (let i = 1; i < p.length; i++) path.lineTo(p[i].x, p[i].y);
  if (it.kind === 'polygon') path.closePath();
  if (it.kind === 'arrow') {
    const [a, b] = p;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const h = Math.min(len * 0.35, Math.max(16, it.width * 4.5));
    for (const s of [-1, 1]) {
      path.moveTo(b.x, b.y);
      path.lineTo(b.x - Math.cos(ang + s * 0.45) * h, b.y - Math.sin(ang + s * 0.45) * h);
    }
  }
  return path;
}

// Marcador: cinta de color con muesca, en el borde izquierdo de la página.
export const MARK_W = 34, MARK_H = 30;
function markPath(it) {
  const p = new Path2D(), x = it.x, y = it.y;
  p.moveTo(x, y); p.lineTo(x + MARK_W, y); p.lineTo(x + MARK_W - 9, y + MARK_H / 2);
  p.lineTo(x + MARK_W, y + MARK_H); p.lineTo(x, y + MARK_H); p.closePath();
  return p;
}

export function getPath(it) {
  let p = pathCache.get(it);
  if (!p) {
    if (it.type === 'stroke') p = it.tool === 'hl' ? centerline(it) : strokeOutline(it);
    else if (it.type === 'shape') p = shapePath(it);
    if (p) pathCache.set(it, p);
  }
  return p;
}

export function getImage(it, onload) {
  let img = imgCache.get(it.src);
  if (!img) {
    img = new Image();
    img.onload = onload;
    img.src = it.src;
    imgCache.set(it.src, img);
  }
  return img;
}

export function textLines(ctx, it) {
  ctx.font = `${it.size}px "Atkinson Hyperlegible", sans-serif`;
  const out = [];
  for (const para of it.text.split('\n')) {
    const words = para.split(' ');
    let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > it.w && line) { out.push(line); line = w; }
      else line = t;
    }
    out.push(line);
  }
  return out;
}

const measureCtx = document.createElement('canvas').getContext('2d');

export function bounds(it) {
  let b = boxCache.get(it);
  if (b) return b;
  if (it.type === 'stroke') {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < it.pts.length; i += 3) {
      const x = it.pts[i], y = it.pts[i + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const pad = it.width;
    b = { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  } else if (it.type === 'shape') {
    if (it.kind === 'ellipse') {
      const r = Math.max(it.rx, it.ry) + it.width;
      b = { x0: it.cx - r, y0: it.cy - r, x1: it.cx + r, y1: it.cy + r };
    } else {
      const xs = it.pts.map(q => q.x), ys = it.pts.map(q => q.y);
      const pad = it.width * 5;
      b = { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad };
    }
  } else if (it.type === 'image') {
    b = { x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + it.h };
  } else if (it.type === 'mark') {
    b = { x0: it.x, y0: it.y, x1: it.x + MARK_W, y1: it.y + MARK_H };
  } else if (it.type === 'cover') {
    b = { x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + it.h };
  } else if (it.type === 'text') {
    const lines = textLines(measureCtx, it);
    b = { x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + lines.length * it.size * 1.3 };
  }
  boxCache.set(it, b);
  return b;
}

export function drawItem(ctx, it, onImageLoad) {
  if (it.type === 'cover') return; // los bloques para tapar los dibuja el editor según el modo
  if (it.type === 'mark') {
    ctx.fillStyle = it.color;
    ctx.fill(markPath(it));
    return;
  }
  if (it.type === 'image') {
    const img = getImage(it, onImageLoad);
    if (img.complete && img.naturalWidth) ctx.drawImage(img, it.x, it.y, it.w, it.h);
    return;
  }
  if (it.type === 'text') {
    const lines = textLines(ctx, it);
    ctx.fillStyle = it.color;
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, it.x, it.y + i * it.size * 1.3));
    return;
  }
  const path = getPath(it);
  if (it.type === 'stroke' && it.tool === 'hl') {
    ctx.save();
    ctx.globalAlpha = 0.38;
    ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = it.color;
    ctx.lineWidth = it.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
    ctx.restore();
  } else if (it.type === 'stroke') {
    ctx.fillStyle = it.color;
    ctx.fill(path);
  } else {
    ctx.strokeStyle = it.color;
    ctx.lineWidth = it.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }
}

// ¿El punto (x, y) toca el elemento, con tolerancia r?
export function hits(it, x, y, r) {
  const b = bounds(it);
  if (x < b.x0 - r || x > b.x1 + r || y < b.y0 - r || y > b.y1 + r) return false;
  if (it.type === 'image' || it.type === 'text' || it.type === 'mark' || it.type === 'cover') return true;
  const segD = (ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(x - ax - t * dx, y - ay - t * dy);
  };
  const tol = r + it.width / 2;
  if (it.type === 'stroke') {
    const P = it.pts;
    if (P.length === 3) return Math.hypot(x - P[0], y - P[1]) < tol;
    for (let i = 3; i < P.length; i += 3) if (segD(P[i - 3], P[i - 2], P[i], P[i + 1]) < tol) return true;
    return false;
  }
  if (it.kind === 'ellipse') {
    const c = Math.cos(-(it.rot || 0)), s = Math.sin(-(it.rot || 0));
    const lx = (x - it.cx) * c - (y - it.cy) * s, ly = (x - it.cx) * s + (y - it.cy) * c;
    const k = Math.hypot(lx / it.rx, ly / it.ry);
    return Math.abs(k - 1) * Math.min(it.rx, it.ry) < tol;
  }
  const p = it.pts;
  const m = it.kind === 'polygon' ? p.length : p.length - 1;
  for (let i = 0; i < m; i++) {
    const a = p[i], b2 = p[(i + 1) % p.length];
    if (segD(a.x, a.y, b2.x, b2.y) < tol) return true;
  }
  return false;
}

// Copia del elemento desplazada (para mover selecciones sin dañar el historial).
export function translated(it, dx, dy) {
  if (it.type === 'stroke') {
    const pts = it.pts.slice();
    for (let i = 0; i < pts.length; i += 3) { pts[i] += dx; pts[i + 1] += dy; }
    return { ...it, pts };
  }
  if (it.type === 'shape') {
    if (it.kind === 'ellipse') return { ...it, cx: it.cx + dx, cy: it.cy + dy };
    return { ...it, pts: it.pts.map(q => ({ x: q.x + dx, y: q.y + dy })) };
  }
  return { ...it, x: it.x + dx, y: it.y + dy };
}
