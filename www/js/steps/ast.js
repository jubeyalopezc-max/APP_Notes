// Árbol de expresiones para el paso a paso: lee el idioma de Giac, simplifica lo obvio
// (0+x, 1·x, x^1, números) e imprime como LaTeX bonito o de vuelta como texto de Giac.
//
// Nodos: {t:'num', n, d}  (racional n/d; d=1 si es entero o decimal)
//        {t:'sym', v}     {t:'add', a:[…]}  {t:'mul', a:[…]}  {t:'div', a, b}
//        {t:'pow', a, b}  {t:'neg', a}      {t:'fn', f, a:[…]}

// ---------- Números racionales ----------
const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a || 1; };
export function N(n, d = 1) {
  if (d < 0) { n = -n; d = -d; }
  if (Number.isInteger(n) && Number.isInteger(d)) { const g = gcd(n, d); return { t: 'num', n: n / g, d: d / g }; }
  return { t: 'num', n: n / d, d: 1 };
}
export const S = v => ({ t: 'sym', v });
export const ZERO = N(0), ONE = N(1);
export const isNum = (x, n, d = 1) => x.t === 'num' && (n === undefined || (x.n === n && x.d === d));
const numVal = x => x.n / x.d;
const qadd = (a, b) => N(a.n * b.d + b.n * a.d, a.d * b.d);
const qmul = (a, b) => N(a.n * b.n, a.d * b.d);

// ---------- Leer texto de Giac ----------
function tokens(s) {
  const out = [];
  const re = /\s*(\d+\.?\d*(?:e[-+]?\d+)?|\.\d+|[A-Za-z_][A-Za-z_0-9]*|[-+*/^(),\[\]])/y;
  while (re.lastIndex < s.length) {
    const at = re.lastIndex, m = re.exec(s);
    if (!m) { if (/^\s*$/.test(s.slice(at))) break; throw new Error('No se pudo leer: ' + s.slice(at, at + 10)); }
    out.push(m[1]);
  }
  return out;
}

export function parse(src) {
  const t = tokens(String(src));
  let i = 0;
  const peek = () => t[i], next = () => t[i++];
  const expect = c => { if (t[i] !== c) throw new Error('Falta ' + c); i++; };
  function sum() {
    const terms = [prod()];
    while (peek() === '+' || peek() === '-') { const op = next(); const b = prod(); terms.push(op === '-' ? { t: 'neg', a: b } : b); }
    return terms.length === 1 ? terms[0] : { t: 'add', a: terms };
  }
  function prod() {
    let a = unary();
    while (peek() === '*' || peek() === '/') {
      const op = next(), b = unary();
      if (op === '*') a = a.t === 'mul' && !a.paren ? { t: 'mul', a: [...a.a, b] } : { t: 'mul', a: [a, b] };
      else a = { t: 'div', a, b };
    }
    return a;
  }
  function unary() {
    if (peek() === '-') { next(); return { t: 'neg', a: unary() }; }
    if (peek() === '+') { next(); return unary(); }
    return power();
  }
  function power() {
    const a = atom();
    if (peek() === '^') { next(); return { t: 'pow', a, b: unary() }; }
    return a;
  }
  function atom() {
    const k = next();
    if (k === undefined) throw new Error('Expresión incompleta');
    if (k === '(') { const a = sum(); expect(')'); if (a.t === 'mul') a.paren = true; return a; }
    if (k === '[') {
      const items = [];
      if (peek() !== ']') { items.push(sum()); while (peek() === ',') { next(); items.push(sum()); } }
      expect(']');
      return { t: 'list', a: items };
    }
    if (/^[\d.]/.test(k)) {
      if (/^\d+$/.test(k)) return N(parseInt(k, 10));
      return N(parseFloat(k));
    }
    if (peek() === '(') {
      next();
      const args = [];
      if (peek() !== ')') { args.push(sum()); while (peek() === ',') { next(); args.push(sum()); } }
      expect(')');
      return { t: 'fn', f: k, a: args };
    }
    return S(k);
  }
  const r = sum();
  if (i !== t.length) throw new Error('Sobra texto al final');
  return clean(r);
}
function clean(n) {
  if (!n || typeof n !== 'object') return n;
  delete n.paren;
  if (n.a && Array.isArray(n.a)) n.a = n.a.map(clean);
  else if (n.a) n.a = clean(n.a);
  if (n.b) n.b = clean(n.b);
  return n;
}

// ---------- Utilidades ----------
export const has = (n, v) => {
  switch (n.t) {
    case 'num': return false;
    case 'sym': return n.v === v;
    case 'neg': return has(n.a, v);
    case 'div': case 'pow': return has(n.a, v) || has(n.b, v);
    default: return (n.a || []).some(x => has(x, v));
  }
};
export const eq = (a, b) => toGiac(simp(a)) === toGiac(simp(b));
export function subst(n, v, val) {
  if (n.t === 'sym') return n.v === v ? val : n;
  if (n.t === 'num') return n;
  if (n.t === 'neg') return { t: 'neg', a: subst(n.a, v, val) };
  if (n.t === 'div' || n.t === 'pow') return { t: n.t, a: subst(n.a, v, val), b: subst(n.b, v, val) };
  return { ...n, a: n.a.map(x => subst(x, v, val)) };
}
/** Reemplaza cada aparición de la subexpresión `what` por `by`. */
export function replace(n, what, by) {
  const key = toGiac(what);
  const go = x => {
    if (toGiac(x) === key) return by;
    if (x.t === 'num' || x.t === 'sym') return x;
    if (x.t === 'neg') return { t: 'neg', a: go(x.a) };
    if (x.t === 'div' || x.t === 'pow') return { t: x.t, a: go(x.a), b: go(x.b) };
    return { ...x, a: x.a.map(go) };
  };
  return go(n);
}

export const add = (...a) => simp({ t: 'add', a });
export const mul = (...a) => simp({ t: 'mul', a });
export const div = (a, b) => simp({ t: 'div', a, b });
export const pow = (a, b) => simp({ t: 'pow', a, b });
export const neg = a => simp({ t: 'neg', a });
export const fn = (f, ...a) => ({ t: 'fn', f, a });

// ---------- Simplificación ligera (lo que haría uno a mano sin pensar) ----------
export function simp(n) {
  switch (n.t) {
    case 'num': case 'sym': return n;
    case 'neg': {
      const a = simp(n.a);
      if (a.t === 'num') return N(-a.n, a.d);
      if (a.t === 'neg') return a.a;
      if (a.t === 'mul' && a.a[0].t === 'num') return simp({ t: 'mul', a: [N(-a.a[0].n, a.a[0].d), ...a.a.slice(1)] });
      return { t: 'neg', a };
    }
    case 'add': {
      let terms = [];
      for (const x of n.a.map(simp)) { if (x.t === 'add') terms.push(...x.a); else terms.push(x); }
      // Los números se suman y quedan donde estaba el primero (1 - x^2, no -x^2 + 1).
      let c = ZERO, at = -1;
      const rest = [];
      for (const x of terms) { if (x.t === 'num') { if (at < 0) at = rest.length; c = qadd(c, x); } else rest.push(x); }
      terms = rest;
      if (c.n !== 0) terms.splice(at, 0, c);
      if (!terms.length) return ZERO;
      return terms.length === 1 ? terms[0] : { t: 'add', a: terms };
    }
    case 'mul': {
      let fs = [];
      let c = ONE;
      for (let x of n.a.map(simp)) {
        if (x.t === 'neg') { c = N(-c.n, c.d); x = x.a; }
        if (x.t === 'mul') { for (const y of x.a) { if (y.t === 'num') c = qmul(c, y); else fs.push(y); } continue; }
        if (x.t === 'num') { c = qmul(c, x); continue; }
        fs.push(x);
      }
      if (c.n === 0) return ZERO;
      // x·x → x^2, x·x^3 → x^4 (misma base)
      const merged = [];
      for (const f of fs) {
        const base = f.t === 'pow' ? f.a : f, exp = f.t === 'pow' ? f.b : ONE;
        const j = merged.findIndex(m => toGiac(m.base) === toGiac(base));
        if (j >= 0 && exp.t === 'num' && merged[j].exp.t === 'num') merged[j].exp = qadd(merged[j].exp, exp);
        else merged.push({ base, exp });
      }
      fs = merged.map(m => (isNum(m.exp, 1) ? m.base : simp({ t: 'pow', a: m.base, b: m.exp }))).filter(f => !isNum(f, 1));
      // Orden de cuaderno: 2x cos(x²), no 2 cos(x²) x
      const isExp = f => (f.t === 'fn' && f.f === 'exp') || (f.t === 'pow' && f.a.t === 'sym' && f.a.v === 'e');
      const rank = f => (f.t === 'sym' || (f.t === 'pow' && f.a.t === 'sym' && !isExp(f)) ? 1 : isExp(f) ? 2 : f.t === 'add' || (f.t === 'pow' && f.a.t === 'add') ? 3 : 4);
      fs = fs.map((f, i) => [f, i]).sort((p, q) => rank(p[0]) - rank(q[0]) || p[1] - q[1]).map(p => p[0]);
      if (!fs.length) return c;
      if (isNum(c, 1)) return fs.length === 1 ? fs[0] : { t: 'mul', a: fs };
      if (isNum(c, -1)) return { t: 'neg', a: fs.length === 1 ? fs[0] : { t: 'mul', a: fs } };
      return { t: 'mul', a: [c, ...fs] };
    }
    case 'div': {
      const a = simp(n.a), b = simp(n.b);
      if (isNum(b, 1)) return a;
      if (isNum(a, 0)) return ZERO;
      if (a.t === 'num' && b.t === 'num' && b.n !== 0) return qmul(a, N(b.d, b.n));
      if (toGiac(a) === toGiac(b)) return ONE;
      if (b.t === 'num' && b.n !== 0) return simp({ t: 'mul', a: [N(b.d, b.n), a] });
      if (a.t === 'neg') return simp({ t: 'neg', a: { t: 'div', a: a.a, b } });
      return { t: 'div', a, b };
    }
    case 'pow': {
      const a = simp(n.a), b = simp(n.b);
      if (isNum(b, 0)) return ONE;
      if (isNum(b, 1)) return a;
      if (isNum(a, 1)) return ONE;
      if (isNum(a, 0) && b.t === 'num' && numVal(b) > 0) return ZERO;
      if (a.t === 'num' && b.t === 'num' && b.d === 1 && Number.isInteger(b.n) && Math.abs(b.n) <= 12 && a.d < 1e6 && Math.abs(a.n) < 1e6) {
        const e = Math.abs(b.n), r = N(Math.pow(a.n, e), Math.pow(a.d, e));
        return b.n >= 0 ? r : N(r.d, r.n);
      }
      if (a.t === 'pow' && b.t === 'num' && a.b.t === 'num') return simp({ t: 'pow', a: a.a, b: qmul(a.b, b) });
      return { t: 'pow', a, b };
    }
    case 'fn': {
      const a = n.a.map(simp);
      const x = a[0];
      if (n.f === 'ln' && x.t === 'sym' && x.v === 'e') return ONE;
      if (n.f === 'ln' && isNum(x, 1)) return ZERO;
      if (n.f === 'exp' && isNum(x, 0)) return ONE;
      if ((n.f === 'sin' || n.f === 'tan') && isNum(x, 0)) return ZERO;
      if (n.f === 'cos' && isNum(x, 0)) return ONE;
      if (n.f === 'sqrt' && x.t === 'num' && x.d === 1 && Number.isInteger(Math.sqrt(x.n))) return N(Math.sqrt(x.n));
      return { t: 'fn', f: n.f, a };
    }
    case 'list': return { t: 'list', a: n.a.map(simp) };
    default: return n;
  }
}

// ---------- Imprimir como texto de Giac ----------
export function toGiac(n) {
  switch (n.t) {
    case 'num': return n.d === 1 ? (n.n < 0 ? `(${n.n})` : String(n.n)) : `(${n.n}/${n.d})`;
    case 'sym': return n.v;
    case 'neg': return `(-${wrapG(n.a)})`;
    case 'add': return '(' + n.a.map(toGiac).join('+') + ')';
    case 'mul': return n.a.map(wrapG).join('*');
    case 'div': return `${wrapG(n.a)}/${wrapG(n.b)}`;
    case 'pow': return `${wrapG(n.a)}^${wrapG(n.b)}`;
    case 'fn': return `${n.f}(${n.a.map(toGiac).join(',')})`;
    case 'list': return '[' + n.a.map(toGiac).join(',') + ']';
    default: return '?';
  }
}
const wrapG = n => (n.t === 'add' || n.t === 'mul' || n.t === 'div' || n.t === 'pow' || n.t === 'neg' ? `(${toGiac(n)})` : toGiac(n));

// ---------- Imprimir como LaTeX ----------
const GREEK = new Set(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'rho', 'sigma', 'tau', 'phi', 'chi', 'psi', 'omega']);
const TRIG = { sin: '\\sin', cos: '\\cos', tan: '\\tan', cot: '\\cot', sec: '\\sec', csc: '\\csc', sinh: '\\sinh', cosh: '\\cosh', tanh: '\\tanh', ln: '\\ln', log10: '\\log', asin: '\\arcsin', acos: '\\arccos', atan: '\\arctan' };

function symTex(v) {
  if (v === 'pi') return '\\pi';
  if (v === 'inf' || v === 'infinity') return '\\infty';
  if (GREEK.has(v.replace(/_$/, ''))) return '\\' + v.replace(/_$/, '');
  const m = /^([a-zA-Z])(\d+)$/.exec(v);
  if (m) return `${m[1]}_{${m[2]}}`;
  if (/^c_(\d+)$/.test(v)) return `C_{${+v.slice(2) + 1}}`;
  return v.length > 1 ? `\\mathrm{${v}}` : v;
}

function isNegTerm(x) { return x.t === 'neg' || (x.t === 'num' && x.n < 0) || (x.t === 'mul' && x.a[0].t === 'num' && x.a[0].n < 0); }
function absTerm(x) {
  if (x.t === 'neg') return x.a;
  if (x.t === 'num') return N(-x.n, x.d);
  return simp({ t: 'mul', a: [N(-x.a[0].n, x.a[0].d), ...x.a.slice(1)] });
}

export function tex(n) {
  switch (n.t) {
    case 'num': {
      if (n.d === 1) return Number.isInteger(n.n) ? String(n.n) : String(+n.n.toPrecision(10));
      return (n.n < 0 ? '-' : '') + `\\frac{${Math.abs(n.n)}}{${n.d}}`;
    }
    case 'sym': return symTex(n.v);
    case 'neg': return '-' + (n.a.t === 'add' ? `\\left(${tex(n.a)}\\right)` : tex(n.a));
    case 'add': {
      // términos con x primero si el último es un número (se ve más natural: x^2+3x+2)
      let s = '';
      n.a.forEach((x, k) => {
        if (k === 0) { s += tex(x); return; }
        s += isNegTerm(x) ? ' - ' + tex(absTerm(x)) : ' + ' + tex(x);
      });
      return s;
    }
    case 'mul': {
      // Factores en el denominador (1/x, x^-2): todo como una sola fracción.
      const den = n.a.filter(f => f.t === 'div' || (f.t === 'pow' && ((f.b.t === 'num' && f.b.n < 0) || f.b.t === 'neg')));
      if (den.length) {
        const top = [], bottom = [];
        for (const f of n.a) {
          if (f.t === 'div') { if (!isNum(f.a, 1)) top.push(f.a); bottom.push(f.b); }
          else if (den.includes(f)) bottom.push(simp({ t: 'pow', a: f.a, b: f.b.t === 'neg' ? f.b.a : N(-f.b.n, f.b.d) }));
          else top.push(f);
        }
        let sign = '';
        // El coeficiente p/q: p arriba y q abajo.
        let c = ONE;
        const rest = top.filter(f => { if (f.t === 'num') { c = qmul(c, f); return false; } return true; });
        if (c.n < 0) { sign = '-'; c = N(-c.n, c.d); }
        if (c.d !== 1) bottom.unshift(N(c.d));
        if (c.n !== 1 || !rest.length) rest.unshift(N(c.n));
        const t = tex(simp({ t: 'mul', a: rest }));
        return sign + `\\frac{${t}}{${tex(simp({ t: 'mul', a: bottom }))}}`;
      }
      let fs = n.a, sign = '';
      if (fs[0].t === 'num' && fs[0].n < 0) { sign = '-'; fs = [N(-fs[0].n, fs[0].d), ...fs.slice(1)]; if (isNum(fs[0], 1)) fs = fs.slice(1); }
      // Coeficiente fraccionario: 1/2·x² → \frac{x^2}{2}; 3/2·x → \frac{3x}{2}
      if (fs[0].t === 'num' && fs[0].d !== 1 && fs.length > 1) {
        const c = fs[0], rest = fs.slice(1);
        const top = (c.n === 1 ? '' : String(c.n) + ' ') + (rest.length === 1 && c.n === 1 ? tex(rest[0]) : rest.map(f => wrapT(f, true)).join(' '));
        return sign + `\\frac{${top || '1'}}{${c.d}}`;
      }
      let s = '';
      fs.forEach((f, k) => {
        const t = wrapT(f, k > 0);
        if (k > 0) s += (needsDot(fs[k - 1], f) ? ' \\cdot ' : ' ');
        s += t;
      });
      return sign + s;
    }
    case 'div': {
      // (1/2)/(x-1) → 1/(2(x-1))
      if (n.a.t === 'num' && n.a.d !== 1) return (n.a.n < 0 ? '-' : '') + `\\frac{${Math.abs(n.a.n)}}{${n.a.d}${wrapT(n.b, true).startsWith('\\left') ? wrapT(n.b, true) : ' ' + tex(n.b)}}`;
      return `\\frac{${tex(n.a)}}{${tex(n.b)}}`;
    }
    case 'pow': {
      const b = n.b;
      if (b.t === 'num' && b.n === 1 && b.d === 2) return `\\sqrt{${tex(n.a)}}`;
      if (b.t === 'num' && b.n === -1 && b.d === 2) return `\\frac{1}{\\sqrt{${tex(n.a)}}}`;
      if (b.t === 'num' && b.n < 0) return `\\frac{1}{${tex(simp({ t: 'pow', a: n.a, b: N(-b.n, b.d) }))}}`;
      if (b.t === 'neg') return `\\frac{1}{${tex(simp({ t: 'pow', a: n.a, b: b.a }))}}`;
      if (n.a.t === 'fn' && TRIG[n.a.f] && n.a.f !== 'ln' && b.t === 'num' && b.d === 1 && b.n > 0) return `${TRIG[n.a.f]}^{${b.n}}${argTex(n.a.a[0])}`;
      if (n.a.t === 'sym' && n.a.v === 'e') return `e^{${tex(b)}}`;
      const base = (n.a.t === 'sym' || (n.a.t === 'num' && n.a.n >= 0 && n.a.d === 1)) ? tex(n.a) : `\\left(${tex(n.a)}\\right)`;
      return `${base}^{${tex(b)}}`;
    }
    case 'fn': {
      const [x, y] = n.a;
      if (n.f === 'sqrt') return `\\sqrt{${tex(x)}}`;
      if (n.f === 'abs') return `\\left|${tex(x)}\\right|`;
      if (n.f === 'exp') return `e^{${tex(x)}}`;
      if (n.f === 'surd') return `\\sqrt[${tex(y)}]{${tex(x)}}`;
      if (n.f === 'logb') return `\\log_{${tex(y)}}${argTex(x)}`;
      if (n.f === 'diff') return `\\frac{d}{d${tex(y || S('x'))}}\\left[${tex(x)}\\right]`;
      if (n.f === 'integrate') return `\\int ${tex(x)}\\,d${tex(y || S('x'))}`;
      if (TRIG[n.f]) return TRIG[n.f] + argTex(x);
      return `\\operatorname{${n.f}}\\left(${n.a.map(tex).join(',\\,')}\\right)`;
    }
    case 'list': return `\\left(${n.a.map(tex).join(',\\ ')}\\right)`;
    default: return '?';
  }
}
function argTex(x) {
  if (x.t === 'sym' || (x.t === 'num' && x.n >= 0 && x.d === 1)) return `\\left(${tex(x)}\\right)`.replace(/\\left\((.*)\\right\)/, '($1)');
  return `\\left(${tex(x)}\\right)`;
}
function wrapT(f, inner) {
  if (f.t === 'add' || (inner && (f.t === 'neg' || (f.t === 'num' && f.n < 0)))) return `\\left(${tex(f)}\\right)`;
  return tex(f);
}
function needsDot(a, b) {
  // 2·3, x·2, (…)·número: con punto; 2x, x sen x: sin punto
  if (b.t === 'num') return true;
  if (b.t === 'pow' && b.a.t === 'num') return true;
  return false;
}

/** Grado de un polinomio en v (o -1 si no es polinomio). */
export function polyDegree(n, v) {
  switch (n.t) {
    case 'num': return 0;
    case 'sym': return n.v === v ? 1 : 0;
    case 'neg': return polyDegree(n.a, v);
    case 'add': { let d = 0; for (const x of n.a) { const k = polyDegree(x, v); if (k < 0) return -1; d = Math.max(d, k); } return d; }
    case 'mul': { let d = 0; for (const x of n.a) { const k = polyDegree(x, v); if (k < 0) return -1; d += k; } return d; }
    case 'pow': {
      if (!has(n.a, v)) return has(n.b, v) ? -1 : 0;
      if (n.b.t === 'num' && n.b.d === 1 && Number.isInteger(n.b.n) && n.b.n >= 0) { const k = polyDegree(n.a, v); return k < 0 ? -1 : k * n.b.n; }
      return -1;
    }
    case 'div': return has(n.b, v) ? -1 : polyDegree(n.a, v);
    default: return has(n, v) ? -1 : 0;
  }
}

/** Factores de un producto (sin el signo) y su coeficiente numérico. */
export function factorsOf(n) {
  if (n.t === 'mul') return n.a;
  if (n.t === 'neg') return [N(-1), ...factorsOf(n.a)];
  return [n];
}
