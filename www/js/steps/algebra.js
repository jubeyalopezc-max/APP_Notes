// Álgebra paso a paso: ecuaciones (lineales, cuadráticas, por factorización), sistemas por Gauss
// y matrices (determinante, inversa, Gauss-Jordan) con fracciones exactas.
import { run, isError, splitApprox } from '../cas.js';
import { N, S, parse, simp, tex, toGiac, has, add, mul, div, neg, polyDegree, isNum } from './ast.js';

class Fail extends Error {}
async function G(cmd) {
  const [r] = await run([cmd]);
  if (isError(r)) throw new Fail(String(r));
  let s = String(r).trim();
  if (s.startsWith('"')) s = s.slice(1, -1);
  return splitApprox(s).exact;
}
const P = s => simp(parse(s));

// ---------- Fracciones exactas ----------
const bgcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
export class Q {
  constructor(n, d = 1n) { if (d < 0n) { n = -n; d = -d; } const g = bgcd(n, d); this.n = n / g; this.d = d / g; }
  static of(x) {
    if (x instanceof Q) return x;
    const s = String(x).trim().replace(/^\((.*)\)$/, '$1');
    let m = /^(-?\d+)\/(\d+)$/.exec(s);
    if (m) return new Q(BigInt(m[1]), BigInt(m[2]));
    m = /^(-?)(\d*)\.(\d+)$/.exec(s);
    if (m) { const den = 10n ** BigInt(m[3].length); return new Q(BigInt(m[1] + (m[2] || '0') + m[3]), den); }
    if (/^-?\d+$/.test(s)) return new Q(BigInt(s));
    return null;
  }
  add(o) { return new Q(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Q(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Q(this.n * o.n, this.d * o.d); }
  div(o) { return new Q(this.n * o.d, this.d * o.n); }
  neg() { return new Q(-this.n, this.d); }
  get zero() { return this.n === 0n; }
  get one() { return this.n === 1n && this.d === 1n; }
  tex() { return this.d === 1n ? String(this.n) : `${this.n < 0n ? '-' : ''}\\frac{${this.n < 0n ? -this.n : this.n}}{${this.d}}`; }
  coefTex() { return this.d === 1n ? String(this.n) : `\\tfrac{${this.n < 0n ? -this.n : this.n}}{${this.d}}`; }
  toString() { return this.d === 1n ? String(this.n) : `${this.n}/${this.d}`; }
}

export const matTex = (M, bar = -1) => {
  const cols = M[0].length;
  const spec = Array.from({ length: cols }, (_, j) => (j === bar ? '|c' : 'c')).join('');
  return `\\left(\\begin{array}{${spec}}${M.map(r => r.map(x => x.tex()).join(' & ')).join(' \\\\ ')}\\end{array}\\right)`;
};
const R = i => `F_{${i + 1}}`;

/** Gauss-Jordan con pasos. bar: columna donde va la raya (matriz aumentada). Devuelve { M, steps, swaps, rank }. */
export function gaussJordan(M0, { bar = -1, upto = null, reduce = true, maxSteps = 40 } = {}) {
  const M = M0.map(r => r.map(Q.of));
  const rows = M.length, cols = upto ?? M[0].length;
  const steps = [];
  let r = 0, swaps = 0;
  const show = (title) => { if (steps.length < maxSteps) steps.push({ title, latex: matTex(M, bar) }); };
  for (let c = 0; c < cols && r < rows; c++) {
    let p = r;
    while (p < rows && M[p][c].zero) p++;
    if (p === rows) continue;
    if (p !== r) { [M[p], M[r]] = [M[r], M[p]]; swaps++; show(`Se intercambian ${R(r)} y ${R(p)} (para tener un número distinto de 0 arriba)`); }
    if (reduce && !M[r][c].one) {
      const k = M[r][c];
      M[r] = M[r].map(x => x.div(k));
      const inv = new Q(1n).div(k);
      show(`$${R(r)} \\to ${inv.n < 0n ? '-' : ''}${(inv.n < 0n ? inv.neg() : inv).one ? '' : (inv.n < 0n ? inv.neg() : inv).coefTex()}${R(r)}$ (se deja un 1 en la diagonal)`);
    }
    for (let i = reduce ? 0 : r + 1; i < rows; i++) {
      if (i === r || M[i][c].zero) continue;
      const k = M[i][c].div(M[r][c]);
      M[i] = M[i].map((x, j) => x.sub(k.mul(M[r][j])));
      const sign = k.n < 0n ? '+' : '-', ka = k.n < 0n ? k.neg() : k;
      show(`$${R(i)} \\to ${R(i)} ${sign} ${ka.one ? '' : ka.coefTex()}${R(r)}$ (se hace 0 debajo${reduce ? ' y encima' : ''} del pivote)`);
    }
    r++;
  }
  return { M, steps, swaps, rank: r };
}

// ---------- Determinante ----------
export function detSteps(A0) {
  const A = A0.map(r => r.map(Q.of));
  const n = A.length;
  const steps = [];
  const bars = M => `\\left|\\begin{array}{${'c'.repeat(M.length)}}${M.map(r => r.map(x => x.tex()).join(' & ')).join(' \\\\ ')}\\end{array}\\right|`;
  if (n === 1) return { value: A[0][0], steps };
  if (n === 2) {
    const [[a, b], [c, d]] = A, v = a.mul(d).sub(b.mul(c));
    steps.push({ title: 'Para una matriz 2×2: diagonal principal menos diagonal secundaria', rule: '\\det = ad - bc', latex: `${bars(A)} = (${a.tex()})(${d.tex()}) - (${b.tex()})(${c.tex()}) = ${v.tex()}` });
    return { value: v, steps };
  }
  if (n === 3) {
    const minor = j => A.slice(1).map(r => r.filter((_, k) => k !== j));
    const d2 = M => M[0][0].mul(M[1][1]).sub(M[0][1].mul(M[1][0]));
    const terms = [0, 1, 2].map(j => ({ a: A[0][j], m: minor(j), d: d2(minor(j)), s: j % 2 ? '-' : '+' }));
    steps.push({ title: 'Expansión por cofactores en la primera fila (signos + − +)', latex: `${bars(A)} = ${terms.map((t, j) => `${j ? t.s + ' ' : ''}${paren(t.a)}${bars(t.m)}`).join(' ')}` });
    steps.push({ title: 'Se calculan los determinantes 2×2', latex: terms.map((t, j) => `${j ? t.s + ' ' : ''}${paren(t.a)}(${t.d.tex()})`).join(' ') });
    const v = terms.reduce((acc, t, j) => (j % 2 ? acc.sub(t.a.mul(t.d)) : acc.add(t.a.mul(t.d))), new Q(0n));
    steps.push({ title: 'Resultado', latex: `\\det = ${v.tex()}` });
    return { value: v, steps };
  }
  // 4×4 o más: se triangula y se multiplica la diagonal
  const { M, steps: gs, swaps } = gaussJordan(A, { reduce: false });
  steps.push({ title: 'Se escalona la matriz (el determinante no cambia al sumar múltiplos de una fila a otra)', latex: matTex(A) });
  steps.push(...gs);
  let v = new Q(swaps % 2 ? -1n : 1n);
  for (let i = 0; i < n; i++) v = v.mul(M[i][i]);
  steps.push({ title: 'El determinante es el producto de la diagonal' + (swaps ? ` (cambia de signo por cada intercambio de filas: ${swaps})` : ''), latex: `\\det = ${swaps % 2 ? '-' : ''}${M.map((r, i) => paren(r[i])).join('\\cdot ')} = ${v.tex()}` });
  return { value: v, steps };
}
const paren = q => (q.n < 0n || q.d !== 1n ? `\\left(${q.tex()}\\right)` : q.tex());

export function inverseSteps(A0) {
  const A = A0.map(r => r.map(Q.of));
  const n = A.length;
  const aug = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => new Q(i === j ? 1n : 0n))]);
  const steps = [{ title: 'Se escribe la matriz junto a la identidad: $[A \\mid I]$', latex: matTex(aug, n) }];
  const { M, steps: gs, rank } = gaussJordan(aug, { bar: n, upto: n });
  steps.push(...gs);
  if (rank < n) { steps.push({ title: 'Queda una fila de ceros a la izquierda: la matriz no tiene inversa', latex: matTex(M, n) }); return { inv: null, steps }; }
  const inv = M.map(r => r.slice(n));
  steps.push({ title: 'A la izquierda quedó la identidad; a la derecha está la inversa', latex: `A^{-1} = ${matTex(inv)}` });
  return { inv, steps };
}

// ---------- Ecuaciones ----------
/** Pasos para resolver lhs = rhs en v (ast). Devuelve null si no es un tipo con pasos. */
export async function equationSteps(lhs, rhs, v) {
  const steps = [];
  const orig = `${tex(lhs)} = ${tex(rhs)}`;
  const E = simp(add(lhs, neg(rhs)));
  // Denominadores con la variable: se multiplica por el común denominador
  let p;
  const nrm = P(await G(`normal(${toGiac(E)})`));
  if (nrm.t === 'div' && has(nrm.b, v)) {
    p = P(await G(`expand(numer(${toGiac(nrm)}))`));
    steps.push({ title: 'Se pasa todo a un lado y se multiplica por el denominador común', latex: `${tex(p)} = 0\\qquad (${tex(nrm.b)} \\neq 0)` });
  } else {
    p = P(await G(`expand(${toGiac(E)})`));
  }
  const d = polyDegree(p, v);
  if (d < 1) return null;
  const coef = async k => Q.of(await G(`coeff(${toGiac(p)},${v},${k})`));
  if (d === 1) {
    const a = await coef(1), b = await coef(0);
    if (!a || !b) return null;
    if (!(nrm.t === 'div' && has(nrm.b, v))) steps.push({ title: 'Se pasan los términos con ' + v + ' a un lado y los números al otro', latex: `${orig} \\;\\Rightarrow\\; ${termTex(a, v)} = ${b.neg().tex()}` });
    else steps.push({ title: 'Se despeja', latex: `${termTex(a, v)} = ${b.neg().tex()}` });
    const x = b.neg().div(a);
    if (!a.one) steps.push({ title: `Se divide entre ${a.tex().includes('frac') ? 'el coeficiente' : a.tex()}`, latex: `${v} = \\frac{${b.neg().tex()}}{${a.tex()}} = ${x.tex()}` });
    else steps.push({ title: 'Resultado', latex: `${v} = ${x.tex()}` });
    return { steps };
  }
  if (d === 2) {
    const [a, b, c] = [await coef(2), await coef(1), await coef(0)];
    if (!a || !b || !c) return null;
    steps.push({ title: 'Se ordena como $ax^2 + bx + c = 0$', latex: `${tex(p)} = 0\\qquad a = ${a.tex()},\\ b = ${b.tex()},\\ c = ${c.tex()}` });
    if (c.zero) {
      steps.push({ title: `Factor común ${v}`, latex: `${v}\\left(${termTex(a, v)} ${b.n < 0n ? '-' : '+'} ${b.n < 0n ? b.neg().tex() : b.tex()}\\right) = 0` });
      const x2 = b.neg().div(a);
      steps.push({ title: 'Si un producto da 0, alguno de los factores es 0', latex: `${v} = 0 \\quad\\text{o}\\quad ${v} = ${x2.tex()}` });
      return { steps };
    }
    const D = b.mul(b).sub(new Q(4n).mul(a).mul(c));
    steps.push({ title: 'Se calcula el discriminante', rule: '\\Delta = b^2 - 4ac', latex: `\\Delta = (${b.tex()})^2 - 4(${a.tex()})(${c.tex()}) = ${D.tex()}` });
    const sol = `${v} = \\frac{-b \\pm \\sqrt{\\Delta}}{2a} = \\frac{${b.neg().tex()} \\pm \\sqrt{${D.tex()}}}{${new Q(2n).mul(a).tex()}}`;
    if (D.n < 0n) {
      steps.push({ title: 'El discriminante es negativo: no hay soluciones reales (son complejas)', latex: sol });
      const r = await G(`csolve(${toGiac(p)}=0,${v})`);
      steps.push({ title: 'Soluciones complejas', latex: listTex(r, v) });
      return { steps };
    }
    steps.push({ title: D.zero ? 'Δ = 0: hay una sola solución (doble)' : 'Δ > 0: hay dos soluciones reales. Fórmula general', rule: `${v} = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}`, latex: sol });
    const r = await G(`solve(${toGiac(p)}=0,${v})`);
    steps.push({ title: 'Soluciones', latex: listTex(r, v) });
    return { steps };
  }
  // Grado 3 o más: factorizar
  const f = P(await G(`factor(${toGiac(p)})`));
  if (f.t !== 'mul' && !(f.t === 'pow')) return null;
  steps.push({ title: 'Se factoriza el polinomio', latex: `${tex(p)} = ${tex(f)} = 0` });
  const factors = (f.t === 'mul' ? f.a : [f]).map(x => (x.t === 'pow' ? x.a : x)).filter(x => has(x, v));
  steps.push({ title: 'Si un producto da 0, alguno de los factores es 0', latex: factors.map(x => `${tex(x)} = 0`).join('\\quad\\text{o}\\quad ') });
  const sols = [];
  for (const fx of factors) {
    const r = await G(`solve(${toGiac(fx)}=0,${v})`);
    sols.push(`${tex(fx)} = 0 \\;\\Rightarrow\\; ${listTex(r, v)}`);
  }
  steps.push({ title: 'Se resuelve cada factor', latex: `\\begin{array}{l}${sols.join(' \\\\ ')}\\end{array}` });
  return { steps };
}
const termTex = (a, v) => (a.one ? v : a.n === -1n && a.d === 1n ? '-' + v : a.d !== 1n ? `${a.tex()}${v}` : `${a.tex()}${v}`);
function listTex(r, v) {
  const m = /^\s*(?:list)?\[(.*)\]\s*$/.exec(r);
  const items = m ? m[1].split(/,(?![^(\[]*[)\]])/).filter(Boolean) : [r];
  if (!items.length) return '\\text{sin solución}';
  return items.map((s, i) => { let t; try { t = tex(P(s)); } catch { t = s; } return `${v}${items.length > 1 ? `_{${i + 1}}` : ''} = ${t}`; }).join(',\\quad ');
}

/** Sistema lineal: [ {lhs, rhs} ], vars → pasos por Gauss-Jordan; null si no es lineal con números. */
export async function systemSteps(eqs, vars) {
  const rows = [];
  for (const { lhs, rhs } of eqs) {
    const E = toGiac(simp(add(lhs, neg(rhs))));
    const row = [];
    for (const x of vars) {
      if (+(await G(`degree(expand(${E}),${x})`)) > 1) return null;
      const c = Q.of(await G(`coeff(expand(${E}),${x},1)`));
      if (!c) return null;
      row.push(c);
    }
    const c0 = Q.of(await G(`subst(expand(${E}),[${vars}],[${vars.map(() => 0)}])`));
    if (!c0) return null;
    row.push(c0.neg());
    rows.push(row);
  }
  const n = vars.length;
  const steps = [{ title: 'Matriz aumentada del sistema (coeficientes | términos independientes)', latex: matTex(rows.map(r => r.map(Q.of)), n) }];
  const { M, steps: gs, rank } = gaussJordan(rows, { bar: n, upto: n });
  steps.push(...gs);
  const inconsistent = M.some(r => r.slice(0, n).every(x => x.zero) && !r[n].zero);
  if (inconsistent) { steps.push({ title: 'Queda una fila 0 = número distinto de 0: el sistema no tiene solución', latex: matTex(M, n) }); return { steps }; }
  if (rank < n) { steps.push({ title: 'Hay menos pivotes que incógnitas: el sistema tiene infinitas soluciones', latex: matTex(M, n) }); return { steps }; }
  steps.push({ title: 'Se lee la solución en la última columna', latex: vars.map((x, i) => `${tex(S(x))} = ${M[i][n].tex()}`).join(',\\quad ') });
  return { steps };
}

/** Lee una matriz de Giac ("[[1,2],[3,4]]") como filas de fracciones; null si tiene símbolos. */
export function readMatrix(str) {
  let n;
  try { n = parse(str); } catch { return null; }
  if (n.t !== 'list' || !n.a.every(r => r.t === 'list')) return null;
  const rows = n.a.map(r => r.a.map(x => { const s = simp(x); return s.t === 'num' ? Q.of(Number.isInteger(s.n) ? `${s.n}/${s.d}` : String(s.n)) : null; }));
  if (rows.some(r => r.some(x => !x)) || rows.some(r => r.length !== rows[0].length)) return null;
  return rows;
}

export { Fail as AlgebraFail };
