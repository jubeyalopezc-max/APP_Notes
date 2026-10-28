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

export async function buildBackup() {
  const [subjects, notes, contents] = await Promise.all([db.all('subjects'), db.all('notes'), db.all('contents')]);
  const data = { app: 'NotesPro', version: 1, createdAt: Date.now(), subjects, notes, contents };
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
  return { added, updated, newSubjects };
}
