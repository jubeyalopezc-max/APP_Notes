// Busca versiones nuevas de NotesPro en GitHub (las mismas que se publican en Releases).
const REPO = 'jubeyalopezc-max/APP_Notes';
const API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const KEY = 'np-update';

export const updaterPlugin = () => {
  const C = window.Capacitor;
  return C && C.isNativePlatform && C.isNativePlatform() && C.Plugins && C.Plugins.Updater || null;
};

/** "v1.0.15" → 15 */
export const tagNumber = tag => { const m = /^v?1\.0\.(\d+)$/.exec(String(tag || '').trim()); return m ? +m[1] : 0; };

/** Saca de las notas de la versión el título y el detalle de los cambios. */
export function parseNotes(body) {
  const s = String(body || '').replace(/\r/g, '');
  const i = s.indexOf('Cambios:');
  if (i < 0) return { title: '', detail: '' };
  const lines = s.slice(i + 8).split('\n').filter(l => !/^\s*(Co-Authored-By|Claude-Session):/i.test(l));
  const title = (lines.shift() || '').trim();
  const detail = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, detail };
}

export function updateState() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
export function saveUpdateState(patch) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...updateState(), ...patch })); } catch {}
}

/**
 * Versiones más nuevas que la instalada, de la más reciente a la más vieja.
 * Cada una: { num, tag, title, detail, url, size, date }.
 */
export async function fetchNewer(current) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  let list;
  try {
    const r = await fetch(API, { headers: { Accept: 'application/vnd.github+json' }, signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    list = await r.json();
  } finally { clearTimeout(timer); }
  saveUpdateState({ checked: Date.now() });
  const out = [];
  for (const rel of Array.isArray(list) ? list : []) {
    if (rel.draft || rel.prerelease) continue;
    const num = tagNumber(rel.tag_name);
    if (!num || num <= current) continue;
    const apk = (rel.assets || []).find(a => /\.apk$/i.test(a.name || ''));
    if (!apk) continue;
    out.push({ num, tag: rel.tag_name, ...parseNotes(rel.body), url: apk.browser_download_url, size: apk.size, date: rel.published_at });
  }
  out.sort((a, b) => b.num - a.num);
  return out;
}
