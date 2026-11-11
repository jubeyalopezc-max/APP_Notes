// Traduce lo que se escribe en el teclado matemático (LaTeX de MathLive) al lenguaje del motor (Giac).
// Se hace con un analizador de verdad (no con reemplazos de texto) para entender la multiplicación
// implícita (2x, xy, 3sen x), integrales con su dx, límites, derivadas d/dx, matrices y valores absolutos.

const FUNCS = {
  sin: 'sin', sen: 'sin', cos: 'cos', tan: 'tan', tg: 'tan', cot: 'cot', ctg: 'cot', sec: 'sec', csc: 'csc', cosec: 'csc',
  arcsin: 'asin', arcsen: 'asin', arccos: 'acos', arctan: 'atan', arctg: 'atan', arccot: 'acot', arcsec: 'asec', arccsc: 'acsc',
  sinh: 'sinh', senh: 'sinh', cosh: 'cosh', tanh: 'tanh', coth: 'coth', sech: 'sech', csch: 'csch',
  arcsinh: 'asinh', arccosh: 'acosh', arctanh: 'atanh', asinh: 'asinh', acosh: 'acosh', atanh: 'atanh',
  asin: 'asin', acos: 'acos', atan: 'atan',
  ln: 'ln', log: 'log10', exp: 'exp', sqrt: 'sqrt', abs: 'abs', sgn: 'sign', sign: 'sign',
  floor: 'floor', ceil: 'ceil', max: 'max', min: 'min', gcd: 'gcd', mcd: 'gcd', lcm: 'lcm', mcm: 'lcm',
  det: 'det', Re: 're', Im: 'im', arg: 'arg', mod: 'irem',
};
const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Sigma', 'Phi', 'Psi', 'Omega'];
// Nombres que Giac ya usa y no pueden ser variables.
const RESERVED = { gamma: 'gamma_', beta: 'beta_', zeta: 'zeta_', Gamma: 'Gamma_', Psi: 'Psi_', Phi: 'Phi_', Delta: 'Delta_', Sigma: 'Sigma_', omega: 'omega' };

export class MathSyntaxError extends Error {}

// ---------- Tokens ----------
function tokenize(src) {
  const s = String(src).replace(/\\placeholder(\[[^\]]*\])?\{[^}]*\}/g, '\\placeholder');
  const t = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
      const name = m[1];
      i += m[0].length;
      // Espacios de LaTeX: no significan nada.
      if ([',', ';', ':', '!', ' ', 'quad', 'qquad', 'displaystyle', 'textstyle', 'limits', 'nolimits'].includes(name)) continue;
      t.push({ k: 'cmd', v: name });
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
      t.push({ k: 'num', v: m[1] });
      i += m[1].length;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) { t.push({ k: 'let', v: c }); i++; continue; }
    if (c === "'") { t.push({ k: 'prime' }); i++; continue; }
    t.push({ k: 'sym', v: c });
    i++;
  }
  return t;
}

// ---------- Árbol ----------
// Nodos: num, var, op(+,-,*,/,^), neg, call(name,args), fact, rel(op,a,b), int, lim, sum, prod,
// diff, mat(rows), abs, prime(var,n), list, pct
class Parser {
  constructor(tokens) { this.t = tokens; this.i = 0; }
  peek(o = 0) { return this.t[this.i + o]; }
  next() { return this.t[this.i++]; }
  is(k, v, o = 0) { const x = this.peek(o); return !!x && x.k === k && (v === undefined || x.v === v); }
  isSym(v, o = 0) { return this.is('sym', v, o); }
  isCmd(v, o = 0) { return this.is('cmd', v, o); }
  eat(k, v) { if (this.is(k, v)) return this.next(); return null; }
  expect(k, v, what) { const x = this.eat(k, v); if (!x) throw new MathSyntaxError(what || 'Falta algo en la expresión'); return x; }
  done() { return this.i >= this.t.length; }

  // { ... } como grupo; si no hay llaves, toma un solo símbolo (x^2, \frac12).
  group() {
    if (this.eat('sym', '{')) {
      if (this.eat('sym', '}')) return { k: 'empty' };
      const e = this.relation();
      this.expect('sym', '}', 'Falta cerrar una llave');
      return e;
    }
    const x = this.next();
    if (!x) throw new MathSyntaxError('La expresión está incompleta');
    if (x.k === 'num') {
      // \frac12 o x^23 sin llaves: LaTeX toma un solo dígito; el resto sigue después.
      if (x.v.length > 1 && !x.v.includes('.')) { this.t.splice(this.i, 0, { k: 'num', v: x.v.slice(1) }); return { k: 'num', v: x.v[0] }; }
      return { k: 'num', v: x.v };
    }
    if (x.k === 'let') return { k: 'var', v: x.v };
    if (x.k === 'cmd') { this.i--; return this.primary(); }
    throw new MathSyntaxError('Expresión incompleta');
  }

  // Texto plano dentro de {...} (para \operatorname{sen}, \mathrm{d}, subíndices).
  rawGroup() {
    if (!this.eat('sym', '{')) { const x = this.next(); return x ? (x.v || '') : ''; }
    let depth = 1, out = '';
    while (!this.done()) {
      const x = this.next();
      if (x.k === 'sym' && x.v === '{') depth++;
      if (x.k === 'sym' && x.v === '}' && --depth === 0) break;
      out += x.k === 'cmd' ? '\\' + x.v : (x.v || '');
    }
    return out;
  }

  program() {
    const items = [this.relation()];
    while (this.eat('sym', ',') || this.eat('sym', ';')) items.push(this.relation());
    if (!this.done()) {
      const x = this.peek();
      throw new MathSyntaxError(x.k === 'sym' && (x.v === ')' || x.v === ']') ? 'Sobra un paréntesis de cierre' : 'No entendí una parte de la expresión');
    }
    return items.length === 1 ? items[0] : { k: 'list', items };
  }

  relation() {
    let a = this.sum();
    const REL = { '=': '=', '<': '<', '>': '>' };
    const CREL = { le: '<=', leq: '<=', ge: '>=', geq: '>=', ne: '!=', neq: '!=' };
    for (;;) {
      let op = null;
      if (this.peek() && this.peek().k === 'sym' && REL[this.peek().v]) op = REL[this.next().v];
      else if (this.peek() && this.peek().k === 'cmd' && CREL[this.peek().v]) op = CREL[this.next().v];
      if (!op) return a;
      const b = this.sum();
      a = { k: 'rel', op, a, b };
    }
  }

  sum() {
    let a = this.term();
    for (;;) {
      if (this.eat('sym', '+')) a = { k: 'op', op: '+', a, b: this.term() };
      else if (this.eat('sym', '-')) a = { k: 'op', op: '-', a, b: this.term() };
      else if (this.isCmd('pm')) { this.next(); a = { k: 'op', op: '+', a, b: this.term() }; }
      else return a;
    }
  }

  startsFactor() {
    const x = this.peek();
    if (!x) return false;
    if (x.k === 'num' || x.k === 'let') return true;
    if (x.k === 'sym') return x.v === '(' || x.v === '[' || x.v === '|' || x.v === '{';
    if (x.k === 'cmd') return !['\\', 'cdot', 'times', 'div', 'le', 'leq', 'ge', 'geq', 'ne', 'neq', 'right', 'end', 'to', 'rightarrow', 'pm', 'mid', 'rvert', 'rVert', 'rbrack', 'rparen'].includes(x.v) && !(x.v === 'vert' && this.absDepth > 0);
    return false;
  }

  term(stopAtFunc = false) {
    let a = this.unary();
    for (;;) {
      if (this.eat('sym', '*') || this.eat('cmd', 'cdot')) { a = { k: 'op', op: '*', a, b: this.unary(), dot: true }; continue; }
      if (this.eat('cmd', 'times')) { a = { k: 'op', op: '*', a, b: this.unary(), cross: true }; continue; }
      if (this.eat('sym', '/') || this.eat('cmd', 'div')) { a = { k: 'op', op: '/', a, b: this.unary() }; continue; }
      // Para el argumento de una función sin paréntesis (\sin 2x): se corta en la siguiente función.
      if (stopAtFunc && this.peek() && this.peek().k === 'cmd' && (FUNCS[this.peek().v] || this.peek().v === 'operatorname')) return a;
      // dx de una integral: no es multiplicación.
      if (this.integrandEnd && this.atDifferential()) return a;
      if (this.isSym('|') && this.absDepth > 0) return a;
      if (this.startsFactor()) { a = { k: 'op', op: '*', a, b: this.power(), implicit: true }; continue; }
      return a;
    }
  }

  unary() {
    if (this.eat('sym', '-')) return { k: 'neg', a: this.unary() };
    if (this.eat('sym', '+')) return this.unary();
    return this.power();
  }

  power() {
    let base = this.postfix();
    if (this.eat('sym', '^')) {
      // x^{\prime} es una derivada (y').
      if (this.isSym('{') && this.is('cmd', 'prime', 1)) {
        this.next(); let n = 0;
        while (this.eat('cmd', 'prime')) n++;
        this.expect('sym', '}');
        return this.withPrimes(base, n);
      }
      if (this.isCmd('prime')) { this.next(); return this.withPrimes(base, 1); }
      const deg = { k: 'op', op: '*', a: base, b: { k: 'var', v: 'pi/180', raw: true } };
      if (this.isCmd('circ')) { this.next(); return deg; }
      if (this.isSym('{') && this.isCmd('circ', 1) && this.isSym('}', 2)) { this.i += 3; return deg; }
      const e = this.unaryPowerExp();
      return { k: 'op', op: '^', a: base, b: e };
    }
    return base;
  }

  unaryPowerExp() {
    if (this.eat('sym', '-')) return { k: 'neg', a: this.unaryPowerExp() };
    const g = this.group();
    if (this.eat('sym', '^')) return { k: 'op', op: '^', a: g, b: this.unaryPowerExp() };
    return g;
  }

  withPrimes(base, n) {
    if (base.k !== 'var') throw new MathSyntaxError('La comilla de derivada va sobre una función, como y\'');
    return { k: 'prime', v: base.v, n };
  }

  postfix() {
    let a = this.primary();
    for (;;) {
      if (this.eat('sym', '!')) { a = { k: 'fact', a }; continue; }
      if (this.is('prime')) { let n = 0; while (this.eat('prime')) n++; a = this.withPrimes(a, n); continue; }
      if (this.isCmd('prime')) { let n = 0; while (this.eat('cmd', 'prime')) n++; a = this.withPrimes(a, n); continue; }
      if (this.eat('sym', '%') || this.eat('cmd', '%')) { a = { k: 'op', op: '/', a, b: { k: 'num', v: '100' } }; continue; }
      return a;
    }
  }

  // Argumento de función: (…) o lo que sigue hasta la próxima suma.
  funcArg() {
    if (this.isCmd('left') || this.isSym('(')) return this.primary();
    return this.termNoSum();
  }
  termNoSum() { return this.term(true); }

  atDifferential() {
    // d seguido de variable (dx), o \mathrm{d}x / \differentialD x
    if (this.is('let', 'd') && this.is('let', undefined, 1) && !this.is('sym', '^', 1)) return true;
    if (this.isCmd('differentialD') || this.isCmd('mathrm') && this.peekRawIs('d') || this.isCmd('operatorname') && this.peekRawIs('d')) return true;
    return false;
  }
  peekRawIs(v) {
    const a = this.peek(1), b = this.peek(2), c = this.peek(3);
    return a && a.k === 'sym' && a.v === '{' && b && b.v === v && c && c.k === 'sym' && c.v === '}';
  }
  eatDifferential() {
    if (this.eat('cmd', 'differentialD')) { /* sigue la variable */ }
    else if (this.isCmd('mathrm') || this.isCmd('operatorname')) { this.next(); this.rawGroup(); }
    else this.expect('let', 'd');
    const v = this.next();
    if (!v || (v.k !== 'let' && v.k !== 'cmd')) throw new MathSyntaxError('Falta la variable de integración (dx)');
    return v.k === 'cmd' ? greekName(v.v) : v.v;
  }

  // Subíndice y superíndice de \int, \sum, \lim (en cualquier orden).
  limits() {
    let lo = null, hi = null;
    for (let k = 0; k < 2; k++) {
      if (this.eat('sym', '_')) lo = this.isSym('{') ? this.groupRaw2() : this.group();
      else if (this.eat('sym', '^')) hi = this.group();
    }
    return { lo, hi };
  }
  groupRaw2() { return this.group(); }

  primary() {
    const x = this.next();
    if (!x) throw new MathSyntaxError('La expresión está incompleta');
    if (x.k === 'num') return { k: 'num', v: x.v };
    if (x.k === 'let') {
      // subíndice: x_1 → x1 (una variable)
      if (this.isSym('_')) { this.next(); const sub = this.rawGroup().replace(/[^a-zA-Z0-9]/g, ''); return { k: 'var', v: x.v + sub }; }
      return { k: 'var', v: x.v };
    }
    if (x.k === 'prime') throw new MathSyntaxError('La comilla de derivada va después de la función, como y\'');
    if (x.k === 'sym') {
      if (x.v === '(' || x.v === '[') {
        const close = x.v === '(' ? ')' : ']';
        const items = [this.relation()];
        while (this.eat('sym', ',')) items.push(this.relation());
        this.expect('sym', close, 'Falta cerrar un paréntesis');
        if (items.length > 1) return { k: 'tuple', items };
        return { k: 'paren', a: items[0] };
      }
      if (x.v === '{') { this.i--; return this.group(); }
      if (x.v === '|') {
        this.absDepth = (this.absDepth || 0) + 1;
        const a = this.sum();
        this.absDepth--;
        this.expect('sym', '|', 'Falta cerrar el valor absoluto');
        return { k: 'call', name: 'abs', args: [a] };
      }
      throw new MathSyntaxError(x.v === ')' ? 'Sobra un paréntesis de cierre' : `No entendí el símbolo “${x.v}”`);
    }
    // Comandos
    const c = x.v;
    if (c === 'placeholder') throw new MathSyntaxError('Hay una casilla vacía por llenar');
    if (c === 'left') {
      const open = this.next();
      const ov = open.k === 'cmd' ? open.v : open.v;
      if (ov === '|' || ov === 'vert' || ov === 'lvert') {
        const a = this.sum();
        this.expect('cmd', 'right'); this.next();
        return { k: 'call', name: 'abs', args: [a] };
      }
      if (ov === 'lfloor') { const a = this.sum(); this.expect('cmd', 'right'); this.next(); return { k: 'call', name: 'floor', args: [a] }; }
      if (ov === 'lceil') { const a = this.sum(); this.expect('cmd', 'right'); this.next(); return { k: 'call', name: 'ceil', args: [a] }; }
      if (ov === 'lbrace' || ov === '{') { this.i--; }
      const items = [this.relation()];
      while (this.eat('sym', ',')) items.push(this.relation());
      this.expect('cmd', 'right', 'Falta cerrar un paréntesis');
      this.next(); // ) ] o .
      if (items.length > 1) return { k: 'tuple', items };
      return { k: 'paren', a: items[0] };
    }
    if (c === 'frac' || c === 'dfrac' || c === 'tfrac') {
      // d/dx: derivada
      const save = this.i;
      const d = this.tryDerivFrac();
      if (d) return d;
      this.i = save;
      const a = this.group(), b = this.group();
      return { k: 'op', op: '/', a, b, frac: true };
    }
    if (c === 'binom' || c === 'dbinom') { const n = this.group(), k = this.group(); return { k: 'call', name: 'comb', args: [n, k] }; }
    if (c === 'sqrt') {
      if (this.eat('sym', '[')) {
        const n = this.sum(); this.expect('sym', ']');
        const a = this.group();
        return { k: 'call', name: 'surd', args: [a, n] };
      }
      return { k: 'call', name: 'sqrt', args: [this.group()] };
    }
    if (c === 'pi') return { k: 'var', v: 'pi' };
    if (c === 'infty') return { k: 'var', v: 'inf' };
    if (c === 'exponentialE') return { k: 'var', v: 'e' };
    if (c === 'imaginaryI') return { k: 'var', v: 'i' };
    if (c === 'degree' || c === 'circ') return { k: 'var', v: 'pi/180', raw: true };
    if (c === 'mathrm' || c === 'operatorname' || c === 'text' || c === 'mathit' || c === 'textrm' || c === 'mathbf' || c === 'vec' || c === 'overrightarrow' || c === 'mathbb') {
      if (c === 'vec' || c === 'overrightarrow' || c === 'mathbf') { return this.group(); }
      const name = this.rawGroup().trim();
      if (name === 'e') return { k: 'var', v: 'e' };
      if (name === 'i') return { k: 'var', v: 'i' };
      if (FUNCS[name]) return this.funcCall(FUNCS[name], name);
      if (/^[a-zA-Z]$/.test(name)) return { k: 'var', v: name };
      if (/^[a-zA-Z]\w*$/.test(name)) return this.funcCall(name, name);
      throw new MathSyntaxError(`No conozco “${name}”`);
    }
    if (FUNCS[c]) {
      if (c === 'log' && this.isSym('_')) {
        this.next();
        const base = this.group();
        const arg = this.funcArgWithPower();
        return { k: 'call', name: 'logb', args: [arg.arg, base], pow: arg.pow };
      }
      return this.funcCall(FUNCS[c], c);
    }
    if (GREEK.includes(c)) return { k: 'var', v: greekName(c) };
    if (c === 'int' || c === 'iint' || c === 'iiint' || c === 'oint') return this.integral(c === 'iint' ? 2 : c === 'iiint' ? 3 : 1);
    if (c === 'lim') return this.limit();
    if (c === 'sum' || c === 'prod') return this.sumProd(c);
    if (c === 'begin') return this.matrix();
    if (c === 'lbrack' || c === 'lparen') { this.i--; this.t[this.i] = { k: 'sym', v: c === 'lbrack' ? '[' : '(' }; return this.primary(); }
    if (c === 'vert' || c === 'lvert' || c === 'mid') {
      const a = this.sum();
      if (!this.eat('cmd', 'vert') && !this.eat('cmd', 'rvert') && !this.eat('cmd', 'mid') && !this.eat('sym', '|')) throw new MathSyntaxError('Falta cerrar el valor absoluto');
      return { k: 'call', name: 'abs', args: [a] };
    }
    if (c === 'nabla') return { k: 'nabla' };
    if (c === 'partial') throw new MathSyntaxError('Para derivadas parciales usa ∂/∂x (la fracción) o el botón Derivar');
    throw new MathSyntaxError(`No conozco el símbolo \\${c}`);
  }

  funcArgWithPower() {
    let pow = null;
    if (this.eat('sym', '^')) pow = this.unaryPowerExp();
    return { arg: this.funcArg(), pow };
  }

  funcCall(name) {
    // sin^2 x  →  sin(x)^2   ;   sin^{-1} x → asin(x)
    let pow = null;
    if (this.eat('sym', '^')) pow = this.unaryPowerExp();
    if (pow && pow.k === 'neg' && pow.a.k === 'num' && pow.a.v === '1' && ['sin', 'cos', 'tan', 'cot', 'sec', 'csc'].includes(name)) {
      return { k: 'call', name: 'a' + name, args: [this.funcArg()] };
    }
    let args;
    if (this.isSym('(') || this.isCmd('left')) {
      const p = this.primary();
      args = p.k === 'tuple' ? p.items : [p.k === 'paren' ? p.a : p];
    } else {
      args = [this.funcArg()];
    }
    const call = { k: 'call', name, args };
    return pow ? { k: 'op', op: '^', a: call, b: pow } : call;
  }

  // \frac{d}{dx} f, \frac{d^2}{dx^2} f, \frac{\partial}{\partial x} f, \frac{dy}{dx}
  tryDerivFrac() {
    if (!this.eat('sym', '{')) return null;
    const isD = () => this.eat('let', 'd') || this.eat('cmd', 'partial') || this.eat('cmd', 'differentialD') || ((this.isCmd('mathrm') || this.isCmd('operatorname')) && this.peekRawIs('d') && (this.next(), this.rawGroup(), true));
    if (!isD()) return null;
    let n = 1;
    if (this.eat('sym', '^')) { const g = this.group(); if (g.k !== 'num') return null; n = +g.v; }
    let fn = null;
    if (!this.isSym('}')) { const f = this.next(); if (!f || f.k !== 'let') return null; fn = f.v; }
    if (!this.eat('sym', '}')) return null;
    if (!this.eat('sym', '{')) return null;
    if (!isD()) return null;
    const v = this.next();
    if (!v || v.k !== 'let') return null;
    if (this.eat('sym', '^')) this.group();
    if (!this.eat('sym', '}')) return null;
    if (fn) return { k: 'prime', v: fn, n, wrt: v.v };
    const body = this.term();
    return { k: 'diff', a: body, v: v.v, n };
  }

  integral(times) {
    const bounds = [];
    let { lo, hi } = this.limits();
    this.integrandEnd = (this.integrandEnd || 0) + 1;
    let body;
    if (this.atDifferential()) body = { k: 'num', v: '1' };
    else body = this.sum();
    this.integrandEnd--;
    const vars = [];
    for (let k = 0; k < times; k++) {
      if (!this.atDifferential()) {
        if (k === 0) throw new MathSyntaxError('A la integral le falta el diferencial (por ejemplo dx al final)');
        break;
      }
      vars.push(this.eatDifferential());
    }
    // Integrales iteradas: \int_a^b \int_c^d f dy dx
    bounds.push({ lo, hi });
    let node = body;
    if (body.k === 'int' && body.pending) {
      // el cuerpo era otra integral que aún no tenía su diferencial: se lo damos ahora
    }
    return { k: 'int', a: node, v: vars[0], lo, hi, more: vars.slice(1) };
  }

  limit() {
    this.expect('sym', '_', 'Al límite le falta a dónde tiende (x→a)');
    this.expect('sym', '{', 'Al límite le falta a dónde tiende (x→a)');
    const v = this.next();
    if (!v || v.k !== 'let') throw new MathSyntaxError('Al límite le falta la variable (x→a)');
    if (!(this.eat('cmd', 'to') || this.eat('cmd', 'rightarrow') || this.eat('cmd', 'longrightarrow'))) throw new MathSyntaxError('Al límite le falta la flecha (x→a)');
    let side = 0;
    let to = this.sumSide();
    if (to.side) { side = to.side; to = to.e; }
    this.expect('sym', '}', 'Falta cerrar el límite');
    const body = this.sum();
    return { k: 'lim', a: body, v: v.v, to, side };
  }
  sumSide() {
    const neg = this.eat('sym', '-');
    let e = this.postfix();
    let side = 0;
    // 0^+ y 2^- son límites laterales; cualquier otro ^ es una potencia (x→e^2).
    if (this.isSym('^')) {
      const sideOf = o => this.isSym('+', o) ? 1 : this.isSym('-', o) && !this.is('num', undefined, o + 1) && !this.is('let', undefined, o + 1) ? -1 : 0;
      if (this.isSym('{', 1) && sideOf(2) && this.isSym('}', 3)) { side = sideOf(2); this.i += 4; }
      else if (sideOf(1)) { side = sideOf(1); this.i += 2; }
      else { this.next(); e = { k: 'op', op: '^', a: e, b: this.unaryPowerExp() }; }
    }
    if (this.eat('sym', '+')) side = 1;
    else if (this.isSym('-') && this.isSym('}', 1)) { this.next(); side = -1; }
    if (neg) e = { k: 'neg', a: e };
    return side ? { e, side } : e;
  }

  sumProd(c) {
    const { lo, hi } = this.limits();
    if (!lo || lo.k !== 'rel' || lo.op !== '=' || lo.a.k !== 'var') throw new MathSyntaxError('A la sumatoria le falta desde dónde empieza (k=1)');
    if (!hi) throw new MathSyntaxError('A la sumatoria le falta hasta dónde va (arriba)');
    const body = this.termNoSum();
    return { k: c, a: body, v: lo.a.v, lo: lo.b, hi };
  }

  matrix() {
    const env = this.rawGroup();
    if (!/matrix|array|cases|aligned/.test(env)) throw new MathSyntaxError(`No conozco el bloque ${env}`);
    if (env === 'array') this.rawGroup();
    const rows = [[]];
    for (;;) {
      if (this.isCmd('end')) { this.next(); this.rawGroup(); break; }
      if (this.done()) throw new MathSyntaxError('La matriz está incompleta');
      rows[rows.length - 1].push(this.relation());
      if (this.eat('sym', '&')) continue;
      if (this.eat('cmd', '\\')) { rows.push([]); continue; }
      if (this.isCmd('end')) continue;
      throw new MathSyntaxError('No entendí una celda de la matriz');
    }
    while (rows.length && !rows[rows.length - 1].length) rows.pop();
    if (env === 'cases' || env === 'aligned') return { k: 'list', items: rows.map(r => r[0]), system: true };
    return { k: 'mat', rows };
  }
}

function greekName(c) { return RESERVED[c] || c; }

// ---------- Giac ----------
const isVec = n => n.k === 'mat' && (n.rows.length === 1 || n.rows.every(r => r.length === 1));
const vecItems = n => n.rows.length === 1 ? n.rows[0] : n.rows.map(r => r[0]);

let ctx = { funcs: new Set() };
function emit(n) {
  switch (n.k) {
    case 'num': return n.v.startsWith('.') ? '0' + n.v : n.v;
    case 'var': return n.v;
    case 'empty': return '';
    case 'paren': return '(' + emit(n.a) + ')';
    case 'tuple': return '[' + n.items.map(emit).join(',') + ']';
    case 'list': return n.items.map(emit).join(',');
    case 'neg': return '-(' + emit(n.a) + ')';
    case 'fact': return 'factorial(' + emit(n.a) + ')';
    case 'nabla': throw new MathSyntaxError('Para el gradiente usa el botón Gradiente');
    case 'op': {
      // y(0) o y'(0) en una ecuación diferencial: es evaluar la función, no multiplicar.
      if (n.op === '*' && n.implicit && n.b.k === 'paren' && ((n.a.k === 'var' && ctx.funcs.has(n.a.v)) || n.a.k === 'prime')) return emit(n.a) + '(' + emit(n.b.a) + ')';
      if (n.op === '*' && (n.dot || n.cross) && isVec(n.a) && isVec(n.b)) return (n.cross ? 'cross(' : 'dot(') + emit(n.a) + ',' + emit(n.b) + ')';
      if (n.op === '^') return '(' + emit(n.a) + ')^(' + emit(n.b) + ')';
      return '(' + emit(n.a) + ')' + n.op + '(' + emit(n.b) + ')';
    }
    case 'rel': return emit(n.a) + n.op + emit(n.b);
    case 'call': {
      const args = n.args.map(emit).join(',');
      const c = n.name + '(' + args + ')';
      return n.pow ? '(' + c + ')^(' + emit(n.pow) + ')' : c;
    }
    case 'prime': return n.v + "'".repeat(n.n);
    case 'diff': return `diff(${emit(n.a)},${n.v}${n.n > 1 ? ',' + n.n : ''})`;
    case 'int': {
      let s;
      if (n.lo && n.hi) s = `integrate(${emit(n.a)},${n.v},${emit(n.lo)},${emit(n.hi)})`;
      else if (n.lo || n.hi) throw new MathSyntaxError('A la integral definida le falta un límite (arriba o abajo)');
      else s = `integrate(${emit(n.a)},${n.v})`;
      for (const v of n.more || []) s = `integrate(${s},${v})`;
      return s;
    }
    case 'lim': return `limit(${emit(n.a)},${n.v},${emit(n.to)}${n.side ? ',' + n.side : ''})`;
    case 'sum': return `sum(${emit(n.a)},${n.v},${emit(n.lo)},${emit(n.hi)})`;
    case 'prod': return `product(${emit(n.a)},${n.v},${emit(n.lo)},${emit(n.hi)})`;
    case 'mat': {
      if (isVec(n) && n.rows.length === 1) return '[' + n.rows[0].map(emit).join(',') + ']';
      if (isVec(n)) return '[' + vecItems(n).map(emit).join(',') + ']';
      return '[' + n.rows.map(r => '[' + r.map(emit).join(',') + ']').join(',') + ']';
    }
    default: throw new MathSyntaxError('No entendí una parte de la expresión');
  }
}

// Qué hay en la expresión: ayuda a sugerir botones (Resolver, Derivar, Determinante…).
function scan(n, info) {
  if (!n || typeof n !== 'object') return info;
  if (n.k === 'var' && !n.raw && !['pi', 'e', 'i', 'inf'].includes(n.v)) info.vars.add(n.v);
  if (n.k === 'rel') info.rel = info.rel || n.op;
  if (n.k === 'prime') { info.ode = true; info.func = n.v; }
  if (n.k === 'mat') info.matrix = isVec(n) ? (info.matrix || 'vector') : 'matrix';
  if (['int', 'lim', 'diff', 'sum', 'prod'].includes(n.k) && !info.op) { info.op = n.k; if (n.k === 'int') info.definite = !!(n.lo && n.hi); }
  // Variables ligadas (dx, k de la suma) no cuentan como libres.
  for (const key of ['a', 'b', 'lo', 'hi', 'to', 'pow']) if (n[key]) scan(n[key], info);
  for (const arr of [n.args, n.items]) if (arr) arr.forEach(x => scan(x, info));
  if (n.rows) n.rows.forEach(r => r.forEach(x => scan(x, info)));
  if (n.k === 'int' || n.k === 'lim' || n.k === 'sum' || n.k === 'prod' || n.k === 'diff') info.bound.add(n.v);
  for (const v of n.more || []) info.bound.add(v);
  return info;
}

/**
 * LaTeX → { giac, info } . info: { vars:[...], rel, ode, func, matrix, op, list }
 * Lanza MathSyntaxError con un mensaje en español si algo no se entiende.
 */
export function latexToGiac(latex) {
  const src = String(latex || '').trim();
  if (!src) throw new MathSyntaxError('Escribe algo primero');
  const p = new Parser(tokenize(src));
  const ast = p.program();
  const info = scan(ast, { vars: new Set(), bound: new Set(), rel: null, ode: false, func: null, matrix: null, op: null });
  ctx = { funcs: new Set(info.func ? [info.func] : []) };
  const giac = emit(ast);
  if (info.ode && info.func) info.vars.delete(info.func);
  const free = [...info.vars].filter(v => !info.bound.has(v) || ast.k === 'list');
  return { giac, ast, info: { ...info, vars: free.sort(varOrder), list: ast.k === 'list', count: ast.k === 'list' ? ast.items.length : 1 } };
}

// x, y, z, t primero (en ese orden), luego el resto alfabético.
const PREF = ['x', 'y', 'z', 't', 'u', 'v', 'w', 'n', 'k'];
function varOrder(a, b) {
  const ia = PREF.indexOf(a), ib = PREF.indexOf(b);
  if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  return a < b ? -1 : 1;
}
