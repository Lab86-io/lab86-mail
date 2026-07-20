import { describe, expect, test } from 'bun:test';
import {
  combinedEvidenceStrength,
  evidenceWeight,
  githubEvidenceKind,
  rankedEvidenceWeight,
  recencyFactor,
} from '@/lib/albatross/evidence-index';

describe('Albatross weighted evidence index', () => {
  test('explicit answers outrank noisy artifact activity', () => {
    expect(evidenceWeight('question_answer', 'confirmed')).toBeGreaterThan(
      evidenceWeight('mail_thread', 'observed'),
    );
    expect(evidenceWeight('github_commit', 'observed')).toBeLessThan(evidenceWeight('task', 'confirmed'));
  });

  test('rejected evidence contributes no strength and confidence is bounded', () => {
    expect(evidenceWeight('manual', 'rejected', 1)).toBe(0);
    expect(evidenceWeight('manual', 'confirmed', 20)).toBe(evidenceWeight('manual', 'confirmed', 1));
  });

  test('activity fades without erasing provenance while confirmed truth stays durable', () => {
    const now = Date.UTC(2026, 6, 14);
    const old = now - 180 * 86_400_000;
    expect(recencyFactor({ occurredAt: old, now })).toBeGreaterThanOrEqual(0.3);
    expect(
      rankedEvidenceWeight({
        sourceKind: 'question_answer',
        trust: 'confirmed',
        occurredAt: old,
        now,
      }),
    ).toBe(1);
    expect(
      rankedEvidenceWeight({ sourceKind: 'github_commit', trust: 'observed', occurredAt: old, now }),
    ).toBeLessThan(evidenceWeight('github_commit', 'observed'));
  });

  test('independent evidence accumulates but never reaches false certainty', () => {
    expect(combinedEvidenceStrength([0.4, 0.4])).toBe(0.64);
    expect(combinedEvidenceStrength(Array.from({ length: 30 }, () => 0.8))).toBe(0.995);
  });

  test('maps normalized GitHub records to distinct provenance kinds', () => {
    expect(githubEvidenceKind('commit')).toBe('github_commit');
    expect(githubEvidenceKind('project_item')).toBe('github_project_item');
    expect(githubEvidenceKind('unknown')).toBe('mcp_item');
  });
});
