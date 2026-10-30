// Calendario de parciales y entregas: fechas, cuenta regresiva, plan de repaso y recordatorios.

const DAY = 86400000;
const Cap = window.Capacitor;
const LN = Cap && Cap.isNativePlatform && Cap.isNativePlatform() ? Cap.Plugins.LocalNotifications : null;

export const TYPES = {
  parcial: 'Parcial', quiz: 'Quiz', entrega: 'Entrega', expo: 'Exposición', otro: 'Otro',
};
export const REMINDERS = { '': 'Sin recordatorio', '1': 'Un día antes', '1,3': '1 y 3 días antes', '1,3,7': '1, 3 y 7 días antes' };

const pad = n => String(n).padStart(2, '0');
export const isoDay = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const dayStart = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const today0 = now => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Días desde hoy hasta la fecha (0 = hoy, 1 = mañana, negativo = ya pasó). */
export function daysUntil(iso, now = Date.now()) {
  return Math.round((dayStart(iso) - today0(now)) / DAY);
}

export function countdown(iso, now = Date.now()) {
  const n = daysUntil(iso, now);
  if (n === 0) return 'hoy';
  if (n === 1) return 'mañana';
  if (n === -1) return 'ayer';
  if (n < 0) return `hace ${-n} días`;
  if (n < 14) return `en ${n} días`;
  const w = Math.round(n / 7);
  return w < 8 ? `en ${w} semanas` : `en ${Math.round(n / 30)} meses`;
}

export function longDate(iso, time) {
  const s = new Date(dayStart(iso)).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
  return s + (time ? `, ${time}` : '');
}

export function shortDate(iso) {
  return new Date(dayStart(iso)).toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
}

export function eventTitle(ev, subject) {
  if (ev.title) return ev.title;
  return `${TYPES[ev.type] || 'Evento'}${subject ? ' de ' + subject.name : ''}`;
}

/**
 * Plan de repaso: reparte los temas pendientes entre hoy y el día anterior al evento,
 * y deja el último día para un examen de práctica de todo.
 * Devuelve [{ iso, label, topics: [noteId], simulacro }].
 */
export function studyPlan(ev, pendingIds, now = Date.now()) {
  const left = daysUntil(ev.date, now);
  if (left < 0) return [];
  const t0 = today0(now);
  const at = i => isoDay(t0 + i * DAY);
  const label = i => (i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : shortDate(at(i)).replace(/^./, c => c.toUpperCase()));
  if (left === 0) return [{ iso: at(0), label: 'Hoy', topics: pendingIds.slice(), simulacro: true, last: true }];
  if (left === 1) return [{ iso: at(0), label: 'Hoy', topics: pendingIds.slice(), simulacro: true }];
  const slots = left - 1;               // días para temas (el último antes del evento es para el simulacro)
  const plan = new Map();
  pendingIds.forEach((id, i) => {
    const d = pendingIds.length >= slots ? Math.floor((i * slots) / pendingIds.length) : Math.round((i * slots) / pendingIds.length);
    if (!plan.has(d)) plan.set(d, []);
    plan.get(d).push(id);
  });
  const out = [...plan.entries()].sort((a, b) => a[0] - b[0]).map(([d, topics]) => ({ iso: at(d), label: label(d), topics }));
  out.push({ iso: at(left - 1), label: label(left - 1), topics: [], simulacro: true });
  return out;
}

// ---------- Recordatorios ----------
function notifIds(ev) {
  let h = 0;
  for (const c of ev.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const base = 200000 + (h % 70000) * 10;
  return [0, 1, 2, 3].map(i => base + i);
}

export async function scheduleReminders(ev, title, now = Date.now()) {
  if (!LN) return;
  try {
    await LN.cancel({ notifications: notifIds(ev).map(id => ({ id })) });
    if (!ev.remind || ev.done) return;
    const ids = notifIds(ev);
    const list = [];
    ev.remind.split(',').map(Number).forEach((n, i) => {
      const d = new Date(dayStart(ev.date) - n * DAY);
      d.setHours(8, 0, 0, 0);
      if (d.getTime() <= now) return;
      list.push({
        id: ids[i], title: `${title} ${n === 1 ? 'mañana' : `en ${n} días`}`,
        body: 'Abre NotesPro para ver tu plan de repaso.', schedule: { at: d, allowWhileIdle: true },
      });
    });
    if (list.length) {
      await LN.requestPermissions().catch(() => {});
      await LN.schedule({ notifications: list });
    }
  } catch {}
}

export async function cancelReminders(ev) {
  if (!LN) return;
  try { await LN.cancel({ notifications: notifIds(ev).map(id => ({ id })) }); } catch {}
}

// ---------- Vista de mes ----------
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** HTML de la cuadrícula del mes (lunes primero) con puntos de colores en los días con eventos. */
export function monthHtml(year, month, events, colorOf, selected, now = Date.now()) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const todayIso = isoDay(now);
  const byDay = new Map();
  for (const ev of events) {
    if (!byDay.has(ev.date)) byDay.set(ev.date, []);
    byDay.get(ev.date).push(ev);
  }
  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<span class="cal-cell cal-blank"></span>';
  for (let d = 1; d <= days; d++) {
    const iso = `${year}-${pad(month + 1)}-${pad(d)}`;
    const evs = byDay.get(iso) || [];
    const dots = evs.slice(0, 3).map(e => `<i style="background:${colorOf(e)}"></i>`).join('');
    const cls = ['cal-cell', iso === todayIso ? 'today' : '', iso === selected ? 'sel' : '', evs.length ? 'has' : ''].join(' ');
    const label = `${d} de ${MONTHS[month]}${evs.length ? `, ${evs.length} evento${evs.length === 1 ? '' : 's'}` : ''}`;
    cells += `<button class="${cls}" data-day="${iso}" aria-label="${label}" aria-pressed="${iso === selected}"><span>${d}</span><span class="cal-dots">${dots}</span></button>`;
  }
  return `<div class="cal-mhead">
      <button class="icon-btn" data-month="-1" aria-label="Mes anterior"><svg><use href="#i-back"/></svg></button>
      <b>${MONTHS[month]} ${year}</b>
      <button class="icon-btn cal-nextm" data-month="1" aria-label="Mes siguiente"><svg><use href="#i-back"/></svg></button>
    </div>
    <div class="cal-grid">${['L', 'M', 'X', 'J', 'V', 'S', 'D'].map(x => `<span class="cal-wd">${x}</span>`).join('')}${cells}</div>`;
}
