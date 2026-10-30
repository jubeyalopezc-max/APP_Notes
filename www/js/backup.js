// Copias de seguridad: un archivo .notespro con materias, notas y su contenido.
import { db } from './db.js';
import { isNative, saveToDevice } from './files.js';

const KEY = 'np-backup';
const DAY = 86400000;
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

export function backupInfo() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
function setInfo(patch) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...backupInfo(), ...patch })); } catch {}
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Cuánto pesan las grabaciones de clase (para decidir si van en la copia). */
export async function audioSize() {
  const list = await db.all('audio');
  return { count: list.length, bytes: list.reduce((a, x) => a + (x.blob ? x.blob.size : 0), 0) };
}

export async function buildBackup({ withAudio = false } = {}) {
  const [subjects, notes, contents, cards, sessions, events] = await Promise.all([db.all('subjects'), db.all('notes'), db.all('contents'), db.all('cards'), db.all('sessions'), db.all('events')]);
  const data = { app: 'NotesPro', version: 5, createdAt: Date.now(), subjects, notes, contents, cards, sessions, events };
  if (withAudio) {
    data.audio = [];
    for (const a of await db.all('audio')) {
      const { blob, ...rest } = a;
      if (blob) data.audio.push({ ...rest, data: await blobToDataUrl(blob) });
    }
  }
  return { blob: new Blob([JSON.stringify(data)], { type: 'application/octet-stream' }), subjects: subjects.length, notes: notes.length };
}

export function backupFileName(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `NotesPro-copia-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.notespro`;
}

export function markManualBackup() { setInfo({ manual: Date.now() }); }

/** Copia automática: una vez al día, en Documentos/NotesPro, conservando la de cada día de la semana. */
export async function autoBackup() {
  if (!isNative) return false;
  const info = backupInfo();
  if (info.autoOff) return false;
  if (info.auto && Date.now() - info.auto < DAY) return false;
  const { blob, notes } = await buildBackup();
  if (!notes) return false;
  const path = await saveToDevice(blob, `copias-automaticas/NotesPro-${WEEKDAYS[new Date().getDay()]}.notespro`);
  if (path) setInfo({ auto: Date.now() });
  return !!path;
}

export function setAutoBackup(on) { setInfo({ autoOff: !on }); }

/** Lee un archivo de copia. Devuelve los datos o lanza un error con un mensaje para la persona. */
export async function readBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { throw new Error('Ese archivo no es una copia de NotesPro.'); }
  if (!data || data.app !== 'NotesPro' || !Array.isArray(data.notes) || !Array.isArray(data.contents)) {
    throw new Error('Ese archivo no es una copia de NotesPro.');
  }
  return data;
}

/**
 * Restaura sin borrar nada: agrega lo que falta y actualiza las notas que en la copia son más recientes.
 * Si ya existe una materia con el mismo nombre, las notas se unen a ella.
 */
export async function restoreBackup(data) {
  const [subjects, notes] = await Promise.all([db.all('subjects'), db.all('notes')]);
  const subjById = new Map(subjects.map(s => [s.id, s]));
  const subjByName = new Map(subjects.map(s => [s.name.trim().toLowerCase(), s]));
  const remap = new Map();
  let newSubjects = 0;
  for (const s of data.subjects || []) {
    if (subjById.has(s.id)) continue;
    const same = subjByName.get(String(s.name).trim().toLowerCase());
    if (same) { remap.set(s.id, same.id); continue; }
    await db.put('subjects', s);
    newSubjects++;
  }
  const noteById = new Map(notes.map(n => [n.id, n]));
  const contentById = new Map(data.contents.map(c => [c.id, c]));
  let added = 0, updated = 0;
  for (const n of data.notes) {
    const mine = noteById.get(n.id);
    if (mine && (mine.updatedAt || 0) >= (n.updatedAt || 0)) continue;
    const meta = { ...n, subjectId: remap.get(n.subjectId) || n.subjectId };
    await db.put('notes', meta);
    await db.put('contents', contentById.get(n.id) || { id: n.id, items: [], pages: 1 });
    mine ? updated++ : added++;
  }
  // Tarjetas de estudio (copias de la versión 2 en adelante): se agregan las que faltan.
  let cards = 0;
  const mineCards = new Set((await db.all('cards')).map(c => c.id));
  for (const c of data.cards || []) {
    if (mineCards.has(c.id)) continue;
    await db.put('cards', c);
    cards++;
  }
  // Tiempo de estudio registrado (versión 3 en adelante).
  const mineSessions = new Set((await db.all('sessions')).map(x => x.id));
  for (const x of data.sessions || []) {
    if (mineSessions.has(x.id)) continue;
    await db.put('sessions', { ...x, subjectId: remap.get(x.subjectId) || x.subjectId });
  }
  // Grabaciones de clase (si la copia las incluye).
  const mineAudio = new Set((await db.all('audio')).map(x => x.id));
  let audio = 0;
  for (const a of data.audio || []) {
    if (mineAudio.has(a.id) || !a.data) continue;
    const { data: url, ...rest } = a;
    const blob = await (await fetch(url)).blob();
    await db.put('audio', { ...rest, blob });
    audio++;
  }
  // Calendario (versión 4 en adelante).
  const mineEvents = new Set((await db.all('events')).map(x => x.id));
  for (const x of data.events || []) {
    if (mineEvents.has(x.id)) continue;
    await db.put('events', { ...x, subjectId: remap.get(x.subjectId) || x.subjectId });
  }
  return { added, updated, newSubjects, cards, audio };
}
