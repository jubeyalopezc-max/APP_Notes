// Estadística y probabilidad: resumen de datos, regresión y distribuciones.

/** "3, 4.5; 7  8" o columnas "x y" por renglón → { xs } o { xs, ys } */
export function parseData(text) {
  let src = String(text || '').trim();
  // Coma decimal (3,5 4,2) si no hay puntos, las comas van pegadas a dígitos y los datos se separan con espacios.
  const decimalComma = !/\./.test(src) && /\d,\d/.test(src) && !/,\s/.test(src) && /\d[\s;]+\d/.test(src);
  if (decimalComma) src = src.replace(/(\d),(\d)/g, '$1.$2');
  const sep = decimalComma ? /[\s;]+/ : /[\s,;]+/;
  const table = src.split(/\n+/).map(r => r.trim().split(sep).filter(Boolean)).filter(r => r.length);
  const bad = [];
  const num = t => { const n = Number(t); return t !== '' && isFinite(n) ? n : NaN; };
  // Dos columnas en todos los renglones → pares (x, y)
  if (table.length >= 3 && table.every(r => r.length === 2)) {
    const xs = [], ys = [];
    table.forEach((r, i) => { const x = num(r[0]), y = num(r[1]); if (isNaN(x) || isNaN(y)) bad.push(`renglón ${i + 1}`); else { xs.push(x); ys.push(y); } });
    return { xs, ys, bad };
  }
  const xs = [];
  for (const r of table) for (const c of r) { const n = num(c); if (isNaN(n)) bad.push(c); else xs.push(n); }
  return { xs, bad };
}

function quantile(sorted, q) {
  // Método de la mayoría de calculadoras (interpolación lineal, tipo 7).
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summary(xs) {
  const n = xs.length;
  if (!n) return null;
  const s = [...xs].sort((a, b) => a - b);
  const sum = xs.reduce((a, b) => a + b, 0), mean = sum / n;
  const ss = xs.reduce((a, b) => a + (b - mean) ** 2, 0);
  const counts = new Map();
  for (const x of xs) counts.set(x, (counts.get(x) || 0) + 1);
  const top = Math.max(...counts.values());
  const modes = top > 1 ? [...counts].filter(([, c]) => c === top).map(([v]) => v).sort((a, b) => a - b) : [];
  return {
    n, sum, mean, median: quantile(s, 0.5), modes, min: s[0], max: s[n - 1], range: s[n - 1] - s[0],
    q1: quantile(s, 0.25), q3: quantile(s, 0.75),
    varS: n > 1 ? ss / (n - 1) : NaN, varP: ss / n,
    sdS: n > 1 ? Math.sqrt(ss / (n - 1)) : NaN, sdP: Math.sqrt(ss / n),
    cv: mean ? Math.sqrt(n > 1 ? ss / (n - 1) : ss / n) / Math.abs(mean) : NaN,
  };
}

export function regression(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  if (!sxx) return null;
  const m = sxy / sxx, b = my - m * mx, r = syy ? sxy / Math.sqrt(sxx * syy) : NaN;
  return { m, b, r, r2: r * r, n };
}

// ---------- Distribuciones ----------
function lnFact(k) { let s = 0; for (let i = 2; i <= k; i++) s += Math.log(i); return s; }
const lnComb = (n, k) => lnFact(n) - lnFact(k) - lnFact(n - k);

export function binomialPmf(n, p, k) { if (k < 0 || k > n) return 0; if (p === 0) return k === 0 ? 1 : 0; if (p === 1) return k === n ? 1 : 0; return Math.exp(lnComb(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p)); }
export function binomialCdf(n, p, k) { let s = 0; for (let i = 0; i <= Math.min(k, n); i++) s += binomialPmf(n, p, i); return Math.min(1, s); }
export function poissonPmf(l, k) { return k < 0 ? 0 : Math.exp(-l + k * Math.log(l) - lnFact(k)); }
export function poissonCdf(l, k) { let s = 0; for (let i = 0; i <= k; i++) s += poissonPmf(l, i); return Math.min(1, s); }

// Φ(z), con error menor que 1e-7 (más que suficiente para tablas de probabilidad).
export function normCdf(z) {
  const t = Math.abs(z) / Math.SQRT2;
  return z >= 0 ? 1 - 0.5 * erfc(t) : 0.5 * erfc(t);
}
function erfc(x) {
  // Aproximación de Numerical Recipes (erfcc), error relativo < 1.2e-7, suficiente para tablas.
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
/** z tal que Φ(z) = p (algoritmo de Acklam). */
export function normInv(p) {
  if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export const fmt = (v, d = 6) => {
  if (v == null || Number.isNaN(v)) return '—';
  if (!isFinite(v)) return v > 0 ? '∞' : '−∞';
  if (v !== 0 && (Math.abs(v) < 1e-4 || Math.abs(v) >= 1e9)) return v.toExponential(4).replace('-', '−');
  return String(+v.toFixed(d)).replace('-', '−');
};
