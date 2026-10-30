// Pantalla de repaso de tarjetas con repetición espaciada.
import { db } from './db.js';
import { schedule, GRADES, intervalLabel, isDue } from './srs.js';

const $ = s => document.querySelector(s);
const SESSION_MAX = 60;

export function createReview({ toast, onOpenSource, onChanged, confirmDelete, onStudied }) {
  const root = $('#review');
  const front = $('#rv-front'), back = $('#rv-back'), divider = $('#rv-divider');
  const showBtn = $('#rv-show'), grades = $('#rv-grades'), done = $('#rv-done');
  const progress = $('#rv-progress'), barFill = $('#rv-bar-fill'), source = $('#rv-source');

  let queue = [], cur = null, shown = false, stats = null, ctx = null, clock = null;
  const timerEl = $('#rv-timer');
  const fmt = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const shuffle = a => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };

  function sideHtml(el, side, label, emptyText) {
    el.innerHTML = '';
    const l = document.createElement('div');
    l.className = 'rv-label';
    l.textContent = label;
    el.appendChild(l);
    const has = side && (side.img || side.text);
    if (side && side.img) { const im = new Image(); im.src = side.img; im.alt = label; im.className = 'rv-img'; el.appendChild(im); }
    if (side && side.text) { const p = document.createElement('p'); p.className = 'rv-text'; p.textContent = side.text; el.appendChild(p); }
    if (!has) { const p = document.createElement('p'); p.className = 'rv-empty'; p.textContent = emptyText; el.appendChild(p); }
  }

  function renderCard() {
    done.hidden = true;
    $('#rv-stage').hidden = false;
    $('#rv-actions').hidden = false;
    cur = queue.shift();
    if (!cur) return ctx.exam ? finishExam(false) : finish();
    ctx.seen.add(cur.id);
    shown = false;
    sideHtml(front, cur.front, 'Pregunta', 'Sin pregunta');
    sideHtml(back, cur.back, 'Respuesta', 'No escribiste la respuesta. Piénsala, revisa la nota si quieres y califícate.');
    back.hidden = true; divider.hidden = true;
    showBtn.hidden = false; grades.hidden = true;
    const note = ctx.notes.get(cur.noteId);
    source.hidden = !note;
    if (note) source.querySelector('span').textContent = note.title + (cur.ref && cur.ref.page ? `, página ${cur.ref.page}` : '');
    const total = stats.total;
    progress.textContent = `${Math.min(stats.done + 1, total)} de ${total}`;
    barFill.style.width = `${(stats.done / total) * 100}%`;
    showBtn.focus();
  }

  function reveal() {
    if (!cur || shown) return;
    shown = true;
    back.hidden = false; divider.hidden = false;
    showBtn.hidden = true; grades.hidden = false;
    grades.innerHTML = '';
    grades.classList.toggle('two', !!ctx.exam);
    if (ctx.exam) {
      for (const [id, label, hint] of [[0, 'No la sabía', 'Queda para repasar hoy'], [2, 'La sabía', 'Sigue igual']]) {
        const b = document.createElement('button');
        b.className = 'rv-grade g' + id;
        b.innerHTML = '<b></b><small></small>';
        b.querySelector('b').textContent = label;
        b.querySelector('small').textContent = hint;
        b.onclick = () => grade(id);
        grades.appendChild(b);
      }
      grades.querySelector('.g2').focus();
      return;
    }
    for (const g of GRADES) {
      const b = document.createElement('button');
      b.className = 'rv-grade g' + g.id;
      b.innerHTML = `<b></b><small></small>`;
      b.querySelector('b').textContent = g.label;
      b.querySelector('small').textContent = ctx.practice ? g.hint : intervalLabel(cur.srs, g.id);
      b.onclick = () => grade(g.id);
      grades.appendChild(b);
    }
    grades.querySelector('.g2').focus();
  }

  async function grade(g) {
    if (!cur || !shown) return;
    const card = cur;
    if (ctx.exam) {
      (g === 0 ? ctx.exam.wrong : ctx.exam.right).push(card);
      stats.done++;
      renderCard();
      return;
    }
    if (!ctx.practice) {
      card.srs = schedule(card.srs, g);
      await db.put('cards', card);
      onChanged && onChanged();
    }
    if (g === 0) { stats.again++; queue.splice(Math.min(queue.length, 4), 0, card); }
    else stats.done++;
    renderCard();
  }

  function finish() {
    cur = null;
    clearInterval(clock);
    $('#rv-stage').hidden = true;
    $('#rv-actions').hidden = true;
    done.hidden = false;
    barFill.style.width = '100%';
    progress.textContent = '';
    const all = ctx.all;
    const now = Date.now();
    const tomorrow = all.filter(c => !isDue(c.srs, now) && c.srs.due < now + 86400000 * 1.2).length;
    const reviewed = stats.done;
    let html;
    if (!reviewed && !ctx.practice) {
      html = `<h2>Por hoy no tienes tarjetas pendientes</h2><p>${all.length} tarjeta${all.length === 1 ? '' : 's'} en total${tomorrow ? `; mañana te tocan ${tomorrow}` : ''}.</p>
        ${all.length ? '<button class="secondary" id="rv-practice">Repasarlas todas igual</button>' : ''}`;
    } else {
      html = `<h2>¡Listo! Repasaste ${reviewed} tarjeta${reviewed === 1 ? '' : 's'}</h2>
        <p>${stats.again ? `Fallaste ${stats.again} vez${stats.again === 1 ? '' : 'es'}; esas te van a salir más seguido. ` : ''}${ctx.practice ? 'Fue un repaso libre: no cambió cuándo te toca cada tarjeta.' : tomorrow ? `Mañana te tocan ${tomorrow}.` : 'Te avisamos cuando te toque repasar otra vez.'}</p>`;
    }
    done.innerHTML = html + '<button class="primary" id="rv-back-btn">Volver</button>';
    $('#rv-back-btn').onclick = close;
    const pr = $('#rv-practice');
    if (pr) pr.onclick = () => start({ cards: ctx.all, notes: ctx.notes, title: ctx.title, practice: true });
    $('#rv-back-btn').focus();
  }

  // Fin del examen: por respuestas o porque se acabó el tiempo.
  async function finishExam(timeout) {
    clearInterval(clock);
    const ex = ctx.exam;
    const unanswered = [...(cur ? [cur] : []), ...queue];
    cur = null; queue = [];
    const total = ex.right.length + ex.wrong.length + unanswered.length;
    const right = ex.right.length;
    const ms = Math.min(Date.now(), ex.endAt) - ex.startAt;
    const grade = Math.round((5 * right / Math.max(1, total)) * 10) / 10;
    // Lo que no supo (o no alcanzó a responder) queda para repasar hoy.
    const toReview = [...ex.wrong, ...unanswered];
    for (const c of toReview) {
      if (c.srs && c.srs.due > Date.now()) { c.srs = { ...c.srs, due: Date.now() }; await db.put('cards', c); }
    }
    ctx.logged = true;
    onStudied && onStudied({ kind: 'exam', cards: [...ex.right, ...ex.wrong, ...unanswered], ms, score: grade });
    onChanged && onChanged();
    $('#rv-stage').hidden = true;
    $('#rv-actions').hidden = true;
    done.hidden = false;
    timerEl.hidden = true;
    barFill.style.width = '100%';
    progress.textContent = '';
    const g = grade.toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const verdict = grade >= 4.5 ? '¡Excelente!' : grade >= 3 ? 'Aprobado' : 'Te falta repasar';
    done.innerHTML = `<p class="ex-verdict">${verdict}</p>
      <h2 class="ex-grade"><span>${g}</span> / 5,0</h2>
      <p>${right} de ${total} correctas${unanswered.length ? `, ${unanswered.length} sin responder${timeout ? ' porque se acabó el tiempo' : ''}` : ''}. Tiempo: ${fmt(ms)} de ${fmt(ex.limit)}.</p>
      ${toReview.length ? `<p>${toReview.length === 1 ? 'La que no sabías quedó' : `Las ${toReview.length} que no sabías quedaron`} para repasar hoy.</p><div class="ex-list"></div>` : '<p>¡Te las sabías todas!</p>'}
      <div class="mt-done-actions">${toReview.length ? '<button class="secondary" id="ex-review">Repasar las que fallé</button>' : ''}<button class="primary" id="rv-back-btn">Volver</button></div>`;
    const list = done.querySelector('.ex-list');
    for (const c of toReview.slice(0, 12)) {
      const row = document.createElement('div');
      row.className = 'ex-row';
      for (const side of [c.front, c.back]) {
        const cell = document.createElement('div');
        if (side && side.img) { const im = new Image(); im.src = side.img; im.alt = ''; cell.appendChild(im); }
        if (side && side.text) { const sp = document.createElement('span'); sp.textContent = side.text; cell.appendChild(sp); }
        row.appendChild(cell);
      }
      list && list.appendChild(row);
    }
    $('#rv-back-btn').onclick = close;
    const rb = $('#ex-review');
    if (rb) rb.onclick = () => start({ cards: toReview, notes: ctx.notes, title: ctx.title, practice: true });
    $('#rv-back-btn').focus();
  }

  function close() {
    clearInterval(clock);
    timerEl.hidden = true;
    if (ctx && !ctx.logged && ctx.seen.size) {
      ctx.logged = true;
      onStudied && onStudied({ kind: 'review', cards: ctx.all.filter(c => ctx.seen.has(c.id)), ms: Date.now() - ctx.startAt });
    }
    root.hidden = true;
    cur = null;
    onChanged && onChanged();
  }

  /** cards: todas las tarjetas del grupo; notes: Map id → nota; title: nombre del grupo */
  function start({ cards, notes, title, practice = false, exam = null }) {
    const now = Date.now();
    clearInterval(clock);
    timerEl.hidden = true;
    if (exam) {
      queue = shuffle(cards).slice(0, exam.count || cards.length);
      ctx = { all: cards, notes, title, practice: false, seen: new Set(), startAt: now,
        exam: { right: [], wrong: [], startAt: now, limit: exam.minutes * 60000, endAt: now + exam.minutes * 60000 } };
      stats = { done: 0, again: 0, total: Math.max(1, queue.length) };
      $('#rv-subject').textContent = `${title}: examen`;
      timerEl.hidden = false;
      const upd = () => {
        const left = ctx.exam.endAt - Date.now();
        timerEl.textContent = fmt(left);
        timerEl.classList.toggle('urgent', left < 60000);
        if (left <= 0 && done.hidden && !root.hidden) { clearInterval(clock); finishExam(true); }
      };
      upd();
      clock = setInterval(upd, 250);
      root.hidden = false;
      renderCard();
      return;
    }
    const due = practice ? cards.slice() : cards.filter(c => isDue(c.srs, now));
    // Primero las vencidas (más antiguas primero), luego las nuevas; un poco de mezcla para no memorizar el orden.
    due.sort((a, b) => ((a.srs.reps ? 0 : 1) - (b.srs.reps ? 0 : 1)) || (a.srs.due - b.srs.due) || (Math.random() - 0.5));
    if (practice) due.sort(() => Math.random() - 0.5);
    queue = due.slice(0, SESSION_MAX);
    ctx = { all: cards, notes, title, practice, seen: new Set(), startAt: now };
    stats = { done: 0, again: 0, total: Math.max(1, queue.length) };
    $('#rv-subject').textContent = practice ? `${title}: repaso libre` : title;
    root.hidden = false;
    renderCard();
  }

  showBtn.onclick = reveal;
  $('#rv-card').addEventListener('click', e => { if (!shown && !e.target.closest('button')) reveal(); });
  $('#rv-close').onclick = close;
  source.onclick = () => { const c = cur; if (!c) return; close(); onOpenSource(c); };
  $('#rv-more').onclick = async () => {
    if (!cur) return;
    if (!await confirmDelete()) return;
    await db.del('cards', cur.id);
    ctx.all = ctx.all.filter(c => c.id !== cur.id);
    queue = queue.filter(c => c.id !== cur.id);
    stats.total = Math.max(1, stats.total - 1);
    toast('Tarjeta eliminada');
    onChanged && onChanged();
    renderCard();
  };
  document.addEventListener('keydown', e => {
    if (root.hidden || document.querySelector('#dlg').open) return;
    if (e.key === ' ' || e.key === 'Enter') { if (!shown && cur) { e.preventDefault(); reveal(); } }
    else if (shown && ctx.exam && ['1', '2'].includes(e.key)) grade(e.key === '1' ? 0 : 2);
    else if (shown && !ctx.exam && ['1', '2', '3', '4'].includes(e.key)) grade(+e.key - 1);
    else if (e.key === 'Escape') close();
  });

  return {
    start,
    get isOpen() { return !root.hidden; },
    close,
  };
}
