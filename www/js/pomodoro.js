// Pomodoro: enfoque y descanso con aviso al terminar. Se basa en la hora de fin (no en contar
// segundos), así sigue siendo exacto aunque Android pause la app en segundo plano.

const KEY = 'np-pomo';
const MIN = 60000;
const Cap = window.Capacitor;
const LN = Cap && Cap.isNativePlatform && Cap.isNativePlatform() ? Cap.Plugins.LocalNotifications : null;
const NOTIF_FOCUS = 7101, NOTIF_BREAK = 7102;

const fmt = ms => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function load() {
  try { return { phase: 'idle', focusMin: 25, breakMin: 5, cycle: 0, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { return { phase: 'idle', focusMin: 25, breakMin: 5, cycle: 0 }; }
}

export function createPomodoro({ toast, getSubject, onFocusLogged, now = () => Date.now() }) {
  let st = load();
  const pill = document.querySelector('#pomo-pill');
  const pillText = pill.querySelector('.pomo-text');
  const pillBtn = pill.querySelector('.pomo-act');
  let tick = null;
  const listeners = new Set();

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} };
  const breakLen = () => ((st.cycle % 4 === 0 && st.cycle > 0) ? 15 : st.breakMin) * MIN; // cada 4, descanso largo
  const nextBreakLen = () => (((st.cycle + 1) % 4 === 0) ? 15 : st.breakMin) * MIN;      // el que viene tras este enfoque

  // ---------- Avisos ----------
  let audio = null;
  function chime(kind) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const notes = kind === 'focus' ? [660, 880, 1100] : [880, 660];
      notes.forEach((f, i) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const t = audio.currentTime + i * 0.18;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.55);
      });
    } catch {}
    if (navigator.vibrate) navigator.vibrate(kind === 'focus' ? [180, 90, 180] : [250]);
  }

  async function scheduleNotifs() {
    if (!LN) return;
    try {
      await LN.cancel({ notifications: [{ id: NOTIF_FOCUS }, { id: NOTIF_BREAK }] });
      const list = [];
      const sub = getSubject(st.subjectId);
      if (st.phase === 'focus') {
        list.push({ id: NOTIF_FOCUS, title: '¡Pomodoro completo!', body: `${sub ? sub.name + ': ' : ''}toma ${nextBreakLen() / MIN} minutos de descanso.`, schedule: { at: new Date(st.endAt), allowWhileIdle: true } });
        list.push({ id: NOTIF_BREAK, title: 'Se acabó el descanso', body: 'Vuelve a NotesPro para el siguiente Pomodoro.', schedule: { at: new Date(st.endAt + nextBreakLen()), allowWhileIdle: true } });
      } else if (st.phase === 'break') {
        list.push({ id: NOTIF_BREAK, title: 'Se acabó el descanso', body: 'Vuelve a NotesPro para el siguiente Pomodoro.', schedule: { at: new Date(st.endAt), allowWhileIdle: true } });
      }
      if (list.length) await LN.schedule({ notifications: list });
    } catch {}
  }
  async function cancelNotifs() {
    if (!LN) return;
    try { await LN.cancel({ notifications: [{ id: NOTIF_FOCUS }, { id: NOTIF_BREAK }] }); } catch {}
  }

  // ---------- Fases ----------
  function logFocus(ms, startedAt) {
    if (ms >= MIN) onFocusLogged && onFocusLogged({ subjectId: st.subjectId || null, ms, start: startedAt });
  }

  // Avanza las fases que ya terminaron (por ejemplo, si la app estuvo en segundo plano).
  function catchUp(silent) {
    let changed = false;
    if (st.phase === 'focus' && now() >= st.endAt) {
      logFocus(st.focusMin * MIN, st.endAt - st.focusMin * MIN);
      st.cycle += 1;
      const len = breakLen();
      st.phase = 'break';
      st.endAt += len;
      st.breakLen = len;
      changed = true;
      if (!silent && now() < st.endAt) { chime('focus'); toast(`¡Pomodoro completo! Descansa ${len / MIN} minutos.`, { long: true }); }
    }
    if (st.phase === 'break' && now() >= st.endAt) {
      st.phase = 'waiting';
      changed = true;
      if (!silent) { chime('break'); toast('Se acabó el descanso. Toca “Seguir” para otro Pomodoro.', { long: true }); }
    }
    if (changed) { save(); emit(); }
  }

  function startFocus() {
    st.phase = 'focus';
    st.endAt = now() + st.focusMin * MIN;
    save();
    scheduleNotifs();
    run();
    emit();
  }

  function start({ subjectId, focusMin, breakMin }) {
    st = { ...st, subjectId: subjectId || null, focusMin, breakMin, cycle: 0 };
    if (LN) LN.requestPermissions().catch(() => {});
    startFocus();
  }

  function pause() {
    if (st.phase !== 'focus' && st.phase !== 'break') return;
    st.paused = { phase: st.phase, left: st.endAt - now() };
    st.phase = 'paused';
    save(); cancelNotifs(); emit();
  }

  function resume() {
    if (st.phase !== 'paused') return;
    st.phase = st.paused.phase;
    st.endAt = now() + st.paused.left;
    delete st.paused;
    save(); scheduleNotifs(); run(); emit();
  }

  function skip() {
    if (st.phase === 'focus' || (st.phase === 'paused' && st.paused.phase === 'focus')) {
      const left = st.phase === 'paused' ? st.paused.left : st.endAt - now();
      logFocus(st.focusMin * MIN - left, now() - (st.focusMin * MIN - left));
      st.cycle += 1;
      st.phase = 'break';
      st.breakLen = breakLen();
      st.endAt = now() + st.breakLen;
      delete st.paused;
    } else {
      st.phase = 'waiting';
      delete st.paused;
    }
    save(); scheduleNotifs(); run(); emit();
  }

  function stop() {
    if (st.phase === 'focus' || (st.phase === 'paused' && st.paused.phase === 'focus')) {
      const left = st.phase === 'paused' ? st.paused.left : st.endAt - now();
      logFocus(st.focusMin * MIN - left, now() - (st.focusMin * MIN - left));
    }
    st.phase = 'idle';
    delete st.paused;
    save(); cancelNotifs(); emit();
  }

  // ---------- Vista ----------
  function remaining() {
    if (st.phase === 'paused') return st.paused.left;
    if (st.phase === 'focus' || st.phase === 'break') return st.endAt - now();
    return 0;
  }

  function label() {
    const sub = getSubject(st.subjectId);
    if (st.phase === 'focus') return { text: `Enfoque ${fmt(remaining())}`, act: 'pause', color: sub ? sub.color : null };
    if (st.phase === 'break') return { text: `Descanso ${fmt(remaining())}`, act: 'pause', color: '#1E9E5A' };
    if (st.phase === 'paused') return { text: `En pausa ${fmt(remaining())}`, act: 'resume', color: sub ? sub.color : null };
    if (st.phase === 'waiting') return { text: 'Descanso terminado', act: 'next', color: '#1E9E5A' };
    return null;
  }

  function render() {
    const l = label();
    pill.hidden = !l;
    document.body.classList.toggle('pomo-on', !!l);
    if (!l) return;
    pillText.textContent = l.text;
    pill.style.setProperty('--pc', l.color || 'var(--accent)');
    pill.dataset.phase = st.phase;
    pillBtn.dataset.act = l.act;
    pillBtn.setAttribute('aria-label', l.act === 'pause' ? 'Pausar' : l.act === 'resume' ? 'Reanudar' : 'Seguir con otro Pomodoro');
    pillBtn.innerHTML = l.act === 'next' ? 'Seguir' : `<svg><use href="#i-${l.act === 'pause' ? 'pause' : 'play'}"/></svg>`;
    pillBtn.classList.toggle('icon', l.act !== 'next');
  }

  function emit() { render(); listeners.forEach(f => f(st)); }

  function run() {
    clearInterval(tick);
    tick = setInterval(() => {
      catchUp(false);
      render();
      if (st.phase !== 'focus' && st.phase !== 'break') clearInterval(tick);
    }, 500);
  }

  pillBtn.addEventListener('click', e => {
    e.stopPropagation();
    const a = pillBtn.dataset.act;
    if (a === 'pause') pause();
    else if (a === 'resume') resume();
    else if (a === 'next') startFocus();
  });

  // Al volver a la app, ponerse al día sin sonar (ya avisó la notificación).
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { catchUp(true); render(); } });

  catchUp(true);
  render();
  if (st.phase === 'focus' || st.phase === 'break') run();

  return {
    get state() { return st; },
    get running() { return st.phase === 'focus' || st.phase === 'paused' && st.paused && st.paused.phase === 'focus'; },
    get active() { return st.phase !== 'idle'; },
    remaining, fmt,
    start, pause, resume, skip, stop, next: startFocus,
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    _tick() { catchUp(false); render(); }, // para pruebas
  };
}
