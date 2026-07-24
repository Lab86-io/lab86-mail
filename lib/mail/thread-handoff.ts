import { stripEmoji } from '../shared/format';
import type { DailyReportItem, ReportLane, ThreadInsight, TrackedThread } from '../shared/types';

const MAX_RECOMMENDATION_LENGTH = 280;
const GENERIC_RECOMMENDATION = /^(reply|respond|follow[\s-]?up|nudge|review|open|check|handle|act)\.?$/i;
const GENERIC_OPEN_LOOP = /^(reply|reply owed|follow[\s-]?up|follow[\s-]?up owed|review)\.?$/i;

export interface RecommendationInput {
  candidate?: unknown;
  lane?: ReportLane | string | null;
  people?: string[];
  subject?: string;
  openLoops?: string[];
}

export function normalizeRecommendation(value: unknown): string | undefined {
  const recommendation = stripEmoji(String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RECOMMENDATION_LENGTH);
  if (!recommendation || GENERIC_RECOMMENDATION.test(recommendation)) return undefined;
  return recommendation;
}

export function deterministicRecommendation(input: RecommendationInput): string | undefined {
  const lane = String(input.lane || '');
  if (!isActionableLane(lane)) return undefined;

  const person = cleanPerson(input.people?.[0]);
  const subject = cleanSubject(input.subject);
  const openLoop = (input.openLoops || [])
    .map((value) =>
      stripEmoji(String(value || ''))
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .find((value) => value && !GENERIC_OPEN_LOOP.test(value));

  if (lane === 'reply_owed') {
    return boundedSentence(
      `Reply${person ? ` to ${person}` : ''}${subject ? ` about “${subject}”` : ''}${
        openLoop ? ` and address ${openLoop}` : ''
      }`,
    );
  }
  if (lane === 'follow_up_owed') {
    return boundedSentence(
      `Follow up${person ? ` with ${person}` : ''}${subject ? ` about “${subject}”` : ''}${
        openLoop ? `; ask about ${openLoop}` : ''
      }`,
    );
  }
  return boundedSentence(
    `Review${subject ? ` “${subject}”` : ''}${person ? ` with ${person}` : ''}${
      openLoop ? ` and close the loop on ${openLoop}` : ' and decide the next step'
    }`,
  );
}

export function recommendationFor(input: RecommendationInput): string | undefined {
  return normalizeRecommendation(input.candidate) || deterministicRecommendation(input);
}

export function isActionableLane(lane: unknown): boolean {
  return lane === 'reply_owed' || lane === 'follow_up_owed' || lane === 'tracked';
}

export function isActionableReportItem(item: Pick<DailyReportItem, 'lane' | 'trackedThreadId'>): boolean {
  return isActionableLane(item.lane) || Boolean(item.trackedThreadId);
}

export function recommendationForInsight(
  insight: ThreadInsight,
  tracked?: Pick<TrackedThread, 'nextAction' | 'openLoops'> | null,
): string | undefined {
  return recommendationFor({
    candidate: insight.nextAction || tracked?.nextAction,
    lane: insight.lane,
    people: insight.people,
    subject: insight.subject,
    openLoops: insight.openLoops.length ? insight.openLoops : tracked?.openLoops,
  });
}

function cleanPerson(value: unknown): string {
  return stripEmoji(String(value ?? ''))
    .replace(/\s*<[^>]+>\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function cleanSubject(value: unknown): string {
  const subject = stripEmoji(String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (!subject || subject === '(no subject)') return '';
  return subject.replace(/^re:\s*/i, '').slice(0, 120);
}

function boundedSentence(value: string): string {
  const clipped = value.replace(/\s+/g, ' ').trim().slice(0, MAX_RECOMMENDATION_LENGTH);
  return /[.!?]$/.test(clipped) ? clipped : `${clipped}.`;
}
