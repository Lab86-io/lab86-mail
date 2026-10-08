// What a step run observed, as text for the proof check (lib/albatross/evidence-gate.ts,
// source 'run'). The model's tool results are facts the system recorded; the
// run's own summary is a claim. The proof check reads both, and only the facts
// can carry a step.

import { truncateText } from '../shared/text';

/** Tool results that never go to the proof check: the handoff itself, and personal or secure values. */
const NOT_EVIDENCE = new Set([
  'step_handoff',
  'personal_details_get',
  'personal_details_save',
  'secure_details_list',
  'secure_fetch',
  'list_accounts',
  'spreadsheet_capabilities',
]);

/** One tool result, as the AI SDK step reports it. */
export interface ObservedToolResult {
  toolName?: string;
  output?: unknown;
  /** Older SDK shape. */
  result?: unknown;
}

export interface ObservedStep {
  toolResults?: readonly ObservedToolResult[] | null;
}

export const OBSERVED_PER_CALL = 600;
export const OBSERVED_TOTAL = 5_000;

function compact(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * The "Observed" lines for one run. Newest results win when the total is over
 * the limit: the end of a run is closest to what the step needed.
 */
export function observedEvidence(
  steps: readonly ObservedStep[] | null | undefined,
  limits: { perCall?: number; total?: number } = {},
): string {
  const perCall = limits.perCall ?? OBSERVED_PER_CALL;
  const total = limits.total ?? OBSERVED_TOTAL;
  const lines: string[] = [];
  for (const step of steps || []) {
    for (const result of step?.toolResults || []) {
      const name = String(result?.toolName || '').trim();
      if (!name || NOT_EVIDENCE.has(name)) continue;
      const body = compact(result.output ?? result.result);
      if (!body) continue;
      lines.push(`Observed ${name}: ${truncateText(body, perCall)}`);
    }
  }
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (used + line.length + 1 > total) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  return kept.join('\n');
}
