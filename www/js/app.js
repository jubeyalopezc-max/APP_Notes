import { db, uid, persist } from './db.js';
import { createEditor, PAPERS } from './editor.js';
import { exportPdf, safeFileName } from './export.js';
import { PAGE_H, PAGE_GAP } from './render.js';
import { shareFile, saveToDevice, isNative, DEVICE_FOLDER } from './files.js';
import { createReview } from './review.js';
import { createMatch } from './match.js';
import { createPomodoro } from './pomodoro.js';
import { statsHtml, fmtMin } from './stats.js';
import { TYPES, REMINDERS, isoDay, daysUntil, countdown, longDate, shortDate, eventTitle, studyPlan, scheduleReminders, cancelReminders, monthHtml } from './calendar.js';
import { newSrs, isDue } from './srs.js';
import { updaterPlugin, fetchNewer, updateState, saveUpdateState } from './updater.js';
import { buildBackup, audioSize, backupFileName, backupInfo, markManualBackup, autoBackup, setAutoBackup, readBackup, restoreBackup } from './backup.js';

const $ = s => document.querySelector(s);
const SUBJECT_COLORS = ['#2D55E0', '#12968A', '#D9442F', '#E7A21A', '#7A4BD6', '#1E9E5A', '#D23D86', '#46566F'];

const MARK_COLORS = ['#D9442F', '#2D55E0', '#1E9E5A', '#E7A21A', '#7A4BD6'];

const state = { subjects: [], notes: [], trash: [], cards: [], events: [], current: 'all', query: '', view: 'notes' };

// ---------- Apariencia ----------
const themeMq = window.matchMedia('(prefers-color-scheme: dark)');
let theme = { mode: 'auto', darkSheets: true };
let editorRef = null;
try { theme = { ...theme, ...JSON.parse(localStorage.getItem('np-theme') || '{}') }; } catch {}
const isDarkTheme = () => theme.mode === 'dark' || (theme.mode === 'auto' && themeMq.matches);
// El PDF sale como se ve en pantalla (hojas oscuras si las estás usando), salvo que se pida siempre claro.
const pdfDark = () => isDarkTheme() && theme.darkSheets && !theme.pdfLight;
function applyTheme() {
  const root = document.documentElement;
  if (theme.mode === 'auto') delete root.dataset.theme; else root.dataset.theme = theme.mode;
  if (editorRef && editorRef.isOpen) editorRef.refresh();
}
applyTheme();
themeMq.addEventListener('change', applyTheme);

// ---------- Avisos ----------
let toastTimer;
function toast(msg, { sticky = false, long = false } = {}) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => t.classList.remove('show'), long ? 5200 : 2600);
}

let busy = false;
async function withBusy(fn) {
  if (busy) { toast('Espera a que termine lo que se está guardando.'); return; }
  busy = true;
  try { return await fn(); }
  finally { busy = false; }
}

// ---------- Diálogos ----------
const dlg = $('#dlg');
const form = $('#dlg-form');
let dlgResolve = null;

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function dialog(html, { onOpen, wide } = {}) {
  form.innerHTML = html;
  dlg.classList.toggle('wide', !!wide);
  dlg.showModal();
  if (onOpen) onOpen(form);
  const first = form.querySelector('input[type=text]');
  if (first) setTimeout(() => { first.focus(); first.select(); }, 50);
  return new Promise(resolve => { dlgResolve = resolve; });
}
dlg.addEventListener('close', () => {
  const r = dlgResolve; dlgResolve = null;
  if (!r) return;
  if (dlg.returnValue === 'ok') r(Object.fromEntries(new FormData(form)));
  else r(dlg.returnValue && dlg.returnValue !== 'cancel' ? { ...Object.fromEntries(new FormData(form)), action: dlg.returnValue } : null);
});
form.addEventListener('keydown', e => {
  // Enter en un campo de texto confirma (no cancela).
  if (e.key === 'Enter' && e.target.matches('input[type=text]')) {
    e.preventDefault();
    if (form.reportValidity()) dlg.close('ok');
  }
});

const buttons = (ok, danger) => `
  <div class="dlg-actions">
    <button value="cancel" formnovalidate class="ghost">Cancelar</button>
    <button value="ok" class="${danger ? 'danger-fill' : 'primary'}">${ok}</button>
  </div>`;

function colorPicker(selected, colors = SUBJECT_COLORS) {
  return `<div class="color-pick" role="radiogroup" aria-label="Color">${colors.map(c =>
    `<label style="--c:${c}"><input type="radio" name="color" value="${c}" ${c === selected ? 'checked' : ''}><span></span></label>`).join('')}</div>`;
}

async function confirmDialog(title, text, ok) {
  const r = await dialog(`<h2>${esc(title)}</h2><p class="dlg-text">${esc(text)}</p>${buttons(ok, true)}`);
  return !!r;
}

async function menu(title, options) {
  const r = await dialog(`<h2>${esc(title)}</h2><div class="menu-list">${options.map(o =>
    `<button value="${o.value}" class="${o.danger ? 'danger' : ''}">${esc(o.label)}</button>`).join('')}</div>
    <div class="dlg-actions"><button value="cancel" class="ghost">Cerrar</button></div>`);
  return r && r.action;
}

async function askMark({ isNew, title, color, snap }) {
  const r = await dialog(`<h2>${isNew ? 'Nuevo marcador' : 'Marcador'}</h2>
    ${snap ? `<img class="mark-snap" src="${snap}" alt="Lo que marcaste">` : ''}
    <label class="field">Nombre${snap ? ' (opcional)' : ''}<input type="text" name="title" maxlength="80" value="${esc(title || '')}" placeholder="${snap ? 'Se mostrará lo que escribiste' : 'Tema 2: límites'}"></label>
    <div class="field">Color${colorPicker(color || MARK_COLORS[0], MARK_COLORS)}</div>
    ${isNew ? '' : '<div class="menu-list"><button value="del" class="danger">Eliminar marcador</button></div>'}
    ${buttons(isNew ? 'Agregar al índice' : 'Guardar')}`);
  if (!r) return null;
  if (r.action) return r;
  return { title: (r.title || '').trim() || (snap ? '' : 'Marcador'), color: r.color || MARK_COLORS[0] };
}

// ---------- Datos ----------
const TRASH_DAYS = 30;

async function purgeNote(n, cards = state.cards) {
  await db.del('notes', n.id);
  await db.del('contents', n.id);
  for (const a of await db.byIndex('audio', 'noteId', n.id)) await db.del('audio', a.id);
  for (const c of cards.filter(c => c.noteId === n.id)) await db.del('cards', c.id);
}
async function load() {
  const [subjects, notes, cards] = await Promise.all([db.all('subjects'), db.all('notes'), db.all('cards')]);
  state.subjects = subjects.sort((a, b) => a.createdAt - b.createdAt);
  // Las notas en la papelera llevan deletedAt; se borran del todo a los 30 días.
  const now = Date.now();
  const expired = notes.filter(n => n.deletedAt && now - n.deletedAt > TRASH_DAYS * 86400000);
  for (const n of expired) await purgeNote(n, cards);
  const gone = new Set(expired.map(n => n.id));
  state.notes = notes.filter(n => !n.deletedAt);
  state.trash = notes.filter(n => n.deletedAt && !gone.has(n.id));
  state.cards = cards.filter(c => !gone.has(c.noteId));
  state.events = await db.all('events');
}

// ---------- Inicio ----------
function renderRail() {
  const list = $('#subject-list');
  list.innerHTML = '';
  for (const s of state.subjects) {
    const n = state.notes.filter(x => x.subjectId === s.id).length;
    const b = document.createElement('button');
    b.className = 'spine';
    b.dataset.subject = s.id;
    b.style.setProperty('--c', s.color);
    b.innerHTML = `<span class="spine-name">${esc(s.name)}</span><span class="count">${n}</span>`;
    list.appendChild(b);
  }
  const loose = state.notes.filter(x => !x.subjectId || !state.subjects.some(s => s.id === x.subjectId)).length;
  if (loose) {
    const b = document.createElement('button');
    b.className = 'spine loose';
    b.dataset.subject = 'none';
    b.innerHTML = `<span class="spine-name">Sin materia</span><span class="count">${loose}</span>`;
    list.appendChild(b);
  }
  $('#count-all').textContent = state.notes.length || '';
  const tb = $('#trash-btn');
  tb.hidden = !state.trash.length;
  $('#trash-count').textContent = state.trash.length || '';
  tb.setAttribute('aria-current', String(state.current === 'trash'));
  document.querySelectorAll('.spine').forEach(b => b.setAttribute('aria-current', String(b.dataset.subject === state.current)));
}

function currentSubject() { return state.subjects.find(s => s.id === state.current); }

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'Ahora';
  if (m < 60) return `Hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `Hace ${h} h`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? 'Ayer' : `Hace ${d} días`;
  return new Date(t).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
}

function renderNotes() {
  if (state.current === 'trash') { renderTrash(); return; }
  $('#notes').classList.remove('as-index');
  document.querySelector('.lib-tools').hidden = false;
  const sub = currentSubject();
  $('#lib-title').textContent = state.current === 'all' ? 'Todas las notas' : state.current === 'none' ? 'Sin materia' : sub ? sub.name : '';
  $('#subject-menu').hidden = !sub;
  document.documentElement.style.setProperty('--subject', sub ? sub.color : 'var(--accent)');

  let list = state.notes.slice();
  if (state.current === 'none') list = list.filter(n => !n.subjectId || !state.subjects.some(s => s.id === n.subjectId));
  else if (state.current !== 'all') list = list.filter(n => n.subjectId === state.current);
  const q = state.query.trim().toLowerCase();
  document.querySelectorAll('.seg [data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  const box0 = $('#notes');
  box0.classList.toggle('as-index', state.view === 'index');
  if (state.view === 'index') { renderIndexView(list, q); return; }
  const inOutline = n => (n.outline || []).some(e => (e.title || '').toLowerCase().includes(q))
    || (n.pdfText && n.pdfText.toLowerCase().includes(q));
  if (q) list = list.filter(n => n.title.toLowerCase().includes(q) || inOutline(n));
  list.sort((a, b) => b.updatedAt - a.updatedAt);

  const box = $('#notes');
  box.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    if (q) empty.innerHTML = `<p>Ninguna nota se llama “${esc(state.query)}”.</p>`;
    else if (!state.subjects.length && !state.notes.length) empty.innerHTML = `<p class="big">Empieza creando tus materias.</p><p>Cada materia guarda sus notas aparte, como un cuaderno.</p><button class="primary" id="empty-subject">Crear la primera materia</button>`;
    else empty.innerHTML = `<p class="big">Aquí no hay notas todavía.</p><button class="primary" id="empty-note">Crear una nota</button>`;
    box.appendChild(empty);
    empty.querySelector('#empty-subject')?.addEventListener('click', newSubject);
    empty.querySelector('#empty-note')?.addEventListener('click', newNote);
    return;
  }
  for (const n of list) {
    const s = state.subjects.find(x => x.id === n.subjectId);
    const card = document.createElement('article');
    card.className = 'note-card';
    card.style.setProperty('--c', s ? s.color : '#9AA6B8');
    card.innerHTML = `
      <button class="thumb" aria-label="Abrir ${esc(n.title)}">${n.thumb ? `<img src="${n.thumb}" alt="">` : ''}</button>
      <div class="note-meta">
        <div class="note-text">
          <h3>${esc(n.title)}</h3>
          <p>${state.current === 'all' && s ? `<span class="tag">${esc(s.name)}</span>` : ''}${ago(n.updatedAt)}</p>
        </div>
        <button class="icon-btn small" aria-label="Opciones de ${esc(n.title)}"><svg><use href="#i-dots"/></svg></button>
      </div>`;
    card.querySelector('.thumb').onclick = () => openNote(n);
    card.querySelector('.icon-btn').onclick = () => noteMenu(n);
    box.appendChild(card);
  }
}

// Índice de la materia: cada nota en orden de clase, con sus títulos y marcadores.
function renderIndexView(list, q) {
  const box = $('#notes');
  box.innerHTML = '';
  list = list.slice().sort((a, b) => a.createdAt - b.createdAt);
  let shown = 0;
  for (const n of list) {
    const entries = n.outline || [];
    const titleMatch = !q || n.title.toLowerCase().includes(q);
    const vis = titleMatch ? entries : entries.filter(e => (e.title || '').toLowerCase().includes(q));
    if (!titleMatch && !vis.length) continue;
    shown++;
    const s = state.subjects.find(x => x.id === n.subjectId);
    const sec = document.createElement('section');
    sec.className = 'ixn';
    sec.style.setProperty('--c', s ? s.color : '#9AA6B8');
    const head = document.createElement('button');
    head.className = 'ixn-head';
    head.innerHTML = `<span class="ixn-title">${esc(n.title)}</span><span class="ixn-date">${state.current === 'all' && s ? esc(s.name) + ', ' : ''}${new Date(n.createdAt).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })}</span>`;
    head.onclick = () => openNote(n);
    sec.appendChild(head);
    if (!vis.length) {
      const p = document.createElement('p');
      p.className = 'ixn-none';
      p.textContent = 'Sin títulos ni marcadores';
      sec.appendChild(p);
    }
    for (const e of vis) {
      const b = document.createElement('button');
      b.className = 'ixn-row ' + e.kind;
      if (e.kind === 'mark') b.style.setProperty('--m', e.color);
      const main = document.createElement('span');
      main.className = 'ixn-main';
      if (e.kind === 'mark') main.insertAdjacentHTML('beforeend', '<span class="ix-flag"></span>');
      if (e.title || !e.snap) { const t = document.createElement('span'); t.className = 'ixn-text'; t.textContent = e.title || 'Marcador'; main.appendChild(t); }
      if (e.snap) { const im = new Image(); im.src = e.snap; im.alt = e.title ? '' : 'Título escrito a mano'; im.className = 'ix-snap'; main.appendChild(im); }
      b.appendChild(main);
      if (e.page) { const pg = document.createElement('span'); pg.className = 'ixn-page'; pg.textContent = `Pág. ${e.page}`; b.appendChild(pg); }
      b.onclick = () => openNote(n, { x: e.x, y: e.y, id: e.id });
      sec.appendChild(b);
    }
    box.appendChild(sec);
  }
  if (!shown) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = q ? `<p>Nada en el índice coincide con “${esc(state.query)}”.</p>`
      : `<p class="big">El índice se arma solo.</p><p>Los títulos que escribas con teclado y los marcadores de tus notas aparecen aquí, nota por nota.</p>`;
    box.appendChild(empty);
  }
}

function render() { renderRail(); renderNotes(); renderBanner(); renderReviewBtn(); renderUpcoming(); }

async function newSubject() {
  const r = await dialog(`<h2>Nueva materia</h2>
    <label class="field">Nombre<input type="text" name="name" required maxlength="40" placeholder="Cálculo diferencial"></label>
    <div class="field">Color${colorPicker(SUBJECT_COLORS[state.subjects.length % SUBJECT_COLORS.length])}</div>
    ${buttons('Crear materia')}`);
  if (!r || !r.name.trim()) return;
  const s = { id: uid(), name: r.name.trim(), color: r.color || SUBJECT_COLORS[0], createdAt: Date.now() };
  await db.put('subjects', s);
  state.subjects.push(s);
  state.current = s.id;
  render();
}

async function subjectMenu() {
  const s = currentSubject();
  if (!s) return;
  const act = await menu(s.name, [
    { value: 'pdf', label: 'Exportar la materia a PDF' },
    { value: 'edit', label: 'Cambiar nombre o color' },
    { value: 'del', label: 'Eliminar materia', danger: true },
  ]);
  if (act === 'pdf') exportSubjectPdf(s);
  else if (act === 'edit') {
    const r = await dialog(`<h2>Editar materia</h2>
      <label class="field">Nombre<input type="text" name="name" required maxlength="40" value="${esc(s.name)}"></label>
      <div class="field">Color${colorPicker(s.color)}</div>${buttons('Guardar')}`);
    if (!r || !r.name.trim()) return;
    s.name = r.name.trim(); s.color = r.color || s.color;
    await db.put('subjects', s);
    render();
  } else if (act === 'del') {
    const n = state.notes.filter(x => x.subjectId === s.id).length;
    const ok = await confirmDialog(`¿Eliminar “${s.name}”?`,
      n ? `Sus ${n} nota${n === 1 ? '' : 's'} no se borran: pasan a “Sin materia”.` : 'La materia está vacía.', 'Eliminar materia');
    if (!ok) return;
    await db.del('subjects', s.id);
    state.subjects = state.subjects.filter(x => x.id !== s.id);
    state.current = 'all';
    render();
  }
}

async function newNote() {
  const sub = currentSubject();
  const subjectOptions = `<option value="">Sin materia</option>` + state.subjects.map(s =>
    `<option value="${s.id}" ${sub && sub.id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const r = await dialog(`<h2>Nueva nota</h2>
    <label class="field">Título<input type="text" name="title" maxlength="80" placeholder="Clase del ${new Date().toLocaleDateString('es-CO', { day: 'numeric', month: 'long' })}"></label>
    <label class="field">Materia<select name="subjectId">${subjectOptions}</select></label>
    <div class="field">Formato<div class="layout-pick">
      <label><input type="radio" name="layout" value="pages" checked><b>Hojas</b><small>Páginas una debajo de otra, como un cuaderno</small></label>
      <label><input type="radio" name="layout" value="canvas"><b>Lienzo libre</b><small>Sin bordes: escribe hacia cualquier lado</small></label>
    </div></div>
    <div class="field">Fondo<div class="paper-pick">${Object.entries(PAPERS).map(([k, v], i) =>
      `<label><input type="radio" name="paper" value="${k}" ${i === 0 ? 'checked' : ''}><span class="paper-swatch ${k}"></span>${v}</label>`).join('')}</div></div>
    ${buttons('Crear nota')}`);
  if (!r) return;
  const title = r.title.trim() || `Clase del ${new Date().toLocaleDateString('es-CO', { day: 'numeric', month: 'long' })}`;
  const n = { id: uid(), title, subjectId: r.subjectId || null, paper: r.paper || 'lines', layout: r.layout || 'pages', createdAt: Date.now(), updatedAt: Date.now(), thumb: null };
  await db.put('notes', n);
  await db.put('contents', { id: n.id, items: [], pages: 1 });
  state.notes.push(n);
  render();
  openNote(n);
}

async function noteMenu(n) {
  const act = await menu(n.title, [
    { value: 'pdf', label: 'Exportar a PDF' },
    { value: 'rename', label: 'Cambiar título' },
    { value: 'move', label: 'Mover a otra materia' },
    { value: 'del', label: 'Eliminar nota', danger: true },
  ]);
  if (act === 'pdf') exportNotesPdf([n]);
  else if (act === 'rename') renameNote(n);
  else if (act === 'move') {
    const r = await dialog(`<h2>Mover nota</h2>
      <label class="field">Materia<select name="subjectId"><option value="">Sin materia</option>${state.subjects.map(s =>
        `<option value="${s.id}" ${n.subjectId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>${buttons('Mover')}`);
    if (!r) return;
    n.subjectId = r.subjectId || null;
    await db.put('notes', n);
    render();
  } else if (act === 'del') {
    n.deletedAt = Date.now();
    await db.put('notes', n);
    state.notes = state.notes.filter(x => x.id !== n.id);
    state.trash.push(n);
    render();
    toast(`“${n.title}” está en la papelera. La puedes recuperar durante ${TRASH_DAYS} días.`, { long: true });
  }
}

async function renameNote(n) {
  const r = await dialog(`<h2>Título de la nota</h2>
    <label class="field">Título<input type="text" name="title" required maxlength="80" value="${esc(n.title)}"></label>${buttons('Guardar')}`);
  if (!r || !r.title.trim()) return;
  n.title = r.title.trim();
  await db.put('notes', n);
  $('#ed-title').textContent = n.title;
  render();
}

// ---------- Editor ----------
let openMeta = null;
const editor = createEditor({
  toast,
  confirmAsk: () => confirmDialog('¿Eliminar esta grabación?', 'Se borra el audio. Lo que escribiste en la nota no cambia.', 'Eliminar grabación'),
  isDarkPaper: () => isDarkTheme() && theme.darkSheets,
  askMark,
  onCapture: captureForCard,
  onSave: async (meta, content, thumb, outline) => {
    meta.updatedAt = Date.now();
    meta.thumb = thumb;
    // El índice de la materia usa los títulos y marcadores (sin imágenes, para no duplicar datos).
    meta.outline = (outline || []).filter(e => e.kind !== 'image');
    await db.put('contents', { id: meta.id, ...content });
    await db.put('notes', meta);
  },
});
editorRef = editor;


async function openNote(n, focus) {
  const content = await db.get('contents', n.id);
  openMeta = n;
  $('#home').hidden = true;
  $('#editor').hidden = false;
  $('#ed-title').textContent = n.title;
  const s = state.subjects.find(x => x.id === n.subjectId);
  document.documentElement.style.setProperty('--subject', s ? s.color : 'var(--accent)');
  editor.open(n, content, focus);
}

async function closeEditor() {
  cardDraft = null;
  editor.setCaptureHint(null);
  await editor.close();
  openMeta = null;
  $('#editor').hidden = true;
  $('#home').hidden = false;
  render();
}

async function editorMore() {
  const act = await dialog(`<h2>Opciones de la nota</h2>
    <div class="field">Fondo<div class="paper-pick">${Object.entries(PAPERS).map(([k, v]) =>
      `<label><input type="radio" name="paper" value="${k}" ${editor.paper === k ? 'checked' : ''}><span class="paper-swatch ${k}"></span>${v}</label>`).join('')}</div></div>
    <div class="menu-list"><button value="all">Ver toda la nota</button>${editor.layout === 'pages' ? '<button value="page">Agregar página al final</button>' : ''}<button value="rename">Cambiar título</button><button value="pdf">Exportar a PDF</button><button value="addpdf">Agregar páginas de un PDF</button><button value="write">Escribir tarjetas (nombre y definición)</button><button value="pomo">Pomodoro</button>${window.innerWidth < 760 ? `<button value="finger">${editor.fingerDraws ? 'El dedo dibuja: cambiar a mover la página' : 'El dedo mueve la página: cambiar a dibujar'}</button>` : ''}${state.cards.some(c => c.noteId === openMeta.id) ? '<button value="review">Repasar las tarjetas de esta nota</button><button value="match">Unir parejas con esta nota</button>' : ''}</div>
    <div class="dlg-actions"><button value="cancel" class="ghost">Cerrar</button><button value="ok" class="primary">Aplicar fondo</button></div>`);
  if (!act) return;
  if (act.action === 'pdf') { await editor.save(); exportNotesPdf([openMeta]); }
  else if (act.action === 'addpdf') pickPdf('append');
  else if (act.action === 'review') { await editor.save(); startReview(state.cards.filter(c => c.noteId === openMeta.id), openMeta.title); }
  else if (act.action === 'match') { await editor.save(); startMatch(state.cards.filter(c => c.noteId === openMeta.id), openMeta.title, 'note:' + openMeta.id); }
  else if (act.action === 'write') writeCards();
  else if (act.action === 'pomo') pomodoroDialog(openMeta.subjectId);
  else if (act.action === 'finger') editor.toggleFinger();
  else if (act.action === 'all') editor.showAll();
  else if (act.action === 'page') editor.addPage();
  else if (act.action === 'rename') renameNote(openMeta);
  else if (act.paper && act.paper !== editor.paper) editor.setPaper(act.paper);
}

// ---------- PDF ----------
async function deliver(blob, filename, what) {
  const saved = await saveToDevice(blob, filename);
  toast(saved ? `${what} guardado en ${DEVICE_FOLDER}. Elige dónde enviarlo.` : `${what} listo.`, { long: true });
  await shareFile(blob, filename);
}

async function makePdf(list, opts) {
  const content = await Promise.all(list.map(m => db.get('contents', m.id)));
  return exportPdf(list.map((meta, i) => ({ meta, content: content[i] })), {
    ...opts,
    dark: pdfDark(),
    onProgress: (d, t) => toast(t > 1 ? `Creando el PDF: página ${d} de ${t}` : 'Creando el PDF…', { sticky: true }),
  });
}

function exportNotesPdf(list) {
  return withBusy(async () => {
    try {
      toast('Creando el PDF…', { sticky: true });
      const blob = await makePdf(list, { title: list[0].title });
      await deliver(blob, safeFileName(list[0].title) + '.pdf', 'PDF');
    } catch (e) {
      console.error(e);
      toast('No se pudo crear el PDF. Inténtalo de nuevo.', { long: true });
    }
  });
}

function exportSubjectPdf(s) {
  const list = state.notes.filter(n => n.subjectId === s.id).sort((a, b) => a.createdAt - b.createdAt);
  if (!list.length) { toast('Esta materia todavía no tiene notas.'); return; }
  return withBusy(async () => {
    try {
      toast('Creando el PDF…', { sticky: true });
      const blob = await makePdf(list, { title: s.name, subject: s });
      await deliver(blob, safeFileName(s.name) + '.pdf', 'PDF');
    } catch (e) {
      console.error(e);
      toast('No se pudo crear el PDF. Inténtalo de nuevo.', { long: true });
    }
  });
}

// ---------- Importar PDF ----------
let pdfMode = 'new';
function pickPdf(mode) {
  pdfMode = mode;
  const i = $('#pdf-input');
  i.value = '';
  i.click();
}

async function loadPdf(file) {
  toast('Abriendo el PDF…', { sticky: true });
  const { openPdf } = await import('./pdfimport.js');
  const doc = await openPdf(file);
  $('#toast').classList.remove('show');
  return doc;
}

async function convertPdf(doc, startPage) {
  const { pdfToItems } = await import('./pdfimport.js');
  return pdfToItems(doc, {
    startPage,
    onProgress: (d, t) => toast(`Importando el PDF: página ${d} de ${t}`, { sticky: true }),
  });
}

$('#pdf-input').addEventListener('change', e => handlePdfFile(e.target.files && e.target.files[0], pdfMode));

async function handlePdfFile(file, mode) {
  if (!file) return;
  if (mode === 'append' && editor.isOpen) {
    await withBusy(async () => {
      try {
        const start = editor.isEmpty ? 0 : editor.pageCount;
        const r = await convertPdf(await loadPdf(file), start);
        editor.appendPdf(r.items, r.pageCount, editor.isEmpty);
        openMeta.pdfText = ((openMeta.pdfText || '') + '\n' + r.text).slice(0, 400000);
        toast(`Se agregaron ${r.pageCount} página${r.pageCount === 1 ? '' : 's'} del PDF.${r.truncated ? ' (Solo las primeras 300.)' : ''}`, { long: true });
      } catch (err) {
        console.error(err);
        toast(err.message || 'No se pudo importar el PDF.', { long: true });
      }
    });
    return;
  }
  let doc;
  try { doc = await loadPdf(file); }
  catch (err) { toast(err.message || 'No se pudo abrir el PDF.', { long: true }); return; }
  const sub = currentSubject();
  const guess = file.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim().slice(0, 80);
  const r = await dialog(`<h2>Importar PDF</h2>
    <p class="dlg-text">${doc.numPages} página${doc.numPages === 1 ? '' : 's'}${doc.numPages > 300 ? ' (se importan las primeras 300)' : ''}. Cada página del PDF queda como una hoja de la nota para escribir encima. Las diapositivas horizontales quedan arriba y abajo te queda espacio para apuntes.</p>
    <label class="field">Título<input type="text" name="title" maxlength="80" value="${esc(guess)}"></label>
    <label class="field">Materia<select name="subjectId"><option value="">Sin materia</option>${state.subjects.map(s =>
      `<option value="${s.id}" ${sub && sub.id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    <div class="field">Fondo del espacio libre<div class="paper-pick">${Object.entries(PAPERS).map(([k, v]) =>
      `<label><input type="radio" name="paper" value="${k}" ${k === 'lines' ? 'checked' : ''}><span class="paper-swatch ${k}"></span>${v}</label>`).join('')}</div></div>
    ${buttons('Importar')}`);
  if (!r) { doc.destroy(); return; }
  await withBusy(async () => {
    try {
      const res = await convertPdf(doc, 0);
      const n = {
        id: uid(), title: (r.title || '').trim() || guess || 'PDF importado', subjectId: r.subjectId || null,
        paper: r.paper || 'lines', layout: 'pages', createdAt: Date.now(), updatedAt: Date.now(),
        thumb: res.thumb, pdfText: res.text,
        outline: res.items.filter(i => i.title).map(i => ({ kind: 'pdf', id: i.id, title: i.title, x: i.x, y: i.y, page: Math.floor(i.y / (PAGE_H + PAGE_GAP)) + 1 })),
      };
      await db.put('contents', { id: n.id, items: res.items, pages: res.pageCount });
      await db.put('notes', n);
      state.notes.push(n);
      render();
      toast(`PDF importado: ${res.pageCount} página${res.pageCount === 1 ? '' : 's'}.${res.truncated ? ' (Solo las primeras 300.)' : ''}`, { long: true });
      openNote(n);
    } catch (err) {
      console.error(err);
      toast(err.message || 'No se pudo importar el PDF.', { long: true });
    }
  });
}

// ---------- Tarjetas de estudio ----------
let cardDraft = null;

async function captureForCard({ img, ref }) {
  if (!openMeta) return;
  if (cardDraft) {
    // Segunda captura: completa la tarjeta.
    const d = cardDraft;
    cardDraft = null;
    editor.setCaptureHint(null);
    const card = d.side === 'front'
      ? { front: { img: d.img }, back: { img }, ref: d.ref }
      : { front: { img }, back: { img: d.img }, ref };
    await saveCard(card);
    return;
  }
  const r = await dialog(`<h2>Nueva tarjeta</h2>
    <img class="card-capture" src="${img}" alt="Lo que marcaste">
    <div class="field">Lo que marcaste es la…<div class="seg seg-form" role="radiogroup">
      <label><input type="radio" name="side" value="front" checked>Pregunta</label>
      <label><input type="radio" name="side" value="back">Respuesta</label>
    </div></div>
    <label class="field"><span id="other-label">Respuesta (opcional)</span><textarea name="text" maxlength="600" placeholder="Escríbela aquí, o márcala en la nota"></textarea></label>
    <button value="other" class="link-btn" id="other-btn">Marcar la respuesta en la nota</button>
    <div class="dlg-actions">
      <button value="cancel" class="ghost">Cancelar</button>
      <button value="ok" class="primary">Guardar tarjeta</button>
    </div>`, {
    onOpen: f => {
      const upd = () => {
        const front = f.querySelector('input[name=side]:checked').value === 'front';
        f.querySelector('#other-label').textContent = front ? 'Respuesta (opcional)' : 'Pregunta';
        f.querySelector('#other-btn').textContent = front ? 'Marcar la respuesta en la nota' : 'Marcar la pregunta en la nota';
        f.querySelector('textarea').placeholder = front ? 'Escríbela aquí, o márcala en la nota' : 'Escribe la pregunta, o márcala en la nota';
      };
      f.querySelectorAll('input[name=side]').forEach(i => i.onchange = upd);
    },
  });
  if (!r) return;
  const side = r.side || 'front';
  const text = (r.text || '').trim();
  if (r.action === 'other' || (side === 'back' && !text)) {
    cardDraft = { side, img, ref };
    editor.setCaptureHint(side === 'front' ? 'Ahora arrastra un rectángulo sobre la respuesta' : 'Ahora arrastra un rectángulo sobre la pregunta',
      () => { cardDraft = null; toast('Tarjeta descartada'); });
    return;
  }
  const other = text ? { text } : {};
  await saveCard(side === 'front' ? { front: { img }, back: other, ref } : { front: other, back: { img }, ref });
}

async function saveCard(c) {
  const card = { id: uid(), noteId: openMeta.id, front: c.front, back: c.back, ref: c.ref, createdAt: Date.now(), srs: newSrs() };
  await db.put('cards', card);
  state.cards.push(card);
  const n = state.cards.filter(x => x.noteId === openMeta.id).length;
  toast(`Tarjeta creada. Esta nota tiene ${n} tarjeta${n === 1 ? '' : 's'}.`);
}

// Tarjetas del grupo que se ve en el inicio (materia actual, sin materia o todas).
function cardsForView() {
  const noteIds = new Set(state.notes.filter(n =>
    state.current === 'all' ? true
      : state.current === 'none' ? (!n.subjectId || !state.subjects.some(s => s.id === n.subjectId))
        : n.subjectId === state.current).map(n => n.id));
  return state.cards.filter(c => noteIds.has(c.noteId));
}

function renderReviewBtn() {
  const cards = cardsForView();
  const b = $('#review-btn');
  b.hidden = !cards.length;
  const due = cards.filter(c => isDue(c.srs)).length;
  $('#review-count').textContent = due ? String(due) : '';
  b.title = due ? `${due} tarjeta${due === 1 ? '' : 's'} para repasar hoy` : 'No tienes tarjetas pendientes hoy';
}

function startReview(cards, title) {
  review.start({ cards, notes: new Map(state.notes.map(n => [n.id, n])), title });
}

// ---------- Tiempo de estudio ----------
let currentExamScope = null;
let pomoRef = null;
// Guarda una sesión de estudio. Mientras corre un Pomodoro, repasar o jugar ya cuenta dentro de él.
async function logStudy({ kind, cards = [], ms, score, subjectId, start }) {
  if (!ms || ms < 60000) return;
  if (kind !== 'pomodoro' && pomoRef && pomoRef.running) return;
  let sid = subjectId;
  if (sid === undefined) {
    const count = new Map();
    for (const c of cards) {
      const n = state.notes.find(x => x.id === c.noteId);
      const k = n && n.subjectId ? n.subjectId : null;
      count.set(k, (count.get(k) || 0) + 1);
    }
    sid = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }
  if (kind === 'exam' && score !== undefined && currentExamScope) {
    lastExams = [{ scope: currentExamScope, score, at: Date.now() }, ...lastExams.filter(x => x.scope !== currentExamScope)].slice(0, 50);
    try { localStorage.setItem('np-exams', JSON.stringify(lastExams)); } catch {}
  }
  await db.put('sessions', { id: uid(), kind, subjectId: sid, start: start || Date.now() - ms, ms, ...(score !== undefined ? { score } : {}) });
}

const review = createReview({
  toast,
  onStudied: logStudy,
  onChanged: () => { if (!$('#home').hidden) renderReviewBtn(); },
  onOpenSource: card => {
    const n = state.notes.find(x => x.id === card.noteId);
    if (n) openNote(n, card.ref ? { ...card.ref } : null);
  },
  confirmDelete: () => confirmDialog('¿Eliminar esta tarjeta?', 'Se borra solo la tarjeta; la nota queda igual.', 'Eliminar tarjeta'),
});

const isComplete = c => !!(c.front && (c.front.img || c.front.text) && c.back && (c.back.img || c.back.text));

const match = createMatch({ onClose: () => { if (!$('#home').hidden) renderReviewBtn(); }, onStudied: logStudy });

function startMatch(cards, title, scope) {
  const ok = cards.filter(isComplete);
  if (ok.length < 2) {
    toast('Para unir parejas necesitas al menos 2 tarjetas con nombre y definición. Escríbelas desde una nota: menú ⋯, Escribir tarjetas.', { long: true });
    return;
  }
  $('#toast').classList.remove('show');
  match.start({ cards: ok, scope, title });
}

// Elegir cómo estudiar (repasar o unir parejas) y de qué tema.
async function studyChooser() {
  const cards = cardsForView();
  const sub = currentSubject();
  const group = state.current === 'all' ? 'Todas las materias' : state.current === 'none' ? 'Sin materia' : sub ? sub.name : '';
  const notesWith = state.notes.filter(n => cards.some(c => c.noteId === n.id)).sort((a, b) => a.createdAt - b.createdAt);
  const r = await dialog(`<h2>Estudiar tarjetas</h2>
    <label class="field">Tema<select name="scope">
      <option value="">${esc(group)}: todo (${cards.length})</option>
      ${notesWith.map(n => `<option value="${n.id}">${esc(n.title)} (${cards.filter(c => c.noteId === n.id).length})</option>`).join('')}
    </select></label>
    <div class="menu-list">
      <button value="review"><span>Repasar tarjetas</span><small id="ch-review"></small></button>
      <button value="match"><span>Unir parejas</span><small id="ch-match"></small></button>
      <button value="exam"><span>Modo examen</span><small id="ch-exam"></small></button>
    </div>
    <div class="dlg-actions"><button value="cancel" class="ghost">Cerrar</button></div>`, {
    onOpen: f => {
      const sel = f.querySelector('select');
      const upd = () => {
        const list = sel.value ? cards.filter(c => c.noteId === sel.value) : cards;
        const due = list.filter(c => isDue(c.srs)).length;
        const pairs = list.filter(isComplete).length;
        f.querySelector('#ch-review').textContent = due ? `Te tocan ${due} hoy. Ves la pregunta, piensas la respuesta y te calificas.` : 'Hoy no te toca ninguna; puedes hacer un repaso libre.';
        const ex = lastExams.find(x => (sel.value ? x.scope === 'note:' + sel.value : x.scope === 'view:' + state.current));
        f.querySelector('#ch-exam').textContent = `Simulacro con tiempo límite y nota de 0 a 5.${ex ? ` Tu último: ${ex.score.toLocaleString('es-CO', { minimumFractionDigits: 1 })}.` : ''}`;
        f.querySelector('#ch-match').textContent = pairs >= 2 ? `${pairs} parejas. Une cada definición con su nombre, contra el reloj.` : 'Necesitas al menos 2 tarjetas con nombre y definición.';
      };
      sel.onchange = upd;
      upd();
    },
  });
  if (!r || !r.action) return;
  const list = r.scope ? cards.filter(c => c.noteId === r.scope) : cards;
  const note = r.scope && state.notes.find(n => n.id === r.scope);
  const title = note ? note.title : group;
  if (r.action === 'review') startReview(list, title);
  else if (r.action === 'exam') examDialog(list, title, r.scope ? 'note:' + r.scope : 'view:' + state.current);
  else if (r.action === 'match') startMatch(list, title, r.scope ? 'note:' + r.scope : 'view:' + state.current);
}
$('#review-btn').onclick = studyChooser;

// Últimas notas de examen por tema (se muestran al elegir).
let lastExams = [];
try { lastExams = JSON.parse(localStorage.getItem('np-exams') || '[]'); } catch {}

async function examDialog(list, title, scope) {
  const usable = list.filter(c => c.front && (c.front.img || c.front.text));
  if (!usable.length) { toast('Este tema todavía no tiene tarjetas.'); return; }
  const n = usable.length;
  const counts = [10, 20].filter(x => x < n).concat([n]);
  const r = await dialog(`<h2>Modo examen</h2>
    <p class="dlg-text">${esc(title)}: ves cada pregunta, la respondes de memoria y dices si la sabías. Cuando se acaba el tiempo, lo que falte cuenta como no respondido.</p>
    <div class="field">Tiempo<div class="seg seg-form" role="radiogroup">${[5, 10, 15, 20, 30].map(m =>
      `<label><input type="radio" name="min" value="${m}" ${m === 10 ? 'checked' : ''}>${m} min</label>`).join('')}</div></div>
    <div class="field">Preguntas<div class="seg seg-form" role="radiogroup">${counts.map((c, i) =>
      `<label><input type="radio" name="count" value="${c}" ${i === counts.length - 1 && c <= 20 || c === 20 ? 'checked' : ''}>${c === n && counts.length > 1 ? `Todas (${n})` : c}</label>`).join('')}</div></div>
    ${buttons('Empezar el examen')}`);
  if (!r) return;
  $('#toast').classList.remove('show');
  currentExamScope = scope;
  review.start({
    cards: usable, notes: new Map(state.notes.map(x => [x.id, x])), title,
    exam: { minutes: +r.min || 10, count: +r.count || n, scope },
  });
}

// Tarjetas escritas: nombre (o término) y definición.
async function writeCards() {
  let n = 0;
  const row = () => { const i = n++; return `<div class="write-row"><input type="text" name="t${i}" maxlength="120" placeholder="Ej.: Enlace iónico" aria-label="Nombre ${i + 1}"><input type="text" name="d${i}" maxlength="400" placeholder="Ej.: Un átomo cede electrones y otro los recibe" aria-label="Definición ${i + 1}"></div>`; };
  const r = await dialog(`<h2>Escribir tarjetas</h2>
    <p class="dlg-text">Cada fila es una tarjeta. Sirven para repasar y para el juego de unir parejas.</p>
    <div class="write-head"><span>Nombre o término</span><span>Definición</span></div>
    <div class="write-rows">${row()}${row()}${row()}${row()}</div>
    <button type="button" class="link-btn" id="add-row">Agregar otra fila</button>
    ${buttons('Guardar tarjetas')}`, {
    wide: true,
    onOpen: f => {
      const rows = f.querySelector('.write-rows');
      const add = () => { rows.insertAdjacentHTML('beforeend', row()); const last = rows.lastElementChild.querySelector('input'); last.focus(); last.scrollIntoView({ block: 'nearest' }); };
      f.querySelector('#add-row').onclick = add;
      // Enter pasa al siguiente campo (y agrega una fila al final) en vez de guardar.
      rows.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault(); e.stopPropagation();
        const all = [...rows.querySelectorAll('input')];
        const i = all.indexOf(e.target);
        if (i === all.length - 1) add(); else all[i + 1].focus();
      });
    },
  });
  if (!r) return;
  let made = 0;
  for (let i = 0; i < 500; i++) {
    if (!(('t' + i) in r)) break;
    const t = (r['t' + i] || '').trim(), d = (r['d' + i] || '').trim();
    if (!t || !d) continue;
    const card = { id: uid(), noteId: openMeta.id, front: { text: t }, back: { text: d }, ref: null, createdAt: Date.now(), srs: newSrs() };
    await db.put('cards', card);
    state.cards.push(card);
    made++;
  }
  const total = state.cards.filter(c => c.noteId === openMeta.id).length;
  toast(made ? `Se crearon ${made} tarjeta${made === 1 ? '' : 's'}. Esta nota tiene ${total}.` : 'No se creó ninguna: llena el nombre y la definición en la misma fila.', { long: true });
}


// ---------- Pomodoro ----------
const pomo = createPomodoro({
  toast,
  getSubject: id => state.subjects.find(s => s.id === id),
  onFocusLogged: ({ subjectId, ms, start }) => logStudy({ kind: 'pomodoro', subjectId, ms, start }),
});
pomoRef = pomo;

async function pomodoroDialog(defaultSubject) {
  const st = pomo.state;
  if (!pomo.active) {
    const pre = defaultSubject !== undefined ? defaultSubject : (currentSubject() ? currentSubject().id : st.subjectId);
    const r = await dialog(`<h2>Pomodoro</h2>
      <p class="dlg-text">Estudia concentrado un rato y luego descansa. Cada 4 pomodoros toca un descanso largo de 15 minutos. Te avisamos aunque tengas la pantalla apagada.</p>
      <label class="field">Materia<select name="subjectId"><option value="">Sin materia</option>${state.subjects.map(s =>
        `<option value="${s.id}" ${s.id === pre ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <div class="field">Enfoque<div class="seg seg-form" role="radiogroup">${[25, 45, 50].map(m =>
        `<label><input type="radio" name="focus" value="${m}" ${m === (st.focusMin || 25) ? 'checked' : ''}>${m} min</label>`).join('')}</div></div>
      <div class="field">Descanso<div class="seg seg-form" role="radiogroup">${[5, 10].map(m =>
        `<label><input type="radio" name="brk" value="${m}" ${m === (st.breakMin || 5) ? 'checked' : ''}>${m} min</label>`).join('')}</div></div>
      <div class="dlg-actions"><button value="stats" class="ghost">Tiempo de estudio</button><button value="cancel" class="ghost">Cerrar</button><button value="ok" class="primary">Empezar</button></div>`);
    if (!r) return;
    if (r.action === 'stats') { statsDialog(); return; }
    pomo.start({ subjectId: r.subjectId || null, focusMin: +r.focus || 25, breakMin: +r.brk || 5 });
    toast('¡A estudiar! Te aviso cuando sea hora de descansar.');
    return;
  }
  const sub = state.subjects.find(s => s.id === st.subjectId);
  const titles = { focus: 'Enfoque', break: 'Descanso', paused: 'En pausa', waiting: 'Descanso terminado' };
  const inFocus = st.phase === 'focus' || (st.phase === 'paused' && st.paused && st.paused.phase === 'focus');
  let live = null;
  const r = await dialog(`<h2>${titles[st.phase] || 'Pomodoro'}</h2>
    <div class="pomo-big" id="pomo-big">${st.phase === 'waiting' ? '0:00' : pomo.fmt(pomo.remaining())}</div>
    <p class="pomo-sub">${sub ? esc(sub.name) + '. ' : ''}${st.cycle ? `Llevas ${st.cycle} pomodoro${st.cycle === 1 ? '' : 's'}.` : 'Primer pomodoro.'}</p>
    <div class="menu-list">
      ${st.phase === 'waiting' ? '<button value="next">Empezar otro pomodoro</button>'
        : st.phase === 'paused' ? '<button value="resume">Reanudar</button>' : '<button value="pause">Pausar</button>'}
      ${st.phase !== 'waiting' ? `<button value="skip">${inFocus ? 'Pasar al descanso' : 'Saltar el descanso'}</button>` : ''}
      <button value="stop" class="danger">Terminar</button>
    </div>
    <div class="dlg-actions"><button value="stats" class="ghost">Tiempo de estudio</button><button value="cancel" class="ghost">Cerrar</button></div>`, {
    onOpen: f => { live = setInterval(() => { const el = f.querySelector('#pomo-big'); if (el && pomo.state.phase !== 'waiting') el.textContent = pomo.fmt(pomo.remaining()); }, 500); },
  });
  clearInterval(live);
  if (!r || !r.action) return;
  if (r.action === 'pause') pomo.pause();
  else if (r.action === 'resume') pomo.resume();
  else if (r.action === 'next') pomo.next();
  else if (r.action === 'skip') pomo.skip();
  else if (r.action === 'stop') { pomo.stop(); toast('Pomodoro terminado. El tiempo quedó guardado.'); }
  else if (r.action === 'stats') statsDialog();
}

async function statsDialog() {
  const sessions = await db.all('sessions');
  let offset = 0;
  await dialog(`<h2>Tiempo de estudio</h2><div id="st-body"></div>
    <div class="dlg-actions"><button value="ok" class="primary">Listo</button></div>`, {
    wide: true,
    onOpen: f => {
      const body = f.querySelector('#st-body');
      const draw = () => { body.innerHTML = statsHtml({ sessions, subjects: state.subjects, offset }); };
      body.addEventListener('click', e => {
        const b = e.target.closest('[data-week]');
        if (!b || b.disabled) return;
        e.preventDefault();
        offset = Math.min(0, offset + +b.dataset.week);
        draw();
      });
      draw();
    },
  });
}

$('#pomo-btn').onclick = () => pomodoroDialog();
$('#pomo-main').onclick = () => pomodoroDialog();
$('#stats-btn').onclick = statsDialog;


// ---------- Calendario ----------
const subjOf = id => state.subjects.find(s => s.id === id);
const colorOfEvent = ev => (subjOf(ev.subjectId) || {}).color || '#9AA6B8';
const evName = ev => eventTitle(ev, subjOf(ev.subjectId));
const evTopics = ev => (ev.noteIds || []).filter(id => state.notes.some(n => n.id === id));
const evDone = ev => (ev.doneTopics || []).filter(id => evTopics(ev).includes(id));

function eventsForView() {
  if (state.current === 'all') return state.events;
  if (state.current === 'none') return state.events.filter(e => !subjOf(e.subjectId));
  return state.events.filter(e => e.subjectId === state.current);
}

// Avisos en el inicio: lo que viene en las próximas 3 semanas.
function renderUpcoming() {
  const box = $('#up-events');
  const soon = eventsForView().filter(e => { const d = daysUntil(e.date); return d >= 0 && d <= 21; })
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '')).slice(0, 3);
  box.hidden = !soon.length;
  box.innerHTML = '';
  for (const ev of soon) {
    const b = document.createElement('button');
    b.className = 'up-chip';
    b.style.setProperty('--c', colorOfEvent(ev));
    const d = daysUntil(ev.date);
    b.innerHTML = '<span></span><b></b>';
    b.querySelector('span').textContent = evName(ev);
    b.querySelector('b').textContent = countdown(ev.date);
    if (d > 3) b.querySelector('b').style.color = 'var(--muted)';
    b.onclick = () => eventDetail(ev);
    box.appendChild(b);
  }
  const week = state.events.filter(e => { const d = daysUntil(e.date); return d >= 0 && d <= 7; }).length;
  $('#cal-count').textContent = week ? String(week) : '';
}

const cal = { year: 0, month: 0, selected: null };

function openCalendar() {
  const d = new Date();
  cal.year = d.getFullYear(); cal.month = d.getMonth(); cal.selected = null;
  $('#calendar').hidden = false;
  renderCalendar();
}
function closeCalendar() { $('#calendar').hidden = true; render(); }

function evCard(ev) {
  const b = document.createElement('button');
  const d = daysUntil(ev.date);
  b.className = 'ev-card' + (d < 0 ? ' past' : '');
  b.style.setProperty('--c', colorOfEvent(ev));
  const topics = evTopics(ev), done = evDone(ev);
  const sub = subjOf(ev.subjectId);
  b.innerHTML = `<span class="ev-top"><span class="ev-title"></span><span class="ev-cd ${d >= 0 && d <= 3 ? 'soon' : ''}"></span></span>
    <span class="ev-meta"></span>
    ${topics.length ? `<span class="ev-prog"><span><i style="width:${Math.round(done.length / topics.length * 100)}%"></i></span><span>${done.length} de ${topics.length} tema${topics.length === 1 ? '' : 's'} repasado${topics.length === 1 ? '' : 's'}</span></span>` : ''}`;
  b.querySelector('.ev-title').textContent = evName(ev);
  b.querySelector('.ev-cd').textContent = countdown(ev.date);
  b.querySelector('.ev-meta').textContent = `${longDate(ev.date, ev.time)}${sub && ev.title ? ' · ' + sub.name : ''}`;
  b.onclick = () => eventDetail(ev);
  return b;
}

function renderCalendar() {
  const monthEvents = state.events;
  $('#cal-month').innerHTML = monthHtml(cal.year, cal.month, monthEvents, colorOfEvent, cal.selected);
  const list = $('#cal-list');
  list.innerHTML = '';
  const h = t => { const e = document.createElement('h3'); e.className = 'cal-h'; e.textContent = t; list.appendChild(e); };
  const sorted = state.events.slice().sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
  if (cal.selected) {
    h(longDate(cal.selected).replace(/^./, c => c.toUpperCase()));
    const day = sorted.filter(e => e.date === cal.selected);
    if (!day.length) { const p = document.createElement('p'); p.className = 'cal-empty'; p.textContent = 'No tienes nada este día.'; list.appendChild(p); }
    day.forEach(e => list.appendChild(evCard(e)));
    const add = document.createElement('button');
    add.className = 'secondary';
    add.innerHTML = '<svg><use href="#i-plus"/></svg>Agregar algo este día';
    add.onclick = () => eventDialog(null, cal.selected);
    list.appendChild(add);
    return;
  }
  const up = sorted.filter(e => daysUntil(e.date) >= 0);
  const week = up.filter(e => daysUntil(e.date) <= 7), later = up.filter(e => daysUntil(e.date) > 7);
  const past = sorted.filter(e => daysUntil(e.date) < 0).reverse().slice(0, 5);
  if (!state.events.length) {
    list.innerHTML = `<div class="empty"><p class="big">Anota tus parciales y entregas.</p><p>Te muestro cuántos días faltan, te armo un plan de repaso con los temas que entran y te aviso antes.</p></div>`;
    const b = document.createElement('button'); b.className = 'primary'; b.textContent = 'Agregar el primero';
    b.onclick = () => eventDialog(null); list.querySelector('.empty').appendChild(b);
    return;
  }
  if (week.length) { h('Esta semana'); week.forEach(e => list.appendChild(evCard(e))); }
  if (later.length) { h('Más adelante'); later.forEach(e => list.appendChild(evCard(e))); }
  if (!up.length) { h('Próximos'); const p = document.createElement('p'); p.className = 'cal-empty'; p.textContent = 'No tienes nada pendiente.'; list.appendChild(p); }
  if (past.length) { h('Ya pasaron'); past.forEach(e => list.appendChild(evCard(e))); }
}

$('#cal-month').addEventListener('click', e => {
  const m = e.target.closest('[data-month]');
  if (m) {
    cal.month += +m.dataset.month;
    if (cal.month < 0) { cal.month = 11; cal.year--; } else if (cal.month > 11) { cal.month = 0; cal.year++; }
    cal.selected = null;
    renderCalendar();
    return;
  }
  const d = e.target.closest('[data-day]');
  if (d) { cal.selected = cal.selected === d.dataset.day ? null : d.dataset.day; renderCalendar(); }
});
$('#cal-btn').onclick = openCalendar;
$('#cal-close').onclick = closeCalendar;
$('#cal-new').onclick = () => eventDialog(null, cal.selected);

function topicPicker(subjectId, checked) {
  const notes = state.notes.filter(n => (subjectId ? n.subjectId === subjectId : !n.subjectId || !subjOf(n.subjectId)))
    .sort((a, b) => a.createdAt - b.createdAt);
  if (!notes.length) return '<p class="cal-empty">Esta materia todavía no tiene notas.</p>';
  return notes.map(n => `<label class="topic"><input type="checkbox" name="topic" value="${n.id}" ${checked.includes(n.id) ? 'checked' : ''}><span>${esc(n.title)}</span><small>${state.cards.filter(c => c.noteId === n.id).length || ''}</small></label>`).join('');
}

async function eventDialog(ev, presetDate) {
  const isNew = !ev;
  const e = ev || { type: 'parcial', subjectId: state.current !== 'all' && state.current !== 'none' ? state.current : (state.subjects[0] || {}).id || '', date: presetDate || isoDay(Date.now() + 7 * 86400000), time: '', title: '', noteIds: [], remind: '1,3' };
  const r = await dialog(`<h2>${isNew ? 'Nuevo evento' : 'Editar evento'}</h2>
    <div class="field">Qué es<div class="seg seg-form wrap" role="radiogroup">${Object.entries(TYPES).map(([k, v]) =>
      `<label><input type="radio" name="type" value="${k}" ${e.type === k ? 'checked' : ''}>${v}</label>`).join('')}</div></div>
    <label class="field">Materia<select name="subjectId"><option value="">Sin materia</option>${state.subjects.map(s =>
      `<option value="${s.id}" ${s.id === e.subjectId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    <label class="field">Nombre (opcional)<input type="text" name="title" maxlength="80" value="${esc(e.title || '')}" placeholder="Ej.: Parcial 2, Taller de derivadas"></label>
    <div class="row2">
      <label class="field">Fecha<input type="date" name="date" required value="${e.date}"></label>
      <label class="field">Hora<input type="time" name="time" value="${e.time || ''}"></label>
    </div>
    <div class="field">Temas que entran<div class="pick-topics" id="pick-topics">${topicPicker(e.subjectId, e.noteIds || [])}</div></div>
    <label class="field">Recordarme<select name="remind">${Object.entries(REMINDERS).map(([k, v]) =>
      `<option value="${k}" ${k === (e.remind ?? '1,3') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    ${buttons(isNew ? 'Guardar' : 'Guardar cambios')}`, {
    wide: true,
    onOpen: f => {
      const sel = f.querySelector('select[name=subjectId]');
      sel.onchange = () => { f.querySelector('#pick-topics').innerHTML = topicPicker(sel.value, []); };
    },
  });
  if (!r) return;
  if (!r.date) { toast('Elige la fecha.'); return; }
  const topics = [...$('#dlg-form').querySelectorAll('input[name=topic]:checked')].map(i => i.value);
  const saved = {
    ...(ev || { id: uid(), createdAt: Date.now(), doneTopics: [] }),
    type: r.type || 'parcial', subjectId: r.subjectId || null, title: (r.title || '').trim(),
    date: r.date, time: r.time || '', noteIds: topics, remind: r.remind ?? '1,3',
  };
  saved.doneTopics = (saved.doneTopics || []).filter(id => topics.includes(id));
  await db.put('events', saved);
  state.events = state.events.filter(x => x.id !== saved.id).concat(saved);
  scheduleReminders(saved, evName(saved));
  toast(isNew ? (daysUntil(saved.date) < 0 ? `${evName(saved)} agregado.` : `${evName(saved)} agregado: ${countdown(saved.date)}.`) : 'Cambios guardados.');
  if (!$('#calendar').hidden) renderCalendar(); else render();
}

async function eventDetail(ev) {
  const topics = evTopics(ev);
  const pending = topics.filter(id => !evDone(ev).includes(id));
  const title = n => (state.notes.find(x => x.id === n) || {}).title || '';
  const plan = studyPlan(ev, pending);
  const d = daysUntil(ev.date);
  const cardsOf = ids => state.cards.filter(c => (ids.length ? ids.includes(c.noteId) : state.notes.some(n => n.id === c.noteId && n.subjectId === ev.subjectId)));
  const nCards = cardsOf(topics).length;
  const r = await dialog(`<h2>${esc(evName(ev))}</h2>
    <p class="ev-when">${esc(longDate(ev.date, ev.time).replace(/^./, c => c.toUpperCase()))}. <b>${countdown(ev.date).replace(/^./, c => c.toUpperCase())}</b>.</p>
    ${topics.length ? `<div class="ev-section">Temas<span id="ev-count">${evDone(ev).length} de ${topics.length} repasado${topics.length === 1 ? '' : 's'}</span></div>
      <div class="topic-list">${topics.map(id => `<label class="topic"><input type="checkbox" data-topic="${id}" ${evDone(ev).includes(id) ? 'checked' : ''}><span>${esc(title(id))}</span><small>${(k => (k ? `${k} tarjeta${k === 1 ? '' : 's'}` : ''))(state.cards.filter(c => c.noteId === id).length)}</small></label>`).join('')}</div>` : '<p class="cal-empty">No elegiste temas. Edita el evento para agregar las notas que entran y te armo un plan.</p>'}
    ${d >= 0 && topics.length ? `<div class="ev-section">Plan de repaso</div><div class="plan" id="ev-plan">${planHtml(plan, title)}</div>` : ''}
    <div class="menu-list" style="margin-top:14px">
      ${nCards ? `<button value="review">Repasar las tarjetas de estos temas (${nCards})</button><button value="exam">Hacer un examen de práctica</button>` : ''}
      <button value="edit">Editar</button>
      <button value="del" class="danger">Eliminar</button>
    </div>
    <div class="dlg-actions"><button value="cancel" class="ghost">Cerrar</button></div>`, {
    wide: true,
    onOpen: f => {
      f.querySelectorAll('[data-topic]').forEach(cb => cb.onchange = async () => {
        const set = new Set(ev.doneTopics || []);
        cb.checked ? set.add(cb.dataset.topic) : set.delete(cb.dataset.topic);
        ev.doneTopics = [...set];
        await db.put('events', ev);
        f.querySelector('#ev-count').textContent = `${evDone(ev).length} de ${topics.length} repasado${topics.length === 1 ? '' : 's'}`;
        const pl = f.querySelector('#ev-plan');
        if (pl) pl.innerHTML = planHtml(studyPlan(ev, topics.filter(id => !evDone(ev).includes(id))), title);
        if (!$('#calendar').hidden) renderCalendar();
      });
    },
  });
  if (!$('#calendar').hidden) renderCalendar(); else renderUpcoming();
  if (!r || !r.action) return;
  if (r.action === 'edit') eventDialog(ev);
  else if (r.action === 'del') {
    if (!await confirmDialog(`¿Eliminar “${evName(ev)}”?`, 'Se borra del calendario junto con sus recordatorios. Tus notas no cambian.', 'Eliminar')) return;
    await db.del('events', ev.id);
    cancelReminders(ev);
    state.events = state.events.filter(x => x.id !== ev.id);
    if (!$('#calendar').hidden) renderCalendar(); else render();
  } else if (r.action === 'review') startReview(cardsOf(topics), evName(ev));
  else if (r.action === 'exam') examDialog(cardsOf(topics), evName(ev), 'event:' + ev.id);
}

function planHtml(plan, title) {
  if (!plan.length) return '';
  const all = plan.every(p => !p.topics.length && p.simulacro);
  return plan.map(p => `<div class="plan-day ${p.simulacro && !p.topics.length ? 'sim' : ''}"><b>${esc(p.label)}</b><span>${
    [...p.topics.map(id => esc(title(id))), p.simulacro ? (all ? '¡Ya repasaste todo! Haz un examen de práctica.' : 'Examen de práctica de todo') : ''].filter(Boolean).join(', ')}</span></div>`).join('');
}


// ---------- Papelera ----------
function renderTrash() {
  $('#lib-title').textContent = 'Papelera';
  $('#subject-menu').hidden = true;
  document.querySelector('.lib-tools').hidden = true;
  $('#up-events').hidden = true;
  document.documentElement.style.setProperty('--subject', 'var(--muted)');
  const box = $('#notes');
  box.classList.remove('as-index');
  box.innerHTML = '';
  const list = state.trash.slice().sort((a, b) => b.deletedAt - a.deletedAt);
  const head = document.createElement('div');
  head.className = 'trash-head';
  head.innerHTML = list.length
    ? `<p>Las notas eliminadas se guardan aquí ${TRASH_DAYS} días, con sus tarjetas, y después se borran solas.</p><button class="ghost danger-text" id="trash-empty">Vaciar papelera</button>`
    : '<p>La papelera está vacía.</p>';
  box.appendChild(head);
  head.querySelector('#trash-empty')?.addEventListener('click', emptyTrash);
  for (const n of list) {
    const s = state.subjects.find(x => x.id === n.subjectId);
    const left = Math.max(1, TRASH_DAYS - Math.floor((Date.now() - n.deletedAt) / 86400000));
    const card = document.createElement('article');
    card.className = 'note-card trashed';
    card.style.setProperty('--c', s ? s.color : '#9AA6B8');
    card.innerHTML = `
      <div class="thumb">${n.thumb ? `<img src="${n.thumb}" alt="">` : ''}</div>
      <div class="note-meta"><div class="note-text"><h3>${esc(n.title)}</h3><p>${s ? `<span class="tag">${esc(s.name)}</span>` : ''}Se borra en ${left} día${left === 1 ? '' : 's'}</p></div></div>
      <div class="trash-actions"><button class="secondary" data-act="restore">Restaurar</button><button class="ghost danger-text" data-act="purge">Eliminar</button></div>`;
    card.querySelector('[data-act=restore]').onclick = () => restoreNote(n);
    card.querySelector('[data-act=purge]').onclick = () => purgeForever(n);
    box.appendChild(card);
  }
}

async function restoreNote(n) {
  delete n.deletedAt;
  await db.put('notes', n);
  state.trash = state.trash.filter(x => x.id !== n.id);
  state.notes.push(n);
  if (!state.trash.length) state.current = n.subjectId && state.subjects.some(s => s.id === n.subjectId) ? n.subjectId : 'all';
  render();
  toast(`“${n.title}” volvió${n.subjectId && state.subjects.some(s => s.id === n.subjectId) ? '' : ' a Sin materia'}.`);
}

async function purgeForever(n) {
  const nc = state.cards.filter(c => c.noteId === n.id).length;
  if (!await confirmDialog(`¿Eliminar “${n.title}” para siempre?`, `Ya no se podrá recuperar${nc ? `, ni sus ${nc} tarjeta${nc === 1 ? '' : 's'}` : ''}.`, 'Eliminar para siempre')) return;
  await purgeNote(n);
  state.cards = state.cards.filter(c => c.noteId !== n.id);
  state.trash = state.trash.filter(x => x.id !== n.id);
  if (!state.trash.length) state.current = 'all';
  render();
}

async function emptyTrash() {
  const k = state.trash.length;
  if (!await confirmDialog('¿Vaciar la papelera?', `Se borran para siempre ${k} nota${k === 1 ? '' : 's'} y sus tarjetas.`, 'Vaciar papelera')) return;
  for (const n of state.trash) { await purgeNote(n); state.cards = state.cards.filter(c => c.noteId !== n.id); }
  state.trash = [];
  state.current = 'all';
  render();
  toast('Papelera vacía.');
}


// ---------- Apariencia ----------
async function themeDialog() {
  const prev = { ...theme };
  const r = await dialog(`<h2>Apariencia</h2>
    <div class="field">Tema<div class="seg seg-form" role="radiogroup">${[['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']].map(([k, v]) =>
      `<label><input type="radio" name="mode" value="${k}" ${theme.mode === k ? 'checked' : ''}>${v}</label>`).join('')}</div></div>
    <p class="dlg-text">Automático sigue el tema de la tablet.</p>
    <label class="check"><input type="checkbox" name="darkSheets" ${theme.darkSheets ? 'checked' : ''}><span>Hojas oscuras en el tema oscuro, para escribir de noche. La tinta oscura se ve clara.</span></label>
    <div class="field">PDF exportado<div class="seg seg-form" role="radiogroup">${[['screen', 'Como se ve en pantalla'], ['light', 'Siempre claro']].map(([k, v]) =>
      `<label><input type="radio" name="pdf" value="${k}" ${(theme.pdfLight ? 'light' : 'screen') === k ? 'checked' : ''}>${v}</label>`).join('')}</div></div>
    <p class="dlg-text">Si escribes con hojas oscuras, el PDF también sale oscuro. Elige "Siempre claro" si lo vas a imprimir.</p>
    ${buttons('Listo')}`, {
    onOpen: f => {
      const upd = () => {
        theme.mode = f.querySelector('input[name=mode]:checked').value;
        theme.darkSheets = f.querySelector('input[name=darkSheets]').checked;
        theme.pdfLight = f.querySelector('input[name=pdf]:checked').value === 'light';
        applyTheme();
      };
      f.querySelectorAll('input').forEach(i => i.addEventListener('change', upd));
    },
  });
  if (!r) { theme = prev; applyTheme(); return; }
  try { localStorage.setItem('np-theme', JSON.stringify(theme)); } catch {}
}
$('#theme-btn').onclick = themeDialog;


// ---------- Abrir con NotesPro (PDF compartido desde WhatsApp, Drive, etc.) ----------
const SharedFile = isNative && window.Capacitor.Plugins.SharedFile;
const sharedSeen = new Set();
async function onSharedFile(d) {
  if (!d || !d.path || sharedSeen.has(d.path)) return;
  sharedSeen.add(d.path);
  if (!/pdf/i.test(d.type || '') && !/\.pdf$/i.test(d.name || '')) { toast('NotesPro solo puede abrir archivos PDF.', { long: true }); return; }
  try {
    const url = window.Capacitor.convertFileSrc('file://' + d.path);
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], d.name || 'documento.pdf', { type: 'application/pdf' });
    // Volver al inicio antes de importar.
    if (dlg.open) dlg.close('cancel');
    if (review.isOpen) review.close();
    if (match.isOpen) match.close();
    if (!$('#calendar').hidden) $('#calendar').hidden = true;
    if (editor.isOpen) await closeEditor();
    await handlePdfFile(file, 'new');
  } catch (e) {
    console.error(e);
    toast('No se pudo abrir el PDF que compartiste.', { long: true });
  }
}
if (SharedFile) {
  SharedFile.addListener('file', onSharedFile);
  SharedFile.addListener('fileError', () => toast('No se pudo leer el archivo compartido.', { long: true }));
}

// ---------- Copia de seguridad ----------
function sinceText(t) {
  if (!t) return null;
  const d = Math.floor((Date.now() - t) / 86400000);
  if (d < 1) return 'hoy';
  if (d === 1) return 'ayer';
  return `hace ${d} días`;
}

async function backupDialog() {
  const info = backupInfo();
  const aud = await audioSize();
  const manual = sinceText(info.manual), auto = sinceText(info.auto);
  const status = manual ? `Tu última copia fue ${manual}.` : 'Todavía no has hecho ninguna copia.';
  const r = await dialog(`<h2>Copia de seguridad</h2>
    <p class="dlg-text">${status} Tus notas solo están guardadas en esta tablet: si se borra la app o se daña el equipo, se pierden. Con una copia en Google Drive o en tu correo las recuperas.</p>
    <div class="menu-list">
      <button value="backup"><span>Hacer copia ahora</span><small>Crea un archivo con todas tus notas y te deja enviarlo a Google Drive, tu correo o WhatsApp.</small></button>
      <button value="restore"><span>Restaurar desde un archivo</span><small>Agrega las notas de una copia. No borra nada de lo que ya tienes.</small></button>
    </div>
    ${aud.count ? `<label class="check"><input type="checkbox" name="audio" ${aud.bytes < 80e6 ? 'checked' : ''}><span>Incluir ${aud.count === 1 ? 'la grabación' : `las ${aud.count} grabaciones`} de clase (${Math.max(1, Math.round(aud.bytes / 1e6))} MB). Si pesan mucho, la copia tarda más en enviarse.</span></label>` : ''}
    ${isNative ? `<label class="check"><input type="checkbox" name="auto" ${info.autoOff ? '' : 'checked'}><span>Copia automática diaria en ${DEVICE_FOLDER}${auto ? ` (la última fue ${auto})` : ''}. Se guardan las de los últimos 7 días.</span></label>` : ''}
    <div class="dlg-actions"><button value="ok" class="ghost">Cerrar</button></div>`, {
    onOpen: f => {
      const c = f.querySelector('input[name=auto]');
      if (c) c.onchange = () => setAutoBackup(c.checked);
    },
  });
  if (!r) return;
  if (r.action === 'backup') makeBackup(r.audio === 'on');
  else if (r.action === 'restore') { const i = $('#restore-input'); i.value = ''; i.click(); }
}

function makeBackup(withAudio = false) {
  return withBusy(async () => {
    try {
      toast('Preparando la copia…', { sticky: true });
      const { blob, notes } = await buildBackup({ withAudio });
      if (!notes) { toast('Todavía no hay notas para respaldar.'); return; }
      const name = backupFileName();
      await saveToDevice(blob, name);
      toast('Elige dónde guardar la copia: Google Drive, tu correo o WhatsApp.', { long: true });
      const res = await shareFile(blob, name);
      if (res !== 'cancelled') { markManualBackup(); renderBanner(); }
    } catch (e) {
      console.error(e);
      toast('No se pudo crear la copia. Inténtalo de nuevo.', { long: true });
    }
  });
}

$('#restore-input').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  let data;
  try { data = await readBackup(f); }
  catch (err) { toast(err.message, { long: true }); return; }
  const when = new Date(data.createdAt).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
  const ok = await dialog(`<h2>Restaurar copia</h2>
    <p class="dlg-text">Copia del ${esc(when)}: ${data.subjects.length} materia${data.subjects.length === 1 ? '' : 's'} y ${data.notes.length} nota${data.notes.length === 1 ? '' : 's'}.</p>
    <p class="dlg-text">Se agregan las notas que no tienes y se actualizan las que en la copia son más recientes. No se borra nada.</p>
    ${buttons('Restaurar')}`);
  if (!ok) return;
  await withBusy(async () => {
    const r = await restoreBackup(data);
    await load();
    render();
    const parts = [];
    if (r.added) parts.push(`${r.added} nota${r.added === 1 ? '' : 's'} agregada${r.added === 1 ? '' : 's'}`);
    if (r.updated) parts.push(`${r.updated} actualizada${r.updated === 1 ? '' : 's'}`);
    if (r.audio) parts.push(`${r.audio} ${r.audio === 1 ? 'grabación' : 'grabaciones'}`);
    if (r.cards) parts.push(`${r.cards} tarjeta${r.cards === 1 ? '' : 's'} de estudio`);
    toast(parts.length ? `Copia restaurada: ${parts.join(', ')}.` : 'Ya tenías todo lo que hay en esa copia.', { long: true });
  });
});

// Aviso en el inicio cuando hace rato no hay una copia fuera de la tablet.
function renderBanner() {
  const b = $('#backup-banner');
  const info = backupInfo();
  const days = info.manual ? Math.floor((Date.now() - info.manual) / 86400000) : null;
  const snoozed = info.snooze && Date.now() < info.snooze;
  const show = state.notes.length >= 3 && !snoozed && (days === null || days >= 14);
  b.hidden = !show;
  if (show) b.querySelector('p').textContent = days === null
    ? 'Todavía no tienes una copia de tus notas fuera de esta tablet.'
    : `Tu última copia de seguridad fue hace ${days} días.`;
}
$('#backup-banner .primary').onclick = makeBackup;
$('#backup-banner .ghost').onclick = () => {
  try { localStorage.setItem('np-backup', JSON.stringify({ ...backupInfo(), snooze: Date.now() + 3 * 86400000 })); } catch {}
  renderBanner();
};

// ---------- Actualizaciones ----------
// Al abrir la app (y al volver a ella) se revisa en GitHub si hay una versión nueva.
const Updater = updaterPlugin();
let installed = 0, installedName = '', newer = [], pendingInstall = null, updating = false;
const verName = v => `v1.0.${v.num}`;
const hideToast = () => $('#toast').classList.remove('show');

async function checkUpdates({ force = false } = {}) {
  if (!Updater || !installed) return newer;
  const st = updateState();
  if (!force && st.checked && Date.now() - st.checked < 4 * 3600000) return newer;
  newer = await fetchNewer(installed);
  saveUpdateState({ list: newer });
  renderUpdate();
  return newer;
}

function renderUpdate() {
  const latest = newer[0];
  $('#update-count').textContent = latest ? '1' : '';
  const b = $('#update-banner');
  const sn = updateState().snooze;
  const snoozed = latest && sn && sn.num === latest.num && Date.now() < sn.until;
  b.hidden = !latest || !!snoozed;
  if (latest && !snoozed) {
    b.querySelector('p').innerHTML = `Hay una versión nueva de NotesPro: ${verName(latest)}` +
      (latest.title ? `<small>${esc(latest.title)}</small>` : '');
  }
}

async function updateDialog() {
  let list = newer;
  if (!Updater) return;
  if (Date.now() - (updateState().checked || 0) > 60000) {
    toast('Buscando actualizaciones…', { sticky: true });
    try { list = await checkUpdates({ force: true }); hideToast(); }
    catch { toast('No se pudo revisar si hay actualizaciones. Revisa tu conexión a internet.', { long: true }); if (!list.length) return; }
  }
  if (!list.length) {
    await dialog(`<h2>Actualizaciones</h2>
      <p class="dlg-text">Tienes la versión más reciente: <b>NotesPro ${esc(installedName)}</b>. Cuando salga una nueva te aviso al abrir la app.</p>
      <div class="dlg-actions"><button value="ok" class="primary">Listo</button></div>`);
    return;
  }
  const fmtDate = iso => { try { return new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }); } catch { return ''; } };
  const items = list.map(v => `<div class="upd-item"><span class="upd-ver">${verName(v)}${v.date ? ` · ${fmtDate(v.date)}` : ''}</span>
    <b>${esc(v.title || 'Mejoras y arreglos')}</b>
    ${v.detail ? `<details><summary>Ver detalles</summary><p>${esc(v.detail)}</p></details>` : ''}</div>`).join('');
  const mb = list[0].size ? ` La descarga pesa ${(list[0].size / 1048576).toFixed(1)} MB.` : '';
  const r = await dialog(`<h2>Versión nueva: ${verName(list[0])}</h2>
    <p class="dlg-text">Tienes ${esc(installedName)}. ${list.length > 1 ? `Desde entonces salieron ${list.length} versiones:` : 'Esto es lo nuevo:'}</p>
    <div class="upd-list">${items}</div>
    <p class="dlg-text">Tus notas, tarjetas y grabaciones no se borran al actualizar.${mb}</p>
    ${buttons('Actualizar ahora')}`, { wide: true });
  if (r) startUpdate(list[0]);
}

async function startUpdate(v) {
  if (!Updater || updating) return;
  let info;
  try { info = await Updater.info(); } catch { info = { canInstall: true }; }
  if (!info.canInstall) {
    const r = await dialog(`<h2>Un permiso, solo la primera vez</h2>
      <p class="dlg-text">Para instalar la actualización, Android necesita que le permitas a NotesPro instalar apps. Se abrirá un ajuste: activa <b>Permitir de esta fuente</b> y vuelve a NotesPro con el botón atrás. La actualización sigue sola.</p>
      ${buttons('Ir al ajuste')}`);
    if (!r) return;
    pendingInstall = v;
    try { await Updater.openInstallSettings(); }
    catch { pendingInstall = null; toast('No se pudo abrir el ajuste. Búscalo en Ajustes, Apps, NotesPro, Instalar apps desconocidas.', { long: true }); }
    return;
  }
  updating = true;
  let sub = null;
  try {
    if (editor.isOpen) await editor.save();
    toast('Descargando la actualización…', { sticky: true });
    sub = await Updater.addListener('progress', p => {
      if (p.total > 0) toast(`Descargando la actualización: ${Math.min(100, Math.floor(p.done * 100 / p.total))} %`, { sticky: true });
    });
    const { path } = await Updater.download({ url: v.url });
    toast('Toca "Instalar" en la ventana de Android. Tus notas se quedan como están.', { long: true });
    await Updater.install({ path });
  } catch (err) {
    toast((err && err.message) || 'No se pudo actualizar. Inténtalo de nuevo.', { long: true });
  } finally {
    updating = false;
    if (sub) sub.remove();
  }
}

async function onResumeUpdate() {
  if (!Updater) return;
  if (pendingInstall) {
    const v = pendingInstall;
    pendingInstall = null;
    let ok = false;
    try { ok = (await Updater.info()).canInstall; } catch {}
    if (ok) startUpdate(v);
    else toast('No se activó el permiso. Puedes intentarlo otra vez desde Actualizaciones.', { long: true });
    return;
  }
  checkUpdates().catch(() => {});
}

$('#update-btn').onclick = updateDialog;
$('#update-banner .primary').onclick = updateDialog;
$('#update-banner .ghost').onclick = () => {
  if (newer[0]) saveUpdateState({ snooze: { num: newer[0].num, until: Date.now() + 86400000 } });
  renderUpdate();
};
if (Updater) {
  $('#update-btn').hidden = false;
  Updater.info().then(i => {
    installed = +i.versionCode || 0;
    installedName = 'v' + (i.versionName || `1.0.${installed}`);
    newer = (updateState().list || []).filter(v => v.num > installed);
    renderUpdate();
    Updater.cleanup().catch(() => {});
    setTimeout(() => checkUpdates().catch(() => {}), 6000);
  }).catch(() => {});
}

// ---------- Eventos ----------
$('#home').addEventListener('click', e => {
  const sp = e.target.closest('.spine');
  if (sp) { state.current = sp.dataset.subject; state.query = ''; $('#search').value = ''; render(); }
});
$('#add-subject').onclick = newSubject;
$('#backup-btn').onclick = backupDialog;
document.querySelectorAll('.seg [data-view]').forEach(b => b.addEventListener('click', () => { state.view = b.dataset.view; renderNotes(); }));
$('#subject-menu').onclick = subjectMenu;
$('#new-note').onclick = newNote;
$('#import-pdf').onclick = () => pickPdf('new');
$('#search').addEventListener('input', e => { state.query = e.target.value; renderNotes(); });
$('#ed-back').onclick = closeEditor;
$('#ed-title').onclick = () => openMeta && renameNote(openMeta);
$('#ed-more').onclick = editorMore;

// Guardar al salir de la app o pasar a segundo plano.
document.addEventListener('visibilitychange', () => { if (document.hidden && editor.isOpen) editor.save(); });

// Botón "atrás" de Android.
const CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
if (CapApp) {
  CapApp.addListener('backButton', () => {
    if (dlg.open) { dlg.close('cancel'); return; }
    if (review.isOpen) { review.close(); return; }
    if (match.isOpen) { match.close(); return; }
    if (!$('#calendar').hidden) { closeCalendar(); return; }
    if (editor.isOpen) { if (!editor.deselect()) closeEditor(); return; }
    if (state.current !== 'all') { state.current = 'all'; render(); return; }
    CapApp.exitApp();
  });
  CapApp.addListener('pause', () => { if (editor.isOpen) editor.save(); });
  CapApp.addListener('resume', () => { autoBackup().catch(() => {}); onResumeUpdate(); });
}

(async function start() {
  persist();
  await load();
  render();
  if (document.fonts) document.fonts.load('16px "Atkinson Hyperlegible"');
  if (SharedFile) SharedFile.getPending().then(r => r && r.file && onSharedFile(r.file)).catch(() => {});
  // La copia automática se hace un poco después de abrir, para no demorar el inicio.
  setTimeout(() => autoBackup().catch(() => {}), 4000);
})();
