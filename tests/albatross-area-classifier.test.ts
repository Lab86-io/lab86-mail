import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  __setAreaClassifierDepsForTest,
  type AreaFactLite,
  type ClassifiableEvent,
  type ClassifiableIntent,
  type ClassifiableThread,
  classifyCalendarEvents,
  classifyIntents,
  classifyThreads,
  extractEmail,
  LLM_BATCH_CAP,
  matchEventToFacts,
  matchThreadToFacts,
  parseClassifierOutput,
  parseIdVerdicts,
  runAreaClassification,
} from '../lib/albatross/area-classifier';

const USER = 'user_classifier_test';
const PERSONAL_AREA = 'area_personal';

const apiMock = {
  albatross: {
    ensurePersonal: 'albatross.ensurePersonal',
    listAreas: 'albatross.listAreas',
    listUserAreaFacts: 'albatross.listUserAreaFacts',
    unclassifiedThreads: 'albatross.unclassifiedThreads',
    unclassifiedCalendarEvents: 'albatross.unclassifiedCalendarEvents',
    recordAreaLinks: 'albatross.recordAreaLinks',
  },
  albatrossIntents: {
    listAutoAssigned: 'albatrossIntents.listAutoAssigned',
    applyAreaVerdicts: 'albatrossIntents.applyAreaVerdicts',
  },
};

function fact(overrides: Partial<AreaFactLite> = {}): AreaFactLite {
  return {
    _id: 'fact_1',
    areaId: 'area_work',
    kind: 'domain',
    value: 'cardhunt.com',
    status: 'verified',
    verifiedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function thread(overrides: Partial<ClassifiableThread> = {}): ClassifiableThread {
  return {
    providerThreadId: 'thread_1',
    accountId: 'acct_1',
    subject: 'Sprint review notes',
    fromAddress: 'Alice <alice@cardhunt.com>',
    lastDate: 1_750_000_000_000,
    snippet: 'notes',
    ...overrides,
  };
}

function event(overrides: Partial<ClassifiableEvent> = {}): ClassifiableEvent {
  return {
    eventId: 'event_1',
    accountId: 'acct_1',
    title: 'Sprint planning',
    organizerEmail: 'alice@cardhunt.com',
    participantEmails: ['bob@elsewhere.io'],
    startAt: 1_750_000_000_000,
    location: null,
    ...overrides,
  };
}

function intent(overrides: Partial<ClassifiableIntent> = {}): ClassifiableIntent {
  return {
    intentId: 'intent_1',
    title: 'Prep sprint demo',
    rawText: 'Put the demo deck together before the cardhunt sprint review',
    source: 'text',
    ...overrides,
  };
}

describe('extractEmail', () => {
  test('extracts from an angled display-name header', () => {
    expect(extractEmail('Alice Smith <Alice@CardHunt.com>')).toBe('alice@cardhunt.com');
  });

  test('accepts a bare address and strips mailto:', () => {
    expect(extractEmail('mailto:bob@example.com')).toBe('bob@example.com');
  });

  test('returns null when there is no address', () => {
    expect(extractEmail('No Reply')).toBeNull();
    expect(extractEmail('')).toBeNull();
  });
});

describe('matchThreadToFacts', () => {
  test('verified domain fact matches the sender domain', () => {
    const match = matchThreadToFacts(thread(), [fact()]);
    expect(match).toMatchObject({
      areaId: 'area_work',
      status: 'verified',
      matchType: 'domain',
      reason: 'verified domain cardhunt.com',
    });
  });

  test('candidate fact produces a candidate match', () => {
    const match = matchThreadToFacts(thread(), [fact({ status: 'candidate' })]);
    expect(match?.status).toBe('candidate');
    expect(match?.reason).toBe('candidate domain cardhunt.com');
  });

  test('exact email fact matches and outranks a domain fact at equal trust', () => {
    const match = matchThreadToFacts(thread(), [
      fact({ _id: 'fact_domain', areaId: 'area_a' }),
      fact({ _id: 'fact_email', areaId: 'area_b', kind: 'email', value: 'alice@cardhunt.com' }),
    ]);
    expect(match?.areaId).toBe('area_b');
    expect(match?.matchType).toBe('email');
  });

  test('verified fact outranks a candidate email fact', () => {
    const match = matchThreadToFacts(thread(), [
      fact({
        _id: 'fact_email',
        areaId: 'area_b',
        kind: 'email',
        value: 'alice@cardhunt.com',
        status: 'candidate',
      }),
      fact({ _id: 'fact_domain', areaId: 'area_a', status: 'verified' }),
    ]);
    expect(match?.areaId).toBe('area_a');
    expect(match?.status).toBe('verified');
  });

  test('normalizes leading @ and case in fact values', () => {
    const match = matchThreadToFacts(thread(), [fact({ value: '@CardHunt.com' })]);
    expect(match?.matchType).toBe('domain');
  });

  test('ignores rejected and superseded facts', () => {
    expect(matchThreadToFacts(thread(), [fact({ status: 'rejected' })])).toBeNull();
    expect(matchThreadToFacts(thread(), [fact({ status: 'superseded' })])).toBeNull();
  });

  test('ignores facts whose values are not email/domain shaped', () => {
    expect(matchThreadToFacts(thread(), [fact({ kind: 'note', value: 'my day job' })])).toBeNull();
    expect(matchThreadToFacts(thread(), [fact({ value: 'cardhunt' })])).toBeNull();
  });

  test('does not match a different domain or subdomain', () => {
    expect(matchThreadToFacts(thread({ fromAddress: 'x@othersite.com' }), [fact()])).toBeNull();
    expect(matchThreadToFacts(thread({ fromAddress: 'x@mail.cardhunt.com' }), [fact()])).toBeNull();
  });

  test('returns null when the sender has no parseable address', () => {
    expect(matchThreadToFacts(thread({ fromAddress: 'System Notification' }), [fact()])).toBeNull();
  });
});

describe('matchEventToFacts', () => {
  test('organizer address matches like a mail sender, including domain facts', () => {
    const match = matchEventToFacts(event(), [fact()]);
    expect(match).toMatchObject({
      areaId: 'area_work',
      status: 'verified',
      matchType: 'domain',
      reason: 'organizer verified domain cardhunt.com',
    });
  });

  test('attendee addresses match exact email facts only, never domain facts', () => {
    const emailFact = fact({ _id: 'fact_email', kind: 'email', value: 'bob@elsewhere.io' });
    const byEmail = matchEventToFacts(event({ organizerEmail: null }), [emailFact]);
    expect(byEmail).toMatchObject({ areaId: 'area_work', matchType: 'email' });
    expect(byEmail?.reason).toBe('verified attendee bob@elsewhere.io');

    const domainFact = fact({ _id: 'fact_domain', value: 'elsewhere.io' });
    expect(matchEventToFacts(event({ organizerEmail: null }), [domainFact])).toBeNull();
  });

  test('a verified attendee fact outranks a candidate one', () => {
    const match = matchEventToFacts(
      event({ organizerEmail: null, participantEmails: ['a@x.io', 'b@y.io'] }),
      [
        fact({ _id: 'f_cand', areaId: 'area_a', kind: 'email', value: 'a@x.io', status: 'candidate' }),
        fact({ _id: 'f_ver', areaId: 'area_b', kind: 'email', value: 'b@y.io', status: 'verified' }),
      ],
    );
    expect(match?.areaId).toBe('area_b');
  });

  test('returns null with no organizer and no matching attendees', () => {
    expect(matchEventToFacts(event({ organizerEmail: null, participantEmails: [] }), [fact()])).toBeNull();
  });
});

describe('parseClassifierOutput / parseIdVerdicts', () => {
  const verdicts = [
    { threadId: 't1', areaName: 'Work', confidence: 'high' },
    { threadId: 't2', areaName: null, confidence: 'low' },
  ];

  test('parses a clean JSON array', () => {
    const parsed = parseClassifierOutput(JSON.stringify(verdicts));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ threadId: 't1', areaName: 'Work', confidence: 'high' });
  });

  test('strips markdown fences and surrounding prose', () => {
    const raw = `Sure, here you go:\n\`\`\`json\n${JSON.stringify(verdicts)}\n\`\`\`\nDone.`;
    expect(parseClassifierOutput(raw)).toHaveLength(2);
  });

  test('drops malformed entries but keeps valid ones', () => {
    const raw = JSON.stringify([...verdicts, { areaName: 'Work' }, { threadId: '' }, 42]);
    expect(parseClassifierOutput(raw)).toHaveLength(2);
  });

  test('coerces unknown confidence values to low instead of dropping', () => {
    const parsed = parseClassifierOutput(JSON.stringify([{ threadId: 't1', confidence: 'certain' }]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].confidence).toBe('low');
  });

  test('returns empty for non-array JSON, garbage, and empty input', () => {
    expect(parseClassifierOutput(JSON.stringify({ threadId: 't1' }))).toEqual([]);
    expect(parseClassifierOutput('the model refused to answer')).toEqual([]);
    expect(parseClassifierOutput('')).toEqual([]);
    expect(parseClassifierOutput('[{"threadId": broken')).toEqual([]);
  });

  test('parseIdVerdicts keys off the requested id field', () => {
    const raw = JSON.stringify([{ eventId: 'e1', areaName: 'Work', confidence: 'high' }]);
    expect(parseIdVerdicts(raw, 'eventId')).toEqual([{ id: 'e1', areaName: 'Work', confidence: 'high' }]);
    expect(parseIdVerdicts(raw, 'intentId')).toEqual([]);
  });
});

describe('classifier orchestration', () => {
  let queryFixtures: Record<string, any>;
  let mutationCalls: Array<{ fn: string; args: any }>;
  let llmCalls: any[];
  let llmResponse: string | (() => string);

  function linkCalls() {
    return mutationCalls.filter((call) => call.fn === apiMock.albatross.recordAreaLinks);
  }

  function verdictCalls() {
    return mutationCalls.filter((call) => call.fn === apiMock.albatrossIntents.applyAreaVerdicts);
  }

  function setDeps() {
    __setAreaClassifierDepsForTest({
      api: apiMock as any,
      convexQuery: (async (fn: any, args: any) => {
        if (fn === apiMock.albatross.listUserAreaFacts) {
          return queryFixtures[`facts:${args.status}`] ?? [];
        }
        return queryFixtures[fn] ?? [];
      }) as any,
      convexMutation: (async (fn: any, args: any) => {
        mutationCalls.push({ fn, args });
        if (fn === apiMock.albatross.ensurePersonal) return { areaId: PERSONAL_AREA };
        if (fn === apiMock.albatrossIntents.applyAreaVerdicts) {
          return { assigned: 0, kept: 0, skipped: 0 };
        }
        return { inserted: args.links?.length ?? 0, skipped: 0 };
      }) as any,
      generateTextForCurrentUser: (async (options: any) => {
        llmCalls.push(options);
        return { text: typeof llmResponse === 'function' ? llmResponse() : llmResponse } as any;
      }) as any,
    });
  }

  beforeEach(() => {
    queryFixtures = {
      [apiMock.albatross.listAreas]: [
        { _id: 'area_work', name: 'Cardhunt job', kind: 'job', description: 'Day job' },
        { _id: 'area_home', name: 'Household', kind: 'home' },
        { _id: PERSONAL_AREA, name: 'Personal', kind: 'personal' },
      ],
      'facts:verified': [fact()],
      'facts:candidate': [
        fact({ _id: 'fact_home', areaId: 'area_home', value: 'hoa-board.org', status: 'candidate' }),
      ],
      [apiMock.albatross.unclassifiedThreads]: [],
      [apiMock.albatross.unclassifiedCalendarEvents]: [],
      [apiMock.albatrossIntents.listAutoAssigned]: [],
    };
    mutationCalls = [];
    llmCalls = [];
    llmResponse = '[]';
    setDeps();
  });

  afterAll(() => {
    __setAreaClassifierDepsForTest();
  });

  describe('classifyThreads', () => {
    test('verified domain fact yields a verified link with an inherited confirmation ref', async () => {
      queryFixtures[apiMock.albatross.unclassifiedThreads] = [thread()];
      const result = await classifyThreads({ userId: USER });
      expect(result).toEqual({ deterministic: 1, llm: 0, personal: 0, skipped: 0 });
      expect(llmCalls).toHaveLength(0);
      expect(linkCalls()).toHaveLength(1);
      const link = linkCalls()[0].args.links[0];
      expect(link).toMatchObject({
        areaId: 'area_work',
        artifactKind: 'mailThread',
        artifactId: 'thread_1',
        accountId: 'acct_1',
        status: 'verified',
        reason: 'verified domain cardhunt.com',
      });
      expect(link.confirmationRefs).toHaveLength(1);
      expect(link.confirmationRefs[0]).toMatchObject({
        kind: 'userConfirmation',
        sourceRefId: 'fact_1',
      });
      expect(Number.isFinite(link.confirmationRefs[0].confirmedAt)).toBe(true);
    });

    test('candidate fact match yields a candidate link without confirmation refs', async () => {
      queryFixtures[apiMock.albatross.unclassifiedThreads] = [
        thread({ providerThreadId: 'thread_hoa', fromAddress: 'board@hoa-board.org' }),
      ];
      const result = await classifyThreads({ userId: USER });
      expect(result).toEqual({ deterministic: 1, llm: 0, personal: 0, skipped: 0 });
      const link = linkCalls()[0].args.links[0];
      expect(link).toMatchObject({ areaId: 'area_home', status: 'candidate' });
      expect(link.confirmationRefs).toBeUndefined();
    });

    test('unmatched threads go to the llm phase; high confidence becomes a candidate link, never verified', async () => {
      queryFixtures[apiMock.albatross.unclassifiedThreads] = [
        thread({ providerThreadId: 'thread_llm', fromAddress: 'news@unknown.io', subject: 'Team offsite' }),
      ];
      llmResponse = JSON.stringify([
        { threadId: 'thread_llm', areaName: 'Cardhunt job', confidence: 'high' },
      ]);
      const result = await classifyThreads({ userId: USER });
      expect(result).toEqual({ deterministic: 0, llm: 1, personal: 0, skipped: 0 });
      expect(llmCalls).toHaveLength(1);
      expect(llmCalls[0].feature).toBe('albatross_classify');
      expect(llmCalls[0].speed).toBe('fast');
      expect(llmCalls[0].prompt).toContain('thread_llm');
      expect(llmCalls[0].prompt).toContain('Cardhunt job');
      const link = linkCalls()[0].args.links[0];
      expect(link.status).toBe('candidate');
      expect(link.confirmationRefs).toBeUndefined();
      expect(link.areaId).toBe('area_work');
    });

    test('medium/low confidence and null areas fall back to Personal instead of limbo', async () => {
      queryFixtures[apiMock.albatross.unclassifiedThreads] = [
        thread({ providerThreadId: 't_medium', fromAddress: 'a@x.io' }),
        thread({ providerThreadId: 't_null', fromAddress: 'b@y.io' }),
        thread({ providerThreadId: 't_unknown_area', fromAddress: 'c@z.io' }),
      ];
      llmResponse = JSON.stringify([
        { threadId: 't_medium', areaName: 'Cardhunt job', confidence: 'medium' },
        { threadId: 't_null', areaName: null, confidence: 'high' },
        { threadId: 't_unknown_area', areaName: 'Not An Area', confidence: 'high' },
      ]);
      const result = await classifyThreads({ userId: USER });
      expect(result).toEqual({ deterministic: 0, llm: 0, personal: 3, skipped: 0 });
      const links = linkCalls()[0].args.links;
      expect(links).toHaveLength(3);
      for (const link of links) {
        expect(link).toMatchObject({
          areaId: PERSONAL_AREA,
          role: 'secondary',
          status: 'candidate',
        });
        expect(link.confidence).toBeLessThan(0.5);
      }
    });

    test('hallucinated thread ids are ignored and unanswered threads stay unlinked for retry', async () => {
      queryFixtures[apiMock.albatross.unclassifiedThreads] = [
        thread({ providerThreadId: 't_real', fromAddress: 'a@x.io' }),
      ];
      llmResponse = JSON.stringify([
        { threadId: 't_invented', areaName: 'Cardhunt job', confidence: 'high' },
      ]);
      const result = await classifyThreads({ userId: USER });
      expect(result).toEqual({ deterministic: 0, llm: 0, personal: 0, skipped: 1 });
      expect(linkCalls()).toHaveLength(0);
    });

    test('malformed llm JSON skips the batch without throwing and still writes deterministic links', async () => {
      queryFixtures[apiMock.albatross.unclassifiedThreads] = [
        thread(),
        thread({ providerThreadId: 't_mystery', fromAddress: 'a@x.io' }),
      ];
      llmResponse = 'I cannot produce JSON today.';
      const result = await classifyThreads({ userId: USER });
      expect(result).toEqual({ deterministic: 1, llm: 0, personal: 0, skipped: 1 });
      expect(linkCalls()).toHaveLength(1);
      expect(linkCalls()[0].args.links).toHaveLength(1);
    });

    test('an llm phase throw is contained: batch skipped, deterministic links still written', async () => {
      queryFixtures[apiMock.albatross.unclassifiedThreads] = [
        thread(),
        thread({ providerThreadId: 't_boom', fromAddress: 'a@x.io' }),
      ];
      llmResponse = () => {
        throw new Error('provider outage');
      };
      const result = await classifyThreads({ userId: USER });
      expect(result).toEqual({ deterministic: 1, llm: 0, personal: 0, skipped: 1 });
      expect(linkCalls()).toHaveLength(1);
    });

    test('with no areas beyond Personal, everything files to Personal without a model call', async () => {
      queryFixtures[apiMock.albatross.listAreas] = [];
      queryFixtures[apiMock.albatross.unclassifiedThreads] = [thread(), thread({ providerThreadId: 't2' })];
      const result = await classifyThreads({ userId: USER });
      expect(result).toEqual({ deterministic: 0, llm: 0, personal: 2, skipped: 0 });
      expect(llmCalls).toHaveLength(0);
      const links = linkCalls()[0].args.links;
      expect(links.map((link: any) => link.areaId)).toEqual([PERSONAL_AREA, PERSONAL_AREA]);
    });

    test('no threads means no link writes at all', async () => {
      const result = await classifyThreads({ userId: USER });
      expect(result).toEqual({ deterministic: 0, llm: 0, personal: 0, skipped: 0 });
      expect(llmCalls).toHaveLength(0);
      expect(linkCalls()).toHaveLength(0);
    });

    test('facts on inactive areas never match', async () => {
      queryFixtures[apiMock.albatross.listAreas] = [{ _id: 'area_home', name: 'Household', kind: 'home' }];
      queryFixtures[apiMock.albatross.unclassifiedThreads] = [thread()];
      llmResponse = '[]';
      const result = await classifyThreads({ userId: USER });
      // The verified cardhunt fact belongs to area_work, which is not active.
      expect(result.deterministic).toBe(0);
      expect(result.skipped).toBe(1);
    });

    test('llm batch is capped per call: overflow stays queued for a later round or tick', async () => {
      const many = Array.from({ length: LLM_BATCH_CAP + 5 }, (_, index) =>
        thread({ providerThreadId: `t_bulk_${index}`, fromAddress: `sender${index}@nowhere.io` }),
      );
      queryFixtures[apiMock.albatross.unclassifiedThreads] = many;
      llmResponse = '[]';
      const result = await classifyThreads({ userId: USER });
      // The whole capped batch went unanswered, so the run stops after one
      // call; the 5 overflow threads are untouched and retry next tick.
      expect(result.skipped).toBe(LLM_BATCH_CAP);
      expect(llmCalls).toHaveLength(1);
      expect(llmCalls[0].prompt).toContain(`t_bulk_${LLM_BATCH_CAP - 1}`);
      expect(llmCalls[0].prompt).not.toContain(`t_bulk_${LLM_BATCH_CAP}`);
    });

    test('overflow past the llm cap is classified in a follow-up round of the same run', async () => {
      const many = Array.from({ length: LLM_BATCH_CAP + 5 }, (_, index) =>
        thread({ providerThreadId: `t_bulk_${index}`, fromAddress: `sender${index}@nowhere.io` }),
      );
      queryFixtures[apiMock.albatross.unclassifiedThreads] = many;
      llmResponse = () => {
        // Answer for whatever the latest prompt asked about: everything to Personal.
        const prompt: string = llmCalls[llmCalls.length - 1].prompt;
        const ids = [...prompt.matchAll(/threadId=(\S+)/g)].map((match) => match[1]);
        return JSON.stringify(ids.map((threadId) => ({ threadId, areaName: null, confidence: 'low' })));
      };
      const result = await classifyThreads({ userId: USER });
      expect(result).toEqual({ deterministic: 0, llm: 0, personal: many.length, skipped: 0 });
      expect(llmCalls).toHaveLength(2);
    });

    test('duplicate verdicts for one thread only produce one link', async () => {
      queryFixtures[apiMock.albatross.unclassifiedThreads] = [
        thread({ providerThreadId: 't_dup', fromAddress: 'a@x.io' }),
      ];
      llmResponse = JSON.stringify([
        { threadId: 't_dup', areaName: 'Cardhunt job', confidence: 'high' },
        { threadId: 't_dup', areaName: 'Household', confidence: 'high' },
      ]);
      const result = await classifyThreads({ userId: USER });
      expect(result).toEqual({ deterministic: 0, llm: 1, personal: 0, skipped: 0 });
      expect(linkCalls()[0].args.links).toHaveLength(1);
      expect(linkCalls()[0].args.links[0].areaId).toBe('area_work');
    });
  });

  describe('classifyCalendarEvents', () => {
    test('organizer fact match yields a deterministic calendarEvent link', async () => {
      queryFixtures[apiMock.albatross.unclassifiedCalendarEvents] = [event()];
      const result = await classifyCalendarEvents({ userId: USER });
      expect(result).toEqual({ deterministic: 1, llm: 0, personal: 0, skipped: 0 });
      const link = linkCalls()[0].args.links[0];
      expect(link).toMatchObject({
        areaId: 'area_work',
        artifactKind: 'calendarEvent',
        artifactId: 'event_1',
        accountId: 'acct_1',
        status: 'verified',
      });
    });

    test('unmatched events get one fast-model verdict; unsure events file to Personal', async () => {
      queryFixtures[apiMock.albatross.unclassifiedCalendarEvents] = [
        event({ eventId: 'e_llm', organizerEmail: 'coach@fitness.io', title: 'HOA monthly meeting' }),
        event({ eventId: 'e_unsure', organizerEmail: 'noreply@random.io', title: 'Untitled block' }),
      ];
      llmResponse = JSON.stringify([
        { eventId: 'e_llm', areaName: 'Household', confidence: 'high' },
        { eventId: 'e_unsure', areaName: null, confidence: 'low' },
      ]);
      const result = await classifyCalendarEvents({ userId: USER });
      expect(result).toEqual({ deterministic: 0, llm: 1, personal: 1, skipped: 0 });
      expect(llmCalls).toHaveLength(1);
      expect(llmCalls[0].speed).toBe('fast');
      expect(llmCalls[0].prompt).toContain('e_llm');
      const links = linkCalls()[0].args.links;
      expect(links.find((link: any) => link.artifactId === 'e_llm')).toMatchObject({
        areaId: 'area_home',
        artifactKind: 'calendarEvent',
        status: 'candidate',
      });
      expect(links.find((link: any) => link.artifactId === 'e_unsure')).toMatchObject({
        areaId: PERSONAL_AREA,
        role: 'secondary',
      });
    });

    test('no events means no work at all', async () => {
      const result = await classifyCalendarEvents({ userId: USER });
      expect(result).toEqual({ deterministic: 0, llm: 0, personal: 0, skipped: 0 });
      expect(llmCalls).toHaveLength(0);
      expect(linkCalls()).toHaveLength(0);
    });
  });

  describe('classifyIntents', () => {
    test('a confident verdict re-homes the intent; unsure intents settle in Personal', async () => {
      queryFixtures[apiMock.albatrossIntents.listAutoAssigned] = [
        intent(),
        intent({ intentId: 'intent_vague', title: null, rawText: 'do the thing' }),
      ];
      llmResponse = JSON.stringify([
        { intentId: 'intent_1', areaName: 'Cardhunt job', confidence: 'high' },
        { intentId: 'intent_vague', areaName: null, confidence: 'low' },
      ]);
      const result = await classifyIntents({ userId: USER });
      expect(result).toEqual({ assigned: 1, keptPersonal: 1, skipped: 0 });
      expect(verdictCalls()).toHaveLength(1);
      const verdicts = verdictCalls()[0].args.verdicts;
      expect(verdicts).toContainEqual({
        intentId: 'intent_1',
        areaId: 'area_work',
        reason: 'llm high-confidence match to Cardhunt job',
      });
      expect(verdicts).toContainEqual({ intentId: 'intent_vague' });
    });

    test('a confident Personal verdict just settles the flag without a move', async () => {
      queryFixtures[apiMock.albatrossIntents.listAutoAssigned] = [intent()];
      llmResponse = JSON.stringify([{ intentId: 'intent_1', areaName: 'Personal', confidence: 'high' }]);
      const result = await classifyIntents({ userId: USER });
      expect(result).toEqual({ assigned: 0, keptPersonal: 1, skipped: 0 });
      expect(verdictCalls()[0].args.verdicts).toEqual([{ intentId: 'intent_1' }]);
    });

    test('with no areas beyond Personal, flags settle without a model call', async () => {
      queryFixtures[apiMock.albatross.listAreas] = [];
      queryFixtures[apiMock.albatrossIntents.listAutoAssigned] = [intent()];
      const result = await classifyIntents({ userId: USER });
      expect(result).toEqual({ assigned: 0, keptPersonal: 1, skipped: 0 });
      expect(llmCalls).toHaveLength(0);
      expect(verdictCalls()[0].args.verdicts).toEqual([{ intentId: 'intent_1' }]);
    });

    test('an llm failure leaves flags untouched so intents retry next tick', async () => {
      queryFixtures[apiMock.albatrossIntents.listAutoAssigned] = [intent()];
      llmResponse = () => {
        throw new Error('provider outage');
      };
      const result = await classifyIntents({ userId: USER });
      expect(result).toEqual({ assigned: 0, keptPersonal: 0, skipped: 1 });
      expect(verdictCalls()).toHaveLength(0);
    });

    test('no flagged intents means no area reads at all', async () => {
      const result = await classifyIntents({ userId: USER });
      expect(result).toEqual({ assigned: 0, keptPersonal: 0, skipped: 0 });
      expect(llmCalls).toHaveLength(0);
      expect(mutationCalls).toHaveLength(0);
    });
  });

  describe('runAreaClassification', () => {
    test('runs all three passes and isolates a failing one', async () => {
      queryFixtures[apiMock.albatross.unclassifiedThreads] = [thread()];
      queryFixtures[apiMock.albatross.unclassifiedCalendarEvents] = [event()];
      // Intent listing explodes; mail + calendar must still complete.
      __setAreaClassifierDepsForTest({
        api: apiMock as any,
        convexQuery: (async (fn: any, args: any) => {
          if (fn === apiMock.albatrossIntents.listAutoAssigned) throw new Error('convex down');
          if (fn === apiMock.albatross.listUserAreaFacts) return queryFixtures[`facts:${args.status}`] ?? [];
          return queryFixtures[fn] ?? [];
        }) as any,
        convexMutation: (async (fn: any, args: any) => {
          mutationCalls.push({ fn, args });
          if (fn === apiMock.albatross.ensurePersonal) return { areaId: PERSONAL_AREA };
          return { inserted: args.links?.length ?? 0, skipped: 0 };
        }) as any,
        generateTextForCurrentUser: (async () => ({ text: '[]' }) as any) as any,
      });
      const run = await runAreaClassification({ userId: USER });
      expect(run.threads).toEqual({ deterministic: 1, llm: 0, personal: 0, skipped: 0 });
      expect(run.events).toEqual({ deterministic: 1, llm: 0, personal: 0, skipped: 0 });
      expect(run.intents).toEqual({ error: 'convex down' });
    });
  });
});
