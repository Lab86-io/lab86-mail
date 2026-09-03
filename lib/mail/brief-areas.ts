import type { AlbatrossDailyReportContext } from '../albatross/daily-report';
import { stripEmoji } from '../shared/format';
import type { BudgetAreaLine } from './brief-budget-document';
import { AREA_LINE_MAX_WORDS, clampWords } from './brief-prose';

// One line per area for the Daily Brief. At most 3 areas. The line comes from
// the stored area pulse when one exists, else from the report's area context.

export interface AreaPulseRecord {
  areaId: string;
  pulse?: {
    lastChange?: string | null;
    nextMove?: string | null;
    openQuestion?: string | null;
    prose?: string | null;
  } | null;
}

export const DAILY_BRIEF_AREA_LIMIT = 3;

function firstSentence(text: string | null | undefined): string {
  const clean = stripEmoji(String(text || ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const match = clean.match(/^.*?[.!?](?=\s|$)/);
  return (match ? match[0] : clean).trim();
}

export function budgetAreaLines(
  context: AlbatrossDailyReportContext | null | undefined,
  pulses: AreaPulseRecord[] = [],
): BudgetAreaLine[] {
  if (!context) return [];
  const pulseByArea = new Map(pulses.map((row) => [String(row.areaId), row.pulse ?? null]));
  const contextLine = new Map<string, string>();
  const remember = (areaId: string | undefined, line: string) => {
    if (!areaId || contextLine.has(areaId) || !line) return;
    contextLine.set(areaId, line);
  };
  for (const area of context.askBeforeCentering) remember(area.areaId, area.prompt);
  for (const project of context.activeProjects) remember(project.areaId, `Project: ${project.title}`);
  for (const intent of context.activeIntents) remember(intent.areaId, `Plan: ${intent.text}`);
  for (const item of context.contextReview) remember(item.areaId, item.title);
  for (const item of context.completions) remember(item.areaId, item.summary);

  const ordered: Array<{ areaId: string; name: string; reason?: string | null }> = [
    ...context.includedAreas.map((area) => ({ areaId: area.areaId, name: area.name, reason: area.reason })),
    ...context.askBeforeCentering.map((area) => ({ areaId: area.areaId, name: area.name })),
  ];
  const seen = new Set<string>();
  const lines: BudgetAreaLine[] = [];
  for (const area of ordered) {
    if (!area.areaId || seen.has(area.areaId)) continue;
    seen.add(area.areaId);
    const pulse = pulseByArea.get(area.areaId);
    const line =
      firstSentence(pulse?.nextMove) ||
      firstSentence(pulse?.openQuestion) ||
      firstSentence(pulse?.lastChange) ||
      firstSentence(contextLine.get(area.areaId)) ||
      firstSentence(area.reason);
    lines.push({
      areaId: area.areaId,
      name: stripEmoji(area.name || '').trim() || 'Area',
      line: line ? clampWords(line, AREA_LINE_MAX_WORDS) : '',
    });
    if (lines.length >= DAILY_BRIEF_AREA_LIMIT) break;
  }
  return lines;
}
