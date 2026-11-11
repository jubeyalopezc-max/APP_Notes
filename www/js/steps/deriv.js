// Derivadas paso a paso: aplica las reglas una por una y cuenta cuál usó en cada momento.
import { N, S, ZERO, ONE, has, simp, tex, add, mul, div, pow, neg, fn, isNum } from './ast.js';

const D = (n, v) => `\\frac{d}{d${v}}\\left[${tex(n)}\\right]`;

// f'(u) de cada función, escrito en términos de u.
const TABLE = {
  sin: { d: u => fn('cos', u), name: 'del seno', rule: '\\frac{d}{dx}\\sin u = \\cos u' },
  cos: { d: u => neg(fn('sin', u)), name: 'del coseno', rule: '\\frac{d}{dx}\\cos u = -\\sin u' },
  tan: { d: u => pow(fn('sec', u), N(2)), name: 'de la tangente', rule: '\\frac{d}{dx}\\tan u = \\sec^2 u' },
  cot: { d: u => neg(pow(fn('csc', u), N(2))), name: 'de la cotangente', rule: '\\frac{d}{dx}\\cot u = -\\csc^2 u' },
  sec: { d: u => mul(fn('sec', u), fn('tan', u)), name: 'de la secante', rule: '\\frac{d}{dx}\\sec u = \\sec u\\tan u' },
  csc: { d: u => neg(mul(fn('csc', u), fn('cot', u))), name: 'de la cosecante', rule: '\\frac{d}{dx}\\csc u = -\\csc u\\cot u' },
  exp: { d: u => fn('exp', u), name: 'de la exponencial', rule: '\\frac{d}{dx}e^{u} = e^{u}' },
  ln: { d: u => div(ONE, u), name: 'del logaritmo natural', rule: '\\frac{d}{dx}\\ln u = \\frac{1}{u}' },
  log10: { d: u => div(ONE, mul(u, fn('ln', N(10)))), name: 'del logaritmo en base 10', rule: '\\frac{d}{dx}\\log u = \\frac{1}{u\\ln 10}' },
  sqrt: { d: u => div(ONE, mul(N(2), fn('sqrt', u))), name: 'de la raíz cuadrada', rule: '\\frac{d}{dx}\\sqrt{u} = \\frac{1}{2\\sqrt{u}}' },
  asin: { d: u => div(ONE, fn('sqrt', add(ONE, neg(pow(u, N(2)))))), name: 'del arcoseno', rule: '\\frac{d}{dx}\\arcsin u = \\frac{1}{\\sqrt{1-u^2}}' },
  acos: { d: u => neg(div(ONE, fn('sqrt', add(ONE, neg(pow(u, N(2))))))), name: 'del arcocoseno', rule: '\\frac{d}{dx}\\arccos u = -\\frac{1}{\\sqrt{1-u^2}}' },
  atan: { d: u => div(ONE, add(ONE, pow(u, N(2)))), name: 'del arcotangente', rule: '\\frac{d}{dx}\\arctan u = \\frac{1}{1+u^2}' },
  sinh: { d: u => fn('cosh', u), name: 'del seno hiperbólico', rule: '\\frac{d}{dx}\\sinh u = \\cosh u' },
  cosh: { d: u => fn('sinh', u), name: 'del coseno hiperbólico', rule: '\\frac{d}{dx}\\cosh u = \\sinh u' },
  tanh: { d: u => add(ONE, neg(pow(fn('tanh', u), N(2)))), name: 'de la tangente hiperbólica', rule: '\\frac{d}{dx}\\tanh u = 1-\\tanh^2 u' },
  abs: { d: u => div(u, fn('abs', u)), name: 'del valor absoluto', rule: '\\frac{d}{dx}|u| = \\frac{u}{|u|}' },
};

export class StepLimit extends Error {}

/** Deriva n respecto a v. Devuelve { result, steps:[{title, rule?, latex}] }. */
export function derivSteps(n, v = 'x', maxSteps = 40) {
  const steps = [];
  const push = s => { if (steps.length >= maxSteps) throw new StepLimit(); steps.push(s); };
  const r = (s) => s.replace(/\\frac\{d\}\{dx\}/g, `\\frac{d}{d${v}}`).replace(/\bdx\b/g, 'd' + v);

  function d(n) {
    if (!has(n, v)) return ZERO;
    switch (n.t) {
      case 'sym': return ONE;
      case 'neg': return neg(d(n.a));
      case 'add': {
        const vary = n.a.filter(x => has(x, v));
        const consts = n.a.length - vary.length;
        if (vary.length > 1 || consts) {
          push({
            title: 'Regla de la suma: se deriva término por término' + (consts ? ' (la derivada de una constante es 0)' : ''),
            rule: r('\\frac{d}{dx}[f+g] = f\' + g\''),
            latex: `${D(n, v)} = ${vary.map(x => D(x, v)).join(' + ').replace(/\+ \\frac\{d\}\{d.\}\\left\[-/g, '- \\frac{d}{d' + v + '}\\left[')}`,
          });
        }
        return add(...vary.map(d));
      }
      case 'mul': {
        const consts = n.a.filter(x => !has(x, v)), vary = n.a.filter(x => has(x, v));
        if (consts.length) {
          const c = mul(...consts), g = mul(...vary);
          push({ title: 'La constante sale de la derivada', rule: r('\\frac{d}{dx}[c\\,f] = c\\,f\''), latex: `${D(n, v)} = ${texFactor(c)}\\,${D(g, v)}` });
          return mul(c, d(g));
        }
        if (vary.length === 1) return d(vary[0]);
        const u = vary[0], w = mul(...vary.slice(1));
        push({ title: 'Regla del producto', rule: r("\\frac{d}{dx}[u\\,v] = u'\\,v + u\\,v'"), latex: `${D(n, v)} = ${D(u, v)}\\cdot ${wrap(w)} + ${wrap(u)}\\cdot ${D(w, v)}` });
        const du = d(u), dw = d(w);
        return add(mul(du, w), mul(u, dw));
      }
      case 'div': {
        const { a, b } = n;
        if (!has(b, v)) {
          push({ title: 'La constante sale de la derivada', rule: r('\\frac{d}{dx}\\left[\\frac{f}{c}\\right] = \\frac{f\'}{c}'), latex: `${D(n, v)} = \\frac{1}{${tex(b)}}\\,${D(a, v)}` });
          return div(d(a), b);
        }
        if (!has(a, v) && (b.t === 'sym' || (b.t === 'pow' && b.a.t === 'sym' && b.b.t === 'num'))) {
          // c/x^n = c·x^(-n): más corto que la regla del cociente
          const base = b.t === 'sym' ? b : b.a, e = b.t === 'sym' ? ONE : b.b;
          const rew = mul(a, pow(base, neg(e)));
          push({ title: 'Se reescribe con exponente negativo', latex: `${tex(n)} = ${texNegPow(a, base, e)}` });
          return d(rew);
        }
        push({ title: 'Regla del cociente', rule: r("\\frac{d}{dx}\\left[\\frac{u}{v}\\right] = \\frac{u'\\,v - u\\,v'}{v^{2}}"), latex: `${D(n, v)} = \\frac{${D(a, v)}\\cdot ${wrap(b)} - ${wrap(a)}\\cdot ${D(b, v)}}{${tex(pow(b, N(2)))}}` });
        const da = d(a), db = d(b);
        return div(add(mul(da, b), neg(mul(a, db))), pow(b, N(2)));
      }
      case 'pow': {
        const { a, b } = n;
        if (has(a, v) && !has(b, v)) {
          const res = mul(b, pow(a, add(b, N(-1))));
          if (a.t === 'sym') {
            push({ title: 'Regla de la potencia', rule: r('\\frac{d}{dx}x^{n} = n\\,x^{n-1}'), latex: `${D(n, v)} = ${tex(res)}` });
            return res;
          }
          push({ title: `Regla de la cadena (potencia), con u = ${inline(a)}`, rule: r("\\frac{d}{dx}u^{n} = n\\,u^{n-1}\\,u'"), latex: `${D(n, v)} = ${tex(res)}\\cdot ${D(a, v)}` });
          return mul(res, d(a));
        }
        if (!has(a, v)) {
          const isE = a.t === 'sym' && a.v === 'e';
          const outer = isE ? n : mul(n, fn('ln', a));
          const simple = b.t === 'sym';
          push({
            title: (isE ? 'Derivada de la exponencial' : 'Derivada de una exponencial de base ' + inline(a)) + (simple ? '' : `, con regla de la cadena (u = ${inline(b)})`),
            rule: r(isE ? "\\frac{d}{dx}e^{u} = e^{u}\\,u'" : "\\frac{d}{dx}a^{u} = a^{u}\\ln a\\,u'"),
            latex: `${D(n, v)} = ${tex(outer)}${simple ? '' : '\\cdot ' + D(b, v)}`,
          });
          return simple ? outer : mul(outer, d(b));
        }
        // u^w con las dos variables: derivación logarítmica
        push({ title: 'Derivación logarítmica (la base y el exponente tienen la variable)', rule: r("\\frac{d}{dx}u^{w} = u^{w}\\left(w'\\ln u + \\frac{w\\,u'}{u}\\right)"), latex: `${D(n, v)} = ${tex(n)}\\left(${D(b, v)}\\,${tex(fn('ln', a))} + \\frac{${tex(b)}}{${tex(a)}}\\,${D(a, v)}\\right)` });
        return mul(n, add(mul(d(b), fn('ln', a)), mul(div(b, a), d(a))));
      }
      case 'fn': {
        let f = n.f, u = n.a[0];
        if (f === 'surd') return d(pow(u, div(ONE, n.a[1])));
        if (f === 'logb') return d(div(fn('ln', u), fn('ln', n.a[1])));
        const row = TABLE[f];
        if (!row) throw new Error('sin regla para ' + f);
        const outer = row.d(u);
        if (u.t === 'sym' && u.v === v) {
          push({ title: 'Derivada ' + row.name, rule: r(row.rule), latex: `${D(n, v)} = ${tex(outer)}` });
          return outer;
        }
        push({ title: `Regla de la cadena: derivada ${row.name} con u = ${inline(u)}`, rule: r(row.rule.replace('= ', "= ").replace(/$/, "\\cdot u'")), latex: `${D(n, v)} = ${wrap(outer)}\\cdot ${D(u, v)}` });
        return mul(outer, d(u));
      }
      default: throw new Error('no se puede derivar');
    }
  }

  const result = simp(d(n));
  return { result, steps };
}

const wrap = n => (n.t === 'add' || n.t === 'neg' ? `\\left(${tex(n)}\\right)` : tex(n));
const texFactor = c => (c.t === 'add' ? `\\left(${tex(c)}\\right)` : tex(c));
const inline = n => `$${tex(n)}$`;
function texNegPow(a, base, e) {
  const coef = isNum(a, 1) ? '' : tex(a);
  return `${coef}${tex(base)}^{-${tex(e)}}`;
}
