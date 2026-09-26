import { describe, expect, test } from 'bun:test';
import { evaluateClassifier, mapConcurrent, validateClassifierResponse } from '../lib/classifier/client';
import {
  assessmentIsCurrent,
  attentionMatches,
  correctionForMail,
  isAttentionView,
  jevReason,
  normalizeJevPreferences,
} from '../lib/jev/contract';
import { explicitReplyRequested, unquotedMessage } from '../lib/jev/fallback';
import {
  assessmentFromResponse,
  buildMailQuestions,
  mailSourceRevision,
  smartCategoryFromJev,
} from '../lib/jev/mail';
import { classifyThreadWithContext, includeInSmartCategory } from '../lib/mail/smart-categories';
import { assessment, mailInput, NOW, responseFor, thread } from './fixtures/jev';

describe('Jev typed transport', () => {
  test('uses the fixed decisions endpoint, independent of the generative model picker', async () => {
    const input = mailInput();
    const questions = buildMailQuestions(input);
    const response = await evaluateClassifier({ apiKey: 'test-only', state: input, questions }, (async (
      url,
      init,
    ) => {
      expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'typesafe/jev-1.13', state: input, questions });
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-only' });
      return Response.json(responseFor(input));
    }) as typeof fetch);
    expect(response.usage.input_tokens).toBe(200);
  });
  test('rejects malformed, out-of-range and unexpected typed answers', () => {
    const input = mailInput();
    const questions = buildMailQuestions(input);
    for (const mutate of [
      (r: any) => {
        r.model = 'typesafe/jev-1.130';
      },
      (r: any) => {
        delete r.answers.reply;
      },
      (r: any) => {
        r.answers.reply.noul = 1.1;
      },
      (r: any) => {
        r.answers.reply.noul = NaN;
      },
      (r: any) => {
        r.answers.reply.type = 'choice';
      },
      (r: any) => {
        r.answers.purpose.choice = 'hacked';
      },
      (r: any) => {
        r.answers.purpose.confidence = -1;
      },
      (r: any) => {
        r.answers.purpose.probabilities.conversation = 0.2;
      },
      (r: any) => {
        r.answers.purpose.probabilities.extra = 0;
      },
      (r: any) => {
        r.usage.input_tokens = -1;
      },
      (r: any) => {
        delete r.usage;
      },
    ]) {
      const raw = responseFor(input);
      mutate(raw);
      expect(() => validateClassifierResponse(raw, questions)).toThrow('invalid_response');
    }
    expect(() => validateClassifierResponse(null, questions)).toThrow('invalid_response');
  });
  test('sanitizes provider failures and honors cancellation and deadlines', async () => {
    const request = { apiKey: 'test-only', state: {}, questions: buildMailQuestions(mailInput()) };
    await expect(evaluateClassifier({ ...request, apiKey: '' })).rejects.toThrow('not_configured');
    await expect(
      evaluateClassifier(request, (async () => new Response('secret body', { status: 429 })) as typeof fetch),
    ).rejects.toThrow('provider');
    await expect(
      evaluateClassifier(request, (async () => new Response('not json')) as typeof fetch),
    ).rejects.toThrow('invalid_response');
    await expect(
      evaluateClassifier(request, (async () => {
        throw new Error('private network data');
      }) as typeof fetch),
    ).rejects.toThrow('provider');
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      evaluateClassifier({ ...request, signal: controller.signal }, (async () => {
        throw new Error('aborted');
      }) as typeof fetch),
    ).rejects.toThrow('cancelled');
    const abortingFetch = (async (_url: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })) as typeof fetch;
    await expect(evaluateClassifier({ ...request, timeoutMs: 2 }, abortingFetch)).rejects.toThrow('timeout');
  });
  test('bounds concurrency and preserves input order', async () => {
    let active = 0;
    let maximum = 0;
    const result = await mapConcurrent([3, 2, 1, 0], 2, async (n) => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, n));
      active--;
      return n * 2;
    });
    expect(result).toEqual([6, 4, 2, 0]);
    expect(maximum).toBe(2);
    expect(await mapConcurrent([], 0, async (n) => n)).toEqual([]);
  });
});

describe('conversation facts, provenance and freshness', () => {
  test('independent obligations coexist with copied source evidence', () => {
    const input = mailInput();
    const result = assessmentFromResponse(
      input,
      responseFor(input, {
        action: 0.96,
        action_evidence: 'm0',
        waiting: 0.97,
        waiting_evidence: 'm0',
        change: 0.99,
        change_evidence: 'm0',
      }),
      NOW,
    );
    expect(result.obligations.map((o) => o.kind)).toEqual(['reply', 'action', 'waiting']);
    expect(result.changeEvidence?.text).toBe(input.messages[0].body);
    expect(result.status).toBe('accepted');
    for (const view of ['needs_reply', 'needs_action', 'waiting_for', 'important_changes'] as const)
      expect(attentionMatches(result, view)).toBe(true);
    expect(attentionMatches(null, 'needs_reply')).toBe(false);
    expect(isAttentionView('noise')).toBe(false);
  });
  test('ambiguous probability, missing evidence and incomplete history cannot assert a clean result', () => {
    const input = mailInput();
    const noEvidence = assessmentFromResponse(input, responseFor(input, { reply_evidence: 'none' }));
    expect(noEvidence.status).toBe('uncertain');
    expect(noEvidence.obligations).toEqual([]);
    const ambiguous = assessmentFromResponse(input, responseFor(input, { reply: 0.5 }));
    expect(ambiguous.status).toBe('uncertain');
    expect(ambiguous.obligations).toEqual([]);
    expect(assessmentFromResponse({ ...input, contextComplete: false }, responseFor(input)).status).toBe(
      'uncertain',
    );
    expect(
      assessmentFromResponse(input, responseFor(input, { purpose: 'unknown', reply: 0.01 })).status,
    ).toBe('uncertain');
    const weak = responseFor(input);
    (weak.answers.reply_evidence as any).confidence = 0.1;
    expect(assessmentFromResponse(input, weak).obligations).toEqual([]);
    delete weak.answers.reply;
    expect(() => assessmentFromResponse(input, weak)).toThrow();
    delete weak.answers.purpose;
    expect(() => assessmentFromResponse(input, weak)).toThrow();
  });
  test('completion clears reply and waiting, without direction-based inventions', () => {
    const input = mailInput('All set. No reply needed.');
    const result = assessmentFromResponse(input, responseFor(input, { reply: 0.01, reply_evidence: 'none' }));
    expect(result.obligations).toEqual([]);
    expect(jevReason(result)).toContain('No unresolved');
    const prompts = buildMailQuestions(input);
    expect(prompts.waiting.instructions).toContain('inbound promise');
    expect(prompts.reply.instructions).toContain('Quoted requests do not create');
    expect(prompts.action.instructions).toContain('untrusted data');
  });
  test('normalizes exact sender/list identity and rejects stale versions', () => {
    const input = mailInput();
    input.messages[0].headers = { 'list-id': 'Athletics <Athletics.University.Test>' };
    const result = assessmentFromResponse(input, responseFor(input, { purpose: 'promotion', reply: 0.01 }));
    expect(result.sender).toBe('maya@university.test');
    expect(result.listId).toBe('athletics.university.test');
    expect(assessmentIsCurrent(result, 'm1', result.sourceRevision)).toBe(true);
    expect(assessmentIsCurrent(result, 'm2')).toBe(false);
    expect(assessmentIsCurrent(result, 'm1', 'changed-body')).toBe(false);
    expect(assessmentIsCurrent({ ...result, version: 0 }, 'm1')).toBe(false);
    expect(mailSourceRevision(input.messages)).not.toBe(
      mailSourceRevision([{ ...input.messages[0], body: 'Changed' }]),
    );
  });
  test('maps facts into shared categories while preserving explicit user rules', () => {
    const local = classifyThreadWithContext(thread(), {});
    const quiet = { obligations: [], meaningfulChange: false };
    const cases = [
      [assessment(), 'main', 'reply'],
      [assessment({ ...quiet, purpose: 'promotion' }), 'noise', 'none'],
      [assessment({ ...quiet, purpose: 'newsletter' }), 'noise', 'none'],
      [assessment({ ...quiet, status: 'uncertain' }), 'review', 'none'],
      [assessment({ ...quiet, subjectKind: 'code' }), 'codes', 'none'],
      [assessment({ ...quiet, subjectKind: 'order' }), 'orders', 'none'],
      [assessment({ ...quiet, subjectKind: 'finance' }), 'finance_admin', 'none'],
      [assessment({ obligations: [{ ...assessment().obligations[0], kind: 'waiting' }] }), 'main', 'wait'],
      [assessment({ ...quiet, meaningfulChange: true }), 'main', 'read'],
    ] as const;
    for (const [a, primary, action] of cases)
      expect(smartCategoryFromJev(a, local, true)).toMatchObject({
        primary,
        suggestedAction: action,
        model: a.model,
      });
    const ownRule = { ...local, model: 'user_rule' };
    expect(smartCategoryFromJev(assessment(), ownRule, true)).toBe(ownRule);
    for (const a of cases.map((c) => c[0])) expect(jevReason(a).length).toBeGreaterThan(15);
    expect(jevReason(assessment({ ...quiet, purpose: 'transaction' }))).toContain('receipt');
    expect(
      jevReason(assessment({ obligations: [{ ...assessment().obligations[0], kind: 'action' }] })),
    ).toContain('unfinished action');
  });
});

describe('precise corrections and conservative fallback', () => {
  test('thread then list then sender, exclude wins ties, never whole-domain or cross-account', () => {
    const input = {
      accountId: 'a',
      threadId: 'CaseSensitiveID',
      sender: 'Maya@University.Test',
      listId: 'list.university.test',
    };
    const sender = {
      id: 's',
      scope: 'sender' as const,
      match: 'maya@university.test',
      brief: 'include' as const,
    };
    const list = { id: 'l', scope: 'list' as const, match: input.listId, brief: 'exclude' as const };
    const exact = { id: 't', scope: 'thread' as const, match: input.threadId, brief: 'include' as const };
    expect(correctionForMail([sender, list, exact], input)).toBe(exact);
    expect(correctionForMail([sender, list], input)).toBe(list);
    expect(correctionForMail([{ ...sender, match: 'university.test' }], input)).toBeUndefined();
    expect(correctionForMail([{ ...exact, match: 'casesensitiveid' }], input)).toBeUndefined();
    expect(correctionForMail([{ ...sender, accountId: 'b' }], input)).toBeUndefined();
    expect(correctionForMail([sender, { ...sender, id: 'exclude', brief: 'exclude' }], input)?.brief).toBe(
      'exclude',
    );
    expect(normalizeJevPreferences({ enabled: 'yes' }).enabled).toBe(true);
    expect(normalizeJevPreferences({ enabled: false }).enabled).toBe(false);
  });
  test('neither a broadcast, thanks nor a quoted old request establishes reply owed', () => {
    for (const body of [
      'Thanks!',
      'All set. No reply needed.',
      'Please reply SALE for tickets on sale. Unsubscribe.',
      'FYI\nOn Monday Maya wrote:\nPlease confirm.',
      'FYI\n> Can you reply?',
    ])
      expect(explicitReplyRequested(body)).toBe(false);
    for (const body of [
      'Could you confirm the budget?',
      'When will the signed agreement arrive?',
      'Please send me the final invoice.',
    ])
      expect(explicitReplyRequested(body)).toBe(true);
    expect(unquotedMessage('New\nFrom: Old sender\nWhat is this?')).toBe('New');
  });
});

test('shared attention filters use independent Jev facts and preserve an explicit Noise rule', () => {
  const value = thread({ jev: assessment() });
  expect(includeInSmartCategory(value, 'needs_reply')).toBe(true);
  expect(includeInSmartCategory(value, 'waiting_for')).toBe(false);
  expect(
    includeInSmartCategory(
      {
        ...value,
        smartCategory: { ...classifyThreadWithContext(value, {}), model: 'user_rule', primary: 'noise' },
      },
      'needs_reply',
    ),
  ).toBe(false);
  for (const body of ['Thanks! No reply needed.', 'Can you confirm the budget?']) {
    const result = classifyThreadWithContext(
      { ...thread(), labels: ['INBOX', 'CATEGORY_PERSONAL'], snippet: body, bodyText: body } as any,
      {},
    );
    expect(result.secondary.includes('needs_reply')).toBe(body.includes('Can you'));
  }
});
