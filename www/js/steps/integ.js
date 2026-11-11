// Integrales paso a paso: escoge el método como lo haría un profesor (tabla, linealidad, sustitución,
// por partes, fracciones parciales, identidades) y comprueba cada resultado con el motor.
import { run, isError, splitApprox } from '../cas.js';
import { N, S, ZERO, ONE, parse, simp, tex, toGiac, has, add, mul, div, pow, neg, fn, isNum, replace, subst, polyDegree, factorsOf } from './ast.js';
import { derivSteps } from './deriv.js';

class Fail extends Error {}

async function G(cmd) {
  const [r] = await run([cmd]);
  if (isError(r)) throw new Fail(String(r));
  let s = String(r).trim();
  if (s.startsWith('"')) s = s.slice(1, -1);
  return splitApprox(s).exact;
}
const P = s => { try { return simp(parse(s)); } catch { throw new Fail('no se pudo leer ' + s); } };
const g = async (op, n, v) => P(await G(`${op}(${toGiac(n)}${v ? ',' + v : ''})`));
const isZero = async n => (await G(`simplify(${toGiac(n)})`)).replace(/\s/g, '') === '0';
/** Es una constante (no depende de v) después de simplificar. Devuelve el valor o null. */
async function constRatio(a, b, v) {
  const r = await g('simplify', div(a, b));
  return has(r, v) ? null : r;
}

const I = (f, v) => { const t = tex(f); return `\\int ${f.t === 'add' || t.startsWith('-') ? `\\left(${t}\\right)` : t}\\,d${v}`; };
const dx = (du, v) => (isNum(du, 1) ? `d${v}` : `${tex(du)}\\,d${v}`);

// Clases de LIATE para escoger u en partes: Logaritmo, Inversa trig, Algebraica, Trigonométrica, Exponencial.
function liate(f, v) {
  if (f.t === 'fn' && (f.f === 'ln' || f.f === 'log10' || f.f === 'logb')) return 0;
  if (f.t === 'fn' && /^a(sin|cos|tan|cot|sec|csc)$/.test(f.f)) return 1;
  if (polyDegree(f, v) >= 1) return 2;
  if (f.t === 'fn' && /^(sin|cos|tan|cot|sec|csc|sinh|cosh)$/.test(f.f)) return 3;
  if ((f.t === 'fn' && f.f === 'exp') || (f.t === 'pow' && !has(f.a, v))) return 4;
  return 5;
}

/**
 * Integra f respecto a v con pasos. Devuelve { F, steps } o lanza Fail.
 * opts.verify: comprobar al final que F' = f (por defecto sí).
 */
export async function integSteps(f0, v = 'x', { maxSteps = 45 } = {}) {
  const steps = [];
  const push = s => { if (steps.length >= maxSteps) throw new Fail('demasiados pasos'); steps.push(s); };
  let calls = 0;

  async function integ(f, depth) {
    if (++calls > 60 || depth > 7) throw new Fail('muy profundo');
    f = simp(f);
    // 1. Constante
    if (!has(f, v)) {
      push({ title: 'Integral de una constante', rule: `\\int k\\,d${v} = k${v}`, latex: `${I(f, v)} = ${tex(mul(f, S(v)))}` });
      return mul(f, S(v));
    }
    // 2. Signo y constantes afuera
    if (f.t === 'neg') return neg(await integ(f.a, depth + 1));
    if (f.t === 'mul') {
      const consts = f.a.filter(x => !has(x, v)), vary = f.a.filter(x => has(x, v));
      if (consts.length) {
        const c = mul(...consts), rest = mul(...vary);
        push({ title: 'La constante sale de la integral', rule: `\\int k\\,f\\,d${v} = k\\int f\\,d${v}`, latex: `${I(f, v)} = ${wrapC(c)}${I(rest, v)}` });
        return mul(c, await integ(rest, depth + 1));
      }
    }
    if (f.t === 'div' && f.b.t === 'mul' && f.b.a.some(x => !has(x, v))) {
      const c = mul(...f.b.a.filter(x => !has(x, v))), rest = div(f.a, mul(...f.b.a.filter(x => has(x, v))));
      push({ title: 'La constante sale de la integral', latex: `${I(f, v)} = \\frac{1}{${tex(c)}}${I(rest, v)}` });
      return div(await integ(rest, depth + 1), c);
    }
    if (f.t === 'div' && !has(f.b, v)) {
      push({ title: 'La constante sale de la integral', latex: `${I(f, v)} = \\frac{1}{${tex(f.b)}}${I(f.a, v)}` });
      return div(await integ(f.a, depth + 1), f.b);
    }
    // 3. Linealidad
    if (f.t === 'add') {
      push({ title: 'La integral de una suma es la suma de las integrales', rule: `\\int (f+g)\\,d${v} = \\int f\\,d${v} + \\int g\\,d${v}`, latex: `${I(f, v)} = ${f.a.map((t, k) => (k && t.t === 'neg' ? '- ' + I(t.a, v) : (k ? '+ ' : '') + I(t, v))).join(' ')}` });
      const parts = [];
      for (const t of f.a) parts.push(await integ(t, depth + 1));
      return add(...parts);
    }
    // 4. Tabla
    const t = table(f, v);
    if (t) { push({ title: t.title, rule: t.rule, latex: `${I(f, v)} = ${tex(t.F)}` }); return t.F; }
    // 1/x^n o √x: se reescribe como potencia
    const rw = asPower(f, v);
    if (rw) {
      push({ title: 'Se reescribe como potencia', latex: `${tex(f)} = ${tex(rw).replace(/\\frac\{1\}\{(.*)\}$/, '$1')}`.replace(/= \\frac/, '= \\frac') });
      return integ(rw, depth + 1);
    }
    // 5. Identidades trigonométricas
    const id = trigIdentity(f, v);
    if (id) { push({ title: id.title, rule: id.rule, latex: `${tex(f)} = ${tex(id.g)}` }); return integ(id.g, depth + 1); }
    // 6. Polinomios: expandir
    if (polyDegree(f, v) >= 0 && (f.t === 'mul' || f.t === 'pow')) {
      const e = await g('expand', f);
      if (e.t === 'add') { push({ title: 'Se expande el polinomio', latex: `${tex(f)} = ${tex(e)}` }); return integ(e, depth + 1); }
    }
    // 7. Sustitución
    const sub = await trySubstitution(f, depth);
    if (sub) return sub;
    // 8. Funciones racionales: división y fracciones parciales
    const rat = await tryRational(f, depth);
    if (rat) return rat;
    // 9. Por partes
    const parts = await tryParts(f, depth);
    if (parts) return parts;
    throw new Fail('sin método');
  }

  // ---------- Sustitución u = g(x) ----------
  function candidates(f) {
    const out = [], seen = new Set();
    const addC = c => { if (!c || !has(c, v) || (c.t === 'sym')) return; const k = toGiac(c); if (!seen.has(k)) { seen.add(k); out.push(c); } };
    const walk = n => {
      if (n.t === 'fn') { n.a.forEach(addC); }
      if (n.t === 'pow') { if (!isNum(n.b) || n.b.d !== 1 || n.a.t !== 'sym') addC(n.a); if (!has(n.a, v)) addC(n.b); }
      if (n.t === 'div') { addC(n.b); if (n.b.t === 'mul') n.b.a.forEach(addC); }
      (n.a && Array.isArray(n.a) ? n.a : [n.a, n.b]).filter(Boolean).forEach(x => typeof x === 'object' && walk(x));
    };
    walk(f);
    // También funciones enteras como u (u = sen x, u = ln x)
    const walk2 = n => { if (n.t === 'fn' && has(n, v) && ['sin', 'cos', 'tan', 'ln', 'atan', 'asin', 'sec', 'exp'].includes(n.f)) addC(n); (Array.isArray(n.a) ? n.a : [n.a, n.b]).filter(x => x && typeof x === 'object').forEach(walk2); };
    walk2(f);
    return out.slice(0, 8);
  }

  async function trySubstitution(f, depth) {
    const U = v === 'u' ? 'w' : 'u';
    const cands = [];
    for (const u of candidates(f)) {
      let du;
      try { du = await g('simplify', derivSteps(u, v).result); } catch { continue; }
      if (!isNum(du, 0)) cands.push({ u, du });
    }
    const attempt = async (u, du, h) => {
      const steps0 = steps.length;
      push({
        title: `Sustitución: $${U} = ${tex(u)}$, entonces $d${U} = ${dx(du, v)}$`,
        rule: `\\int f(g(${v}))\\,g'(${v})\\,d${v} = \\int f(${U})\\,d${U}`,
        latex: `${I(f, v)} = ${I(h, U)}`,
      });
      try {
        const H = await integSub(h, U, depth + 1);
        const F = simp(subst(H, U, u));
        push({ title: `Se regresa a la variable original ($${U} = ${tex(u)}$)`, latex: `${tex(H)} = ${tex(F)}` });
        return F;
      } catch (e) {
        steps.length = steps0;
        if (!(e instanceof Fail)) throw e;
        return null;
      }
    };
    // 1.ª pasada: la expresión ya trae u tal cual (cos(x²)·x con u = x²).
    for (const { u, du } of cands) {
      const tries = [simp(div(f, du))];
      try { tries.push(await g('simplify', div(f, du))); } catch {}
      try { tries.push(await g('normal', div(f, du))); } catch {}
      const seen = new Set();
      for (const q of tries) {
        const h = simp(replace(q, u, S(U)));
        if (has(h, v) || seen.has(toGiac(h))) continue;
        seen.add(toGiac(h));
        const F = await attempt(u, du, h);
        if (F) return F;
      }
    }
    // 2.ª pasada (solo u polinomial): el motor reescribió la expresión (x²+1 → 2x²+2), se despeja x.
    for (const { u, du } of cands) {
      const deg = polyDegree(u, v);
      if (deg < 1 || deg > 2) continue;
      try {
        const sol = await G(`solve(${toGiac(u)}=${U},${v})`);
        const m = /^\s*(?:list)?\[(.*)\]\s*$/.exec(sol);
        if (!m || !m[1].trim()) continue;
        const first = m[1].split(',')[0];
        const h = P(await G(`simplify(subst(${toGiac(simp(div(f, du)))},${v}=${first}))`));
        if (has(h, v) || /floor|sign|abs/.test(toGiac(h))) continue;
        const F = await attempt(u, du, h);
        if (F) return F;
      } catch (e) { if (!(e instanceof Fail)) throw e; }
    }
    return null;
  }
  // Integrar en u reutiliza todo, cambiando la variable.
  async function integSub(h, U, depth) {
    const saved = v;
    v = U;
    try { return await integ(h, depth); } finally { v = saved; }
  }

  // ---------- Racionales ----------
  async function tryRational(f, depth) {
    let num, den;
    if (f.t === 'div') { num = f.a; den = f.b; }
    else return null;
    const dn = polyDegree(num, v), dd = polyDegree(den, v);
    if (dn < 0 || dd < 1) return null;
    if (dn >= dd) {
      const Q = P(await G(`quo(${toGiac(num)},${toGiac(den)},${v})`)), R = P(await G(`rem(${toGiac(num)},${toGiac(den)},${v})`));
      const g2 = add(Q, div(R, den));
      push({ title: 'División de polinomios (el numerador tiene grado mayor o igual)', latex: `\\frac{${tex(num)}}{${tex(den)}} = ${tex(g2)}` });
      return integ(g2, depth + 1);
    }
    const pf = P(await G(`partfrac(${toGiac(f)},${v})`));
    if (pf.t === 'add' && pf.a.length > 1) {
      const fac = await g('factor', den).catch(() => den);
      push({ title: 'Fracciones parciales', rule: 'Se factoriza el denominador y se separa en fracciones simples', latex: `\\frac{${tex(num)}}{${tex(fac)}} = ${tex(pf)}` });
      return integ(pf, depth + 1);
    }
    // 1/(x² + bx + c) irreducible: completar el cuadrado → arcotangente
    if (dd === 2 && dn === 0) {
      const [a2, b1, c0] = await Promise.all([G(`coeff(${toGiac(den)},${v},2)`), G(`coeff(${toGiac(den)},${v},1)`), G(`coeff(${toGiac(den)},${v},0)`)]);
      const A = P(a2), B = P(b1), C = P(c0);
      const h = P(await G(`simplify(${toGiac(C)}/${toGiac(A)}-(${toGiac(B)}/(2*${toGiac(A)}))^2)`));
      if (h.t === 'num' && h.n > 0) {
        const shift = simp(div(B, mul(N(2), A)));
        const sq = add(pow(add(S(v), shift), N(2)), h);
        push({ title: 'Se completa el cuadrado en el denominador', latex: `${tex(den)} = ${tex(mul(A, sq))}` });
        return integ(div(num, mul(A, sq)), depth + 1);
      }
    }
    return null;
  }

  // ---------- Por partes ----------
  async function tryParts(f, depth) {
    let fs = factorsOf(f).filter(x => has(x, v));
    if (f.t === 'fn' && (liate(f, v) <= 1)) fs = [f, ONE];
    if (fs.length < 2) return null;
    const order = fs.map((x, i) => [x, i]).sort((p, q) => liate(p[0], v) - liate(q[0], v));
    const u = order[0][0];
    const dv = simp(mul(...fs.filter((x, i) => i !== order[0][1])));
    const cyc = liate(u, v) === 3 && fs.some(x => liate(x, v) === 4);
    if (cyc) return cyclicParts(f, fs, depth);
    const du = await g('simplify', derivSteps(u, v).result);
    const steps0 = steps.length;
    push({ title: 'Integración por partes (se escoge u con la regla LIATE)', rule: `\\int u\\,dv = u\\,v - \\int v\\,du`, latex: `u = ${tex(u)},\\quad dv = ${isNum(dv, 1) ? '' : tex(dv)}\\,d${v}` });
    let V;
    try { V = await integQuiet(dv, depth + 1); } catch (e) { steps.length = steps0; if (e instanceof Fail) return null; throw e; }
    push({ title: 'Se calculan du y v', latex: `du = ${dx(du, v)},\\quad v = ${tex(V)}` });
    const rest = await g('simplify', mul(V, du));
    push({ title: 'Se aplica la fórmula', latex: `${I(f, v)} = ${tex(simp(mul(u, V)))} - ${I(rest, v)}` });
    try {
      const R = await integ(rest, depth + 1);
      return add(mul(u, V), neg(R));
    } catch (e) { steps.length = steps0; if (e instanceof Fail) return null; throw e; }
  }

  // eˣ·sen x: dos veces por partes y aparece la integral original; se despeja.
  async function cyclicParts(f, fs, depth) {
    const T = fs.find(x => liate(x, v) === 3), E = simp(mul(...fs.filter(x => x !== T)));
    const vE = await integQuiet(E, depth + 1);
    const dT = await g('simplify', derivSteps(T, v).result);
    const g1 = await g('simplify', mul(vE, dT));            // ∫f = T·vE − ∫g1
    const T2 = factorsOf(g1).find(x => liate(x, v) === 3);
    if (!T2) return null;
    const E2 = await g('simplify', div(g1, T2));
    const vE2 = await integQuiet(E2, depth + 1);
    const dT2 = await g('simplify', derivSteps(T2, v).result);
    const g2 = await g('simplify', mul(vE2, dT2));            // ∫g1 = T2·vE2 − ∫g2
    const k = await constRatio(g2, f, v);                     // g2 = k·f
    if (!k) return null;
    // ∫f = T·vE − T2·vE2 + k∫f  →  ∫f = (T·vE − T2·vE2)/(1 − k)
    const A = add(mul(T, vE), neg(mul(T2, vE2)));
    push({ title: 'Por partes con $u = ' + tex(T) + '$, $dv = ' + tex(E) + '\\,d' + v + '$', rule: `\\int u\\,dv = u\\,v - \\int v\\,du`, latex: `${I(f, v)} = ${tex(mul(T, vE))} - ${I(g1, v)}` });
    push({ title: 'Otra vez por partes en la nueva integral', latex: `${I(g1, v)} = ${tex(mul(T2, vE2))} - ${I(g2, v)}` });
    push({ title: 'Aparece la integral original: se despeja', rule: 'Si I = A + k\\,I, entonces I = \\frac{A}{1-k}', latex: `I = ${tex(A)} ${isNum(k, -1) ? '-' : '+ ' + wrapC(k)} I` });
    const F = simp(div(A, add(ONE, neg(k))));
    push({ title: 'Despejando I', latex: `I = ${tex(F)}` });
    return F;
  }

  // Integral auxiliar (para v en partes): sus pasos no se muestran, solo el resultado.
  async function integQuiet(h, depth) {
    const n = steps.length;
    const F = await integ(h, depth);
    steps.length = n;
    return F;
  }

  const f = simp(f0);
  const F = simp(await integ(f, 0));
  // Comprobación: la derivada del resultado debe dar la función (se prueba en varios puntos).
  if (!(await checkDerivative(F, f, v))) throw new Fail('la comprobación no dio');
  return { F, steps };
}

async function checkDerivative(F, f, v) {
  const d = toGiac(add(derivSteps(F, v).result, neg(f)));
  const pts = ['0.37', '1.73', '2.9', '-0.61', '4.2', '0.81'];
  const out = await run(pts.map(p => `evalf(subst(${d},${v}=${p}))`));
  let good = 0;
  for (const o of out) {
    const n = Number(String(o).trim());
    if (!isFinite(n)) continue;
    if (Math.abs(n) > 1e-6) return false;
    good++;
  }
  return good >= 2;
}

const wrapC = c => (c.t === 'add' || c.t === 'neg' ? `\\left(${tex(c)}\\right)` : tex(c));

// ---------- Tabla de integrales (argumento exactamente x) ----------
function table(f, v) {
  const X = S(v), isV = n => n && n.t === 'sym' && n.v === v;
  const row = (title, F, rule) => ({ title, F: simp(F), rule });
  if (isV(f)) return row('Regla de la potencia', div(pow(X, N(2)), N(2)), `\\int ${v}\\,d${v} = \\frac{${v}^{2}}{2}`);
  if (f.t === 'pow' && isV(f.a) && !has(f.b, v)) {
    if (isNum(f.b, -1)) return row('Integral de 1/x', fn('ln', fn('abs', X)), `\\int \\frac{1}{${v}}\\,d${v} = \\ln|${v}|`);
    const e = add(f.b, ONE);
    return row('Regla de la potencia', div(pow(X, e), e), `\\int ${v}^{n}\\,d${v} = \\frac{${v}^{n+1}}{n+1}\\quad (n\\neq -1)`);
  }
  if (f.t === 'div' && isNum(f.a, 1) && isV(f.b)) return row('Integral de 1/x', fn('ln', fn('abs', X)), `\\int \\frac{1}{${v}}\\,d${v} = \\ln|${v}|`);
  if ((f.t === 'fn' && f.f === 'exp' && isV(f.a[0])) || (f.t === 'pow' && f.a.t === 'sym' && f.a.v === 'e' && isV(f.b))) return row('Integral de la exponencial', fn('exp', X), `\\int e^{${v}}\\,d${v} = e^{${v}}`);
  if (f.t === 'pow' && !has(f.a, v) && isV(f.b)) return row('Integral de una exponencial de base ' + tex(f.a), div(f, fn('ln', f.a)), `\\int a^{${v}}\\,d${v} = \\frac{a^{${v}}}{\\ln a}`);
  if (f.t === 'fn' && isV(f.a[0])) {
    const T = {
      sin: ['Integral del seno', neg(fn('cos', X)), `\\int \\sin ${v}\\,d${v} = -\\cos ${v}`],
      cos: ['Integral del coseno', fn('sin', X), `\\int \\cos ${v}\\,d${v} = \\sin ${v}`],
      tan: ['Integral de la tangente', neg(fn('ln', fn('abs', fn('cos', X)))), `\\int \\tan ${v}\\,d${v} = -\\ln|\\cos ${v}|`],
      cot: ['Integral de la cotangente', fn('ln', fn('abs', fn('sin', X))), `\\int \\cot ${v}\\,d${v} = \\ln|\\sin ${v}|`],
      sec: ['Integral de la secante', fn('ln', fn('abs', add(fn('sec', X), fn('tan', X)))), `\\int \\sec ${v}\\,d${v} = \\ln|\\sec ${v}+\\tan ${v}|`],
      csc: ['Integral de la cosecante', neg(fn('ln', fn('abs', add(fn('csc', X), fn('cot', X))))), `\\int \\csc ${v}\\,d${v} = -\\ln|\\csc ${v}+\\cot ${v}|`],
      sinh: ['Integral del seno hiperbólico', fn('cosh', X)], cosh: ['Integral del coseno hiperbólico', fn('sinh', X)],
      sqrt: ['Regla de la potencia ($\\sqrt{x} = x^{1/2}$)', mul(N(2, 3), pow(X, N(3, 2))), `\\int ${v}^{n}\\,d${v} = \\frac{${v}^{n+1}}{n+1}`],
    }[f.f];
    if (T) return row(T[0], T[1], T[2]);
  }
  if (f.t === 'pow' && isNum(f.b, 2) && f.a.t === 'fn' && isV(f.a.a[0])) {
    if (f.a.f === 'sec') return row('Integral de la secante al cuadrado', fn('tan', X), `\\int \\sec^2 ${v}\\,d${v} = \\tan ${v}`);
    if (f.a.f === 'csc') return row('Integral de la cosecante al cuadrado', neg(fn('cot', X)), `\\int \\csc^2 ${v}\\,d${v} = -\\cot ${v}`);
  }
  if (f.t === 'mul' && f.a.length === 2 && f.a.every(x => x.t === 'fn' && isV(x.a[0]))) {
    const names = f.a.map(x => x.f).sort().join(',');
    if (names === 'sec,tan') return row('Integral de sec·tan', fn('sec', X), `\\int \\sec ${v}\\tan ${v}\\,d${v} = \\sec ${v}`);
    if (names === 'cot,csc') return row('Integral de csc·cot', neg(fn('csc', X)), `\\int \\csc ${v}\\cot ${v}\\,d${v} = -\\csc ${v}`);
  }
  // 1/(1+x²), 1/√(1−x²), 1/(x²+a²)
  if (f.t === 'div' && isNum(f.a, 1)) {
    const b = f.b;
    const sq = n => n.t === 'pow' && isV(n.a) && isNum(n.b, 2);
    if (b.t === 'add' && b.a.length === 2) {
      const [p, q] = b.a, x2 = sq(p) ? p : sq(q) ? q : null, k = x2 === p ? q : p;
      if (x2 && k.t === 'num' && k.n > 0) {
        if (isNum(k, 1)) return row('Integral del arcotangente', fn('atan', X), `\\int \\frac{1}{1+${v}^2}\\,d${v} = \\arctan ${v}`);
        const a = simp(fn('sqrt', k));
        return row('Fórmula del arcotangente', mul(div(ONE, a), fn('atan', div(X, a))), `\\int \\frac{1}{${v}^2+a^2}\\,d${v} = \\frac{1}{a}\\arctan\\frac{${v}}{a}`);
      }
    }
    if (b.t === 'fn' && b.f === 'sqrt' && b.a[0].t === 'add' && b.a[0].a.length === 2) {
      const [p, q] = b.a[0].a;
      if (isNum(p, 1) && q.t === 'neg' && sq(q.a)) return row('Integral del arcoseno', fn('asin', X), `\\int \\frac{1}{\\sqrt{1-${v}^2}}\\,d${v} = \\arcsin ${v}`);
    }
  }
  return null;
}

function asPower(f, v) {
  const isV = n => n.t === 'sym' && n.v === v;
  if (f.t === 'div' && !has(f.a, v) && f.b.t === 'pow' && isV(f.b.a) && !has(f.b.b, v)) return simp(mul(f.a, pow(S(v), neg(f.b.b))));
  if (f.t === 'div' && !has(f.a, v) && f.b.t === 'fn' && f.b.f === 'sqrt' && isV(f.b.a[0])) return simp(mul(f.a, pow(S(v), N(-1, 2))));
  if (f.t === 'fn' && f.f === 'surd' && isV(f.a[0])) return simp(pow(S(v), div(ONE, f.a[1])));
  return null;
}

function trigIdentity(f, v) {
  if (f.t !== 'pow' || !isNum(f.b, 2) || f.a.t !== 'fn') return null;
  const u = f.a.a[0], two = mul(N(2), u);
  if (f.a.f === 'sin') return { title: 'Identidad del ángulo doble', rule: '\\sin^2\\theta = \\frac{1-\\cos 2\\theta}{2}', g: simp(div(add(ONE, neg(fn('cos', two))), N(2))) };
  if (f.a.f === 'cos') return { title: 'Identidad del ángulo doble', rule: '\\cos^2\\theta = \\frac{1+\\cos 2\\theta}{2}', g: simp(div(add(ONE, fn('cos', two)), N(2))) };
  if (f.a.f === 'tan') return { title: 'Identidad pitagórica', rule: '\\tan^2\\theta = \\sec^2\\theta - 1', g: simp(add(pow(fn('sec', u), N(2)), N(-1))) };
  return null;
}

export { Fail as IntegFail };
