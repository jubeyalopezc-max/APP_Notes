// Paso a paso: decide qué explicación corresponde a cada cálculo de la calculadora.
import { run, isError, splitApprox } from '../cas.js';
import { latexToGiac } from '../latex2giac.js';
import { parse, simp, tex, toGiac, S, add, neg, has } from './ast.js';
import { derivSteps, StepLimit } from './deriv.js';
import { integSteps } from './integ.js';
import { limitSteps } from './limit.js';
import { equationSteps, systemSteps, detSteps, inverseSteps, gaussJordan, readMatrix, matTex } from './algebra.js';

async function G(cmd) {
  const [r] = await run([cmd]);
  if (isError(r)) throw new Error(String(r));
  let s = String(r).trim();
  if (s.startsWith('"')) s = s.slice(1, -1);
  return splitApprox(s).exact;
}
const P = s => simp(parse(s));

/** La forma más corta y clara del resultado (como en la calculadora). */
async function nicest(n) {
  const c = [n];
  for (const op of ['simplify', 'normal', 'expand']) { try { c.push(P(await G(`${op}(${toGiac(n)})`))); } catch {} }
  return c.sort((a, b) => tex(a).length - tex(b).length)[0];
}

/** ¿Tiene sentido ofrecer el paso a paso para este cálculo? (rápido, sin el motor) */
export function hasSteps(h) {
  const a = h.action;
  if (['diff', 'int', 'lim', 'det', 'inv', 'rref', 'solve'].includes(a)) return true;
  if (a !== 'auto') return false;
  try {
    const { info } = latexToGiac(h.input);
    if (info.op && ['diff', 'int', 'lim'].includes(info.op)) return true;
    if (info.rel === '=' && !info.ode) return true;
  } catch {}
  return false;
}

// "diff(F,x,2)" → { f:F, v, n }
function call(giac, name) {
  const n = parse(giac);
  if (n.t !== 'fn' || n.f !== name) return null;
  return n.a;
}

export async function stepsFor(h) {
  const { giac, info } = latexToGiac(h.input);
  const o = h.opts || {};
  let a = h.action;
  if (a === 'auto') a = info.op || (info.rel === '=' ? 'solve' : a);
  const out = [];

  if (a === 'diff') {
    let f, v, n;
    const c = h.action === 'auto' ? call(giac, 'diff') : null;
    if (c) { f = simp(c[0]); v = c[1].v; n = c[2] ? c[2].n : 1; }
    else { f = P(giac); v = o.var || 'x'; n = +o.order || 1; }
    let cur = f;
    for (let k = 1; k <= Math.min(n, 4); k++) {
      if (n > 1) out.push({ title: `${['', 'Primera', 'Segunda', 'Tercera', 'Cuarta'][k]} derivada`, heading: true });
      const r = derivSteps(cur, v);
      out.push(...r.steps);
      const nice = await nicest(r.result);
      out.push({ title: 'Se juntan los resultados y se simplifica', latex: `${n > 1 ? `f^{(${k})}` : `\\frac{d}{d${v}}\\left[${tex(f)}\\right]`} = ${tex(nice)}` });
      cur = nice;
    }
    return out;
  }

  if (a === 'int') {
    let f, v, lo = null, hi = null;
    const c = h.action === 'auto' ? call(giac, 'integrate') : null;
    if (c) {
      if (c[0].t === 'fn' && c[0].f === 'integrate') return null; // integrales dobles: solo resultado
      f = simp(c[0]); v = c[1].v; if (c[2]) { lo = c[2]; hi = c[3]; }
    } else {
      f = P(giac); v = o.var || 'x';
      if (o.a && o.b) { lo = P(latexToGiac(o.a).giac); hi = P(latexToGiac(o.b).giac); }
    }
    const r = await integSteps(f, v);
    out.push(...r.steps);
    const F = await nicest(r.F);
    if (!lo) {
      out.push({ title: 'Resultado (se suma la constante de integración C)', latex: `\\int ${tex(f)}\\,d${v} = ${tex(F)} + C` });
      return out;
    }
    const Fb = P(await G(`simplify(subst(${toGiac(F)},${v}=${toGiac(hi)}))`));
    const Fa = P(await G(`simplify(subst(${toGiac(F)},${v}=${toGiac(lo)}))`));
    const val = P(await G(`simplify(${toGiac(add(Fb, neg(Fa)))})`));
    out.push({ title: 'Teorema fundamental del cálculo: se evalúa la primitiva en los límites', rule: '\\int_a^b f\\,dx = F(b) - F(a)', latex: `\\int_{${tex(lo)}}^{${tex(hi)}} ${tex(f)}\\,d${v} = \\left[${tex(F)}\\right]_{${tex(lo)}}^{${tex(hi)}} = ${wrapP(Fb)} - ${wrapP(Fa)} = ${tex(val)}` });
    return out;
  }

  if (a === 'lim') {
    let f, v, at, side = 0;
    const c = h.action === 'auto' ? call(giac, 'limit') : null;
    if (c) { f = simp(c[0]); v = c[1].v; at = toGiac(c[2]); side = c[3] ? (c[3].t === 'num' ? c[3].n : -1) : 0; }
    else { f = P(giac); v = o.var || 'x'; at = o.to ? latexToGiac(o.to).giac : '0'; side = +o.side || 0; }
    at = at.replace(/^\(?\+?inf\)?$/, 'inf').replace(/^\(?-\(?inf\)?\)?$/, '-inf');
    const r = await limitSteps(f, v, at, side);
    return r.steps;
  }

  if (a === 'solve') {
    if (info.ode) return null;
    if (info.list) {
      const eqs = giac.split(/,(?![^([]*[)\]])/).map(s => s.split('=')).filter(p => p.length === 2).map(([l, r]) => ({ lhs: P(l), rhs: P(r) }));
      if (eqs.length !== info.count) return null;
      const r = await systemSteps(eqs, info.vars);
      return r && r.steps;
    }
    if (info.rel !== '=' && info.rel) return null;
    const v = o.var || (info.vars.includes('x') ? 'x' : info.vars[0]);
    const [l, r] = giac.includes('=') ? giac.split('=') : [giac, '0'];
    const res = await equationSteps(P(l), P(r), v);
    return res && res.steps;
  }

  if (['det', 'inv', 'rref'].includes(a)) {
    const M = readMatrix(giac);
    if (!M) return null;
    if (a === 'det') { if (M.length !== M[0].length) return null; return detSteps(M).steps; }
    if (a === 'inv') { if (M.length !== M[0].length) return null; return inverseSteps(M).steps; }
    const r = gaussJordan(M);
    return [{ title: 'Matriz inicial', latex: matTex(M) }, ...r.steps, { title: 'Forma escalonada reducida', latex: matTex(r.M) }];
  }
  return null;
}
const wrapP = n => (n.t === 'add' || n.t === 'neg' || (n.t === 'num' && n.n < 0) ? `\\left(${tex(n)}\\right)` : tex(n));
export { StepLimit };
