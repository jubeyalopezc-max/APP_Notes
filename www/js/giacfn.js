// Convierte una expresión en el idioma de Giac ("x^2*sin(x)") en una función de JavaScript para graficar.
// Es un analizador pequeño y propio: no usa eval, así que nunca ejecuta texto como código.

const F = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  cot: x => 1 / Math.tan(x), sec: x => 1 / Math.cos(x), csc: x => 1 / Math.sin(x),
  acot: x => Math.atan(1 / x), asec: x => Math.acos(1 / x), acsc: x => Math.asin(1 / x),
  coth: x => 1 / Math.tanh(x), sech: x => 1 / Math.cosh(x), csch: x => 1 / Math.sinh(x),
  exp: Math.exp, ln: Math.log, log: Math.log, log10: Math.log10, sqrt: Math.sqrt, abs: Math.abs,
  sign: Math.sign, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  logb: (x, b) => Math.log(x) / Math.log(b),
  surd: (x, n) => (x < 0 && n % 2 === 1 ? -Math.pow(-x, 1 / n) : Math.pow(x, 1 / n)),
  max: Math.max, min: Math.min, erf, factorial: x => gamma(x + 1), Gamma: gamma,
  Heaviside: x => (x < 0 ? 0 : 1),
};
const C = { pi: Math.PI, e: Math.E, inf: Infinity, infinity: Infinity };

function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function gamma(z) {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  z -= 1;
  const g = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  let x = g[0];
  for (let i = 1; i < 9; i++) x += g[i] / (z + i);
  const t = z + 7.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

function tokens(s) {
  const out = [];
  const re = /\s*(\d+\.?\d*(?:e[-+]?\d+)?|\.\d+|[A-Za-z_][A-Za-z_0-9]*|\*\*|[-+*/^(),])/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < s.length) {
    const at = re.lastIndex;
    m = re.exec(s);
    if (!m) { if (/^\s*$/.test(s.slice(at))) break; throw new Error('no se puede graficar'); }
    out.push(m[1] === '**' ? '^' : m[1]);
  }
  return out;
}

/** Compila a una función f(x). Devuelve null si la expresión tiene otras variables o no se entiende. */
export function compile(expr, v = 'x') {
  let t;
  try { t = tokens(String(expr)); } catch { return null; }
  let i = 0;
  const peek = () => t[i], next = () => t[i++];
  const expect = c => { if (t[i] !== c) throw 0; i++; };
  function sum() {
    let a = prod();
    while (peek() === '+' || peek() === '-') { const op = next(), b = prod(), A = a; a = op === '+' ? x => A(x) + b(x) : x => A(x) - b(x); }
    return a;
  }
  function prod() {
    let a = unary();
    while (peek() === '*' || peek() === '/') { const op = next(), b = unary(), A = a; a = op === '*' ? x => A(x) * b(x) : x => A(x) / b(x); }
    return a;
  }
  function unary() {
    if (peek() === '-') { next(); const a = unary(); return x => -a(x); }
    if (peek() === '+') { next(); return unary(); }
    return pow();
  }
  function pow() {
    const a = atom();
    if (peek() === '^') {
      next();
      const b = unary();
      return x => {
        const base = a(x), e = b(x);
        // raíces impares de negativos: (-8)^(1/3) = -2
        if (base < 0 && !Number.isInteger(e)) {
          const inv = 1 / e;
          if (Math.abs(inv - Math.round(inv)) < 1e-9 && Math.round(inv) % 2 !== 0) return -Math.pow(-base, e);
        }
        return Math.pow(base, e);
      };
    }
    return a;
  }
  function atom() {
    const k = next();
    if (k === undefined) throw 0;
    if (k === '(') { const a = sum(); expect(')'); return a; }
    if (/^[\d.]/.test(k)) { const n = parseFloat(k); return () => n; }
    if (/^[A-Za-z_]/.test(k)) {
      if (peek() === '(') {
        next();
        const args = [];
        if (peek() !== ')') { args.push(sum()); while (peek() === ',') { next(); args.push(sum()); } }
        expect(')');
        const fn = F[k];
        if (!fn) throw 0;
        if (args.length === 1) { const a = args[0]; return x => fn(a(x)); }
        return x => fn(...args.map(g => g(x)));
      }
      if (k === v) return x => x;
      if (k in C) { const c = C[k]; return () => c; }
      throw 0;
    }
    throw 0;
  }
  try {
    const f = sum();
    if (i !== t.length) return null;
    f(0.5);
    return f;
  } catch { return null; }
}
