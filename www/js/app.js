import { db, uid, persist } from './db.js';
import { createEditor, PAPERS } from './editor.js';

const $ = s => document.querySelector(s);
const SUBJECT_COLORS = ['#2D55E0', '#12968A', '#D9442F', '#E7A21A', '#7A4BD6', '#1E9E5A', '#D23D86', '#46566F'];

const MARK_COLORS = ['#D9442F', '#2D55E0', '#1E9E5A', '#E7A21A', '#7A4BD6'];

const state = { subjects: [], notes: [], current: 'all', query: '', view: 'notes' };

// ---------- Avisos ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- Diálogos ----------
const dlg = $('#dlg');
const form = $('#dlg-form');
let dlgResolve = null;

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function dialog(html, { onOpen } = {}) {
  form.innerHTML = html;
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
  else r(dlg.returnValue && dlg.returnValue !== 'cancel' ? { action: dlg.returnValue } : null);
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
async function load() {
  const [subjects, notes] = await Promise.all([db.all('subjects'), db.all('notes')]);
  state.subjects = subjects.sort((a, b) => a.createdAt - b.createdAt);
  state.notes = notes;
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
  const inOutline = n => (n.outline || []).some(e => (e.title || '').toLowerCase().includes(q));
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

function render() { renderRail(); renderNotes(); }

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
    { value: 'edit', label: 'Cambiar nombre o color' },
    { value: 'del', label: 'Eliminar materia', danger: true },
  ]);
  if (act === 'edit') {
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
    { value: 'rename', label: 'Cambiar título' },
    { value: 'move', label: 'Mover a otra materia' },
    { value: 'del', label: 'Eliminar nota', danger: true },
  ]);
  if (act === 'rename') renameNote(n);
  else if (act === 'move') {
    const r = await dialog(`<h2>Mover nota</h2>
      <label class="field">Materia<select name="subjectId"><option value="">Sin materia</option>${state.subjects.map(s =>
        `<option value="${s.id}" ${n.subjectId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>${buttons('Mover')}`);
    if (!r) return;
    n.subjectId = r.subjectId || null;
    await db.put('notes', n);
    render();
  } else if (act === 'del') {
    if (!await confirmDialog(`¿Eliminar “${n.title}”?`, 'La nota y todo lo que tiene se borran de este dispositivo.', 'Eliminar nota')) return;
    await db.del('notes', n.id);
    await db.del('contents', n.id);
    state.notes = state.notes.filter(x => x.id !== n.id);
    render();
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
  askMark,
  onSave: async (meta, content, thumb, outline) => {
    meta.updatedAt = Date.now();
    meta.thumb = thumb;
    // El índice de la materia usa los títulos y marcadores (sin imágenes, para no duplicar datos).
    meta.outline = (outline || []).filter(e => e.kind !== 'image');
    await db.put('contents', { id: meta.id, ...content });
    await db.put('notes', meta);
  },
});

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
    <div class="menu-list"><button value="all">Ver toda la nota</button>${editor.layout === 'pages' ? '<button value="page">Agregar página al final</button>' : ''}<button value="rename">Cambiar título</button></div>
    <div class="dlg-actions"><button value="cancel" class="ghost">Cerrar</button><button value="ok" class="primary">Aplicar fondo</button></div>`);
  if (!act) return;
  if (act.action === 'all') editor.showAll();
  else if (act.action === 'page') editor.addPage();
  else if (act.action === 'rename') renameNote(openMeta);
  else if (act.paper && act.paper !== editor.paper) editor.setPaper(act.paper);
}

// ---------- Eventos ----------
$('#home').addEventListener('click', e => {
  const sp = e.target.closest('.spine');
  if (sp) { state.current = sp.dataset.subject; state.query = ''; $('#search').value = ''; render(); }
});
$('#add-subject').onclick = newSubject;
document.querySelectorAll('.seg [data-view]').forEach(b => b.addEventListener('click', () => { state.view = b.dataset.view; renderNotes(); }));
$('#subject-menu').onclick = subjectMenu;
$('#new-note').onclick = newNote;
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
    if (editor.isOpen) { if (!editor.deselect()) closeEditor(); return; }
    if (state.current !== 'all') { state.current = 'all'; render(); return; }
    CapApp.exitApp();
  });
  CapApp.addListener('pause', () => { if (editor.isOpen) editor.save(); });
}

(async function start() {
  persist();
  await load();
  render();
  if (document.fonts) document.fonts.load('16px "Atkinson Hyperlegible"');
})();
