// Límites paso a paso: sustitución directa, forma indeterminada, factorizar y simplificar,
// comparar grados en el infinito, L'Hôpital y forma 1^∞.
import { run, isError, splitApprox } from '../cas.js';
import { N, S, ONE, ZERO, parse, simp, tex, toGiac, has, div, mul, add, pow, neg, fn, polyDegree } from './ast.js';
import { derivSteps } from './deriv.js';

class Fail extends Error {}
async function G(cmd) {
  const [r] = await run([cmd]);
  if (isError(r)) throw new Fail(String(r));
  let s = String(r).trim();
  if (s.startsWith('"')) s = s.slice(1, -1);
  return splitApprox(s).exact;
}
const P = s => simp(parse(s));

// Lo que da el motor como valor: número, ±∞ o indefinido.
function kind(s) {
  const t = s.replace(/\s/g, '');
  if (t === 'undef' || /limit\(/.test(t)) return 'undef';
  if (t === 'infinity') return 'inf?';
  if (t === '+infinity' || t === 'inf') return '+inf';
  if (t === '-infinity' || t === '-inf') return '-inf';
  return 'fin';
}
const valTex = s => { const k = kind(s); return k === '+inf' ? '+\\infty' : k === '-inf' ? '-\\infty' : k === 'inf?' ? '\\infty' : tex(P(s)).replace(/e\^\{1\}/g, 'e'); };
// "a = b = b" → "a = b"
export const dedupe = s => s.split(' = ').filter((x, i, a) => i === 0 || x.trim() !== a[i - 1].trim()).join(' = ');

/**
 * Pasos de lím_{v→a} f. aStr: punto en texto de Giac (puede ser "inf", "-inf"); side: 0, 1 o -1.
 * Devuelve { steps, value } (value: texto de Giac del resultado).
 */
export async function limitSteps(f0, v, aStr, side = 0) {
  const steps = [];
  const sideTxt = side > 0 ? '^{+}' : side < 0 ? '^{-}' : '';
  const aTex = aStr === 'inf' || aStr === '+inf' ? '+\\infty' : aStr === '-inf' ? '-\\infty' : tex(P(aStr));
  const L = (f) => `\\lim_{${v}\\to ${aTex}${sideTxt}} ${f.t === 'add' ? `\\left(${tex(f)}\\right)` : tex(f)}`;
  const lim = async f => G(`limit(${toGiac(f)},${v},${aStr}${side ? ',' + side : ''})`);
  const atInf = /inf/.test(aStr);

  async function go(f, depth) {
    if (depth > 4) throw new Fail('demasiados pasos');
    f = simp(f);
    // 1. Sustitución directa (solo en un punto finito)
    if (!atInf) {
      let direct = null;
      try { direct = await G(`simplify(subst(${toGiac(f)},${v}=${aStr}))`); } catch {}
      if (direct && kind(direct) === 'fin' && !/undef|infinity/.test(direct)) {
        steps.push({ title: 'Sustitución directa: la función está definida en ese punto', latex: `${L(f)} = ${tex(replaceVar(f, v, P(aStr)))} = ${valTex(direct)}` });
        return direct;
      }
    }
    // 2. Cocientes: ver qué forma tiene (fracciones dentro de fracciones se simplifican primero)
    let num = null, den = null;
    if (f.t === 'div' && depth > 0 && (hasDiv(f.a) || hasDiv(f.b))) {
      const t = P(await G(`normal(${toGiac(f)})`));
      if (t.t === 'div' && toGiac(t) !== toGiac(f)) { steps.push({ title: 'Se simplifica la fracción', latex: `${tex(f)} = ${tex(t)}` }); f = t; }
    }
    if (f.t === 'div') { num = f.a; den = f.b; }
    else if (f.t === 'mul' && f.a.some(x => x.t === 'div' || (x.t === 'pow' && x.b.t === 'num' && x.b.n < 0))) {
      const t = P(await G(`normal(${toGiac(f)})`));
      if (t.t === 'div') { num = t.a; den = t.b; }
    }
    if (num && den) {
      const [ln, ld] = [await lim(num), await lim(den)];
      const kn = kind(ln), kd = kind(ld);
      const zero = s => kind(s) === 'fin' && P(s).t === 'num' && P(s).n === 0;
      const infy = k => k.includes('inf');
      if (zero(ln) && zero(ld)) {
        steps.push({ title: 'Al sustituir queda $\\frac{0}{0}$: forma indeterminada', latex: `${L(f)} \\;\\to\\; \\frac{0}{0}` });
        // 2a. Polinomios: factorizar y simplificar
        if (polyDegree(num, v) >= 1 && polyDegree(den, v) >= 1) {
          const fn_ = P(await G(`factor(${toGiac(num)})`)), fd = P(await G(`factor(${toGiac(den)})`));
          const s = P(await G(`normal(${toGiac(f)})`));
          if (toGiac(s) !== toGiac(f) && (s.t !== 'div' || polyDegree(s.b, v) < polyDegree(den, v))) {
            steps.push({ title: 'Se factoriza y se cancela el factor común', latex: `\\frac{${tex(fn_)}}{${tex(fd)}} = ${tex(s)}` });
            return go(s, depth + 1);
          }
        }
        return lhopital(num, den, depth);
      }
      if (infy(kn) && infy(kd)) {
        steps.push({ title: 'Queda $\\frac{\\infty}{\\infty}$: forma indeterminada', latex: `${L(f)} \\;\\to\\; \\frac{\\infty}{\\infty}` });
        const pn = polyDegree(num, v), pd = polyDegree(den, v);
        if (atInf && pn >= 0 && pd >= 0) {
          const [cn, cd] = await Promise.all([G(`coeff(${toGiac(num)},${v},${pn})`), G(`coeff(${toGiac(den)},${v},${pd})`)]);
          const k = Math.max(pn, pd);
          const res = await lim(f);
          const why = pn < pd ? 'el denominador tiene mayor grado: el límite es 0'
            : pn === pd ? 'los grados son iguales: el límite es el cociente de los coeficientes principales'
              : 'el numerador tiene mayor grado: el límite es infinito';
          steps.push({ title: `Se divide arriba y abajo entre $${k === 1 ? v : `${v}^{${k}}`}$; ${why}`, latex: pn === pd ? `${L(f)} = \\frac{${tex(P(cn))}}{${tex(P(cd))}} = ${valTex(res)}` : `${L(f)} = ${valTex(res)}` });
          return res;
        }
        return lhopital(num, den, depth);
      }
      if (kind(ln) === 'fin' && zero(ld) && !zero(ln)) {
        const res = await lim(f);
        steps.push({ title: 'Queda un número dividido entre 0: el límite tiende a infinito' + (kind(res) === 'undef' || kind(res) === 'inf?' ? ' (con signo distinto a cada lado)' : ''), latex: `${L(f)} \\;\\to\\; \\frac{${valTex(ln)}}{0}${kind(res) === 'undef' || kind(res) === 'inf?' ? '\\quad\\text{(no existe)}' : ' = ' + valTex(res)}` });
        return res;
      }
    }
    // 3. Forma 1^∞ (y en general u^w): se escribe como exponencial
    if (f.t === 'pow' && has(f.a, v) && has(f.b, v)) {
      const lb = await lim(f.a), le = await lim(f.b);
      if (kind(lb) === 'fin' && P(lb).t === 'num' && P(lb).n === 1 && kind(le).includes('inf')) {
        steps.push({ title: 'Queda $1^{\\infty}$: forma indeterminada. Se escribe como exponencial', rule: `u^{w} = e^{\\,w\\ln u}`, latex: `${L(f)} = e^{\\,${limTex(v, aTex, sideTxt)} ${tex(mul(f.b, fn('ln', f.a)))}}` });
        const inner = simp(div(fn('ln', f.a), div(ONE, f.b)));
        steps.push({ title: 'El exponente queda $0\\cdot\\infty$; se reescribe como cociente', latex: `${tex(mul(f.b, fn('ln', f.a)))} = ${tex(inner)}` });
        const e = await go(inner, depth + 1);
        const res = await lim(f);
        steps.push({ title: 'Se vuelve a la exponencial', latex: `${L(f)} = e^{${valTex(e)}} = ${valTex(res)}` });
        return res;
      }
    }
    const res = await lim(f);
    steps.push({ title: 'Valor del límite', latex: `${L(f)} = ${kind(res) === 'undef' ? '\\text{no existe}' : valTex(res)}` });
    return res;
  }

  async function lhopital(num, den, depth) {
    const dn = P(await G(`simplify(${toGiac(derivSteps(num, v).result)})`));
    const dd = P(await G(`simplify(${toGiac(derivSteps(den, v).result)})`));
    steps.push({ title: "Regla de L'Hôpital: se deriva arriba y abajo por separado", rule: `\\lim \\frac{f}{g} = \\lim \\frac{f'}{g'}`, latex: `${limTex(v, aTex, sideTxt)} \\frac{${tex(num)}}{${tex(den)}} = ${limTex(v, aTex, sideTxt)} \\frac{${tex(dn)}}{${tex(dd)}}` });
    return go(div(dn, dd), depth + 1);
  }

  const value = await go(simp(f0), 0);
  for (const s of steps) s.latex = dedupe(s.latex);
  return { steps, value };
}

const hasDiv = n => n.t === 'div' || (n.t === 'pow' && n.b.t === 'num' && n.b.n < 0) || (Array.isArray(n.a) ? n.a.some(hasDiv) : n.a && typeof n.a === 'object' && hasDiv(n.a));
const limTex = (v, aTex, sideTxt) => `\\lim_{${v}\\to ${aTex}${sideTxt}}`;
function replaceVar(n, v, val) {
  if (n.t === 'sym') return n.v === v ? val : n;
  if (n.t === 'num') return n;
  if (n.t === 'neg') return { t: 'neg', a: replaceVar(n.a, v, val) };
  if (n.t === 'div' || n.t === 'pow') return { t: n.t, a: replaceVar(n.a, v, val), b: replaceVar(n.b, v, val) };
  return { ...n, a: n.a.map(x => replaceVar(x, v, val)) };
}
export { Fail as LimitFail };
