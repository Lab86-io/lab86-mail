import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createProofMatchesPost } from '../app/api/albatross/proof-matches/route';

function matchesRequest(body: unknown) {
  return new NextRequest('http://localhost/api/albatross/proof-matches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const sheetsWork = {
  _id: 'work-sheets',
  title: 'Order new sheets for Tree',
  contract: {
    outcome: 'The new linen sheets for Tree are ordered',
    proofs: [{ id: 'confirmation', what: 'The sheets order confirmation arrived' }],
  },
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    requireCurrentUser: mock(async () => ({ userId: 'user-1', email: 'u@example.com' })) as any,
    enforceUserRateLimit: mock(async () => undefined) as any,
    convexQuery: mock(async (_fn: any, args: any) => {
      if (args.providerThreadId) return null;
      return [sheetsWork];
    }) as any,
    evidenceSatisfies: mock(async () => ({ satisfies: true, reason: 'Confirmed.' })) as any,
    ...overrides,
  };
}

describe('proof matches route', () => {
  test('a blocked mail class returns no candidates and never calls the gate', async () => {
    const evidenceGate = mock(async () => ({ satisfies: true, reason: 'x' }));
    const post = createProofMatchesPost(
      makeDeps({
        convexQuery: mock(async (_fn: any, args: any) => {
          if (args.providerThreadId) return { llmCategory: { primary: 'noise' } };
          return [sheetsWork];
        }) as any,
        evidenceSatisfies: evidenceGate as any,
      }),
    );
    const response = await post(
      matchesRequest({
        subject: 'Fresh linen looks for summer',
        snippet: 'Washer friendly linens, dry care tips',
        accountId: 'personal',
        providerThreadId: 'thread-9',
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, candidates: [], blocked: 'category' });
    expect(evidenceGate).not.toHaveBeenCalled();
  });

  test('the gate refutes a lexical coincidence before it renders anywhere', async () => {
    const post = createProofMatchesPost(
      makeDeps({
        evidenceSatisfies: mock(async () => ({ satisfies: false, reason: 'Shared words only.' })) as any,
      }),
    );
    const response = await post(
      matchesRequest({ subject: 'Your linen sheets order questions', snippet: 'sheets order confirmation' }),
    );
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.candidates).toEqual([]);
  });

  test('a confirmed match carries the named proof and outstanding list', async () => {
    const post = createProofMatchesPost(makeDeps());
    const response = await post(
      matchesRequest({
        subject: 'Order confirmation',
        snippet: 'Your linen sheets order confirmation arrived',
        accountId: 'personal',
        providerThreadId: 'thread-2',
      }),
    );
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({
      workId: 'work-sheets',
      workTitle: 'Order new sheets for Tree',
      proofId: 'confirmation',
      gate: 'confirmed',
      outstanding: [{ id: 'confirmation', what: 'The sheets order confirmation arrived' }],
    });
  });

  test('an unavailable gate keeps the offer but marks it unchecked', async () => {
    const post = createProofMatchesPost(
      makeDeps({
        evidenceSatisfies: mock(async () => ({
          satisfies: false,
          reason: 'The check did not run.',
          unavailable: true,
        })) as any,
      }),
    );
    const response = await post(
      matchesRequest({ subject: 'Order confirmation', snippet: 'Your linen sheets order confirmation' }),
    );
    const body = await response.json();
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].gate).toBe('unchecked');
  });

  test('mail text is required', async () => {
    const post = createProofMatchesPost(makeDeps());
    const response = await post(matchesRequest({ subject: '', snippet: '' }));
    expect(response.status).toBe(400);
  });
});
