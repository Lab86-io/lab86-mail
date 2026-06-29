import { getAiRequestContext } from '../ai/context';
import {
  type BriefAction,
  type BriefBlock,
  type BriefComposition,
  compositionFromReport,
} from '../shared/brief-composition';
import type { DailyReport } from '../shared/types';
import { type BriefService, briefServicesFromIds } from './brief-services';
import { getDailyArt } from './daily-art';

export function buildNativeDailyReportArtifact(
  report: DailyReport,
  compositionInput?: BriefComposition,
): string {
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
  const composition = compositionInput || report.composition || compositionFromReport(report);
  const services = servicesForReport(report, composition);

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
.caption{max-width:1120px;margin:.55rem auto 0;padding:0 1.25rem;color:var(--brief-muted);font-size:.68rem;letter-spacing:.08em;text-transform:uppercase}
main{max-width:1120px;margin:0 auto;padding:clamp(2rem,5vw,4rem) 1.25rem 3rem}
.blocks{display:grid;grid-template-columns:minmax(0,1fr);gap:2rem}
@media (min-width:860px){.blocks{grid-template-columns:minmax(0,.92fr) minmax(18rem,.48fr)}}
.block{min-width:0}
.block-wide,.lede-block,.week,.chart-block,.timeline-block,.widget-block{grid-column:1/-1}
.lede-block{max-width:960px;margin-bottom:.5rem}
.lede{margin:0;font-family:var(--brief-font-display);font-size:clamp(1.35rem,3.4vw,2.45rem);font-style:italic;line-height:1.15;text-wrap:balance}
.lede + .lede{margin-top:1rem}
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
.tool-item,.check-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1rem;align-items:start;border-top:1px solid var(--brief-hairline);padding:.82rem 0}
.tool-item:first-child,.check-item:first-child{border-top:0}
.badge{display:inline-flex;align-items:center;border:1px solid var(--brief-hairline);border-radius:999px;padding:.12rem .48rem;color:var(--brief-muted);font-size:.68rem}
.chart-shell{border-top:1px solid var(--brief-hairline);padding-top:1rem}
.chart-row{display:grid;grid-template-columns:minmax(5rem,10rem) minmax(0,1fr) max-content;gap:.75rem;align-items:center;margin:.6rem 0}
.bar{height:.7rem;border-radius:999px;background:var(--brief-accent-soft);overflow:hidden}
.bar span{display:block;height:100%;border-radius:inherit;background:var(--brief-accent)}
.timeline{border-top:1px solid var(--brief-hairline)}
.timeline-item{display:grid;grid-template-columns:minmax(7rem,max-content) minmax(0,1fr);gap:1rem;padding:.8rem 0;border-bottom:1px solid var(--brief-hairline)}
.widget-frame{width:100%;min-height:280px;border:1px solid var(--brief-hairline);border-radius:14px;background:var(--brief-bg)}
.fallback{white-space:pre-wrap;color:var(--brief-muted);line-height:1.55}
.empty{padding:1rem 0;color:var(--brief-muted);border-top:1px solid var(--brief-hairline)}
.brief-footer{position:relative;margin-top:4.5rem;padding:4.4rem 1rem 5.5rem;overflow:hidden;text-align:center;color:var(--brief-muted)}
.brief-footer::before{content:"";position:absolute;top:0;left:50%;width:min(920px,100%);height:1px;transform:translateX(-50%);background:linear-gradient(90deg,transparent,var(--brief-hairline),transparent)}
.brief-footer::after{content:"";position:absolute;right:0;bottom:0;left:0;height:48%;opacity:.45;background-image:radial-gradient(var(--brief-hairline) .65px,transparent .65px);background-size:10px 10px;mask-image:linear-gradient(to bottom,transparent,black);pointer-events:none}
.brief-footer-line{position:relative;z-index:1;max-width:1200px;margin:0 auto;font-family:var(--brief-font-display);font-size:clamp(1.65rem,3vw,2.75rem);font-weight:650;line-height:1.18;letter-spacing:var(--brief-display-tracking);text-wrap:balance}
.brief-footer-line .soft{color:var(--brief-muted)}
.footer-brand,.footer-service{display:inline-flex;align-items:center;gap:.16em;color:var(--brief-ink);white-space:nowrap}
.footer-logo{width:.88em;height:.88em;flex:none;vertical-align:-.12em}
.footer-sep{color:var(--brief-muted)}
.brief-footer-love{position:relative;z-index:1;margin-top:1.55rem;font-family:var(--brief-font-display);font-size:clamp(1rem,2vw,1.35rem);line-height:1.2;color:var(--brief-muted);opacity:.72}
.footer-letter{display:inline-grid;place-items:center;width:1.25em;height:1.25em;margin-left:.1em;border:1px solid currentColor;border-radius:999px;font-size:.72em;line-height:1;text-transform:uppercase}
	@media (max-width:640px){.masthead{padding:2.5rem}.masthead h1{font-size:clamp(3.35rem,20vw,6rem)}.spine{display:none}.need,.event{grid-template-columns:1fr}.task{grid-template-columns:minmax(0,1fr) auto}.actions{justify-content:start}.caption,main{padding-left:1rem;padding-right:1rem}}
</style>
</head>
<body>
<header class="hero">
<img src="${escapeAttr(art.imageUrl)}" alt="" data-fallbacks="${escapeAttr(JSON.stringify(art.fallbacks))}" onerror="(function(img){try{var f=JSON.parse(img.getAttribute('data-fallbacks')||'[]');if(f.length){img.setAttribute('data-fallbacks',JSON.stringify(f.slice(1)));img.src=f[0];}else{img.onerror=null;img.style.display='none';var h=img.closest('.hero');if(h){h.style.background='var(--brief-accent-soft)';}}}catch(e){img.onerror=null;}})(this)">
<div class="spine left">${escapeHtml(localDate)}</div>
<div class="spine right">${escapeHtml(localTime)}</div>
<div class="masthead"><h1>The ${escapeHtml(weekday)} Brief</h1></div>
</header>
<div class="caption">${escapeHtml(art.credit)} · ${escapeHtml(art.source)}</div>
<main>
<div class="blocks">
${renderBlocks(composition.blocks, timezone)}
</div>
${renderBriefFooter(services)}
</main>
<script>
		var pendingRemovals={};
		var widgetActions=new Map();
		function syncWidgetActions(){var frames=document.querySelectorAll('iframe[data-widget-actions]');for(var i=0;i<frames.length;i++){try{widgetActions.set(frames[i].contentWindow,JSON.parse(frames[i].getAttribute('data-widget-actions')||'[]'));}catch(_){widgetActions.set(frames[i].contentWindow,[]);}}}
		syncWidgetActions();
		window.addEventListener('message',function(e){var d=e.data;if(d&&d.source==='lab86-brief-widget'){var allowed=widgetActions.get(e.source)||[];if(allowed.indexOf(d.action)!==-1){window.parent.postMessage({source:'lab86-daily-report',action:d.action,payload:d.payload||{}},'*');}}if(d&&d.source==='lab86-host'&&d.type==='theme'&&d.theme){for(var k in d.theme){document.documentElement.style.setProperty(k,d.theme[k]);}}if(d&&d.source==='lab86-host'&&d.payload&&d.payload.clientActionId){var row=pendingRemovals[d.payload.clientActionId];if(row){if(d.ok){row.remove();}else{row.style.opacity='';row.style.pointerEvents='';}delete pendingRemovals[d.payload.clientActionId];}}});
		document.addEventListener('click',function(e){var el=e.target.closest('[data-action]');if(!el)return;var action=el.getAttribute('data-action');var payload={};try{payload=JSON.parse(el.getAttribute('data-payload')||'{}');}catch(_){}var row=el.closest('[data-card-id],[data-thread-key]');if(row&&(action==='dismiss_task'||action==='dismiss_thread'||action==='resolve_thread'||(action==='toggle_task'&&payload.completed))){var id=String(Date.now())+String(Math.random()).slice(2);payload.clientActionId=id;pendingRemovals[id]=row;row.style.opacity='.45';row.style.pointerEvents='none';}window.parent.postMessage({source:'lab86-daily-report',action:action,payload:payload},'*');});
	</script>
</body>
</html>`;
}

function renderBlocks(blocks: BriefBlock[], timezone: string) {
  return blocks.map((block) => renderBlock(block, timezone)).join('');
}

function renderBlock(block: BriefBlock, timezone: string): string {
  switch (block.type) {
    case 'lede':
      return `<section class="block lede-block">${block.title ? `<h2 class="section-title">${escapeHtml(block.title)}</h2>` : ''}${block.paragraphs.map((paragraph) => `<p class="lede">${escapeHtml(paragraph)}</p>`).join('')}</section>`;
    case 'needs_you':
      return renderNeedsBlock(block);
    case 'task_digest':
      return renderTasksBlock(block);
    case 'week_ahead':
      return renderWeekBlock(block, timezone);
    case 'tool_digest':
      return renderToolBlock(block);
    case 'chart':
      return renderChartBlock(block);
    case 'timeline':
      return renderTimelineBlock(block, timezone);
    case 'prep_checklist':
      return renderChecklistBlock(block);
    case 'custom_widget':
      return renderCustomWidgetBlock(block);
    default:
      return '';
  }
}

function renderNeedsBlock(block: Extract<BriefBlock, { type: 'needs_you' }>) {
  if (!block.items.length) {
    return `<section><h2 class="section-title">Needs you</h2><div class="empty">No open thread needs you right now.</div></section>`;
  }
  return `<section class="block"><h2 class="section-title">${escapeHtml(block.title)}</h2><div class="needs">${block.items
    .map((item) => {
      const person = item.person || 'Mail';
      const title = [person, item.subject].filter(Boolean).join(' - ');
      return `<article class="need" data-thread-key="${escapeAttr(reportThreadKey(item.account, item.threadId))}" data-received-at="${escapeAttr(item.receivedAt ?? '')}">
		<div>
		<div class="tag">${escapeHtml(item.lane || 'Thread')}</div>
		<h3>${escapeHtml(title)}</h3>
		<p>${escapeHtml(item.reason || 'Review this thread when you have a moment.')}</p>
		<div class="meta">${escapeHtml(ageLine(item.receivedAt ?? undefined))}</div>
		</div>
		<div class="actions">
		${renderActions(
      item.actions.length
        ? item.actions
        : [
            {
              action: 'open_thread',
              label: 'Open',
              payload: { account: item.account, threadId: item.threadId },
              style: 'primary',
            },
            {
              action: 'resolve_thread',
              label: 'Done',
              payload: threadPayload(item),
              style: 'quiet',
            },
            {
              action: 'dismiss_thread',
              label: 'Remove',
              payload: threadPayload(item),
              style: 'quiet',
            },
          ],
    )}
		</div>
		</article>`;
    })
    .join('')}</div></section>`;
}

function renderTasksBlock(block: Extract<BriefBlock, { type: 'task_digest' }>) {
  const rows = block.tasks.length
    ? block.tasks
        .map(
          (task) => `<article class="task" data-card-id="${escapeAttr(task.cardId)}">
		<div>
		<h3>${escapeHtml(task.title)}</h3>
		<div class="meta">${escapeHtml(task.meta || (task.dueAt ? `Due ${shortDate(task.dueAt)}` : ''))}</div>
		</div>
		<div class="task-actions">
		${renderActions(
      task.actions.length
        ? task.actions
        : [
            {
              action: 'toggle_task',
              label: 'Done',
              payload: { cardId: task.cardId, completed: true, title: task.title },
              style: 'quiet',
            },
            {
              action: 'dismiss_task',
              label: 'Remove',
              payload: { cardId: task.cardId, title: task.title },
              style: 'quiet',
            },
          ],
    )}
		</div>
		</article>`,
        )
        .join('')
    : `<div class="empty">No active task context is waiting.</div>`;
  return `<section class="block"><h2 class="section-title">${escapeHtml(block.title)}</h2>${rows}<div class="actions">${button('open_view', 'Open tasks', { view: 'tasks' })}</div></section>`;
}

function renderWeekBlock(block: Extract<BriefBlock, { type: 'week_ahead' }>, timezone: string) {
  const rows = block.events.length
    ? block.events
        .map(
          (event) => `<article class="event">
	<div class="time">${escapeHtml(eventWindow(event, timezone))}</div>
	<div>
	<h3>${escapeHtml(event.title)}</h3>
	${event.location ? `<div class="meta">${escapeHtml(event.location)}</div>` : ''}
	${event.prep ? `<p class="meta">${escapeHtml(event.prep)}</p>` : ''}
	</div>
	<div class="actions">${renderActions(event.actions.length ? event.actions : [{ action: 'open_event', label: 'Open', payload: { account: event.account, eventId: event.eventId }, style: 'secondary' }])}</div>
	</article>`,
        )
        .join('')
    : `<div class="empty">No calendar context is scheduled for the next week.</div>`;
  return `<section class="block week"><h2 class="section-title">${escapeHtml(block.title)}</h2><div class="agenda">${rows}</div><div class="actions" style="margin-top:1rem">${button('open_view', 'Open calendar', { view: 'calendar' })}</div></section>`;
}

function renderToolBlock(block: Extract<BriefBlock, { type: 'tool_digest' }>) {
  const rows = block.items.length
    ? block.items
        .map(
          (item) => `<article class="tool-item">
	<div>
	<div class="tag">${escapeHtml(item.server)}</div>
	<h3>${item.url ? `<a href="${escapeAttr(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</h3>
	<div class="meta">${escapeHtml([item.state, item.author].filter(Boolean).join(' - '))}</div>
	${item.reason ? `<p class="meta">${escapeHtml(item.reason)}</p>` : ''}
	</div>
	${item.actions.length ? `<div class="actions">${renderActions(item.actions)}</div>` : ''}
	</article>`,
        )
        .join('')
    : `<div class="empty">No connected-tool context is waiting.</div>`;
  return `<section class="block block-wide"><h2 class="section-title">${escapeHtml(block.title)}</h2>${rows}</section>`;
}

function renderChartBlock(block: Extract<BriefBlock, { type: 'chart' }>) {
  const max = Math.max(...block.data.map((item) => item.value), 1);
  const rows = block.data
    .map((item) => {
      const pct = Math.max(2, Math.round((item.value / max) * 100));
      return `<div class="chart-row"><span>${escapeHtml(item.label)}</span><div class="bar"><span style="width:${pct}%"></span></div><strong>${escapeHtml(item.value)}</strong></div>`;
    })
    .join('');
  return `<section class="block chart-block"><h2 class="section-title">${escapeHtml(block.title)}</h2>${block.description ? `<p class="muted">${escapeHtml(block.description)}</p>` : ''}<div class="chart-shell">${rows}</div></section>`;
}

function renderTimelineBlock(block: Extract<BriefBlock, { type: 'timeline' }>, timezone: string) {
  const rows = block.items
    .map(
      (item) => `<article class="timeline-item">
	<div class="time">${escapeHtml(item.at ? shortDate(item.at, timezone) : '')}</div>
	<div><h3>${escapeHtml(item.label)}</h3>${item.detail ? `<p class="meta">${escapeHtml(item.detail)}</p>` : ''}</div>
	</article>`,
    )
    .join('');
  return `<section class="block timeline-block"><h2 class="section-title">${escapeHtml(block.title)}</h2><div class="timeline">${rows}</div></section>`;
}

function renderChecklistBlock(block: Extract<BriefBlock, { type: 'prep_checklist' }>) {
  const rows = block.items
    .map(
      (item) => `<article class="check-item">
	<div><h3>${escapeHtml(item.label)}</h3>${item.detail ? `<p class="meta">${escapeHtml(item.detail)}</p>` : ''}</div>
	${item.action ? `<div class="actions">${renderActions([item.action])}</div>` : ''}
	</article>`,
    )
    .join('');
  return `<section class="block block-wide"><h2 class="section-title">${escapeHtml(block.title)}</h2>${rows}</section>`;
}

function renderCustomWidgetBlock(block: Extract<BriefBlock, { type: 'custom_widget' }>) {
  if (!isAllowedWidgetHtml(block.html)) {
    return `<section class="block widget-block"><h2 class="section-title">${escapeHtml(block.title)}</h2><div class="fallback">${escapeHtml(block.fallbackMarkdown)}</div></section>`;
  }
  return `<section class="block widget-block"><h2 class="section-title">${escapeHtml(block.title)}</h2><iframe class="widget-frame" title="${escapeAttr(block.title)}" sandbox="allow-scripts" data-widget-actions="${escapeAttr(JSON.stringify(block.allowedActions))}" srcdoc="${escapeAttr(block.html)}"></iframe></section>`;
}

function button(action: string, label: string, payload: Record<string, unknown>, variant = '') {
  return `<button type="button" class="btn ${variant}" data-action="${escapeAttr(action)}" data-payload="${escapeAttr(JSON.stringify(payload))}">${escapeHtml(label)}</button>`;
}

function renderActions(actions: BriefAction[]) {
  return actions
    .map((action) => {
      const cls = action.style === 'primary' ? 'primary' : action.style === 'quiet' ? 'icon-btn' : '';
      if (action.style === 'quiet') {
        const label = /remove|dismiss/i.test(action.label) ? '&times;' : '&#10003;';
        return `<button type="button" class="${cls}" data-action="${escapeAttr(action.action)}" data-payload="${escapeAttr(JSON.stringify(action.payload))}" aria-label="${escapeAttr(action.label)}" title="${escapeAttr(action.label)}">${label}</button>`;
      }
      return button(action.action, action.label, action.payload, cls);
    })
    .join('');
}

function reportThreadKey(account: string, threadId: string) {
  return JSON.stringify([account, threadId]);
}

function threadPayload(item: {
  account: string;
  threadId: string;
  subject?: string;
  receivedAt?: number | null;
  trackedThreadId?: string;
}) {
  return {
    account: item.account,
    threadId: item.threadId,
    subject: item.subject,
    receivedAt: item.receivedAt ?? null,
    trackedThreadId: item.trackedThreadId,
  };
}

function servicesForReport(report: DailyReport, composition: BriefComposition): BriefService[] {
  const hasCalendar = composition.blocks.some((block) => block.type === 'week_ahead' && block.events.length);
  const hasTasks = composition.blocks.some((block) => block.type === 'task_digest' && block.tasks.length);
  const serviceIds = [
    ...(composition.services || []),
    ...(report.services || []),
    ...(report.sections?.mcp || []).map((item) => item.server),
    ...(hasCalendar ? ['calendar'] : []),
    ...(hasTasks ? ['tasks'] : []),
  ];
  if (!serviceIds.length && (report.accounts || []).length) serviceIds.push('mail');
  if (!serviceIds.length) serviceIds.push('mail');
  return briefServicesFromIds(serviceIds);
}

function renderBriefFooter(services: BriefService[]) {
  return `<footer class="brief-footer">
<div class="brief-footer-line"><span class="soft">Made for you by</span> <span class="footer-brand">Lab86</span> <span class="soft">using your</span> ${renderServiceList(services)}<span class="footer-sep">.</span></div>
<div class="brief-footer-love">With love from ${renderLab86Letters()}</div>
</footer>`;
}

function renderServiceList(services: BriefService[]) {
  if (!services.length) return `<span class="footer-service">Mail</span>`;
  return services
    .map((service, index) => {
      const prefix =
        index === 0 ? '' : services.length === 2 ? ' and ' : index === services.length - 1 ? ', and ' : ', ';
      return `${prefix}<span class="footer-service">${service.logoSvg}<span>${escapeHtml(service.label)}</span></span>`;
    })
    .join('');
}

function renderLab86Letters() {
  return ['L', 'A', 'B', '8', '6'].map((letter) => `<span class="footer-letter">${letter}</span>`).join('');
}

function eventWindow(event: { startAt: number; endAt: number; allDay?: boolean | null }, timezone: string) {
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

function isAllowedWidgetHtml(html: string) {
  const value = String(html || '').toLowerCase();
  if (/<script[^>]+\bsrc\s*=/.test(value)) return false;
  if (/<iframe\b/.test(value)) return false;
  if (/\b(fetch|xmlhttprequest|websocket|eventsource)\s*\(/.test(value)) return false;
  if (/\b(localstorage|sessionstorage|indexeddb|document\.cookie)\b/.test(value)) return false;
  if (/\b(src|href)\s*=\s*["']?\s*(https?:|\/\/)/.test(value)) return false;
  return true;
}
