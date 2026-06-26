import { getAiRequestContext } from '../ai/context';
import type {
  DailyReport,
  DailyReportCalendarItem,
  DailyReportItem,
  DailyReportTaskItem,
} from '../shared/types';
import { getDailyArt } from './daily-art';

const MAX_NEEDS = 8;
const MAX_TASKS = 8;
const MAX_EVENTS = 12;

export function buildNativeDailyReportArtifact(report: DailyReport): string {
  const timezone = getAiRequestContext().userTimezone || 'UTC';
  const generatedAt = report.generatedAt || Date.now();
  const art = getDailyArt(generatedAt);
  const weekday = formatInTimezone(generatedAt, timezone, { weekday: 'long' });
  const localDate = formatInTimezone(generatedAt, timezone, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).toUpperCase();
  const localTime = formatInTimezone(generatedAt, timezone, { hour: 'numeric', minute: '2-digit' });
  const sections = report.sections || ({} as DailyReport['sections']);
  const needs = [
    ...withLane(sections.replyOwed || [], 'Reply owed'),
    ...withLane(sections.followUpOwed || [], 'Follow-up'),
    ...withLane(sections.timeSensitive || [], 'Time-sensitive'),
    ...withLane(sections.newPeople || [], 'New person'),
    ...withLane(sections.tracked || [], 'Tracked'),
  ].slice(0, MAX_NEEDS);
  const tasks = (sections.tasks || []).filter((task) => !task.completedAt).slice(0, MAX_TASKS);
  const events = (sections.calendar || [])
    .slice()
    .sort((a, b) => Number(a.startAt || 0) - Number(b.startAt || 0))
    .slice(0, MAX_EVENTS);
  const serviceText = serviceLine(report, Boolean(events.length), Boolean(tasks.length));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..600&family=Instrument+Serif:ital@0;1&family=Instrument+Sans:wght@400..700&family=Averia+Serif+Libre:wght@400;700&family=Geist:wght@400..700&family=Hanken+Grotesk:wght@400..700&display=swap">
<style>
*,*::before,*::after{box-sizing:border-box}
:root{--brief-bg:#faf9f6;--brief-ink:#1a1a1a;--brief-muted:#6b6b6b;--brief-hairline:#e6e3dc;--brief-accent:#c2683c;--brief-accent-soft:rgba(194,104,60,.14);--brief-font-display:'Fraunces',Georgia,serif;--brief-font-body:'Geist',system-ui,sans-serif;--brief-display-tracking:0em}
html,body{margin:0;min-height:100%;background:var(--brief-bg);color:var(--brief-ink);font-family:var(--brief-font-body);font-size:16px}
body{overflow-x:hidden}
button,a{font:inherit}
.hero{position:relative;min-height:280px;height:min(46vh,460px);overflow:hidden;background:#111;color:white}
.hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:saturate(.96) contrast(1.03)}
.hero::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.58),rgba(0,0,0,.18) 34%,rgba(0,0,0,.38)),linear-gradient(0deg,rgba(0,0,0,.42),rgba(0,0,0,0) 42%)}
.masthead{position:absolute;inset:0;z-index:1;display:grid;place-items:center;text-align:center;padding:3rem 4rem}
.masthead h1{max-width:12ch;margin:0;font-family:var(--brief-font-display);font-size:clamp(4rem,11vw,9.5rem);font-weight:650;font-style:italic;line-height:.82;letter-spacing:var(--brief-display-tracking);text-wrap:balance;text-shadow:0 2px 30px rgba(0,0,0,.48)}
.spine{position:absolute;z-index:2;top:1.5rem;bottom:1.5rem;display:flex;align-items:center;font-size:.72rem;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.84);writing-mode:vertical-rl}
.spine.left{left:1rem}.spine.right{right:1rem;transform:rotate(180deg)}
.caption{max-width:1080px;margin:.55rem auto 0;padding:0 1.25rem;color:var(--brief-muted);font-size:.68rem;letter-spacing:.08em;text-transform:uppercase}
main{max-width:1080px;margin:0 auto;padding:clamp(2rem,5vw,4rem) 1.25rem 3rem}
.lede{max-width:920px;margin:0 0 2.5rem;font-family:var(--brief-font-display);font-size:clamp(1.35rem,3.4vw,2.45rem);font-style:italic;line-height:1.15;text-wrap:balance}
.grid{display:grid;grid-template-columns:minmax(0,1fr);gap:2rem}
@media (min-width:860px){.grid{grid-template-columns:minmax(0,.92fr) minmax(18rem,.48fr)}}
section{min-width:0}
.section-title{display:flex;align-items:center;gap:.85rem;margin:0 0 1rem;font-family:var(--brief-font-display);font-size:.82rem;font-weight:700;letter-spacing:max(var(--brief-display-tracking),.12em);text-transform:uppercase;color:var(--brief-ink)}
.section-title::after{content:"";height:1px;flex:1;background:var(--brief-hairline)}
.needs{display:grid;gap:.8rem}
.need{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.8rem;padding:1rem 0;border-top:1px solid var(--brief-hairline)}
.need:first-child{border-top:0}
.tag{font-size:.68rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--brief-accent)}
.need h3{margin:.25rem 0 .35rem;font-family:var(--brief-font-display);font-size:1.2rem;line-height:1.12;letter-spacing:var(--brief-display-tracking)}
.need p,.muted{margin:0;color:var(--brief-muted);line-height:1.5}
.actions{display:flex;align-items:start;gap:.5rem}
.btn{border:1px solid var(--brief-hairline);border-radius:999px;background:transparent;color:var(--brief-ink);padding:.5rem .8rem;cursor:pointer;white-space:nowrap}
.btn.primary{border-color:var(--brief-accent);background:var(--brief-accent);color:var(--brief-bg)}
.btn:hover{transform:translateY(-1px)}
.side{display:grid;gap:1.6rem;align-content:start}
.task,.event{border-top:1px solid var(--brief-hairline);padding:.78rem 0}
.task:first-child,.event:first-child{border-top:0}
.task{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.75rem;align-items:start}
.task h3,.event h3{margin:0;font-size:.96rem;line-height:1.25}
.task-actions{display:flex;align-items:center;gap:.25rem}
.icon-btn{display:grid;place-items:center;width:2rem;height:2rem;border:1px solid var(--brief-hairline);border-radius:.5rem;background:transparent;color:var(--brief-muted);cursor:pointer}
.icon-btn:hover{color:var(--brief-accent);background:var(--brief-accent-soft)}
.meta{margin-top:.28rem;color:var(--brief-muted);font-size:.78rem;line-height:1.35}
.week{grid-column:1/-1;width:100%;max-width:100%;min-width:0;margin-top:1rem}
.agenda{border-top:1px solid var(--brief-hairline)}
.event{display:grid;grid-template-columns:minmax(7rem,max-content) minmax(0,1fr) auto;gap:1rem;align-items:start}
.time{color:var(--brief-accent);font-weight:700;font-size:.82rem;white-space:nowrap}
.event h3,.event .meta{overflow-wrap:anywhere}
.empty{padding:1rem 0;color:var(--brief-muted);border-top:1px solid var(--brief-hairline)}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--brief-hairline);color:var(--brief-muted);font-size:.74rem}
	@media (max-width:640px){.masthead{padding:2.5rem}.masthead h1{font-size:clamp(3.35rem,20vw,6rem)}.spine{display:none}.need,.event{grid-template-columns:1fr}.task{grid-template-columns:minmax(0,1fr) auto}.actions{justify-content:start}.caption,main{padding-left:1rem;padding-right:1rem}}
</style>
</head>
<body>
<header class="hero">
<img src="${escapeAttr(art.imageUrl)}" alt="">
<div class="spine left">${escapeHtml(localDate)}</div>
<div class="spine right">${escapeHtml(localTime)}</div>
<div class="masthead"><h1>The ${escapeHtml(weekday)} Brief</h1></div>
</header>
<div class="caption">${escapeHtml(art.credit)} · ${escapeHtml(art.source)}</div>
<main>
<p class="lede">${escapeHtml(report.narrative || fallbackNarrative(needs, tasks, events))}</p>
<div class="grid">
${renderNeeds(needs)}
<aside class="side">
${renderTasks(tasks)}
</aside>
${renderEvents(events, timezone)}
</div>
<footer>Built for you using your ${escapeHtml(serviceText)} with care.</footer>
</main>
<script>
	var pendingRemovals={};
	window.addEventListener('message',function(e){var d=e.data;if(d&&d.source==='lab86-host'&&d.type==='theme'&&d.theme){for(var k in d.theme){document.documentElement.style.setProperty(k,d.theme[k]);}}if(d&&d.source==='lab86-host'&&d.payload&&d.payload.clientActionId){var row=pendingRemovals[d.payload.clientActionId];if(row){if(d.ok){row.remove();}else{row.style.opacity='';row.style.pointerEvents='';}delete pendingRemovals[d.payload.clientActionId];}}});
	document.addEventListener('click',function(e){var el=e.target.closest('[data-action]');if(!el)return;var action=el.getAttribute('data-action');var payload={};try{payload=JSON.parse(el.getAttribute('data-payload')||'{}');}catch(_){}var row=el.closest('[data-card-id],[data-thread-key]');if(row&&(action==='dismiss_task'||action==='dismiss_thread'||action==='resolve_thread'||(action==='toggle_task'&&payload.completed))){var id=String(Date.now())+String(Math.random()).slice(2);payload.clientActionId=id;pendingRemovals[id]=row;row.style.opacity='.45';row.style.pointerEvents='none';}window.parent.postMessage({source:'lab86-daily-report',action:action,payload:payload},'*');});
</script>
</body>
</html>`;
}

function withLane(items: DailyReportItem[], laneLabel: string) {
  return items.map((item) => ({ ...item, laneLabel }));
}

function renderNeeds(items: Array<DailyReportItem & { laneLabel: string }>) {
  if (!items.length) {
    return `<section><h2 class="section-title">Needs you</h2><div class="empty">No open thread needs you right now.</div></section>`;
  }
  return `<section><h2 class="section-title">Needs you</h2><div class="needs">${items
    .map((item) => {
      const person = item.people?.[0] || 'Mail';
      const title = [person, item.subject].filter(Boolean).join(' - ');
      return `<article class="need" data-thread-key="${escapeAttr(reportThreadKey(item.account, item.threadId))}" data-received-at="${escapeAttr(item.receivedAt ?? '')}">
	<div>
	<div class="tag">${escapeHtml(item.laneLabel)}</div>
	<h3>${escapeHtml(title)}</h3>
	<p>${escapeHtml(item.whyItMatters || item.nextAction || 'Review this thread when you have a moment.')}</p>
	<div class="meta">${escapeHtml(ageLine(item.receivedAt ?? undefined))}</div>
	</div>
	<div class="actions">
	${button('open_thread', 'Open', { account: item.account, threadId: item.threadId }, 'primary')}
	${iconButton('resolve_thread', '&#10003;', threadPayload(item), 'Mark resolved')}
	${iconButton('dismiss_thread', '&times;', threadPayload(item), 'Remove from future briefs')}
	</div>
	</article>`;
    })
    .join('')}</div></section>`;
}

function renderTasks(tasks: DailyReportTaskItem[]) {
  const rows = tasks.length
    ? tasks
        .map(
          (task) => `<article class="task" data-card-id="${escapeAttr(task.cardId)}">
	<div>
	<h3>${escapeHtml(task.title)}</h3>
	<div class="meta">${escapeHtml([task.boardTitle, task.columnName, task.dueAt ? `Due ${shortDate(task.dueAt)}` : ''].filter(Boolean).join(' - '))}</div>
	</div>
	<div class="task-actions">
	${iconButton('toggle_task', '&#10003;', { cardId: task.cardId, completed: true, title: task.title }, 'Complete task')}
	${iconButton('dismiss_task', '&times;', { cardId: task.cardId, title: task.title }, 'Remove from future briefs')}
	</div>
	</article>`,
        )
        .join('')
    : `<div class="empty">No active task context is waiting.</div>`;
  return `<section><h2 class="section-title">Tasks</h2>${rows}<div class="actions">${button('open_view', 'Open tasks', { view: 'tasks' })}</div></section>`;
}

function renderEvents(events: DailyReportCalendarItem[], timezone: string) {
  const rows = events.length
    ? events
        .map(
          (event) => `<article class="event">
<div class="time">${escapeHtml(eventWindow(event, timezone))}</div>
<div>
<h3>${escapeHtml(event.title)}</h3>
${event.location ? `<div class="meta">${escapeHtml(event.location)}</div>` : ''}
</div>
<div class="actions">${button('open_event', 'Open', { account: event.account, eventId: event.eventId })}</div>
</article>`,
        )
        .join('')
    : `<div class="empty">No calendar context is scheduled for the next week.</div>`;
  return `<section class="week"><h2 class="section-title">The week ahead</h2><div class="agenda">${rows}</div><div class="actions" style="margin-top:1rem">${button('open_view', 'Open calendar', { view: 'calendar' })}</div></section>`;
}

function button(action: string, label: string, payload: Record<string, unknown>, variant = '') {
  return `<button type="button" class="btn ${variant}" data-action="${escapeAttr(action)}" data-payload="${escapeAttr(JSON.stringify(payload))}">${escapeHtml(label)}</button>`;
}

function iconButton(action: string, labelHtml: string, payload: Record<string, unknown>, title: string) {
  return `<button type="button" class="icon-btn" data-action="${escapeAttr(action)}" data-payload="${escapeAttr(JSON.stringify(payload))}" aria-label="${escapeAttr(title)}" title="${escapeAttr(title)}">${labelHtml}</button>`;
}

function reportThreadKey(account: string, threadId: string) {
  return JSON.stringify([account, threadId]);
}

function threadPayload(item: DailyReportItem) {
  return {
    account: item.account,
    threadId: item.threadId,
    subject: item.subject,
    receivedAt: item.receivedAt ?? null,
    trackedThreadId: item.trackedThreadId,
  };
}

function serviceLine(report: DailyReport, hasCalendar: boolean, hasTasks: boolean) {
  const services = new Set<string>();
  if ((report.accounts || []).length) services.add('Mail');
  if (hasCalendar) services.add('Calendar');
  if (hasTasks) services.add('Tasks');
  if (!services.size) services.add('Mail');
  const values = [...services];
  if (values.length <= 1) return values[0];
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

function fallbackNarrative(
  needs: Array<DailyReportItem & { laneLabel: string }>,
  tasks: DailyReportTaskItem[],
  events: DailyReportCalendarItem[],
) {
  const parts = [];
  if (needs.length) parts.push(`${needs.length} thread${needs.length === 1 ? '' : 's'} need attention`);
  if (events.length)
    parts.push(`${events.length} calendar item${events.length === 1 ? '' : 's'} shape the week`);
  if (tasks.length) parts.push(`${tasks.length} task${tasks.length === 1 ? '' : 's'} are active`);
  return parts.length
    ? `Here is the shape of the day: ${parts.join(', ')}.`
    : 'A quiet brief today: nothing urgent is waiting.';
}

function eventWindow(event: DailyReportCalendarItem, timezone: string) {
  if (event.allDay) return shortDate(event.startAt, timezone);
  const date = shortDate(event.startAt, timezone);
  const start = formatInTimezone(event.startAt, timezone, { hour: 'numeric', minute: '2-digit' });
  const end = formatInTimezone(event.endAt, timezone, { hour: 'numeric', minute: '2-digit' });
  return `${date} ${start}-${end}`;
}

function ageLine(receivedAt?: number) {
  if (!receivedAt) return '';
  const days = Math.max(0, Math.floor((Date.now() - receivedAt) / 86_400_000));
  if (days === 0) return 'Received today';
  if (days === 1) return 'Received yesterday';
  return `Received ${days} days ago`;
}

function shortDate(ts: number, timezone?: string) {
  return formatInTimezone(ts, timezone || getAiRequestContext().userTimezone || 'UTC', {
    month: 'short',
    day: 'numeric',
  });
}

function formatInTimezone(ts: number, timezone: string, options: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...options }).format(new Date(ts));
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(new Date(ts));
  }
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: unknown) {
  return escapeHtml(value);
}
