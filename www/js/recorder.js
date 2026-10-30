// Grabadora de la clase. Lleva su propio reloj (sin contar las pausas), que es el mismo tiempo
// del audio: así cada trazo queda marcado con el segundo exacto en que se escribió.

const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export function recordingSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

/**
 * Empieza a grabar. onPartial(blob, ms) se llama cada minuto con lo grabado hasta ahí,
 * para no perderlo si la app se cierra.
 */
export async function startRecording({ onPartial } = {}) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    const msg = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
      ? 'NotesPro necesita permiso para usar el micrófono. Actívalo en los ajustes de Android y vuelve a intentarlo.'
      : 'No se pudo usar el micrófono.';
    throw new Error(msg);
  }
  const mime = TYPES.find(t => window.MediaRecorder.isTypeSupported(t)) || '';
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
  const chunks = [];
  let acc = 0, since = Date.now(), paused = false, partialTimer = null;

  const elapsed = () => acc + (paused ? 0 : Date.now() - since);
  mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  mr.start(1000);
  if (onPartial) partialTimer = setInterval(() => {
    if (chunks.length) onPartial(new Blob(chunks, { type: mr.mimeType || mime || 'audio/webm' }), elapsed());
  }, 60000);

  return {
    mime: mr.mimeType || mime,
    elapsed,
    get paused() { return paused; },
    pause() {
      if (paused || mr.state !== 'recording') return;
      mr.pause(); acc += Date.now() - since; paused = true;
    },
    resume() {
      if (!paused || mr.state !== 'paused') return;
      mr.resume(); since = Date.now(); paused = false;
    },
    /** Termina y devuelve { blob, duration, mime }. */
    stop() {
      clearInterval(partialTimer);
      const duration = elapsed();
      return new Promise(resolve => {
        const finish = () => {
          stream.getTracks().forEach(t => t.stop());
          resolve({ blob: new Blob(chunks, { type: mr.mimeType || mime || 'audio/webm' }), duration, mime: mr.mimeType || mime });
        };
        if (mr.state === 'inactive') { finish(); return; }
        mr.onstop = finish;
        try { mr.stop(); } catch { finish(); }
      });
    },
  };
}

export const fmtClock = ms => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};
