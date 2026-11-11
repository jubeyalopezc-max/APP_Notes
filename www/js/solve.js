// Qué hacer con cada expresión: arma las órdenes para el motor y presenta el resultado.
import { run, isError, splitApprox } from './cas.js';
import { latexToGiac, MathSyntaxError } from './latex2giac.js';

export { MathSyntaxError };

const SPECIAL = /\b(erf|erfc|Si|Ci|Ei|igamma|LambertW|Gamma|Beta|Zeta|Psi|fresnel\w*|dilog|polylog)\(/;
const UNEVAL = { integrate: 'integral', limit: 'límite', sum: 'suma', desolve: 'ecuación' };

/** Limpia el LaTeX que devuelve Giac para que se vea como en el cuaderno. */
export function tidyLatex(l) {
  let s = String(l == null ? '' : l).trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  s = s.replace(/""/g, '"').replace(/\n/g, ' ');
  s = s.replace(/\\mathrm\{c\\_(\d+)\}/g, (_, n) => `C_{${+n + 1}}`);
  s = s.replace(/e\^\{1\}/g, 'e');
  s = s.replace(/\\mathrm\{(Si|Ci|Ei|erf|erfc|igamma|LambertW|sign)\}/g, '\\operatorname{$1}');
  s = s.replace(/\\mathrm\{([a-zA-Z]{2,})\}\\left\(/g, '\\operatorname{$1}\\left(');
  s = s.replace(/\\\^/g, '^');
  // \left( x \right) con algo sencillo adentro: paréntesis normales (se ven más compactos).
  for (let k = 0; k < 4; k++) s = s.replace(/\\left\(([^\\{}()]*|[^{}()]*?\^\{[^{}]*\}[^{}()\\]*)\\right\)/g, '($1)');
  // El punto de multiplicación solo hace falta entre dos números.
  s = s.replace(/(\d)\s*\\cdot\s*(\d)/g, '$1\u0000$2').replace(/\s*\\cdot\s*/g, ' ').replace(/\u0000/g, '\\cdot ');
  s = s.replace(/\\mbox\{ and \}/g, '\\ \\text{y}\\ ').replace(/\\mbox\{ or \}/g, '\\ \\text{o}\\ ');
  // \frac{(…)}{…}: los paréntesis sobran en una fracción.
  s = s.replace(/\\frac\{\(([^{}()]*(?:\{[^{}]*\}[^{}()]*)*)\)\}/g, '\\frac{$1}').replace(/\}\{\(([^{}()]*(?:\{[^{}]*\}[^{}()]*)*)\)\}/g, '}{$1}');
  s = s.replace(/\+\s*-/g, '-').replace(/-\s*-/g, '+');
  s = s.replace(/\+infinity|\binfinity\b/g, '\\infty').replace(/\binf\b/g, '\\infty');
  s = s.replace(/\\mathrm\{undef\}|\bundef\b/g, '\\text{indefinido}');
  return s;
}

const isNumeric = s => /^-?\d+(\.\d+)?(e[-+]?\d+)?$/.test(String(s).trim());

function cleanString(s) {
  let r = String(s || '').trim();
  if (r.startsWith('"') && r.endsWith('"')) r = r.slice(1, -1);
  return r;
}

let counter = 0;
/** Evalúa y devuelve { str, latex, approx }. Lanza un Error con mensaje si Giac falla. */
async function evaluate(expr, { approx = true } = {}) {
  const v = 'npv' + (++counter % 50);
  const out = await run([`${v}:=(${expr}):;`, `string(${v})`, `latex(${v})`, approx ? `evalf(${v})` : '0', `lname(${v})`]);
  for (const o of out) if (isError(o)) throw new Error(giacMessage(o));
  const str = cleanString(out[1]);
  const lat = tidyLatex(out[2]);
  let ap = null;
  if (approx && /^\[\s*\]$/.test(String(out[4]).trim())) {
    const a = splitApprox(out[3]).exact;
    if (isNumeric(a) && !isNumeric(str)) ap = fmtNum(a);
  }
  return { str, latex: lat, approx: ap, ref: v };
}

/** Evalúa varias formas equivalentes y se queda con la más corta (simplify a veces complica la trigonometría). */
async function shortest(cands, opts) {
  let best = null;
  for (const c of cands) {
    try {
      const r = await evaluate(c, opts);
      if (!best || r.str.length < best.str.length) best = r;
    } catch (e) { if (!best && c === cands[cands.length - 1]) throw e; }
  }
  return best;
}

function fmtNum(s) {
  const n = Number(s);
  if (!isFinite(n)) return s;
  if (Math.abs(n) >= 1e-4 && Math.abs(n) < 1e9) return String(+n.toPrecision(10));
  return n.toExponential(6).replace(/\.?0+e/, 'e');
}

function giacMessage(o) {
  const m = String(o).replace(/^GIAC_ERROR:\s*/, '');
  if (/Bad Argument|argument/i.test(m)) return 'El motor no pudo operar con esos datos. Revisa la expresión.';
  if (/[Ss]yntax/.test(m)) return 'Hay un error de escritura en la expresión.';
  if (/[Dd]ivision by 0|division par 0/.test(m)) return 'Hay una división por cero.';
  return 'No se pudo calcular: ' + m.slice(0, 140);
}

async function listItems(ref) {
  const [n] = await run([`size(${ref})`]);
  const k = Math.min(+n || 0, 12);
  if (!k) return [];
  const cmds = [];
  for (let i = 0; i < k; i++) cmds.push(`latex(${ref}[${i}])`, `string(${ref}[${i}])`, `evalf(${ref}[${i}])`);
  const out = await run(cmds);
  const items = [];
  for (let i = 0; i < k; i++) {
    const str = cleanString(out[i * 3 + 1]);
    const a = splitApprox(out[i * 3 + 2]).exact;
    items.push({ latex: tidyLatex(out[i * 3]), str, approx: isNumeric(a) && !isNumeric(str) && !str.includes('[') ? fmtNum(a) : null });
  }
  return items;
}

export const pickVar = (vars, prefer) => (prefer && vars.includes(prefer) ? prefer : (['x', 't', 'y', 'z'].find(v => vars.includes(v)) || vars[0] || 'x'));

/**
 * Resuelve. action: auto | simplify | factor | expand | decimal | diff | int | lim | solve |
 *   taylor | extrema | tangent | det | inv | tran | eigen | rank | rref | grad | div | curl | norm
 * Devuelve { title, input, blocks:[{label, latex, approx}], notes:[...], plot:{fns, var} }
 */
export async function compute(latex, action = 'auto', o = {}) {
  const { giac, info } = latexToGiac(latex);
  const vars = info.vars;
  const v = o.var || pickVar(vars);
  const res = { input: latex, blocks: [], notes: [], plot: null, title: '' };
  const add = (label, r) => res.blocks.push({ label, latex: r.latex, approx: r.approx, str: r.str });
  const expr = giac;

  const plain = async (cmd, label, title) => {
    const r = await evaluate(cmd);
    res.title = title;
    add(label, r);
    noteUneval(r.str, res);
    return r;
  };

  switch (action) {
    case 'simplify': {
      const r = await shortest([`simplify(${expr})`, `normal(${expr})`, `simplify(texpand(${expr}))`]);
      res.title = 'Simplificar'; add('Simplificado', r); noteUneval(r.str, res); break;
    }
    case 'factor': await plain(`factor(${expr})`, 'Factorizado', 'Factorizar'); break;
    case 'expand': await plain(`expand(${expr})`, 'Expandido', 'Expandir'); break;
    case 'decimal': {
      const r = await evaluate(`evalf(${expr},${o.digits || 12})`, { approx: false });
      res.title = 'Valor decimal'; add('≈', r); break;
    }
    case 'diff': {
      const n = Math.max(1, Math.min(10, +o.order || 1));
      const d = `diff(${expr},${v}${n > 1 ? ',' + n : ''})`;
      const r = await shortest([d, `normal(${d})`, `simplify(${d})`]);
      res.title = n > 1 ? `Derivada ${ordinal(n)} respecto a ${v}` : `Derivada respecto a ${v}`;
      add(n > 1 ? `\\frac{d^{${n}}}{d${v}^{${n}}}` : `\\frac{d}{d${v}}`, r);
      res.plot = { fns: [expr, r.str], var: v, names: ['f', n > 1 ? `f^{(${n})}` : "f'"] };
      break;
    }
    case 'int': {
      const hasA = o.a != null && o.a !== '', hasB = o.b != null && o.b !== '';
      if (hasA !== hasB) throw new MathSyntaxError('Para la integral definida pon los dos límites (a y b), o ninguno.');
      const a = hasA ? latexToGiac(o.a).giac : null, b = hasB ? latexToGiac(o.b).giac : null;
      if (hasA) {
        const r = await evaluate(`integrate(${expr},${v},${a},${b})`);
        res.title = 'Integral definida';
        if (/integrate\(/.test(r.str)) {
          const nr = await evaluate(`evalf(romberg(${expr},${v},${a},${b}))`, { approx: false });
          add('Valor numérico', nr);
          res.notes.push('Esta integral no tiene una forma exacta conocida; se calculó su valor numérico.');
        } else {
          add('=', r);
          if (SPECIAL.test(r.str)) res.notes.push('El resultado usa funciones especiales porque la primitiva no se puede escribir con funciones elementales.');
        }
        res.plot = { fns: [expr], var: v, shade: [a, b] };
      } else {
        const r = await evaluate(`integrate(${expr},${v})`);
        res.title = `Integral respecto a ${v}`;
        if (/integrate\(/.test(r.str)) {
          res.notes.push('Esta función no tiene una primitiva que se pueda escribir con funciones conocidas. Pon límites a y b para calcular el valor numérico.');
          add('Sin primitiva elemental', r);
        } else {
          add('', { ...r, latex: r.latex + '+C' });
          if (SPECIAL.test(r.str)) res.notes.push('El resultado usa funciones especiales (como erf o Si): no existe una primitiva con funciones elementales.');
        }
        res.plot = { fns: [expr, r.str], var: v, names: ['f', 'F'] };
      }
      break;
    }
    case 'lim': {
      const to = o.to != null && o.to !== '' ? latexToGiac(o.to).giac : '0';
      const side = o.side === 1 || o.side === -1 ? o.side : 0;
      res.title = `Límite cuando ${v} → ${o.to || '0'}${side ? (side > 0 ? '⁺' : '⁻') : ''}`;
      await limitBlock(`limit(${expr},${v},${to}${side ? ',' + side : ''})`, res, add, side ? null : { expr, v, to });
      break;
    }
    case 'solve': await solveBlock(info, giac, o.var || pickVar(vars, vars.includes('y') && vars.includes('x') ? 'y' : null), res, add); break;
    case 'taylor': {
      const a = o.at != null && o.at !== '' ? latexToGiac(o.at).giac : '0';
      const n = Math.max(1, Math.min(15, +o.order || 5));
      const r = await evaluate(`convert(taylor(${expr},${v}=${a},${n}),polynom)`);
      res.title = `Serie de Taylor alrededor de ${v} = ${o.at || 0} (hasta grado ${n})`;
      add('≈', r);
      res.plot = { fns: [expr, r.str], var: v, names: ['f', 'P'] };
      break;
    }
    case 'extrema': {
      res.title = 'Máximos y mínimos';
      const out = await run([`npd:=simplify(diff(${expr},${v})):;`, `latex(npd)`, `npc:=solve(npd=0,${v}):;`, `size(npc)`]);
      if (out.some(isError)) throw new Error('No se pudieron encontrar los puntos críticos.');
      res.blocks.push({ label: `f'(${v})`, latex: tidyLatex(out[1]) });
      const k = Math.min(+out[3] || 0, 10);
      if (!k) res.notes.push('No tiene puntos críticos reales (la derivada nunca vale cero).');
      for (let i = 0; i < k; i++) {
        const r = await run([`latex(npc[${i}])`, `evalf(npc[${i}])`, `simplify(subst(diff(npd,${v}),${v}=npc[${i}]))`, `latex(simplify(subst(${expr},${v}=npc[${i}])))`, `evalf(subst(${expr},${v}=npc[${i}]))`, `evalf(subst(diff(npd,${v}),${v}=npc[${i}]))`]);
        const f2 = Number(splitApprox(r[5]).exact);
        const kind = !isFinite(f2) ? 'Punto crítico' : f2 > 0 ? 'Mínimo' : f2 < 0 ? 'Máximo' : 'Punto crítico (la 2.ª derivada es 0)';
        const xl = tidyLatex(r[0]), fl = tidyLatex(r[3]);
        const plainNums = /^-?\d+(\.\d+)?$/.test(xl) && /^-?\d+(\.\d+)?$/.test(fl);
        res.blocks.push({ label: kind, latex: `${v}=${xl},\\quad f=${fl}`, approx: !plainNums && isNumeric(splitApprox(r[1]).exact) ? `${v} ≈ ${fmtNum(splitApprox(r[1]).exact)}, f ≈ ${fmtNum(splitApprox(r[4]).exact)}` : null });
      }
      res.plot = { fns: [expr], var: v };
      break;
    }
    case 'tangent': {
      const a = o.at != null && o.at !== '' ? latexToGiac(o.at).giac : '0';
      const r = await evaluate(`simplify(subst(diff(${expr},${v}),${v}=${a})*(${v}-(${a}))+subst(${expr},${v}=${a}))`);
      res.title = `Recta tangente en ${v} = ${o.at || 0}`;
      add('y =', r);
      res.plot = { fns: [expr, r.str], var: v, names: ['f', 't'] };
      break;
    }
    case 'det': await plain(`det(${expr})`, '\\det', 'Determinante'); break;
    case 'inv': {
      const d = await evaluate(`det(${expr})`, { approx: false });
      if (d.str === '0') { res.title = 'Matriz inversa'; res.notes.push('La matriz no tiene inversa: su determinante es 0.'); add('\\det', d); break; }
      await plain(`inv(${expr})`, 'A^{-1}', 'Matriz inversa'); break;
    }
    case 'tran': await plain(`tran(${expr})`, 'A^{T}', 'Transpuesta'); break;
    case 'rank': await plain(`rank(${expr})`, 'Rango', 'Rango'); break;
    case 'rref': await plain(`rref(${expr})`, 'Escalonada', 'Forma escalonada reducida (Gauss-Jordan)'); break;
    case 'eigen': {
      res.title = 'Valores y vectores propios';
      add('Valores propios', await evaluate(`eigenvals(${expr})`, { approx: false }));
      add('Vectores propios (columnas)', await evaluate(`eigenvects(${expr})`, { approx: false }));
      break;
    }
    case 'norm': await plain(`l2norm(${expr})`, '\\lVert v\\rVert', 'Norma (magnitud)'); break;
    case 'grad': {
      const vv = vectorVars(vars);
      await plain(`grad(${expr},[${vv}])`, '\\nabla f', `Gradiente respecto a (${vv})`); break;
    }
    case 'div': await plain(`divergence(${expr},[${vectorVars(vars, 3)}])`, '\\nabla\\cdot F', 'Divergencia'); break;
    case 'curl': await plain(`curl(${expr},[x,y,z])`, '\\nabla\\times F', 'Rotacional'); break;
    case 'plot': res.title = 'Gráfica'; res.plot = { fns: info.list ? giac.split(',') : [rhs(giac)], var: v }; break;
    default: await autoBlock(info, giac, vars, res, add, o);
  }
  if (!res.plot && !info.matrix && !info.list && !info.rel && vars.length === 1 && !info.op) res.plot = { fns: [expr], var: vars[0], optional: true };
  return res;
}

// y = f(x)  →  f(x) para graficar
const rhs = g => { const m = /^\s*y\s*=(.*)$/.exec(g); return m ? m[1] : g.includes('=') ? g.split('=').map(s => `(${s})`).join('-') : g; };

function vectorVars(vars, min = 0) {
  const vv = ['x', 'y', 'z'].filter(c => vars.includes(c));
  const rest = vars.filter(c => !['x', 'y', 'z'].includes(c));
  const all = [...vv, ...rest];
  if (min && all.length < min) return 'x,y,z';
  return (all.length ? all : ['x', 'y']).join(',');
}

const ordinal = n => ({ 2: 'segunda', 3: 'tercera', 4: 'cuarta' }[n] || `de orden ${n}`);

function noteUneval(str, res) {
  for (const [fn, what] of Object.entries(UNEVAL)) {
    if (new RegExp('\\b' + fn + '\\(').test(str)) { res.notes.push(`El motor no encontró una forma exacta para esta ${what}.`); return; }
  }
  if (SPECIAL.test(str)) res.notes.push('El resultado usa funciones especiales (no tiene forma con funciones elementales).');
}

async function limitBlock(cmd, res, add, sides) {
  const r = await evaluate(cmd);
  const s = r.str.replace(/\s/g, '');
  if (sides && (s === 'infinity' || s === 'undef' || /^limit\(/.test(s))) {
    const base = cmd.slice(0, -1);
    const L = await evaluate(base + ',-1)'), R = await evaluate(base + ',1)');
    if (L.str !== R.str) {
      res.notes.push('El límite no existe: por cada lado da un valor distinto.');
      add('Por la izquierda', L); add('Por la derecha', R);
      return;
    }
    add('=', L);
    return;
  }
  if (s === 'undef') res.notes.push('El límite no existe (la función oscila o no se acerca a ningún valor).');
  add('=', r);
  noteUneval(r.str, res);
}

async function solveBlock(info, giac, v, res, add) {
  if (info.ode) return odeBlock(info, giac, res, add);
  if (info.list) {
    const vars = info.vars.length ? info.vars : ['x'];
    res.title = `Sistema de ${info.count} ecuaciones`;
    const r = await evaluate(`solve([${giac}],[${vars}])`, { approx: false });
    const items = await listItems(r.ref);
    if (!items.length) { res.notes.push('El sistema no tiene solución.'); return; }
    if (items.length && /\[\s*\]/.test(items[0].str)) { res.notes.push('El sistema tiene infinitas soluciones o ninguna.'); }
    for (const [k, it] of items.entries()) {
      const vals = await listItems(`${r.ref}[${k}]`);
      if (vals.length === vars.length) res.blocks.push({ label: items.length > 1 ? `Solución ${k + 1}` : 'Solución', latex: vals.map((x, j) => `${vars[j]}=${x.latex}`).join(',\\quad '), approx: vals.some(x => x.approx) ? vals.map((x, j) => `${vars[j]} ≈ ${x.approx || x.str}`).join(', ') : null });
      else res.blocks.push({ label: 'Solución', latex: it.latex });
    }
    return;
  }
  const eq = info.rel ? giac : `${giac}=0`;
  const ineq = info.rel && info.rel !== '=';
  res.title = ineq ? `Inecuación (despejando ${v})` : `Ecuación (despejando ${v})`;
  const r = await evaluate(`solve(${eq},${v})`, { approx: false });
  let items = await listItems(r.ref);
  if (ineq) {
    if (!items.length) res.notes.push('No hay valores que cumplan la desigualdad.');
    for (const it of items) res.blocks.push({ label: 'Solución', latex: it.latex });
    return;
  }
  if (!items.length) {
    const c = await evaluate(`csolve(${eq},${v})`, { approx: false });
    const ci = await listItems(c.ref);
    if (ci.length) {
      res.notes.push('No tiene soluciones reales. Estas son las soluciones complejas:');
      ci.forEach((it, k) => res.blocks.push({ label: ci.length > 1 ? `${v}_{${k + 1}}` : v, latex: `${v}=${it.latex}`, approx: it.approx }));
      return;
    }
    const f = await evaluate(`fsolve(${eq},${v})`, { approx: false });
    const fi = /\[|\d/.test(f.str) && !/fsolve/.test(f.str) ? await listItems(f.ref) : [];
    if (fi.length || isNumeric(f.str)) {
      res.notes.push('No hay fórmula exacta; esta es la solución numérica.');
      (fi.length ? fi : [f]).forEach(it => res.blocks.push({ label: v, latex: `${v}\\approx ${it.latex}` }));
      return;
    }
    res.notes.push('No encontré soluciones.');
    return;
  }
  items.forEach((it, k) => res.blocks.push({ label: items.length > 1 ? `${v}_{${k + 1}}` : v, latex: `${v}=${it.latex}`, approx: it.approx }));
  if (!info.vars.filter(x => x !== v).length) res.plot = { fns: [rhs(giac)], var: v, roots: items.map(i => i.str) };
}

async function odeBlock(info, giac, res, add) {
  const f = info.func;
  const eqs = info.list ? giac : giac;
  const parts = info.list ? `[${eqs}]` : (info.rel ? eqs : `${eqs}=0`);
  res.title = 'Ecuación diferencial';
  const r = await evaluate(`desolve(${parts},${f})`, { approx: false });
  if (/desolve\(/.test(r.str) || r.str === '[]') { res.notes.push('No encontré una solución exacta para esta ecuación diferencial.'); return; }
  const items = r.str.startsWith('[') || r.str.startsWith('list') ? await listItems(r.ref) : [r];
  items.forEach((it, k) => res.blocks.push({ label: items.length > 1 ? `Solución ${k + 1}` : 'Solución', latex: `${f}=${it.latex}` }));
  if (/c_\d/.test(r.str)) res.notes.push('C₁, C₂… son constantes: ponles valores con condiciones iniciales, por ejemplo y(0)=1.');
}

async function autoBlock(info, giac, vars, res, add, o) {
  if (info.ode || info.rel || (info.list && info.count > 1 && /=/.test(giac))) return solveBlock(info, giac, o.var || pickVar(vars, vars.includes('y') && vars.includes('x') && info.rel === '=' && /^\s*y\s*=/.test(giac) ? 'x' : (vars.includes('y') && vars.includes('x') ? 'y' : null)), res, add);
  if (info.matrix) { res.title = info.matrix === 'vector' ? 'Vector' : 'Matriz'; add('=', await evaluate(`simplify(${giac})`)); return; }
  if (info.op === 'lim' && /^limit\(/.test(giac) && !/,[-]?1\)$/.test(giac)) {
    res.title = 'Límite';
    await limitBlock(giac, res, add, true);
    return;
  }
  const title = { int: 'Integral', diff: 'Derivada', sum: 'Suma', prod: 'Producto', lim: 'Límite' }[info.op];
  const r = vars.length ? await shortest([giac, `normal(${giac})`, `simplify(${giac})`]) : await evaluate(giac);
  res.title = title || (vars.length ? 'Simplificado' : 'Resultado');
  if (info.op === 'int' && !info.definite && !/integrate\(/.test(r.str)) add('=', { ...r, latex: r.latex + '+C' });
  else if (info.op === 'int' && info.definite && /integrate\(/.test(r.str)) {
    const nr = await evaluate(`evalf(${giac})`, { approx: false });
    add('Valor numérico', nr);
    res.notes.push('Esta integral no tiene una forma exacta conocida; se calculó su valor numérico.');
    return;
  } else add('=', r);
  noteUneval(r.str, res);
}
