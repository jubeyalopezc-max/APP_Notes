// Cliente del motor de cálculo: manda órdenes al hilo de Giac y espera la respuesta.
let worker = null, seq = 0;
const pending = new Map();

function start() {
  worker = new Worker(new URL('./cas-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = e => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    clearTimeout(p.timer);
    if (e.data.error) p.reject(new Error(e.data.error));
    else p.resolve(e.data.out);
  };
  worker.onerror = e => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('El motor de cálculo falló: ' + (e.message || ''))); }
    pending.clear();
    worker = null;
  };
}

/** Precarga el motor (tarda menos de un segundo la primera vez). */
export function warmUp() { if (!worker) start(); return run(['1+1'], 30000).catch(() => {}); }

/**
 * Ejecuta órdenes de Giac en orden y devuelve sus resultados (texto).
 * Si se pasa del tiempo, se corta el motor y se arranca uno nuevo.
 */
export function run(cmds, timeout = 12000) {
  if (!worker) start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      try { worker.terminate(); } catch {}
      worker = null;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('restart')); }
      pending.clear();
      reject(Object.assign(new Error('Este cálculo está tardando demasiado. Prueba con algo más simple o con valores numéricos.'), { timeout: true }));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, cmds });
  });
}

// Giac a veces pega la aproximación decimal al final ("19/12=1.58333"): se separa.
export function splitApprox(s) {
  const m = /^(.*?)=(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)$/.exec(String(s).trim());
  if (m && !/[=<>]/.test(m[1])) return { exact: m[1], approx: m[2] };
  return { exact: String(s).trim(), approx: null };
}

export const isError = s => /^GIAC_ERROR/.test(String(s)) || /^"?(Error|Syntax error|Bad Argument)/i.test(String(s));
