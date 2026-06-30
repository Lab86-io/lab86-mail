import { describe, expect, test } from 'bun:test';
import {
  areasStats,
  buildAreaDetail,
  buildAreaSummaries,
  buildIntentWorkbench,
  buildNoiseRules,
  buildRecentCorrections,
  buildReviewDetail,
  buildReviewQueue,
  intentsStats,
  resolveArtifact,
  unassignedStats,
} from '../components/albatross/surface-data';

describe('Areas surface selectors', () => {
  test('area summaries are sorted by priority and expose fact roll-ups', () => {
    const summaries = buildAreaSummaries();
    expect(summaries.length).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < summaries.length; i += 1) {
      expect(summaries[i].area.priority).toBeGreaterThanOrEqual(summaries[i - 1].area.priority);
    }
    const cardhunt = summaries.find((s) => s.area.id === 'area_cardhunt');
    expect(cardhunt?.factCounts.verified).toBeGreaterThan(0);
    expect(cardhunt?.factCounts.rejected).toBeGreaterThan(0);
  });

  test('area detail groups facts by status and only verified facts carry confirmations', () => {
    const detail = buildAreaDetail('area_cardhunt');
    expect(detail).not.toBeNull();
    expect(detail?.facts.verified.length).toBeGreaterThan(0);
    expect(detail?.facts.candidate.length).toBeGreaterThan(0);
    expect(detail?.facts.rejected.length).toBeGreaterThan(0);
    for (const fact of detail?.facts.verified ?? []) {
      expect(fact.confirmationRefs.length).toBeGreaterThan(0);
    }
    for (const fact of detail?.facts.candidate ?? []) {
      expect(fact.confirmationRefs.length).toBe(0);
    }
  });

  test('linked artifacts resolve to a human title and a confidence in range', () => {
    const detail = buildAreaDetail('area_cardhunt');
    expect(detail?.links.length ?? 0).toBeGreaterThan(0);
    for (const { link, title } of detail?.links ?? []) {
      expect(title.length).toBeGreaterThan(0);
      expect(link.confidence).toBeGreaterThanOrEqual(0);
      expect(link.confidence).toBeLessThanOrEqual(1);
    }
  });

  test('area detail surfaces projects scoped to the area', () => {
    const detail = buildAreaDetail('area_cardhunt');
    expect(detail?.projects.length ?? 0).toBeGreaterThan(0);
    expect(detail?.projects.every((project) => project.areaId === 'area_cardhunt')).toBe(true);
  });

  test('unknown area id returns null', () => {
    expect(buildAreaDetail('area_does_not_exist')).toBeNull();
  });
});

describe('Intents surface selectors', () => {
  test('workbench pairs an intent with its plan and human-gated approvals', () => {
    const bench = buildIntentWorkbench('intent_salvage_day');
    expect(bench).not.toBeNull();
    expect(bench?.plan?.intentId).toBe('intent_salvage_day');
    expect(bench?.approvals.length).toBeGreaterThan(0);
    for (const approval of bench?.approvals ?? []) {
      expect(approval.requiresHumanApproval).toBe(true);
    }
  });

  test('a blocked intent exposes its open questions and an empty plan', () => {
    const bench = buildIntentWorkbench('intent_passport_one_word');
    expect(bench?.plan?.status).toBe('blocked_on_questions');
    expect(bench?.openQuestionCount).toBeGreaterThan(0);
    expect(bench?.plan?.digitalActions.length).toBe(0);
  });

  test('unknown intent id returns null', () => {
    expect(buildIntentWorkbench('intent_missing')).toBeNull();
  });
});

describe('Unassigned surface selectors', () => {
  test('review queue resolves artifacts and candidate area names', () => {
    const queue = buildReviewQueue();
    expect(queue.length).toBeGreaterThanOrEqual(4);
    const recruiter = queue.find((row) => row.item.id === 'review_recruiter');
    expect(recruiter?.artifact.title.length).toBeGreaterThan(0);
    expect(recruiter?.candidateAreas).toContain('Job Search');
    expect(recruiter?.item.suggestedActions).toContain('create_area');
  });

  test('review detail resolves candidate areas and the fact a decision would settle', () => {
    const detail = buildReviewDetail('review_cardhunt_andrew_relationship');
    expect(detail).not.toBeNull();
    expect(detail?.artifact.title.length).toBeGreaterThan(0);
    expect(detail?.candidateAreas.some((area) => area.name === 'CardHunt')).toBe(true);
    expect(detail?.candidateFacts.map((fact) => fact.id)).toContain('fact_cardhunt_manager_candidate');
    expect(detail?.candidateFacts.every((fact) => fact.status === 'candidate')).toBe(true);
  });

  test('a mail-backed review item carries its thread; unknown ids return null', () => {
    expect(buildReviewDetail('review_recruiter')?.thread?.id).toBe('thread_recruiter_founder');
    expect(buildReviewDetail('review_missing')).toBeNull();
  });

  test('noise rules and recent corrections are derived from the seed', () => {
    expect(buildNoiseRules().every((fact) => fact.kind === 'sender_rule')).toBe(true);
    expect(buildRecentCorrections().every((event) => event.kind === 'context_review')).toBe(true);
  });
});

describe('Surface stats', () => {
  test('each surface reports four non-negative stat tiles', () => {
    for (const stats of [areasStats(), intentsStats(), unassignedStats()]) {
      expect(stats.length).toBe(4);
      for (const stat of stats) {
        expect(stat.label.length).toBeGreaterThan(0);
        expect(stat.value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('resolveArtifact falls back to the id for unknown artifacts', () => {
    expect(resolveArtifact('mailThread', 'thread_missing').title).toBe('thread_missing');
  });
});
