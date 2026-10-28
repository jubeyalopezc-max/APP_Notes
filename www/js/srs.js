// Repetición espaciada (variante sencilla de SM-2, como la de Anki).
// Cada tarjeta guarda: due (fecha de repaso), interval (días), ease (facilidad), reps, lapses.

const DAY = 86400000;
const MIN = 60000;

export const GRADES = [
  { id: 0, label: 'Otra vez', hint: 'No me la sabía' },
  { id: 1, label: 'Difícil', hint: 'Me costó' },
  { id: 2, label: 'Bien', hint: 'Me la sabía' },
  { id: 3, label: 'Fácil', hint: 'Muy fácil' },
];

export function newSrs() {
  return { due: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0, last: 0 };
}

// Las tarjetas que tocan hoy vencen al empezar el día, no a la hora exacta.
function startOfDay(t) { const d = new Date(t); d.setHours(4, 0, 0, 0); if (d.getTime() > t) d.setDate(d.getDate() - 1); return d.getTime(); }

/** Nuevo estado de la tarjeta según la calificación (0 a 3). */
export function schedule(srs, grade, now = Date.now()) {
  const s = { ...newSrs(), ...srs };
  let interval;
  if (grade === 0) {
    s.lapses += s.reps > 0 ? 1 : 0;
    s.reps = 0;
    s.ease = Math.max(1.3, s.ease - 0.2);
    s.interval = 0;
    s.due = now + 1 * MIN;  // vuelve a salir en esta misma sesión
    s.last = now;
    return s;
  }
  if (s.reps === 0) interval = grade === 1 ? 1 : grade === 2 ? 1 : 4;
  else if (s.reps === 1) interval = grade === 1 ? 2 : grade === 2 ? 3 : 6;
  else {
    const base = Math.max(1, s.interval);
    interval = grade === 1 ? base * 1.2 : grade === 2 ? base * s.ease : base * s.ease * 1.3;
  }
  if (grade === 1) s.ease = Math.max(1.3, s.ease - 0.15);
  if (grade === 3) s.ease += 0.15;
  s.interval = Math.min(365, Math.max(1, Math.round(interval)));
  s.reps += 1;
  s.due = startOfDay(now) + s.interval * DAY;
  s.last = now;
  return s;
}

export function isDue(srs, now = Date.now()) {
  return !srs || (srs.due || 0) <= now;
}

export function intervalLabel(srs, grade, now = Date.now()) {
  const next = schedule(srs, grade, now);
  if (grade === 0) return '1 min';
  const d = next.interval;
  if (d < 1.5) return '1 día';
  if (d < 14) return `${d} días`;
  if (d < 60) return `${Math.round(d / 7)} sem`;
  if (d < 365) return `${Math.round(d / 30)} meses`;
  return '1 año';
}

export function dueText(srs, now = Date.now()) {
  if (!srs || !srs.reps) return 'Nueva';
  const days = Math.round((srs.due - startOfDay(now)) / DAY);
  if (days <= 0) return 'Para hoy';
  if (days === 1) return 'Mañana';
  return `En ${days} días`;
}
