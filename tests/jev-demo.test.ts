import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createJevDemoRoute } from '../app/api/jev/demo/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { DEFAULT_JEV_PREFERENCES } from '../lib/jev/contract';
import { demoMailInput, demoResult, JEV_DEMO_EXAMPLES, jevDemoInputSchema } from '../lib/jev/demo';
import { MORE_MAIL_VIEWS, mailNavigationSelection, PRIMARY_MAIL_VIEWS } from '../lib/mail/navigation';
import { QUICK_SEARCH_QUERIES } from '../lib/mail/search/constants';
import { RateLimitError } from '../lib/rate-limit';
import { responseFor } from './fixtures/jev';

const example = JEV_DEMO_EXAMPLES[1].input;
const input = demoMailInput(example, 1000);
const request = (body: unknown = example) =>
  new NextRequest('http://localhost/api/jev/demo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
function dependencies(extra: Record<string, unknown> = {}) {
  return {
    requireCurrentUser: async () => ({ userId: 'viewer' }),
    runWithAiRequestContext: async (_ctx: any, fn: () => Promise<unknown>) => fn(),
    resolveClassifierRuntime: mock(async () => ({ userId: 'viewer', apiKey: 'private-secret' })),
    loadJevPolicy: mock(async () => ({ preferences: DEFAULT_JEV_PREFERENCES })),
    recordClassifierUsage: mock(async () => undefined),
    evaluateClassifier: mock(async () => responseFor(input)),
    enforceUserRateLimit: mock(async () => undefined),
    ...extra,
  } as any;
}

describe('live Jev demonstration', () => {
  test('uses the production questions, authenticated credentials and policy with no mailbox write', async () => {
    const deps = dependencies();
    const req = request();
    const response = await createJevDemoRoute(deps)(req);
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(result).toMatchObject({
      ok: true,
      category: 'Main',
      briefEligible: true,
      obligations: ['reply'],
      evidence: [example.body],
    });
    expect(result.inferenceMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result)).not.toContain('private-secret');
    expect(deps.loadJevPolicy).toHaveBeenCalledWith('viewer');
    expect(deps.resolveClassifierRuntime).toHaveBeenCalledWith('viewer');
    expect(deps.enforceUserRateLimit.mock.calls[0][0]).toMatchObject({
      userId: 'viewer',
      key: 'jev:demo',
      limit: 10,
    });
    expect(deps.evaluateClassifier.mock.calls[0][0]).toMatchObject({
      apiKey: 'private-secret',
      signal: req.signal,
      questions: { purpose: { type: 'choice' }, reply: { type: 'noul' } },
    });
    expect(deps.recordClassifierUsage.mock.calls[0][1]).toBe('jev_demo');
  });
  test('auth and strict bounded input validation run before any paid request', async () => {
    const deps = dependencies({
      requireCurrentUser: async () => {
        throw new AuthRequiredError();
      },
    });
    expect((await createJevDemoRoute(deps)(request())).status).toBe(401);
    expect(deps.evaluateClassifier).not.toHaveBeenCalled();
    const validAuth = dependencies();
    for (const body of [
      { ...example, userId: 'victim' },
      { ...example, model: 'other' },
      { ...example, sender: 'invalid' },
      { ...example, body: 'x'.repeat(2401) },
      { ...example, reply: 'x'.repeat(2401) },
      null,
    ]) {
      expect((await createJevDemoRoute(validAuth)(request(body))).status).toBe(400);
    }
    const malformed = new NextRequest('http://localhost/api/jev/demo', { method: 'POST', body: '{' });
    expect((await createJevDemoRoute(validAuth)(malformed)).status).toBe(400);
    expect(validAuth.evaluateClassifier).not.toHaveBeenCalled();
    expect(validAuth.enforceUserRateLimit).toHaveBeenCalledTimes(7);
    await expect(
      createJevDemoRoute(
        dependencies({
          requireCurrentUser: async () => {
            throw new Error('auth unavailable');
          },
        }),
      )(request()),
    ).rejects.toThrow('auth unavailable');
  });
  test('rate limits and provider failures are visible without leaking provider secrets', async () => {
    const limited = dependencies({
      enforceUserRateLimit: async () => {
        throw new RateLimitError('Try again shortly.', 2000, 10);
      },
    });
    const limitedRequest = request();
    const response = await createJevDemoRoute(limited)(limitedRequest);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('2');
    expect(limited.evaluateClassifier).not.toHaveBeenCalled();
    expect(limitedRequest.bodyUsed).toBe(false);
    const unavailable = dependencies({
      evaluateClassifier: async () => {
        throw new Error('private-secret');
      },
    });
    const failed = await createJevDemoRoute(unavailable)(request());
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private-secret');
    expect(unavailable.recordClassifierUsage).toHaveBeenCalledTimes(1);
    expect(unavailable.recordClassifierUsage.mock.calls[0]).toHaveLength(2);
  });
  test('bounds declared and chunked bytes before JSON parsing, including a false small content length', async () => {
    const deps = dependencies();
    const route = createJevDemoRoute(deps);
    const declared = new NextRequest('http://localhost/api/jev/demo', {
      method: 'POST',
      headers: { 'Content-Length': '32769' },
      body: '{}',
    });
    expect((await route(declared)).status).toBe(413);
    for (const contentLength of [undefined, '1']) {
      const cancelled = mock(() => undefined);
      const stream = new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(20_000).fill(32));
        },
        cancel: cancelled,
      });
      const streamed = new NextRequest('http://localhost/api/jev/demo', {
        method: 'POST',
        body: stream,
        duplex: 'half',
        headers: contentLength ? { 'Content-Length': contentLength } : {},
      } as any);
      expect((await route(streamed)).status).toBe(413);
      expect(cancelled).toHaveBeenCalledTimes(1);
    }
    expect(deps.enforceUserRateLimit).toHaveBeenCalledTimes(3);
    expect(deps.evaluateClassifier).not.toHaveBeenCalled();
    const multilingual = { ...example, body: '字'.repeat(2400), reply: '字'.repeat(2400) };
    expect((await route(request(multilingual))).status).toBe(200);
  });
  test('examples show policy effects and resolution without relying on unread state', () => {
    for (const sample of JEV_DEMO_EXAMPLES)
      expect(jevDemoInputSchema.safeParse(sample.input).success).toBe(true);
    const promo = demoMailInput(JEV_DEMO_EXAMPLES[0].input, 1000);
    const promotional = responseFor(promo, { purpose: 'promotion', reply: 0, reply_evidence: 'none' });
    expect(demoResult(promo, promotional, DEFAULT_JEV_PREFERENCES, 220, 1000)).toMatchObject({
      category: 'Noise',
      briefEligible: false,
      inferenceMs: 220,
      evidence: [],
    });
    expect(
      demoResult(promo, promotional, { ...DEFAULT_JEV_PREFERENCES, briefPromotions: true }, 1, 1000)
        .briefEligible,
    ).toBe(true);
    const answered = demoMailInput(JEV_DEMO_EXAMPLES[2].input, 1000);
    expect(answered.messages[1]).toMatchObject({
      from: answered.selfAddresses[0],
      to: example.sender,
      body: 'Approved, please proceed.',
    });
    expect(answered.messageId).toBe('demo-reply');
    expect(
      demoResult(
        answered,
        responseFor(answered, { reply: 0, reply_evidence: 'none' }),
        DEFAULT_JEV_PREFERENCES,
        1,
        1001,
      ),
    ).toMatchObject({ obligations: [], briefEligible: false });
    const changed = demoMailInput(JEV_DEMO_EXAMPLES[3].input, 1000);
    const cancellation = responseFor(changed, {
      purpose: 'transaction',
      subject_kind: 'booking',
      reply: 0,
      reply_evidence: 'none',
      change: 0.98,
      change_evidence: 'm0',
    });
    expect(demoResult(changed, cancellation, DEFAULT_JEV_PREFERENCES, 1, 1000)).toMatchObject({
      meaningfulChange: true,
      briefEligible: true,
      evidence: [changed.messages[0].body],
    });
  });
});

describe('simpler Mail navigation', () => {
  test('keeps three primary views and all detailed views reachable', () => {
    expect(PRIMARY_MAIL_VIEWS.map((item) => item.id)).toEqual(['main', 'needs_reply', 'noise', 'codes']);
    expect(MORE_MAIL_VIEWS.map((item) => item.id)).toEqual([
      'needs_action',
      'waiting_for',
      'important_changes',
      'orders',
      'finance_admin',
      'review',
    ]);
  });
  test('active categories take precedence over stale folder queries; folders and custom views stay identifiable', () => {
    expect(mailNavigationSelection('main', QUICK_SEARCH_QUERIES.unread, [])).toMatchObject({
      moreLabel: 'More',
      moreActive: false,
      folder: undefined,
    });
    expect(mailNavigationSelection(null, QUICK_SEARCH_QUERIES.sent, [])).toMatchObject({
      moreLabel: 'Sent',
      moreActive: true,
    });
    expect(mailNavigationSelection('needs_action', '', [])).toMatchObject({
      moreLabel: 'Needs action',
      moreActive: true,
    });
    expect(mailNavigationSelection('custom:budget', '', [{ _id: 'budget', name: 'Budget' }])).toMatchObject({
      moreLabel: 'Budget',
      moreActive: true,
    });
    expect(mailNavigationSelection(null, 'quarterly budget', [])).toMatchObject({
      moreLabel: 'More',
      moreActive: false,
    });
  });
});
