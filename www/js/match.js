// Juego de unir parejas: definiciones a la izquierda, nombres a la derecha; se unen con una línea.
const $ = s => document.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';

const shuffle = a => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const fmt = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function bestKey(scope) { return 'np-match-best:' + scope; }
function getBest(scope) { try { return +localStorage.getItem(bestKey(scope)) || 0; } catch { return 0; } }
function setBest(scope, ms) { try { localStorage.setItem(bestKey(scope), String(ms)); } catch {} }

export function createMatch({ onClose, onStudied }) {
  const root = $('#match');
  const board = $('#mt-board'), colL = $('#mt-left'), colR = $('#mt-right'), svg = $('#mt-lines');
  const timerEl = $('#mt-timer'), countEl = $('#mt-count'), errEl = $('#mt-errors'), done = $('#mt-done');

  let deck = [], rounds = [], roundIdx = 0, pairs = [];
  let matched = new Set(), picked = null, drag = null;
  let t0 = 0, tick = null, errors = 0, missed = new Map(), scope = '', title = '';

  const perRound = () => (window.innerWidth < 700 ? 4 : 6);

  function itemEl(side, card) {
    const el = document.createElement('button');
    el.className = 'mt-item';
    el.dataset.id = card.id;
    el.dataset.side = side;
    const c = side === 'L' ? card.back : card.front;
    if (c.img) { const im = new Image(); im.src = c.img; im.alt = side === 'L' ? 'Definición escrita a mano' : 'Nombre escrito a mano'; el.appendChild(im); }
    if (c.text) { const p = document.createElement('span'); p.textContent = c.text; el.appendChild(p); }
    return el;
  }

  function anchor(el) {
    // Punto de la línea: borde derecho de las definiciones, borde izquierdo de los nombres.
    const r = el.getBoundingClientRect();
    return rel(el.dataset.side === 'L' ? r.right : r.left, r.top + r.height / 2);
  }

  // Coordenadas dentro del tablero, contando lo que se haya desplazado.
  function rel(cx, cy) {
    const b = board.getBoundingClientRect();
    return { x: cx - b.left + board.scrollLeft, y: cy - b.top + board.scrollTop };
  }

  function line(a, b, cls) {
    const l = document.createElementNS(SVGNS, 'line');
    l.setAttribute('x1', a.x); l.setAttribute('y1', a.y);
    l.setAttribute('x2', b.x); l.setAttribute('y2', b.y);
    l.setAttribute('class', cls);
    svg.appendChild(l);
    return l;
  }

  function redrawLines() {
    svg.setAttribute('width', board.scrollWidth); svg.setAttribute('height', board.scrollHeight);
    svg.querySelectorAll('line.ok').forEach(l => l.remove());
    for (const id of matched) {
      const a = colL.querySelector(`[data-id="${id}"]`), b = colR.querySelector(`[data-id="${id}"]`);
      if (a && b) line(anchor(a), anchor(b), 'ok');
    }
  }

  function updateHud() {
    countEl.textContent = `${matched.size} de ${pairs.length}` + (rounds.length > 1 ? `, ronda ${roundIdx + 1} de ${rounds.length}` : '');
    errEl.textContent = errors ? `${errors} error${errors === 1 ? '' : 'es'}` : '';
  }

  function startRound() {
    pairs = rounds[roundIdx];
    matched = new Set(); picked = null;
    colL.innerHTML = '<div class="mt-colhead">Definición</div>';
    colR.innerHTML = '<div class="mt-colhead">Nombre</div>';
    svg.innerHTML = '';
    for (const c of shuffle(pairs)) colL.appendChild(itemEl('L', c));
    for (const c of shuffle(pairs)) colR.appendChild(itemEl('R', c));
    done.hidden = true; board.hidden = false; $('#mt-help').hidden = false;
    updateHud();
    // Las imágenes cambian la altura: las líneas se recalculan cuando cargan.
    board.querySelectorAll('img').forEach(im => im.addEventListener('load', redrawLines, { once: true }));
    requestAnimationFrame(redrawLines);
  }

  function setPicked(el) {
    if (picked) picked.classList.remove('picked');
    picked = el;
    if (el) el.classList.add('picked');
  }

  function attempt(a, b) {
    if (!a || !b || a.dataset.side === b.dataset.side) return;
    const L = a.dataset.side === 'L' ? a : b, R = L === a ? b : a;
    const pa = anchor(L), pb = anchor(R);
    if (L.dataset.id === R.dataset.id) {
      matched.add(L.dataset.id);
      L.classList.add('ok'); R.classList.add('ok');
      L.disabled = true; R.disabled = true;
      line(pa, pb, 'ok');
      if (navigator.vibrate) navigator.vibrate(15);
      updateHud();
      if (matched.size === pairs.length) setTimeout(nextRound, 550);
    } else {
      errors++;
      missed.set(L.dataset.id, (missed.get(L.dataset.id) || 0) + 1);
      const l = line(pa, pb, 'bad');
      [L, R].forEach(el => {
        el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
        el.addEventListener('animationend', () => el.classList.remove('shake'), { once: true });
      });
      setTimeout(() => l.remove(), 650);
      updateHud();
    }
  }

  function nextRound() {
    if (roundIdx + 1 < rounds.length) { roundIdx++; startRound(); return; }
    finish();
  }

  let logged = false;
  function log() {
    if (logged) return;
    logged = true;
    onStudied && onStudied({ kind: 'match', cards: deck, ms: Date.now() - t0 });
  }

  function finish() {
    clearInterval(tick);
    const ms = Date.now() - t0;
    log();
    const best = getBest(scope);
    const record = !errors && (!best || ms < best);
    if (record) setBest(scope, ms);
    board.hidden = true;
    $('#mt-help').hidden = true;
    countEl.textContent = '';
    timerEl.textContent = fmt(ms);
    done.hidden = false;
    const wrong = deck.filter(c => missed.has(c.id));
    done.innerHTML = `<h2>${errors ? '¡Terminaste!' : '¡Perfecto, sin errores!'}</h2>
      <p class="mt-stats"><b>${fmt(ms)}</b> de tiempo, <b>${errors}</b> error${errors === 1 ? '' : 'es'}, ${deck.length} parejas.${record ? ' ¡Nuevo récord!' : best ? ` Tu récord sin errores: ${fmt(best)}.` : ''}</p>
      ${wrong.length ? `<p class="mt-sub">Estas te costaron; repásalas:</p><div class="mt-wrong"></div>` : ''}
      <div class="mt-done-actions"><button class="secondary" id="mt-again">Jugar otra vez</button><button class="primary" id="mt-exit">Volver</button></div>`;
    const box = done.querySelector('.mt-wrong');
    for (const c of wrong) {
      const row = document.createElement('div');
      row.className = 'mt-pair';
      row.append(itemEl('L', c), itemEl('R', c));
      row.querySelectorAll('button').forEach(b => { b.disabled = true; });
      box.appendChild(row);
    }
    $('#mt-again').onclick = () => start({ cards: deck, scope, title });
    $('#mt-exit').onclick = close;
    $('#mt-exit').focus();
  }

  function close() {
    clearInterval(tick);
    if (!root.hidden) log();
    root.hidden = true;
    onClose && onClose();
  }

  /** cards: tarjetas con pregunta y respuesta; scope: clave para el récord; title: lo que se muestra arriba */
  function start({ cards, scope: sc, title: t }) {
    deck = shuffle(cards);
    scope = sc; title = t;
    const n = perRound();
    rounds = [];
    for (let i = 0; i < deck.length; i += n) rounds.push(deck.slice(i, i + n));
    // Que la última ronda no quede con una sola pareja.
    if (rounds.length > 1 && rounds[rounds.length - 1].length < 3) {
      const last = rounds.pop();
      rounds[rounds.length - 1].push(...last);
    }
    roundIdx = 0; errors = 0; missed = new Map(); logged = false;
    $('#mt-title').textContent = t;
    root.hidden = false;
    t0 = Date.now();
    clearInterval(tick);
    timerEl.textContent = '0:00';
    tick = setInterval(() => { timerEl.textContent = fmt(Date.now() - t0); }, 500);
    startRound();
  }

  // Unir: arrastrar de una tarjeta a otra, o tocar una y luego la otra.
  board.addEventListener('pointerdown', e => {
    const el = e.target.closest('.mt-item');
    if (!el || el.disabled) return;
    e.preventDefault();
    drag = { el, id: e.pointerId, moved: false, from: anchor(el), tmp: null };
    try { board.setPointerCapture(e.pointerId); } catch {}
  });
  board.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const p = rel(e.clientX, e.clientY);
    if (!drag.moved && Math.hypot(p.x - drag.from.x, p.y - drag.from.y) < 12 && !drag.tmp) {
      const r = drag.el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
    }
    drag.moved = true;
    if (!drag.tmp) { drag.tmp = line(drag.from, p, 'tmp'); drag.el.classList.add('picked'); }
    drag.tmp.setAttribute('x2', p.x); drag.tmp.setAttribute('y2', p.y);
  });
  const endDrag = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (d.tmp) d.tmp.remove();
    d.el.classList.remove('picked');
    if (d.moved) {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const el = target && target.closest('.mt-item');
      if (el && !el.disabled && el !== d.el) attempt(d.el, el);
      if (picked) setPicked(null);
      return;
    }
    // Toque: primera selección o intento con la que ya estaba elegida.
    if (picked && picked !== d.el && picked.dataset.side !== d.el.dataset.side) { const a = picked; setPicked(null); attempt(a, d.el); }
    else setPicked(picked === d.el ? null : d.el);
  };
  board.addEventListener('pointerup', endDrag);
  board.addEventListener('pointercancel', e => { if (drag && drag.tmp) drag.tmp.remove(); if (drag) drag.el.classList.remove('picked'); drag = null; });
  window.addEventListener('resize', () => { if (!root.hidden && !board.hidden) redrawLines(); });
  board.addEventListener('scroll', redrawLines);
  $('#mt-close').onclick = close;

  return { start, get isOpen() { return !root.hidden; }, close };
}
