import { describe, expect, test } from 'bun:test';
import {
  assertFactTransitionAllowed,
  assertVerifiedFactAllowed,
  hasUserConfirmation,
  isSensitiveFactKind,
  normalizeConfirmationRefs,
  normalizeSourceRefs,
} from '../convex/albatrossModel';

const userConfirmation = {
  kind: 'userConfirmation',
  id: 'confirm_1',
  confirmedAt: Date.parse('2026-06-30T10:00:00.000Z'),
  confirmedBy: 'test_user',
};

describe('Albatross context graph trust rules', () => {
  test('verified facts require explicit user confirmation refs', () => {
    expect(() =>
      assertVerifiedFactAllowed({
        kind: 'domain',
        status: 'verified',
        confirmationRefs: [],
      }),
    ).toThrow(/confirmation refs/);

    expect(() =>
      assertVerifiedFactAllowed({
        kind: 'domain',
        status: 'verified',
        confirmationRefs: [{ kind: 'mailThread', id: 'thread_1', confirmedAt: userConfirmation.confirmedAt }],
      }),
    ).toThrow(/explicit user confirmation/);

    expect(() =>
      assertVerifiedFactAllowed({
        kind: 'domain',
        status: 'verified',
        confirmationRefs: [userConfirmation],
      }),
    ).not.toThrow();
  });

  test('sensitive people/job/finance facts are recognized as explicit-confirmation only', () => {
    expect(isSensitiveFactKind('person_relationship')).toBe(true);
    expect(isSensitiveFactKind('job')).toBe(true);
    expect(isSensitiveFactKind('finance_account')).toBe(true);
    expect(isSensitiveFactKind('repo')).toBe(false);
    expect(() =>
      assertVerifiedFactAllowed({
        kind: 'finance_account',
        status: 'verified',
        confirmationRefs: [{ kind: 'mailThread', id: 'thread_1', confirmedAt: userConfirmation.confirmedAt }],
      }),
    ).toThrow(/Sensitive area facts/);
  });

  test('candidate to verified/rejected and verified to superseded are the only status transitions', () => {
    expect(() => assertFactTransitionAllowed('candidate', 'verified')).not.toThrow();
    expect(() => assertFactTransitionAllowed('candidate', 'rejected')).not.toThrow();
    expect(() => assertFactTransitionAllowed('verified', 'superseded')).not.toThrow();

    expect(() => assertFactTransitionAllowed('candidate', 'superseded')).toThrow(/Invalid/);
    expect(() => assertFactTransitionAllowed('verified', 'rejected')).toThrow(/Invalid/);
    expect(() => assertFactTransitionAllowed('rejected', 'verified')).toThrow(/Invalid/);
  });

  test('refs normalize to bounded, queryable evidence shapes', () => {
    const sources = normalizeSourceRefs([
      { kind: ' mailThread ', id: ' thread_1 ', label: ' Launch thread ' },
      { kind: '', id: 'missing_kind' },
    ]);
    expect(sources).toEqual([{ kind: 'mailThread', id: 'thread_1', label: 'Launch thread' }]);

    const confirmations = normalizeConfirmationRefs([
      { ...userConfirmation, prompt: ' Store this as context. ' },
      { kind: 'userConfirmation', id: 'bad', confirmedAt: Number.NaN },
    ]);
    expect(hasUserConfirmation(confirmations)).toBe(true);
    expect(confirmations).toEqual([
      { ...userConfirmation, prompt: 'Store this as context.', sourceRefId: undefined },
    ]);
  });

  test('ref normalization bounds every persisted string field and caps arrays', () => {
    const long = 'x'.repeat(800);
    const sources = normalizeSourceRefs(
      Array.from({ length: 25 }, (_, index) => ({
        kind: `kind-${index}-${long}`,
        id: `id-${index}-${long}`,
        label: `label-${index}-${long}`,
        accountId: `account-${index}-${long}`,
        url: `https://example.test/${index}/${long}`,
      })),
    );

    expect(sources).toHaveLength(20);
    expect(sources[0]!.kind.length).toBeLessThanOrEqual(80);
    expect(sources[0]!.id.length).toBeLessThanOrEqual(200);
    expect(sources[0]!.label!.length).toBeLessThanOrEqual(200);
    expect(sources[0]!.accountId!.length).toBeLessThanOrEqual(120);
    expect(sources[0]!.url!.length).toBeLessThanOrEqual(500);

    const confirmations = normalizeConfirmationRefs(
      Array.from({ length: 25 }, (_, index) => ({
        kind: `kind-${index}-${long}`,
        id: `id-${index}-${long}`,
        confirmedAt: userConfirmation.confirmedAt + index,
        confirmedBy: `user-${index}-${long}`,
        prompt: `prompt-${index}-${long}`,
        sourceRefId: `source-${index}-${long}`,
      })),
    );

    expect(confirmations).toHaveLength(20);
    expect(confirmations[0]!.kind.length).toBeLessThanOrEqual(80);
    expect(confirmations[0]!.id.length).toBeLessThanOrEqual(200);
    expect(confirmations[0]!.confirmedBy!.length).toBeLessThanOrEqual(120);
    expect(confirmations[0]!.prompt!.length).toBeLessThanOrEqual(500);
    expect(confirmations[0]!.sourceRefId!.length).toBeLessThanOrEqual(200);
  });
});
