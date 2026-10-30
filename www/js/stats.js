// Tiempo de estudio por semana: por materia, por día, racha y de dónde salió el tiempo.
const DAY = 86400000;
const DAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const DAY_NAMES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const KINDS = { pomodoro: 'Pomodoro', review: 'repasando tarjetas', match: 'uniendo parejas', exam: 'en exámenes' };

export function weekStart(t, offset = 0) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // lunes = 0
  d.setDate(d.getDate() - dow + offset * 7);
  return d.getTime();
}

export function fmtMin(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Días seguidos con al menos 10 minutos de estudio, terminando hoy (o ayer si hoy aún no hay).
function streak(sessions, now) {
  const byDay = new Map();
  for (const s of sessions) {
    const d = new Date(s.start); d.setHours(0, 0, 0, 0);
    byDay.set(d.getTime(), (byDay.get(d.getTime()) || 0) + s.ms);
  }
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  let t = today.getTime(), n = 0;
  if ((byDay.get(t) || 0) < 10 * 60000) t -= DAY;
  while ((byDay.get(t) || 0) >= 10 * 60000) { n++; t -= DAY; }
  return n;
}

/** HTML del resumen de una semana. */
export function statsHtml({ sessions, subjects, offset = 0, now = Date.now() }) {
  const ws = weekStart(now, offset), we = ws + 7 * DAY;
  const week = sessions.filter(s => s.start >= ws && s.start < we);
  const total = week.reduce((a, s) => a + s.ms, 0);
  const subj = new Map(subjects.map(s => [s.id, s]));

  const bySub = new Map();
  for (const s of week) {
    const k = subj.has(s.subjectId) ? s.subjectId : '';
    bySub.set(k, (bySub.get(k) || 0) + s.ms);
  }
  const subRows = [...bySub.entries()].sort((a, b) => b[1] - a[1]);
  const maxSub = Math.max(1, ...subRows.map(r => r[1]));

  const perDay = Array.from({ length: 7 }, (_, i) => week.filter(s => s.start >= ws + i * DAY && s.start < ws + (i + 1) * DAY).reduce((a, s) => a + s.ms, 0));
  const maxDay = Math.max(1, ...perDay);
  const todayIdx = offset === 0 ? Math.floor((new Date(now).setHours(0, 0, 0, 0) - ws) / DAY) : -1;

  const byKind = {};
  for (const s of week) byKind[s.kind] = (byKind[s.kind] || 0) + s.ms;
  const kinds = Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${fmtMin(v)} ${k === 'pomodoro' ? 'en Pomodoro' : KINDS[k] || k}`);

  const d0 = new Date(ws), d1 = new Date(we - DAY);
  const range = offset === 0 ? 'Esta semana' : offset === -1 ? 'La semana pasada'
    : `Semana del ${d0.getDate()} de ${d0.toLocaleDateString('es-CO', { month: 'short' })}`;
  const st = offset === 0 ? streak(sessions, now) : 0;
  const todayMs = offset === 0 ? perDay[todayIdx] || 0 : 0;

  return `
    <div class="st-head">
      <button type="button" class="icon-btn" data-week="-1" aria-label="Semana anterior"><svg><use href="#i-back"/></svg></button>
      <div class="st-range"><b>${range}</b><span>${d0.getMonth() === d1.getMonth() ? `${d0.getDate()}–${d1.getDate()} de ${d1.toLocaleDateString('es-CO', { month: 'long' })}` : `${d0.getDate()} de ${d0.toLocaleDateString('es-CO', { month: 'short' }).replace('.', '')} – ${d1.getDate()} de ${d1.toLocaleDateString('es-CO', { month: 'short' }).replace('.', '')}`}</span></div>
      <button type="button" class="icon-btn st-next" data-week="1" aria-label="Semana siguiente" ${offset >= 0 ? 'disabled' : ''}><svg><use href="#i-back"/></svg></button>
    </div>
    <div class="st-kpis">
      <div><b>${fmtMin(total)}</b><span>en total</span></div>
      ${offset === 0 ? `<div><b>${fmtMin(todayMs)}</b><span>hoy</span></div><div><b>${st}</b><span>${st === 1 ? 'día seguido' : 'días seguidos'}</span></div>` : ''}
    </div>
    ${total ? `
    <div class="st-days" role="img" aria-label="Minutos por día">
      ${perDay.map((ms, i) => `<div class="st-day ${i === todayIdx ? 'today' : ''}" title="${DAY_NAMES[i]}: ${fmtMin(ms)}">
        <span class="st-val">${ms ? Math.round(ms / 60000) : ''}</span>
        <span class="st-col"><span style="height:${Math.round((ms / maxDay) * 100)}%"></span></span>
        <span class="st-lbl">${DAYS[i]}</span></div>`).join('')}
    </div>
    <h3 class="st-h">Por materia</h3>
    <div class="st-subs">
      ${subRows.map(([id, ms]) => {
        const s = subj.get(id);
        return `<div class="st-sub"><span class="st-name">${esc(s ? s.name : 'Sin materia')}</span>
          <span class="st-bar"><span style="width:${Math.max(2, Math.round((ms / maxSub) * 100))}%;background:${s ? s.color : '#9AA6B8'}"></span></span>
          <span class="st-min">${fmtMin(ms)}</span></div>`;
      }).join('')}
    </div>
    <p class="st-kinds">De eso: ${kinds.join(', ')}.</p>`
    : `<p class="st-empty">${offset === 0 ? 'Todavía no hay tiempo de estudio esta semana. Empieza un Pomodoro, repasa tarjetas o haz un examen y aquí se va sumando.' : 'No hay tiempo de estudio registrado esa semana.'}</p>`}`;
}
