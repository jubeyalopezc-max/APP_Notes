// Almacenamiento local con IndexedDB.
// subjects: materias · notes: datos de cada nota (sin el contenido) · contents: trazos, imágenes y texto de cada nota

const DB_NAME = 'notespro';
const DB_VERSION = 4; // 2: tarjetas · 3: sesiones de estudio · 4: calendario
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('subjects')) db.createObjectStore('subjects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('notes')) {
        const s = db.createObjectStore('notes', { keyPath: 'id' });
        s.createIndex('subjectId', 'subjectId');
      }
      if (!db.objectStoreNames.contains('contents')) db.createObjectStore('contents', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('cards')) {
        const c = db.createObjectStore('cards', { keyPath: 'id' });
        c.createIndex('noteId', 'noteId');
      }
      if (!db.objectStoreNames.contains('sessions')) {
        const t = db.createObjectStore('sessions', { keyPath: 'id' });
        t.createIndex('start', 'start');
      }
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const db = {
  all: (store) => tx(store, 'readonly', s => s.getAll()),
  get: (store, id) => tx(store, 'readonly', s => s.get(id)),
  put: (store, value) => tx(store, 'readwrite', s => s.put(value)),
  del: (store, id) => tx(store, 'readwrite', s => s.delete(id)),
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Pide al sistema que no borre los datos si falta espacio.
export function persist() {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
