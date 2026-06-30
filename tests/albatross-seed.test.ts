import { describe, expect, test } from 'bun:test';
import seed from '../fixtures/albatross-0.9.seed.json';

describe('Albatross seed fixture', () => {
  test('covers the first 0.9 surfaces and trust boundaries', () => {
    const tables = seed.tables;

    expect(tables.areas.length).toBeGreaterThanOrEqual(10);
    expect(tables.areaFacts.some((fact) => fact.status === 'verified')).toBe(true);
    expect(tables.areaFacts.some((fact) => fact.status === 'candidate')).toBe(true);
    expect(tables.areaFacts.some((fact) => fact.status === 'rejected')).toBe(true);
    expect(
      tables.areaFacts.every((fact) => fact.status !== 'verified' || fact.confirmationRefs.length > 0),
    ).toBe(true);

    expect(tables.contextReviewItems.length).toBeGreaterThanOrEqual(4);
    expect(tables.contextReviewItems.some((item) => item.id === 'review_banjo_course')).toBe(true);
    expect(tables.contextReviewItems.some((item) => item.id === 'review_rewards_sender')).toBe(true);
    expect(tables.contextReviewItems.some((item) => item.id === 'review_recruiter')).toBe(true);

    expect(tables.intents.some((intent) => intent.id === 'intent_passport_one_word')).toBe(true);
    expect(tables.intents.some((intent) => intent.id === 'intent_salvage_day')).toBe(true);
    expect(tables.intentPlans.some((plan) => plan.status === 'blocked_on_questions')).toBe(true);
    expect(tables.approvalQueue.every((approval) => approval.requiresHumanApproval)).toBe(true);
    expect(tables.dailyReportSignals.some((signal) => signal.reportBehavior === 'ask_before_centering')).toBe(
      true,
    );
  });
});
