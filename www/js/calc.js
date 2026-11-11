// Calculadora: teclado matemático (MathLive), motor (Giac), resultados con MathJax, gráficas y estadística.
import { compute, MathSyntaxError, pickVar } from './solve.js';
import { latexToGiac } from './latex2giac.js';
import { warmUp } from './cas.js';
import { compile } from './giacfn.js';
import { createPlot, PLOT_COLORS } from './plot.js';
import * as ST from './calcstats.js';

const $ = s => document.querySelector(s);
const HIST_KEY = 'np-calc-history';
const INK = '#1F2937', INK_DARK = '#E6EBF4';

// ---------- Cargas perezosas (solo cuando se abre la calculadora) ----------
let mlReady = null, mjReady = null;
function loadMathLive() {
  if (!mlReady) mlReady = import('../vendor/mathlive/mathlive.min.mjs').then(ML => {
    ML.MathfieldElement.soundsDirectory = null;
    ML.MathfieldElement.plonkSound = null;
    ML.MathfieldElement.keypressSound = null;
    return ML;
  });
  return mlReady;
}
function loadMathJax() {
  if (!mjReady) mjReady = new Promise((resolve, reject) => {
    window.MathJax = {
      tex: { packages: { '[+]': ['ams'] } },
      svg: { fontCache: 'none' },
      options: { enableMenu: false },
      startup: {
        typeset: false,
        ready() {
          window.MathJax.startup.defaultReady();
          // Estilos de las fórmulas (sin ellos se ve una copia pequeña para lectores de pantalla).
          try { document.head.appendChild(window.MathJax.svgStylesheet()); } catch {}
          resolve(window.MathJax);
        },
      },
    };
    const s = document.createElement('script');
    s.src = 'vendor/mathjax/tex-svg.js';
    s.async = true;
    s.onerror = () => reject(new Error('No se pudo cargar el dibujo de fórmulas'));
    document.head.appendChild(s);
  });
  return mjReady;
}

function texNode(latex, display = true) {
  try {
    const n = window.MathJax.tex2svg(latex, { display });
    return n;
  } catch {
    const s = document.createElement('code');
    s.textContent = latex;
    return s;
  }
}

/** Fórmula → imagen (dos versiones: tinta oscura y tinta clara) con su tamaño en unidades de página. */
function formulaPicture(latex) {
  const node = window.MathJax.tex2svg(latex, { display: true });
  const svg = node.querySelector('svg');
  if (!svg) throw new Error('fórmula vacía');
  const ex = v => parseFloat(v) || 1;
  const EX = 12; // unidades de página por "ex": queda del tamaño de una letra escrita a mano
  const w = ex(svg.getAttribute('width')) * EX, h = ex(svg.getAttribute('height')) * EX;
  const make = color => {
    const c = svg.cloneNode(true);
    c.setAttribute('width', (w * 2).toFixed(1));
    c.setAttribute('height', (h * 2).toFixed(1));
    c.setAttribute('color', color);
    c.setAttribute('style', `color:${color}`);
    c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const xml = new XMLSerializer().serializeToString(c).replace(/currentColor/g, color);
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  };
  return { src: make(INK), srcDark: make(INK_DARK), w, h };
}

const OPS = [
  // id, etiqueta, cuándo se muestra
  ['simplify', 'Simplificar', i => !i.matrix && !i.rel],
  ['factor', 'Factorizar', i => !i.matrix && !i.rel && !i.op],
  ['expand', 'Expandir', i => !i.matrix && !i.rel && !i.op],
  ['decimal', 'Decimal', i => !i.rel],
  ['diff', 'Derivar', i => !i.matrix && !i.rel && !i.ode],
  ['int', 'Integrar', i => !i.matrix && !i.rel && !i.ode],
  ['lim', 'Límite', i => !i.matrix && !i.rel && !i.ode],
  ['solve', 'Resolver', i => !i.matrix],
  ['plot', 'Graficar', i => !i.matrix && !i.ode],
  ['extrema', 'Máx. y mín.', i => !i.matrix && !i.rel && !i.ode],
  ['tangent', 'Recta tangente', i => !i.matrix && !i.rel && !i.ode],
  ['taylor', 'Taylor', i => !i.matrix && !i.rel && !i.ode],
  ['grad', 'Gradiente', i => !i.matrix && !i.rel && i.vars.length >= 2],
  ['det', 'Determinante', i => i.matrix === 'matrix'],
  ['inv', 'Inversa', i => i.matrix === 'matrix'],
  ['tran', 'Transpuesta', i => i.matrix === 'matrix'],
  ['eigen', 'Valores propios', i => i.matrix === 'matrix'],
  ['rank', 'Rango', i => i.matrix === 'matrix'],
  ['rref', 'Gauss-Jordan', i => i.matrix === 'matrix'],
  ['norm', 'Norma', i => i.matrix === 'vector'],
  ['div', 'Divergencia', i => i.matrix === 'vector'],
  ['curl', 'Rotacional', i => i.matrix === 'vector'],
];
const NEEDS_VAR = ['diff', 'int', 'lim', 'solve', 'extrema', 'tangent', 'taylor'];

const EXAMPLES = [
  ['x^2-5x+6=0', 'Ecuaciones'],
  ['\\int x^2\\sin x\\,dx', 'Integrales'],
  ['\\lim_{x\\to0}\\frac{\\sin x}{x}', 'Límites'],
  ['\\frac{d}{dx}e^{x}\\cos x', 'Derivadas'],
  ["y''+y=0", 'Ecuaciones diferenciales'],
  ['\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}', 'Matrices'],
  ['\\begin{cases}2x+y=5\\\\x-y=1\\end{cases}', 'Sistemas'],
  ['\\sum_{k=1}^{n}k^2', 'Sumatorias'],
];

// Teclado en español, con pestañas por tema.
function keyboardLayouts() {
  const k = (latex, extra = {}) => ({ latex, ...extra });
  const ins = (insert, label, extra = {}) => ({ insert, label, ...extra });
  return [
    {
      label: '123', tooltip: 'Números y operaciones',
      rows: [
        ['[7]', '[8]', '[9]', '[/]', ins('\\frac{#@}{#0}', '<span style="font-size:.8em">a/b</span>'), k('x'), k('y'), ins('#@^{2}', 'x²'), ins('#@^{#?}', 'xⁿ')],
        ['[4]', '[5]', '[6]', '[*]', ins('\\left(#0\\right)', '( )'), k('\\pi'), k('e'), ins('\\sqrt{#0}', '√'), ins('\\sqrt[#?]{#0}', 'ⁿ√')],
        ['[1]', '[2]', '[3]', '[-]', k('='), k('<'), k('>'), k('\\le'), k('\\ge')],
        ['[0]', '[.]', ins(',', ','), '[+]', ins('\\left|#0\\right|', '|x|'), k('!'), ins('^{\\circ}', '°'), '[left]', '[right]', '[backspace]'],
      ],
    },
    {
      label: 'f(x)', tooltip: 'Funciones',
      rows: [
        [ins('\\sin\\left(#0\\right)', 'sen'), ins('\\cos\\left(#0\\right)', 'cos'), ins('\\tan\\left(#0\\right)', 'tan'), ins('\\sec\\left(#0\\right)', 'sec'), ins('\\csc\\left(#0\\right)', 'csc'), ins('\\cot\\left(#0\\right)', 'cot'), ins('e^{#0}', 'eˣ')],
        [ins('\\arcsin\\left(#0\\right)', 'sen⁻¹'), ins('\\arccos\\left(#0\\right)', 'cos⁻¹'), ins('\\arctan\\left(#0\\right)', 'tan⁻¹'), ins('\\sinh\\left(#0\\right)', 'senh'), ins('\\cosh\\left(#0\\right)', 'cosh'), ins('\\tanh\\left(#0\\right)', 'tanh'), ins('\\ln\\left(#0\\right)', 'ln')],
        [ins('\\log\\left(#0\\right)', 'log'), ins('\\log_{#?}\\left(#0\\right)', 'logₐ'), ins('\\binom{#?}{#?}', 'nCr'), k('\\theta'), k('\\alpha'), k('\\beta'), ins('#@_{#?}', 'x₁')],
        [k('x'), k('y'), k('z'), k('t'), k('n'), k('k'), '[left]', '[right]', '[backspace]'],
      ],
    },
    {
      label: '∫ d/dx', tooltip: 'Cálculo',
      rows: [
        [ins('\\int #0\\,dx', '∫ dx'), ins('\\int_{#?}^{#?}#0\\,dx', '∫ₐᵇ'), ins('\\int_{#?}^{#?}\\int_{#?}^{#?}#0\\,dy\\,dx', '∬'), ins('\\frac{d}{dx}#0', 'd/dx'), ins('\\frac{d^{2}}{dx^{2}}#0', 'd²/dx²'), ins('\\frac{\\partial}{\\partial #?}#0', '∂/∂')],
        [ins('\\lim_{x\\to#?}#0', 'lím'), ins('\\lim_{x\\to#?^{+}}#0', 'lím⁺'), ins('\\lim_{x\\to#?^{-}}#0', 'lím⁻'), k('\\infty'), ins('\\sum_{k=1}^{#?}#0', 'Σ'), ins('\\prod_{k=1}^{#?}#0', 'Π')],
        [ins("y'", "y'"), ins("y''", "y''"), ins('dx', 'dx'), ins('dy', 'dy'), ins('dt', 'dt'), k('y'), k('x')],
        [k('='), ins(',', ','), k('\\pi'), k('e'), '[left]', '[right]', '[backspace]'],
      ],
    },
    {
      label: '[ ] ×', tooltip: 'Matrices y vectores',
      rows: [
        [ins('\\begin{pmatrix}#0 & #? \\\\ #? & #?\\end{pmatrix}', '2×2'), ins('\\begin{pmatrix}#0 & #? & #? \\\\ #? & #? & #? \\\\ #? & #? & #?\\end{pmatrix}', '3×3'), ins('\\begin{pmatrix}#0 & #? & #?\\end{pmatrix}', '(a,b,c)'), ins('\\begin{pmatrix}#0 & #?\\end{pmatrix}', '(a,b)')],
        [{ label: '+ col', command: ['performWithFeedback', 'addColumnAfter'] }, { label: '+ fila', command: ['performWithFeedback', 'addRowAfter'] }, { label: '− col', command: ['performWithFeedback', 'removeColumn'] }, { label: '− fila', command: ['performWithFeedback', 'removeRow'] }],
        [k('\\times', { label: '× (cruz)' }), k('\\cdot', { label: '· (punto)' }), ins('\\begin{cases}#0\\\\#?\\end{cases}', 'sistema'), k('&', { label: 'celda' })],
        ['[7]', '[8]', '[9]', '[4]', '[5]', '[6]', '[1]', '[2]', '[3]', '[0]', '[-]', '[left]', '[right]', '[backspace]'],
      ],
    },
    'alphabetic',
  ];
}

export function createCalc({ toast, getEditor, isDark, onToggle }) {
  const root = $('#calc'), feed = $('#calc-feed'), opsBar = $('#calc-ops'), optsEl = $('#calc-opts'), wrap = $('#calc-mf-wrap'), go = $('#calc-go');
  let mf = null, op = null, info = null, opts = {}, history = loadHistory(), busy = false, rendered = false;
  const plots = new Set();

  function loadHistory() { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]').slice(-40); } catch { return []; } }
  function saveHistory() { try { localStorage.setItem(HIST_KEY, JSON.stringify(history.slice(-40))); } catch {} }

  async function setup() {
    const [ML] = await Promise.all([loadMathLive(), loadMathJax(), warmUp()]);
    if (mf) return;
    window.mathVirtualKeyboard.layouts = keyboardLayouts();
    const kbd = window.mathVirtualKeyboard, kbdBox = $('#calc-kbd');
    kbd.container = kbdBox;
    // El teclado vive dentro del panel: el panel le reserva el alto que necesita.
    const fit = () => { kbdBox.style.height = kbd.visible ? Math.round(kbd.boundingRect.height) + 'px' : '0px'; };
    kbd.addEventListener('geometrychange', fit);
    kbd.addEventListener('virtual-keyboard-toggle', () => setTimeout(fit, 0));
    mf = new ML.MathfieldElement();
    mf.mathVirtualKeyboardPolicy = 'manual';
    mf.smartFence = true;
    mf.smartMode = false;
    mf.setAttribute('aria-label', 'Escribe la operación');
    wrap.innerHTML = '';
    wrap.appendChild(mf);
    try {
      mf.menuItems = [];
      // Atajos: "sen", "raiz", "int"... se convierten al escribir con teclado físico.
      mf.inlineShortcuts = { ...mf.inlineShortcuts, sen: '\\sin', raiz: '\\sqrt{#0}', inf: '\\infty', infinito: '\\infty' };
    } catch (e) { console.warn(e); }
    mf.addEventListener('focusin', () => window.mathVirtualKeyboard.show());
    mf.addEventListener('input', onInput);
    mf.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    // Recordar lo que se estaba escribiendo.
    try { const d = localStorage.getItem('np-calc-draft'); if (d) mf.value = d; } catch {}
    onInput();
  }

  function onInput() {
    if (!mf) return;
    try { localStorage.setItem('np-calc-draft', mf.value); } catch {}
    try { info = latexToGiac(mf.value).info; } catch { info = null; }
    renderOps();
  }

  function renderOps() {
    const i = info || { vars: [], rel: null, matrix: null, op: null, ode: false };
    opsBar.innerHTML = '';
    for (const [id, label, when] of OPS) {
      if (!when(i)) continue;
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.op = id;
      b.setAttribute('aria-pressed', String(op === id));
      if (!op && i.rel && id === 'solve') b.classList.add('hint');
      b.onclick = () => { op = op === id ? null : id; opts = {}; renderOps(); renderOpts(); };
      opsBar.appendChild(b);
    }
    if (op && !OPS.find(([id, , when]) => id === op && when(i))) { op = null; renderOpts(); }
    const lbl = { null: '=', diff: 'Derivar', int: 'Integrar', lim: 'Límite', solve: 'Resolver', plot: 'Graficar' }[op] || (op ? 'Calcular' : '=');
    go.textContent = lbl;
    go.style.fontSize = lbl === '=' ? '' : '16px';
  }

  function renderOpts() {
    optsEl.innerHTML = '';
    optsEl.hidden = !op || !NEEDS_VAR.includes(op);
    if (optsEl.hidden) return;
    const vars = (info && info.vars.length ? info.vars : ['x']);
    const varSel = document.createElement('label');
    varSel.innerHTML = `${op === 'solve' ? 'Despejar' : 'Variable'} <select>${(vars.includes('x') ? vars : ['x', ...vars]).map(v => `<option${v === (opts.var || pickVar(vars, op === 'solve' && vars.includes('y') && vars.includes('x') ? 'y' : null)) ? ' selected' : ''}>${v}</option>`).join('')}</select>`;
    const sel = varSel.querySelector('select');
    opts.var = sel.value;
    sel.onchange = () => { opts.var = sel.value; };
    optsEl.appendChild(varSel);
    const small = (key, label, value = '') => {
      const l = document.createElement('label');
      l.textContent = label + ' ';
      const f = document.createElement('math-field');
      f.mathVirtualKeyboardPolicy = 'manual';
      f.value = opts[key] ?? value;
      f.addEventListener('focusin', () => window.mathVirtualKeyboard.show());
      f.addEventListener('input', () => { opts[key] = f.value; });
      opts[key] = f.value;
      l.appendChild(f);
      optsEl.appendChild(l);
    };
    const num = (key, label, value, max) => {
      const l = document.createElement('label');
      l.innerHTML = `${label} <input type="number" min="1" max="${max}" step="1" value="${opts[key] || value}" style="width:64px">`;
      const inp = l.querySelector('input');
      opts[key] = inp.value;
      inp.oninput = () => { opts[key] = inp.value; };
      optsEl.appendChild(l);
    };
    if (op === 'diff') num('order', 'Orden', 1, 10);
    if (op === 'int') { small('a', 'Desde'); small('b', 'Hasta'); }
    if (op === 'lim') {
      small('to', 'Tiende a', '0');
      const l = document.createElement('label');
      l.innerHTML = 'Lado <select><option value="0">Ambos</option><option value="-1">Izquierda (⁻)</option><option value="1">Derecha (⁺)</option></select>';
      const s = l.querySelector('select');
      s.value = String(opts.side || 0);
      opts.side = +s.value;
      s.onchange = () => { opts.side = +s.value; };
      optsEl.appendChild(l);
    }
    if (op === 'taylor') { small('at', 'Alrededor de', '0'); num('order', 'Grado', 5, 15); }
    if (op === 'tangent') small('at', 'En el punto', '1');
  }

  // ---------- Resultados ----------
  function renderEmpty() {
    if (history.length) return;
    const el = document.createElement('div');
    el.className = 'calc-empty';
    el.innerHTML = '<b>Escribe una operación</b> con el teclado de abajo y toca <b>=</b>. Resuelve ecuaciones, sistemas, derivadas, integrales, límites, matrices, vectores y más, sin internet. Ejemplos (tócalos para probar):<div class="calc-ex"></div>';
    const box = el.querySelector('.calc-ex');
    for (const [l, name] of EXAMPLES) {
      const b = document.createElement('button');
      b.title = name;
      b.appendChild(texNode(l, false));
      b.onclick = () => { if (mf) { mf.value = l; onInput(); run(); } };
      box.appendChild(b);
    }
    feed.appendChild(el);
  }

  function renderAll() {
    plots.clear();
    feed.innerHTML = '';
    renderEmpty();
    for (const h of history) feed.appendChild(card(h));
    feed.scrollTop = feed.scrollHeight;
    rendered = true;
  }

  function label(l) {
    const span = document.createElement('span');
    span.className = 'cc-label';
    if (/[\\_^{]/.test(l)) span.appendChild(texNode(l, false)); else span.textContent = l;
    return span;
  }

  function card(h) {
    const el = document.createElement('article');
    el.className = 'calc-card' + (h.error ? ' err' : '');
    el.dataset.id = h.id;
    const head = document.createElement('div');
    head.className = 'cc-head';
    head.innerHTML = `<span>${esc(h.res ? h.res.title || 'Resultado' : h.error ? 'No se pudo' : '')}</span><button class="icon-btn cc-x" aria-label="Quitar este resultado"><svg><use href="#i-close"/></svg></button>`;
    head.querySelector('.cc-x').onclick = () => { history = history.filter(x => x.id !== h.id); saveHistory(); el.remove(); if (!history.length) renderAll(); };
    el.appendChild(head);
    if (h.input) {
      const inp = document.createElement('div');
      inp.className = 'cc-input';
      inp.appendChild(texNode(h.input + opSuffix(h), true));
      el.appendChild(inp);
    }
    if (h.error) {
      const p = document.createElement('p');
      p.className = 'cc-note';
      p.textContent = h.error;
      el.appendChild(p);
    }
    if (h.res) {
      for (const b of h.res.blocks) {
        const row = document.createElement('div');
        row.className = 'cc-block';
        row.appendChild(label(b.label || '='));
        const m = document.createElement('div');
        m.className = 'cc-math';
        m.appendChild(texNode(b.latex, true));
        row.appendChild(m);
        if (b.approx) { const a = document.createElement('span'); a.className = 'cc-approx'; a.textContent = (/[=≈]/.test(b.approx) ? '' : '≈ ') + b.approx; row.appendChild(a); }
        el.appendChild(row);
      }
      if (h.res.table) {
        const t = document.createElement('table');
        t.className = 'st-table';
        t.innerHTML = h.res.table.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
        el.appendChild(t);
      }
      for (const n of h.res.notes || []) { const p = document.createElement('p'); p.className = 'cc-note'; p.textContent = n; el.appendChild(p); }
      const actions = document.createElement('div');
      actions.className = 'cc-actions';
      const plotSpec = buildPlot(h.res.plot);
      let plotBox = null;
      const showPlot = () => {
        if (plotBox) { plotBox.remove(); plotBox = null; return; }
        plotBox = plotView(plotSpec, h);
        el.insertBefore(plotBox, actions);
      };
      const btn = (text, fn, main) => { const b = document.createElement('button'); b.textContent = text; if (main) b.className = 'main'; b.onclick = fn; actions.appendChild(b); return b; };
      if (h.res.blocks.length || h.res.table) btn('Insertar en la nota', () => insertCard(h), true);
      if (h.res.blocks.length && h.res.blocks[0].latex && !h.res.table) btn('Usar resultado', () => useResult(h));
      if (plotSpec) btn(h.res.plot && h.res.plot.optional ? 'Ver gráfica' : 'Gráfica', showPlot);
      el.appendChild(actions);
      if (plotSpec && !h.res.plot.optional) showPlot();
    }
    return el;
  }

  function opSuffix(h) {
    const o = h.opts || {};
    switch (h.action) {
      case 'diff': return `\\quad \\left[\\tfrac{d${+o.order > 1 ? '^{' + o.order + '}' : ''}}{d${o.var || 'x'}${+o.order > 1 ? '^{' + o.order + '}' : ''}}\\right]`;
      case 'int': return o.a && o.b ? `\\quad\\left[\\int_{${o.a}}^{${o.b}} d${o.var || 'x'}\\right]` : `\\quad\\left[\\int d${o.var || 'x'}\\right]`;
      case 'lim': return `\\quad\\left[${o.var || 'x'}\\to ${o.to || 0}${o.side > 0 ? '^{+}' : o.side < 0 ? '^{-}' : ''}\\right]`;
      default: return '';
    }
  }

  function buildPlot(p) {
    if (!p || !p.fns) return null;
    const v = p.var || 'x';
    const fns = [];
    p.fns.forEach((s, i) => { const f = compile(s, v); if (f) fns.push({ f, color: PLOT_COLORS[i % PLOT_COLORS.length], name: p.names ? p.names[i] : null }); });
    if (!fns.length) return null;
    const num = s => { const f = compile(String(s), v); return f ? f(0) : NaN; };
    const spec = { fns, v };
    if (p.shade) { const a = num(p.shade[0]), b = num(p.shade[1]); if (isFinite(a) && isFinite(b)) spec.shade = { a, b }; }
    if (p.roots) spec.points = p.roots.map(num).filter(isFinite).map(x => ({ x, y: 0, color: '#D93838' }));
    return spec;
  }

  function plotView(spec, h) {
    const box = document.createElement('div');
    box.className = 'cc-plot';
    const cv = document.createElement('canvas');
    box.appendChild(cv);
    const z = document.createElement('div');
    z.className = 'cc-zoom';
    z.innerHTML = '<button aria-label="Alejar">−</button><button aria-label="Acercar">+</button>';
    box.appendChild(z);
    if (spec.fns.some(f => f.name)) {
      const lg = document.createElement('div');
      lg.className = 'cc-legend';
      lg.innerHTML = spec.fns.filter(f => f.name).map(f => `<span><i style="background:${f.color}"></i>${esc(f.name.replace(/\^\{\((\d+)\)\}/, '⁽$1⁾'))}</span>`).join('');
      box.appendChild(lg);
    }
    const act = document.createElement('div');
    act.className = 'cc-actions';
    act.innerHTML = '<button class="main">Insertar gráfica en la nota</button>';
    box.appendChild(act);
    requestAnimationFrame(() => {
      const pl = createPlot(cv, { fns: spec.fns, shade: spec.shade, points: spec.points, dark: isDark() });
      plots.add(pl);
      z.children[0].onclick = () => pl.zoom(1.5);
      z.children[1].onclick = () => pl.zoom(1 / 1.5);
      act.querySelector('button').onclick = () => insertPlot(pl);
    });
    return box;
  }

  // ---------- Al cuaderno ----------
  function editorOrToast() {
    const ed = getEditor();
    if (!ed || !ed.isOpen) { toast('Abre una nota para insertar el resultado en ella.'); return null; }
    return ed;
  }

  function cardLatex(h) {
    const r = h.res;
    if (r.table) return '\\begin{array}{ll}' + `\\textbf{${texEsc(r.title)}} & \\\\` + r.table.map(([k, v]) => `\\text{${texEsc(k)}} & \\text{${texEsc(v)}}`).join('\\\\') + '\\end{array}';
    const lines = [];
    const blocks = r.blocks;
    const simple = blocks.length === 1 && ['=', '', '≈'].includes(blocks[0].label || '');
    if (h.input && simple) return `${h.input} ${blocks[0].label === '≈' ? '\\approx' : '='} ${blocks[0].latex}`;
    if (h.input) lines.push(h.input);
    for (const b of blocks) {
      const lab = b.label && !['=', ''].includes(b.label) ? (/[\\_^{]/.test(b.label) ? b.label : `\\text{${texEsc(b.label)}}`) + ':\\ ' : '';
      lines.push(lab + b.latex);
    }
    return '\\begin{array}{l}' + lines.join('\\\\[4pt]') + '\\end{array}';
  }

  function insertCard(h) {
    const ed = editorOrToast();
    if (!ed) return;
    try {
      const pic = formulaPicture(cardLatex(h));
      ed.insertPicture({ ...pic, math: { latex: cardLatex(h) } });
      toast('Listo: quedó en la nota. Muévela o cambia su tamaño con el punto amarillo.');
      if (window.innerWidth < 900) close();
    } catch { toast('No se pudo insertar ese resultado.'); }
  }

  function insertPlot(pl) {
    const ed = editorOrToast();
    if (!ed) return;
    pl.setDark(false);
    const src = pl.toDataURL();
    pl.setDark(true);
    const srcDark = pl.toDataURL();
    pl.setDark(isDark());
    const cv = document.createElement('canvas');
    const img = new Image();
    img.onload = () => {
      const k = 600 / img.width;
      ed.insertPicture({ src, srcDark, w: 600, h: img.height * k });
      toast('Gráfica insertada en la nota.');
      if (window.innerWidth < 900) close();
    };
    img.src = src;
    void cv;
  }

  function useResult(h) {
    if (!mf) return;
    const b = h.res.blocks[0];
    let l = b.latex.replace(/\+C$/, '');
    // "x=2" → 2
    const m = /^[a-zA-Z](?:_\{\d+\})?=(.*)$/.exec(l);
    if (m) l = m[1];
    mf.value = l;
    onInput();
    mf.focus();
  }

  // ---------- Calcular ----------
  async function run() {
    if (busy || !mf) return;
    const latex = mf.value.trim();
    if (!latex) { toast('Escribe una operación primero.'); mf.focus(); return; }
    busy = true;
    go.disabled = true;
    const h = { id: Date.now().toString(36), input: latex, action: op || 'auto', opts: { ...opts } };
    const wait = document.createElement('div');
    wait.className = 'calc-card';
    wait.innerHTML = '<div class="cc-busy">Calculando…</div>';
    feed.querySelector('.calc-empty')?.remove();
    feed.appendChild(wait);
    feed.scrollTop = feed.scrollHeight;
    try {
      h.res = await compute(latex, h.action, h.opts);
    } catch (e) {
      h.error = e instanceof MathSyntaxError ? e.message : (e && e.message) || 'No se pudo calcular.';
    }
    wait.remove();
    history.push(h);
    saveHistory();
    const c = card(h);
    feed.appendChild(c);
    c.scrollIntoView({ block: 'end', behavior: 'smooth' });
    busy = false;
    go.disabled = false;
    // La operación elegida (Derivar, Integrar…) vale para un cálculo; luego vuelve a "=".
    if (op) { op = null; opts = {}; renderOps(); renderOpts(); }
  }

  // ---------- Estadística ----------
  function statCard(title, table, notes = [], plot = null, input = null) {
    const h = { id: Date.now().toString(36), input, action: 'stats', res: { title, blocks: [], table, notes, plot } };
    history.push(h);
    saveHistory();
    feed.querySelector('.calc-empty')?.remove();
    const c = card(h);
    feed.appendChild(c);
    c.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }
  const f = ST.fmt;
  const numIn = id => { const v = $(id).value.trim().replace(',', '.'); return v === '' ? NaN : Number(v); };

  $('#st-go').onclick = () => {
    const { xs, ys, bad } = ST.parseData($('#st-data').value);
    if (!xs.length) { toast('Escribe al menos un dato.'); return; }
    const notes = bad.length ? [`Ignoré lo que no era número: ${bad.slice(0, 6).join(', ')}${bad.length > 6 ? '…' : ''}`] : [];
    if (ys) {
      const r = ST.regression(xs, ys);
      if (!r) { toast('Los valores de x son todos iguales: no se puede hacer regresión.'); return; }
      const sx = ST.summary(xs), sy = ST.summary(ys);
      statCard('Regresión lineal', [
        ['Pares de datos', String(r.n)], ['Recta', `y = ${f(r.m, 4)}x ${r.b < 0 ? '−' : '+'} ${f(Math.abs(r.b), 4)}`],
        ['Pendiente m', f(r.m)], ['Intercepto b', f(r.b)], ['Correlación r', f(r.r, 4)], ['R²', f(r.r2, 4)],
        ['Media de x', f(sx.mean)], ['Media de y', f(sy.mean)],
      ], [...notes, Math.abs(r.r) > 0.9 ? 'La relación lineal es fuerte.' : Math.abs(r.r) > 0.6 ? 'La relación lineal es moderada.' : 'La relación lineal es débil.'],
      { fns: [`${r.m}*x+(${r.b})`], var: 'x', roots: [] });
      return;
    }
    const s = ST.summary(xs);
    statCard('Resumen de los datos', [
      ['Cantidad n', String(s.n)], ['Suma', f(s.sum)], ['Media', f(s.mean)], ['Mediana', f(s.median)],
      ['Moda', s.modes.length ? s.modes.map(m => f(m)).join(', ') : 'No hay (ningún dato se repite)'],
      ['Mínimo', f(s.min)], ['Máximo', f(s.max)], ['Rango', f(s.range)], ['Cuartil 1 (Q1)', f(s.q1)], ['Cuartil 3 (Q3)', f(s.q3)],
      ['Varianza muestral (s²)', f(s.varS)], ['Desviación muestral (s)', f(s.sdS)],
      ['Varianza poblacional (σ²)', f(s.varP)], ['Desviación poblacional (σ)', f(s.sdP)], ['Coeficiente de variación', isFinite(s.cv) ? f(s.cv * 100, 2) + ' %' : '—'],
    ], notes);
  };
  $('#bn-go').onclick = () => {
    const n = numIn('#bn-n'), p = numIn('#bn-p'), k = numIn('#bn-k');
    if (!(Number.isInteger(n) && n > 0 && n <= 5000 && p >= 0 && p <= 1 && Number.isInteger(k) && k >= 0)) { toast('Revisa los datos: n entero positivo, p entre 0 y 1, k entero.'); return; }
    statCard(`Binomial (n = ${n}, p = ${p})`, [
      [`P(X = ${k})`, f(ST.binomialPmf(n, p, k))], [`P(X ≤ ${k})`, f(ST.binomialCdf(n, p, k))], [`P(X < ${k})`, f(k ? ST.binomialCdf(n, p, k - 1) : 0)],
      [`P(X ≥ ${k})`, f(1 - (k ? ST.binomialCdf(n, p, k - 1) : 0))], [`P(X > ${k})`, f(1 - ST.binomialCdf(n, p, k))],
      ['Media (np)', f(n * p)], ['Varianza (np(1−p))', f(n * p * (1 - p))], ['Desviación', f(Math.sqrt(n * p * (1 - p)))],
    ]);
  };
  $('#ps-go').onclick = () => {
    const l = numIn('#ps-l'), k = numIn('#ps-k');
    if (!(l > 0 && Number.isInteger(k) && k >= 0 && k < 5000)) { toast('Revisa los datos: λ positivo y k entero.'); return; }
    statCard(`Poisson (λ = ${l})`, [
      [`P(X = ${k})`, f(ST.poissonPmf(l, k))], [`P(X ≤ ${k})`, f(ST.poissonCdf(l, k))], [`P(X < ${k})`, f(k ? ST.poissonCdf(l, k - 1) : 0)],
      [`P(X ≥ ${k})`, f(1 - (k ? ST.poissonCdf(l, k - 1) : 0))], [`P(X > ${k})`, f(1 - ST.poissonCdf(l, k))], ['Media y varianza (λ)', f(l)],
    ]);
  };
  $('#nm-go').onclick = () => {
    const mu = numIn('#nm-mu'), sd = numIn('#nm-sd');
    let a = numIn('#nm-a'), b = numIn('#nm-b');
    if (!(isFinite(mu) && sd > 0)) { toast('Revisa μ y σ (σ debe ser positiva).'); return; }
    if (isNaN(a)) a = -Infinity;
    if (isNaN(b)) b = Infinity;
    if (a > b) [a, b] = [b, a];
    const za = (a - mu) / sd, zb = (b - mu) / sd;
    const P = ST.normCdf(zb) - ST.normCdf(za);
    statCard(`Normal (μ = ${mu}, σ = ${sd})`, [
      [`P(${isFinite(a) ? f(a, 4) : '−∞'} < X < ${isFinite(b) ? f(b, 4) : '∞'})`, f(P)], ['En porcentaje', f(P * 100, 4) + ' %'],
      ...(isFinite(a) ? [['z de a', f(za, 4)]] : []), ...(isFinite(b) ? [['z de b', f(zb, 4)]] : []),
    ], [], { fns: [`exp(-((x-(${mu}))^2)/(2*(${sd})^2))/(${sd}*sqrt(2*pi))`], var: 'x', shade: [String(isFinite(a) ? a : mu - 5 * sd), String(isFinite(b) ? b : mu + 5 * sd)] });
  };
  $('#nm-inv').onclick = () => {
    const mu = numIn('#nm-mu'), sd = numIn('#nm-sd'), p = numIn('#nm-p');
    if (!(isFinite(mu) && sd > 0 && p > 0 && p < 1)) { toast('Revisa μ, σ y la probabilidad (entre 0 y 1).'); return; }
    const z = ST.normInv(p), zc = ST.normInv(0.5 + p / 2);
    statCard(`Normal inversa (μ = ${mu}, σ = ${sd})`, [
      [`x con P(X < x) = ${p}`, f(mu + z * sd)], ['z', f(z, 4)],
      [`Intervalo central del ${f(p * 100, 2)} %`, `${f(mu - zc * sd)} a ${f(mu + zc * sd)}`], ['z (dos colas)', '±' + f(zc, 4)],
    ]);
  };

  // ---------- Pestañas, abrir y cerrar ----------
  root.querySelectorAll('.calc-tabs button').forEach(b => b.onclick = () => {
    root.querySelectorAll('.calc-tabs button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    const stats = b.dataset.tab === 'stats';
    $('#calc-ops-pane').hidden = stats;
    $('#calc-stats-pane').hidden = !stats;
    if (stats) window.mathVirtualKeyboard && window.mathVirtualKeyboard.hide();
  });
  root.querySelectorAll('.calc-stabs button').forEach(b => b.onclick = () => {
    root.querySelectorAll('.calc-stabs button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    root.querySelectorAll('.calc-st').forEach(p => { p.hidden = p.dataset.st !== b.dataset.st; });
  });
  go.onclick = run;
  $('#calc-close').onclick = () => close();
  $('#calc-clear').onclick = () => {
    if (!history.length) return;
    history = []; saveHistory(); renderAll(); toast('Historial borrado.');
  };

  async function open() {
    root.hidden = false;
    document.body.classList.add('calc-docked');
    window.dispatchEvent(new Event('resize'));
    onToggle && onToggle(true);
    try {
      await setup();
      if (!rendered) renderAll();
      if (!$('#calc-ops-pane').hidden) { mf.focus(); window.mathVirtualKeyboard.show(); }
    } catch (e) {
      console.error(e);
      wrap.innerHTML = '<span class="calc-loading">No se pudo cargar la calculadora. Cierra y vuelve a abrir la app.</span>';
    }
  }
  function close() {
    if (root.hidden) return;
    root.hidden = true;
    document.body.classList.remove('calc-docked');
    try { window.mathVirtualKeyboard && window.mathVirtualKeyboard.hide(); } catch {}
    window.dispatchEvent(new Event('resize'));
    onToggle && onToggle(false);
  }

  return {
    open, close,
    toggle() { if (root.hidden) open(); else close(); },
    get isOpen() { return !root.hidden; },
    refreshTheme() { for (const p of plots) p.setDark(isDark()); },
  };
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
// Para texto dentro de \text{}: solo se escapan los símbolos especiales de LaTeX.
function texEsc(s) { return String(s).replace(/\\/g, '\\backslash ').replace(/[{}#$%&_^~]/g, c => '\\' + c); }
