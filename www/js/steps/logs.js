// Logaritmos paso a paso: propiedades (expandir y juntar), cambio de base y ecuaciones
// exponenciales y logarítmicas (misma base, logaritmo a ambos lados, forma exponencial, dominio).
import { run, isError, splitApprox } from '../cas.js';
import { N, S, ONE, parse, simp, tex, toGiac, has, add, mul, div, pow, neg, fn, isNum } from './ast.js';
import { equationSteps } from './algebra.js';

class Fail extends Error {}
async function G(cmd) {
  const [r] = await run([cmd]);
  if (isError(r)) throw new Fail(String(r));
  let s = String(r).trim();
  if (s.startsWith('"')) s = s.slice(1, -1);
  return splitApprox(s).exact;
}
const P = s => simp(parse(s));

export const isLog = n => n && n.t === 'fn' && (n.f === 'ln' || n.f === 'log10' || n.f === 'logb');
const isE = n => n && n.t === 'sym' && n.v === 'e';
export const baseOf = n => (n.f === 'ln' ? S('e') : n.f === 'log10' ? N(10) : n.a[1]);
export function mkLog(arg, base) {
  if (isE(base)) return fn('ln', arg);
  if (isNum(base, 10)) return fn('log10', arg);
  return fn('logb', arg, base);
}
const sameBase = (a, b) => toGiac(simp(a)) === toGiac(simp(b));
const bTex = b => (isE(b) ? '\\ln' : isNum(b, 10) ? '\\log' : `\\log_{${tex(b)}}`);
const hasLog = n => isLog(n) || (Array.isArray(n.a) ? n.a.some(hasLog) : (n.a && typeof n.a === 'object' && hasLog(n.a)) || (n.b && hasLog(n.b)));
const hasExpVar = (n, v) => (n.t === 'pow' && has(n.b, v)) || (n.t === 'fn' && n.f === 'exp' && has(n, v)) || (Array.isArray(n.a) ? n.a.some(x => hasExpVar(x, v)) : (n.a && typeof n.a === 'object' && hasExpVar(n.a, v)) || (n.b && hasExpVar(n.b, v)));

// ---------- Expandir ----------
export function expandLogSteps(n0) {
  const steps = [];
  const once = new Set();
  const note = (key, s) => { if (!once.has(key)) { once.add(key); steps.push(s); } else steps.push({ ...s, rule: undefined }); };
  function ex(n) {
    if (isLog(n)) {
      const b = baseOf(n), arg = simp(n.a[0]), L = x => mkLog(x, b);
      if (sameBase(arg, b)) { note('bb', { title: 'El logaritmo de la base es 1', rule: '\\log_b b = 1', latex: `${tex(n)} = 1` }); return ONE; }
      // log de un número que es potencia exacta de la base: log 100 = 2, log₂ 8 = 3
      if (arg.t === 'num' && arg.d === 1 && arg.n > 0 && b.t === 'num' && b.d === 1 && b.n > 1) {
        const k = Math.round(Math.log(arg.n) / Math.log(b.n));
        if (Math.pow(b.n, k) === arg.n) { note('num' + k, { title: `Como $${tex(b)}^{${k}} = ${arg.n}$, el logaritmo vale ${k}`, rule: '\\log_b b^{k} = k', latex: `${tex(n)} = ${k}` }); return N(k); }
      }
      if (arg.t === 'mul') {
        const r = add(...arg.a.map(L));
        note('prod', { title: 'Logaritmo de un producto: se separa en una suma', rule: '\\log_b(MN) = \\log_b M + \\log_b N', latex: `${tex(n)} = ${tex(r)}` });
        return ex(r);
      }
      if (arg.t === 'div') {
        const r = add(L(arg.a), neg(L(arg.b)));
        note('quot', { title: 'Logaritmo de un cociente: se separa en una resta', rule: '\\log_b\\frac{M}{N} = \\log_b M - \\log_b N', latex: `${tex(n)} = ${tex(r)}` });
        return ex(r);
      }
      if (arg.t === 'pow' && !isE(arg.a)) {
        const r = mul(arg.b, L(arg.a));
        note('pow', { title: 'Logaritmo de una potencia: el exponente pasa adelante', rule: '\\log_b M^{k} = k\\log_b M', latex: `${tex(n)} = ${tex(r)}` });
        return ex(r);
      }
      if (arg.t === 'pow' && isE(arg.a) && isE(b)) { note('lne', { title: 'El logaritmo natural deshace la exponencial', rule: '\\ln e^{k} = k', latex: `${tex(n)} = ${tex(arg.b)}` }); return arg.b; }
      if (arg.t === 'fn' && arg.f === 'sqrt') {
        const r = mul(N(1, 2), L(arg.a[0]));
        note('sqrt', { title: 'La raíz es una potencia 1/2: el exponente pasa adelante', rule: '\\log_b \\sqrt{M} = \\tfrac{1}{2}\\log_b M', latex: `${tex(n)} = ${tex(r)}` });
        return ex(r);
      }
      return n;
    }
    if (n.t === 'add') return add(...n.a.map(ex));
    if (n.t === 'mul') return mul(...n.a.map(ex));
    if (n.t === 'neg') return neg(ex(n.a));
    if (n.t === 'div') return div(ex(n.a), n.b);
    return n;
  }
  const result = simp(ex(simp(n0)));
  if (steps.length) steps.push({ title: 'Resultado (se supone que los argumentos son positivos)', latex: `${tex(simp(n0))} = ${tex(result)}` });
  return { result, steps };
}

// ---------- Juntar ----------
export function condenseLogSteps(n0) {
  const n = simp(n0);
  const terms = n.t === 'add' ? n.a : [n];
  const steps = [];
  // Cada término: coeficiente·log_b(A)
  const parts = [];
  const rest = [];
  for (const t of terms) {
    let sign = 1, x = t;
    if (x.t === 'neg') { sign = -1; x = x.a; }
    let c = ONE, lg = null;
    if (isLog(x)) lg = x;
    else if (x.t === 'mul') { const l = x.a.filter(isLog); if (l.length === 1) { lg = l[0]; c = mul(...x.a.filter(y => y !== lg)); } }
    if (lg && !has(c, '__')) parts.push({ sign, c: simp(c), lg }); else rest.push(t);
  }
  if (parts.length < 1 || (parts.length === 1 && isNum(parts[0].c, 1))) return { result: n, steps };
  const b = baseOf(parts[0].lg);
  if (!parts.every(p => sameBase(baseOf(p.lg), b))) return { result: n, steps: [{ title: 'Los logaritmos tienen bases distintas: primero usa “Cambio de base”', latex: tex(n) }] };
  // 1. Coeficientes como exponentes
  const pw = parts.map(p => ({ sign: p.sign, A: isNum(p.c, 1) ? p.lg.a[0] : pow(p.lg.a[0], p.c) }));
  if (parts.some(p => !isNum(p.c, 1))) {
    const mid = add(...pw.map(p => (p.sign < 0 ? neg(mkLog(p.A, b)) : mkLog(p.A, b))), ...rest);
    steps.push({ title: 'Cada coeficiente sube como exponente', rule: 'k\\log_b M = \\log_b M^{k}', latex: `${tex(n)} = ${tex(mid)}` });
  }
  // 2. Sumas → producto, restas → cociente
  const top = pw.filter(p => p.sign > 0).map(p => p.A), bot = pw.filter(p => p.sign < 0).map(p => p.A);
  const arg = bot.length ? div(top.length ? mul(...top) : ONE, mul(...bot)) : mul(...top);
  const single = mkLog(arg, b);
  const result = rest.length ? add(single, ...rest) : single;
  steps.push({ title: bot.length && top.length > 1 ? 'Las sumas se vuelven producto y las restas cociente' : bot.length ? 'La resta de logaritmos es el logaritmo del cociente' : 'La suma de logaritmos es el logaritmo del producto', rule: bot.length ? '\\log_b M - \\log_b N = \\log_b\\frac{M}{N}' : '\\log_b M + \\log_b N = \\log_b(MN)', latex: `= ${tex(result)}` });
  return { result, steps };
}

// ---------- Cambio de base ----------
export async function changeBaseSteps(n0) {
  const steps = [];
  const logs = [];
  const walk = n => { if (isLog(n) && n.f !== 'ln') logs.push(n); (Array.isArray(n.a) ? n.a : [n.a, n.b]).filter(x => x && typeof x === 'object').forEach(walk); };
  walk(simp(n0));
  if (!logs.length) return null;
  for (const l of logs.slice(0, 4)) {
    const b = baseOf(l), a = l.a[0];
    const r = div(fn('ln', a), fn('ln', b));
    let approx = '';
    if (!has(a, 'x') && !/[a-z]/.test(toGiac(a).replace(/pi|e\b|sqrt|ln/g, ''))) { try { approx = ' \\approx ' + (+Number(await G(`evalf(${toGiac(r)})`)).toPrecision(8)); } catch {} }
    steps.push({ title: 'Cambio de base a logaritmo natural', rule: '\\log_b a = \\frac{\\ln a}{\\ln b}', latex: `${tex(l)} = ${tex(r)} = ${tex(div(fn('log10', a), fn('log10', b)))}${approx}` });
  }
  return steps;
}

// ---------- Ecuaciones exponenciales y logarítmicas ----------
/** Devuelve pasos, o null si la ecuación no es de este tipo. */
export async function logEquationSteps(lhs0, rhs0, v) {
  let lhs = simp(lhs0), rhs = simp(rhs0);
  if (!(hasLog(lhs) && has(lhs, v)) && !(hasLog(rhs) && has(rhs, v)) && !hasExpVar(lhs, v) && !hasExpVar(rhs, v)) return null;
  // La parte con la variable a la izquierda
  if (!has(lhs, v) && has(rhs, v)) [lhs, rhs] = [rhs, lhs];
  const steps = [];
  const logArgs = [];
  const collectArgs = n => { if (isLog(n) && has(n, v)) logArgs.push(n.a[0]); (Array.isArray(n.a) ? n.a : [n.a, n.b]).filter(x => x && typeof x === 'object').forEach(collectArgs); };
  collectArgs(lhs); collectArgs(rhs);

  let F = null, C = null; // la ecuación algebraica final F = C
  if (hasLog(lhs) && !has(rhs, v)) {
    // log_b(F) = c (juntando primero si hay varios)
    let L = lhs;
    if (!isLog(L)) {
      const c = condenseLogSteps(L);
      if (!isLog(c.result)) return null;
      const lastRule = c.steps.length ? c.steps[c.steps.length - 1].rule : undefined;
      if (c.steps.length > 1) for (const s of c.steps.slice(0, -1)) steps.push(s);
      steps.push({ title: 'Se juntan los logaritmos en uno solo (propiedades)', rule: lastRule, latex: `${tex(L)} = ${tex(c.result)}` });
      L = c.result;
    }
    const b = baseOf(L);
    F = L.a[0]; C = simp(pow(b, rhs));
    steps.push({ title: 'Se pasa a forma exponencial', rule: '\\log_b M = c \\iff M = b^{c}', latex: `${tex(L)} = ${tex(rhs)} \\iff ${tex(F)} = ${tex(pow(b, rhs))}${toGiac(C) !== toGiac(pow(b, rhs)) ? ' = ' + tex(C) : ''}` });
  } else if (isLog(lhs) && isLog(rhs) && sameBase(baseOf(lhs), baseOf(rhs))) {
    F = lhs.a[0]; C = rhs.a[0];
    steps.push({ title: 'Mismo logaritmo a los dos lados: los argumentos son iguales', rule: '\\log_b M = \\log_b N \\iff M = N', latex: `${tex(F)} = ${tex(C)}` });
  } else {
    // k·a^f = c  → a^f = c/k
    let E = lhs, k = ONE;
    if (E.t === 'mul') { const pw = E.a.filter(x => hasExpVar(x, v)); if (pw.length === 1 && E.a.every(x => x === pw[0] || !has(x, v))) { k = mul(...E.a.filter(x => x !== pw[0])); E = pw[0]; } }
    const asPow = n => (n.t === 'fn' && n.f === 'exp' ? { a: S('e'), f: n.a[0] } : n.t === 'pow' && !has(n.a, v) ? { a: n.a, f: n.b } : null);
    const L = asPow(E);
    if (!L) return null;
    let R = rhs;
    if (!isNum(k, 1)) { R = simp(div(rhs, k)); steps.push({ title: 'Se despeja la potencia', latex: `${tex(E)} = ${tex(R)}` }); }
    const Rp = asPow(R);
    if (!has(R, v)) {
      // ¿c es potencia de a? (8 = 2^3)
      let kk = null;
      try { const t = P(await G(`simplify(ln(${toGiac(R)})/ln(${toGiac(L.a)}))`)); if (t.t === 'num') kk = t; } catch {}
      if (kk) {
        steps.push({ title: `Se escribe ${tex(R).length < 12 ? '$' + tex(R) + '$' : 'el número'} como potencia de ${'$' + tex(L.a) + '$'}`, latex: `${tex(E)} = ${tex({ t: 'pow', a: L.a, b: kk })}` });
        steps.push({ title: 'Misma base: se igualan los exponentes', rule: 'a^{M} = a^{N} \\iff M = N', latex: `${tex(L.f)} = ${tex(kk)}` });
        F = L.f; C = kk;
      } else {
        const lg = isE(L.a) ? 'ln' : 'ln';
        steps.push({ title: isE(L.a) ? 'Se saca logaritmo natural a los dos lados (deshace la e)' : 'Se saca logaritmo natural a los dos lados', rule: isE(L.a) ? '\\ln e^{M} = M' : '\\ln a^{M} = M\\ln a', latex: `${isE(L.a) ? tex(L.f) : tex(mul(L.f, fn(lg, L.a)))} = ${tex(fn('ln', R))}` });
        F = isE(L.a) ? L.f : mul(L.f, fn('ln', L.a)); C = fn('ln', R);
      }
    } else if (Rp) {
      steps.push({ title: 'Potencias de bases distintas: logaritmo natural a los dos lados', rule: '\\ln a^{M} = M\\ln a', latex: `${tex(mul(L.f, fn('ln', L.a)))} = ${tex(mul(Rp.f, fn('ln', Rp.a)))}` });
      F = mul(L.f, fn('ln', L.a)); C = mul(Rp.f, fn('ln', Rp.a));
    } else return null;
  }
  // Resolver la ecuación algebraica que quedó
  let inner = null;
  // Si ya quedó x = número, no hay nada más que despejar.
  const solved = F.t === 'sym' && F.v === v && !has(C, v);
  if (!solved) { try { inner = await equationSteps(F, C, v); } catch {} }
  else inner = { steps: [] };
  if (inner && inner.steps) steps.push(...inner.steps.filter(s => !/^Se ordena/.test(s.title) || true));
  const sols = await G(`solve(${toGiac(F)}=${toGiac(C)},${v})`);
  const m = /^\s*(?:list)?\[(.*)\]\s*$/.exec(sols);
  const cand = m && m[1].trim() ? m[1].split(/,(?![^(\[]*[)\]])/) : [];
  if (!inner || !inner.steps) steps.push({ title: 'Se despeja ' + v, latex: cand.length ? cand.map(s => `${v} = ${tex(P(s))}`).join(',\\quad ') : '\\text{sin solución}' });
  // Dominio: los argumentos de los logaritmos deben ser positivos
  if (logArgs.length && cand.length) {
    const ok = [], bad = [];
    for (const s of cand) {
      let good = true;
      for (const a of logArgs) {
        const val = Number(await G(`evalf(subst(${toGiac(a)},${v}=${s}))`));
        if (!(val > 0)) { good = false; break; }
      }
      (good ? ok : bad).push(s);
    }
    steps.push({
      title: bad.length ? 'Se revisa el dominio: el argumento de un logaritmo debe ser positivo; se descartan las que no cumplen' : 'Se revisa el dominio: con estas soluciones todos los argumentos de los logaritmos son positivos',
      latex: [...ok.map(s => `${v} = ${tex(P(s))}\\ \\checkmark`), ...bad.map(s => `${v} = ${tex(P(s))}\\ \\text{(se descarta)}`)].join(',\\quad ') || '\\text{ninguna}',
    });
  }
  return steps;
}
