import type { AlbatrossDailyReportContext } from '../albatross/daily-report';

const AREA_BRIEF_MARKER = 'data-lab86-area-brief-host';

interface AreaBriefCard {
  areaId: string;
  name: string;
  meta: string;
  imageUrl: string | null;
  rows: string[];
  tone: 'active' | 'question' | 'quiet';
}

export function injectReportAreaBrief(html: string, context: AlbatrossDailyReportContext | null): string {
  if (!html || !context) return html;
  if (html.includes(AREA_BRIEF_MARKER)) return html;
  const brief = renderReportAreaBriefHtml(context);
  const footerIndex = html.search(/<footer\b(?=[^>]*\bclass=(["'])[^"']*\bbrief-footer\b[^"']*\1)/i);
  if (footerIndex >= 0) return `${html.slice(0, footerIndex)}${brief}${html.slice(footerIndex)}`;
  const mainClose = html.toLowerCase().lastIndexOf('</main>');
  if (mainClose >= 0) return `${html.slice(0, mainClose)}${brief}${html.slice(mainClose)}`;
  const bodyClose = html.toLowerCase().lastIndexOf('</body>');
  if (bodyClose >= 0) return `${html.slice(0, bodyClose)}${brief}${html.slice(bodyClose)}`;
  return `${html}${brief}`;
}

export function renderReportAreaBriefHtml(context: AlbatrossDailyReportContext): string {
  const cards = areaBriefCards(context);
  const activeTotal = context.activeProjects.length + context.activeIntents.length;
  const reviewTotal = context.contextReview.length + context.completions.length;
  const summary = activeTotal
    ? `${activeTotal} active ${activeTotal === 1 ? 'plan/project' : 'plans/projects'} across your areas.`
    : context.askBeforeCentering.length
      ? `${context.askBeforeCentering.length} ${context.askBeforeCentering.length === 1 ? 'area wants' : 'areas want'} a decision before it takes over the brief.`
      : reviewTotal
        ? `${reviewTotal} recent ${reviewTotal === 1 ? 'area update' : 'area updates'} to review.`
        : 'Areas are quiet right now, but they are still available as places to work from.';
  return `<style id="lab86-area-brief-css">
.area-brief-host{grid-column:1/-1;margin:1.25rem 0 1.75rem;padding:1.05rem 0;border-top:1px solid var(--brief-hairline);border-bottom:1px solid var(--brief-hairline)}
.area-brief-head{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;margin-bottom:.85rem}
.area-brief-kicker{margin:0;color:var(--brief-accent-2,var(--brief-accent));font-size:.76rem;font-weight:750;letter-spacing:.02em}
.area-brief-title{margin:.15rem 0 0;font-family:var(--brief-font-display);font-size:clamp(1.2rem,2.2vw,1.8rem);font-weight:680;line-height:1.08;letter-spacing:var(--brief-display-tracking)}
.area-brief-summary{max-width:42rem;margin:.35rem 0 0;color:var(--brief-muted);font-size:.88rem;line-height:1.48}
.area-brief-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:.8rem}
.area-brief-card{min-width:0;border-left:3px solid var(--brief-hairline);padding:.2rem 0 .25rem .85rem}
.area-brief-card[data-tone="active"]{border-left-color:var(--brief-accent)}
.area-brief-card[data-tone="question"]{border-left-color:var(--brief-accent-2,var(--brief-accent))}
.area-brief-card-head{display:flex;align-items:flex-start;gap:.55rem}
.area-brief-mark{width:1.7rem;height:1.7rem;flex:none;border-radius:.38rem;object-fit:cover;background:var(--brief-accent-soft)}
.area-brief-card h3{margin:0;font-size:.98rem;line-height:1.2}
.area-brief-card p{margin:.16rem 0 0;color:var(--brief-muted);font-size:.76rem;line-height:1.35}
.area-brief-list{margin:.55rem 0 0;padding:0;list-style:none;display:grid;gap:.35rem}
.area-brief-list li{color:var(--brief-muted);font-size:.78rem;line-height:1.38;overflow-wrap:anywhere}
.area-brief-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.8rem}
.area-brief-host .btn{border:1px solid var(--brief-hairline);border-radius:999px;background:transparent;color:var(--brief-ink);padding:.48rem .76rem;cursor:pointer;white-space:nowrap;font-size:.78rem}
.area-brief-host .btn:hover{border-color:var(--brief-accent);color:var(--brief-accent);transform:translateY(-1px)}
@media(max-width:640px){.area-brief-head{display:block}.area-brief-actions{margin-top:.7rem}}
</style>${renderAreaBriefSection(cards, summary)}`;
}

function renderAreaBriefSection(cards: AreaBriefCard[], summary: string): string {
  const cardHtml = cards.length
    ? cards.map(renderAreaBriefCard).join('')
    : `<article class="area-brief-card" data-tone="quiet">
<div class="area-brief-card-head"><div class="area-brief-mark" aria-hidden="true"></div><div><h3>No active area pressure</h3><p>Use Areas when you want to work from a specific part of life.</p></div></div>
</article>`;
  return `<section class="block area-brief-host" ${AREA_BRIEF_MARKER}>
<div class="area-brief-head">
<div><p class="area-brief-kicker">Areas</p><h2 class="area-brief-title">Area briefs</h2><p class="area-brief-summary">${escapeHtml(summary)}</p></div>
<div class="area-brief-actions">${button('open_view', 'Open areas', { view: 'areas' })}</div>
</div>
<div class="area-brief-grid">${cardHtml}</div>
</section>`;
}

function renderAreaBriefCard(card: AreaBriefCard): string {
  const rows = card.rows.length
    ? `<ul class="area-brief-list">${card.rows
        .slice(0, 4)
        .map((row) => `<li>${escapeHtml(row)}</li>`)
        .join('')}</ul>`
    : '';
  const image = card.imageUrl
    ? `<img class="area-brief-mark" src="${escapeAttr(card.imageUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
    : `<div class="area-brief-mark" aria-hidden="true"></div>`;
  return `<article class="area-brief-card" data-tone="${escapeAttr(card.tone)}">
<div class="area-brief-card-head">${image}<div><h3>${escapeHtml(card.name)}</h3><p>${escapeHtml(card.meta)}</p></div></div>
${rows}
<div class="area-brief-actions">${button('open_area', 'Open brief', { areaId: card.areaId })}</div>
</article>`;
}

function areaBriefCards(context: AlbatrossDailyReportContext): AreaBriefCard[] {
  const byArea = new Map<string, AreaBriefCard>();
  const ensure = (
    areaId: string,
    input: Partial<Pick<AreaBriefCard, 'name' | 'meta' | 'imageUrl' | 'tone'>> = {},
  ) => {
    const existing = byArea.get(areaId);
    if (existing) {
      existing.name = input.name || existing.name;
      existing.meta = input.meta || existing.meta;
      existing.imageUrl = safeImageUrl(input.imageUrl) || existing.imageUrl;
      if (input.tone === 'question' || (input.tone === 'active' && existing.tone === 'quiet')) {
        existing.tone = input.tone;
      }
      return existing;
    }
    const card: AreaBriefCard = {
      areaId,
      name: input.name || readableAreaName(areaId),
      meta: input.meta || 'Area context',
      imageUrl: safeImageUrl(input.imageUrl),
      rows: [],
      tone: input.tone || 'quiet',
    };
    byArea.set(areaId, card);
    return card;
  };

  for (const area of context.includedAreas) {
    ensure(area.areaId, {
      name: area.name,
      meta: area.reason || 'Active area',
      imageUrl: area.imageUrl ?? area.faviconUrl ?? null,
      tone: 'active',
    });
  }
  for (const area of context.askBeforeCentering) {
    const card = ensure(area.areaId, {
      name: area.name,
      meta: 'Needs a decision',
      imageUrl: area.imageUrl ?? area.faviconUrl ?? null,
      tone: 'question',
    });
    card.rows.push(area.prompt);
  }
  for (const project of context.activeProjects) {
    if (!project.areaId) continue;
    const card = ensure(String(project.areaId), { tone: 'active' });
    card.rows.push(`Project: ${project.title}${project.outcome ? ` - ${project.outcome}` : ''}`);
  }
  for (const intent of context.activeIntents) {
    if (!intent.areaId) continue;
    const card = ensure(String(intent.areaId), { tone: 'active' });
    card.rows.push(`Plan: ${intent.text}`);
  }
  for (const item of context.contextReview) {
    if (!item.areaId) continue;
    const card = ensure(String(item.areaId), { meta: 'Needs context review' });
    card.rows.push(`${item.title}${item.reason ? ` - ${item.reason}` : ''}`);
  }
  for (const item of context.completions) {
    if (!item.areaId) continue;
    const card = ensure(String(item.areaId));
    card.rows.push(item.summary);
  }

  return [...byArea.values()].slice(0, 6);
}

function button(action: string, label: string, payload: Record<string, unknown>) {
  return `<button type="button" class="btn" data-action="${escapeAttr(action)}" data-payload="${escapeAttr(JSON.stringify(payload))}">${escapeHtml(label)}</button>`;
}

function readableAreaName(areaId: string) {
  return (
    areaId
      .replace(/^area[:_-]?/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase()) || 'Area'
  );
}

function safeImageUrl(value?: string | null) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
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
