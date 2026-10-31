import { describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { contentLabelsSchema } from '../lib/content/contract';
import { classifyContent } from '../lib/content/intelligence';
import { runContentCycle } from '../lib/content/sync';
import {
  buildPrepareQuestions,
  type JevCalendarEvent,
  prepareProbability,
  prepareState,
} from '../lib/jev/calendar';
import { DEFAULT_JEV_PREFERENCES } from '../lib/jev/contract';
import { runJevSweep, runPrepareSweep } from '../lib/jev/service';
import {
  githubGraphqlUrl,
  loadBitbucketOwnerFacts,
  loadGitHubOwnerFacts,
  type SyncConnectionDeps,
  syncConnection,
  withOwnerFacts,
} from '../lib/mcp/sync';
import type { ObligationView } from '../lib/obligations/contract';
import {
  loadCalendarWrites,
  type ObligationRecord,
  type ObligationServiceDependencies,
  runObligationAction,
  sendCalendarRsvp,
} from '../lib/obligations/service';
import { mailInput, responseFor } from './fixtures/jev';

// Needs you phases 2 and 4, Node side. Invented people and services only.

const NOW = Date.parse('2026-10-30T15:00:00Z');
const caller = { userId: 'u1', email: 'owner@example.test' };

function view(patch: Partial<ObligationView> = {}): ObligationView {
  return {
    id: 'ob1',
    kind: 'rsvp',
    state: 'open',
    source: 'calendar',
    sourceKey: 'calendar:acct:evt-1',
    accountId: 'acct',
    eventId: 'evt-1',
    eventStart: NOW + 86_400_000,
    title: 'Answer the invitation: Budget review',
    asker: 'Rosa Diaz',
    due: 'soon',
    pushLevel: 'none',
    probability: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

function service(record: ObligationRecord, extra: Partial<ObligationServiceDependencies> = {}) {
  const calls: Record<string, any[]> = {};
  const note = (name: string, value: unknown) => {
    calls[name] = [...(calls[name] ?? []), value];
  };
  const deps: ObligationServiceDependencies = {
    flag: () => true,
    get: async () => record,
    act: async (input) => {
      note('act', input);
      return { ok: true, obligation: view({ state: 'done', closeReason: 'event_passed' }) };
    },
    recordReply: async () => ({ ok: true, obligation: view() }),
    saveDraft: async () => undefined,
    correctionFor: (target) => {
      note('correctionFor', target);
      return { id: 'c1', scope: 'thread', match: target.threadId, brief: 'exclude' };
    },
    cancelSend: async () => true,
    generateDraft: async () => ({ to: [], cc: [], subject: '', body: '' }),
    sendReply: async () => ({}),
    rsvp: async (who, target) => {
      note('rsvp', { who, target });
    },
    ...extra,
  };
  return { deps, calls };
}

const rsvpRecord = (
  patch: Partial<ObligationView> = {},
  calendarId: string | null = 'cal-1',
): ObligationRecord => ({
  obligation: view(patch),
  sourceMessageId: '1',
  calendarId,
  undo: null,
  draft: null,
});

describe('the rsvp action (phase 4)', () => {
  test('sends the answer through the calendar path, then closes the item', async () => {
    const { deps, calls } = service(rsvpRecord());
    const result = await runObligationAction(caller, 'ob1', { action: 'rsvp', response: 'maybe' }, deps);
    expect(result.obligation).toMatchObject({ state: 'done', closeReason: 'event_passed' });
    expect(result.undoUntil).toBeUndefined();
    expect(calls.rsvp).toEqual([
      {
        who: caller,
        target: { accountId: 'acct', calendarId: 'cal-1', eventId: 'evt-1', response: 'maybe' },
      },
    ]);
    expect(calls.act).toEqual([{ userId: 'u1', id: 'ob1', action: 'rsvp' }]);
  });

  test('a wrong answer, another kind, a missing calendar, or a closed item is refused', async () => {
    const run = (record: ObligationRecord, body: unknown) =>
      runObligationAction(caller, 'ob1', body, service(record).deps).catch((error) => error.status);
    expect(await run(rsvpRecord(), { action: 'rsvp', response: 'later' })).toBe(400);
    expect(await run(rsvpRecord({ kind: 'action' }), { action: 'rsvp', response: 'yes' })).toBe(400);
    expect(await run(rsvpRecord({}, null), { action: 'rsvp', response: 'yes' })).toBe(400);
    expect(await run(rsvpRecord({ eventId: undefined }), { action: 'rsvp', response: 'yes' })).toBe(400);
    expect(await run(rsvpRecord({ state: 'done' }), { action: 'rsvp', response: 'yes' })).toBe(409);
  });

  test('a failed calendar write leaves the item open', async () => {
    const { deps, calls } = service(rsvpRecord(), {
      rsvp: async () => {
        throw new Error('calendar down');
      },
    });
    await expect(
      runObligationAction(caller, 'ob1', { action: 'rsvp', response: 'yes' }, deps),
    ).rejects.toThrow('calendar down');
    expect(calls.act).toBeUndefined();
  });

  test('the default path calls rsvpCalendarEvent with the owner and the answer', async () => {
    const sent: any[] = [];
    await sendCalendarRsvp(
      caller,
      { accountId: 'acct', calendarId: 'cal-1', eventId: 'evt-1', response: 'no' },
      async () => ({
        rsvpCalendarEvent: async (input: any) => {
          sent.push(input);
          return { ok: true, operationId: 'op' };
        },
      }),
    );
    expect(sent).toEqual([
      { userId: 'u1', accountId: 'acct', calendarId: 'cal-1', eventId: 'evt-1', status: 'no' },
    ]);
    expect(typeof (await loadCalendarWrites()).rsvpCalendarEvent).toBe('function');
  });

  test('Not mine on a connected item writes no mail correction', async () => {
    const slack = rsvpRecord({ kind: 'action', source: 'slack', accountId: undefined, threadId: undefined });
    const { deps, calls } = service(slack);
    await runObligationAction(caller, 'ob1', { action: 'not_mine' }, deps);
    expect(calls.correctionFor).toBeUndefined();
    expect(calls.act).toEqual([{ userId: 'u1', id: 'ob1', action: 'not_mine' }]);
    const mail = service(rsvpRecord({ kind: 'reply', source: 'mail', threadId: 'th' }));
    await runObligationAction(caller, 'ob1', { action: 'not_mine' }, mail.deps);
    expect(mail.calls.correctionFor).toHaveLength(1);
  });
});

describe('the prepare question (phase 4)', () => {
  const event: JevCalendarEvent = {
    accountId: 'acct',
    providerCalendarId: 'cal-1',
    providerEventId: 'evt-1',
    revision: 'prepare-1:a',
    title: 'Budget review',
    description: 'Bring the Q3 numbers.',
    startAt: NOW + 3_600_000,
    endAt: NOW + 7_200_000,
    organizer: 'Rosa Diaz <rosa@northwind.test>',
    attendees: ['Rosa Diaz <rosa@northwind.test>', 'owner@example.test'],
    selfAddresses: ['owner@example.test'],
  };

  test('the question, the state, and the answer', () => {
    expect(Object.keys(buildPrepareQuestions())).toEqual(['prepare']);
    expect(buildPrepareQuestions().prepare.type).toBe('noul');
    expect(prepareState(event)).toEqual({
      ownerAddresses: ['owner@example.test'],
      event: {
        title: 'Budget review',
        description: 'Bring the Q3 numbers.',
        location: '',
        startsAt: new Date(NOW + 3_600_000).toISOString(),
        endsAt: new Date(NOW + 7_200_000).toISOString(),
        organizer: 'Rosa Diaz <rosa@northwind.test>',
        attendees: event.attendees,
      },
    });
    expect(
      prepareState({ ...event, description: undefined, organizer: undefined, location: 'Room 4' }).event,
    ).toMatchObject({
      description: '',
      organizer: '',
      location: 'Room 4',
    });
    expect(
      prepareProbability({ model: 'm', answers: { prepare: { type: 'noul', noul: 0.9 } }, usage: {} as any }),
    ).toBe(0.9);
    expect(prepareProbability({ model: 'm', answers: {}, usage: {} as any })).toBeUndefined();
  });

  function prepareDeps(
    events: JevCalendarEvent[],
    options: { deliverThrows?: boolean; noDeliver?: boolean } = {},
  ) {
    const mutations: Array<{ fn: string; args: any }> = [];
    const usage: any[] = [];
    const delivered: string[][] = [];
    const deps: any = {
      convexMutation: async (fn: any, args: any) => {
        mutations.push({ fn: getFunctionName(fn), args });
        if (getFunctionName(fn).endsWith('claimPrepareEvents')) return { events };
        return { obligationIds: args.results.some((result: any) => result.probability > 0.85) ? ['p1'] : [] };
      },
      evaluateClassifier: async (input: any) => {
        if (input.state.event.title === 'Broken') throw new Error('timeout');
        if (input.state.event.title === 'Empty') return { model: 'm', answers: {}, usage: {} };
        return { model: 'm', answers: { prepare: { type: 'noul', noul: 0.92 } }, usage: {} };
      },
      recordClassifierUsage: async (...args: any[]) => {
        usage.push(args);
      },
      ...(options.noDeliver
        ? {}
        : {
            deliverObligations: async (_userId: string, ids: string[]) => {
              delivered.push(ids);
              if (options.deliverThrows) throw new Error('down');
            },
          }),
    };
    return { deps, mutations, usage, delivered };
  }
  const runtime: any = { apiKey: 'test-only', model: { protocol: 'typesafe' } };

  test('asks each claimed event, stores the answers, and pushes the new items', async () => {
    const run = prepareDeps([
      event,
      { ...event, providerEventId: 'e2', title: 'Broken' },
      { ...event, providerEventId: 'e3', title: 'Empty' },
    ]);
    expect(await runPrepareSweep('u', runtime, run.deps)).toEqual({ asked: 3, stored: 1 });
    const store = run.mutations.find((entry) => entry.fn === 'obligations:storePrepare')!;
    expect(store.args.results).toEqual([
      {
        accountId: 'acct',
        providerCalendarId: 'cal-1',
        providerEventId: 'evt-1',
        revision: 'prepare-1:a',
        probability: 0.92,
      },
      { accountId: 'acct', providerCalendarId: 'cal-1', providerEventId: 'e2', revision: 'prepare-1:a' },
      { accountId: 'acct', providerCalendarId: 'cal-1', providerEventId: 'e3', revision: 'prepare-1:a' },
    ]);
    expect(run.usage.map((args) => args[1])).toEqual(['jev_calendar', 'jev_calendar', 'jev_calendar']);
    expect(run.usage[1][4]).toContain('unavailable');
    expect(run.delivered).toEqual([['p1']]);
  });

  test('no claimed event costs no call; a failed push or no push dependency does not fail', async () => {
    const empty = prepareDeps([]);
    expect(await runPrepareSweep('u', runtime, empty.deps)).toEqual({ asked: 0, stored: 0 });
    expect(empty.mutations).toHaveLength(1);
    expect(await runPrepareSweep('u', runtime, prepareDeps([event], { deliverThrows: true }).deps)).toEqual({
      asked: 1,
      stored: 1,
    });
    expect(await runPrepareSweep('u', runtime, prepareDeps([event], { noDeliver: true }).deps)).toEqual({
      asked: 1,
      stored: 1,
    });
  });

  test('the Jev sweep of a flag user asks the prepare question after the mail', async () => {
    const mutations: string[] = [];
    const item = { ...mailInput(), leaseId: 'lease' };
    let claimed = false;
    const deps: any = {
      loadJevPolicy: async () => ({ preferences: DEFAULT_JEV_PREFERENCES, corrections: [], revision: 1 }),
      resolveClassifierRuntime: async () => runtime,
      evaluateClassifier: async () => responseFor(item),
      recordClassifierUsage: async () => undefined,
      convexMutation: async (fn: any, args: any) => {
        mutations.push(getFunctionName(fn));
        if (getFunctionName(fn).endsWith('claimPrepareEvents')) return { events: [] };
        if (args.items) return { stored: args.items.length, obligationIds: [] };
        if (claimed) return { items: [], moreRemaining: false };
        claimed = true;
        return { items: [item], moreRemaining: false };
      },
      needsYouFor: () => true,
      deliverObligations: async () => undefined,
    };
    await runJevSweep('u', deps);
    expect(mutations).toEqual(['jev:claimPending', 'jev:storeAssessments', 'obligations:claimPrepareEvents']);
  });
});

describe('content labels (phase 2)', () => {
  const item: any = {
    _id: 'item',
    source: 'slack',
    connectionId: 'slack',
    externalId: 'x',
    title: 'Release',
    text: 'Can you sign off today?',
    version: '1',
    modifiedAt: NOW,
    indexedAt: NOW,
    partial: false,
    ownerIdentities: ['Owner'],
  };
  const answers: any = {
    kind: { type: 'choice', choice: 'request', confidence: 0.9 },
    work: { type: 'choice', choice: 'none', confidence: 0.99 },
    actionable: { type: 'noul', noul: 0.93 },
    resolved: { type: 'noul', noul: 0.1 },
    due: { type: 'choice', choice: 'today', confidence: 0.8 },
  };
  const deps = (given: any): any => ({
    resolveClassifierRuntime: async () => ({ apiKey: 'fake' }),
    evaluateClassifier: async () => ({ model: 'typesafe/jev-1.13', answers: given }),
    recordClassifierUsage: async () => undefined,
  });

  test('the due answer and the actionable probability are stored; an unclear due is left out', async () => {
    const labels = await classifyContent('owner', item, [], deps(answers));
    expect(labels).toMatchObject({ actionable: true, due: 'today', actionableProbability: 0.93 });
    expect(contentLabelsSchema.parse(labels)).toMatchObject({ due: 'today' });
    const unclear = await classifyContent(
      'owner',
      item,
      [],
      deps({ ...answers, due: { ...answers.due, confidence: 0.2 } }),
    );
    expect('due' in unclear).toBe(false);
    const odd = await classifyContent(
      'owner',
      item,
      [],
      deps({ ...answers, due: { type: 'choice', choice: 'x', confidence: 1 } }),
    );
    expect('due' in odd).toBe(false);
    const { due: _due, ...old } = answers;
    expect('due' in (await classifyContent('owner', item, [], deps(old)))).toBe(false);
  });

  test('the content cycle of a flag user passes the flag and pushes the returned items', async () => {
    const completes: any[] = [];
    const delivered: string[][] = [];
    const cycle = (needsYou: boolean | undefined, answer: unknown) => ({
      convexMutation: async (ref: any, args: any) => {
        const name = getFunctionName(ref);
        if (name.endsWith(':claimSync')) return { lease: 'lease' };
        if (name.endsWith(':claimItems')) return [{ ...item, lease: 'a' }];
        if (name.endsWith(':completeItem')) {
          completes.push(args);
          return answer;
        }
        return { changed: 0 };
      },
      convexQuery: async (ref: any) =>
        getFunctionName(ref).endsWith(':workCandidates') ? [] : { items: [], cursor: null, attachments: [] },
      syncCloudContent: async () => {},
      syncMailAttachments: async () => {},
      syncMcpContent: async () => {},
      loadJevPolicy: async () => ({ preferences: { enabled: true } }),
      classifyContent: async () => ({ kind: 'request' }),
      embedContent: async () => [],
      prepareBriefWork: async () => {},
      ...(needsYou === undefined
        ? {}
        : {
            needsYouFor: () => needsYou,
            deliverObligations: async (_userId: string, ids: string[]) => {
              delivered.push(ids);
              throw new Error('push down');
            },
          }),
    });
    await runContentCycle('owner', cycle(true, { ok: true, obligationIds: ['o1'] }) as any);
    expect(completes[0].needsYou).toBe(true);
    expect(delivered).toEqual([['o1']]);
    await runContentCycle('owner', cycle(true, { ok: true }) as any);
    await runContentCycle('owner', cycle(false, true) as any);
    expect('needsYou' in completes[2]).toBe(false);
    await runContentCycle('owner', cycle(undefined, true) as any);
    expect(delivered).toHaveLength(1);
  });
});

describe('GitHub and Bitbucket owner facts (phase 2)', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const ref = (type: string, repo: string, number: number) => ({
    __typename: type,
    number,
    repository: { nameWithOwner: repo },
  });

  test('one GraphQL call gives review requests, mentions, assigned items, and failed checks', async () => {
    const requests: Array<{ url: string; body: any; headers: any }> = [];
    const facts = await loadGitHubOwnerFacts('https://api.github.com/', 'gho_test', (async (
      url: string,
      init: any,
    ) => {
      requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return json({
        data: {
          reviews: { nodes: [ref('PullRequest', 'northwind/web', 482), {}] },
          mentions: { nodes: [ref('Issue', 'northwind/web', 77), ref('PullRequest', 'northwind/web', 482)] },
          assigned: { nodes: [ref('Issue', 'northwind/web', 77), ref('Issue', 'northwind/web', 77)] },
          authored: {
            nodes: [
              {
                number: 9,
                repository: { nameWithOwner: 'northwind/api' },
                commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
              },
              {
                number: 10,
                repository: { nameWithOwner: 'northwind/api' },
                commits: { nodes: [{ commit: { statusCheckRollup: { state: 'ERROR' } } }] },
              },
              {
                number: 11,
                repository: { nameWithOwner: 'northwind/api' },
                commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
              },
              { number: 12, repository: { nameWithOwner: 'northwind/api' }, commits: { nodes: [] } },
            ],
          },
        },
      });
    }) as any);
    expect(requests[0].url).toBe('https://api.github.com/graphql');
    expect(requests[0].headers.authorization).toBe('Bearer gho_test');
    expect(requests[0].body.query).toContain('review-requested:@me');
    expect(Object.fromEntries(facts)).toEqual({
      'github:pull_request:northwind/web#482': ['review_requested', 'mentioned'],
      'github:issue:northwind/web#77': ['mentioned', 'assigned'],
      'github:pull_request:northwind/api#9': ['checks_failed'],
      'github:pull_request:northwind/api#10': ['checks_failed'],
    });
    expect(
      (await loadGitHubOwnerFacts('https://api.github.com', 't', (async () => json({})) as any)).size,
    ).toBe(0);
    await expect(
      loadGitHubOwnerFacts('https://api.github.com', 't', (async () => json({}, 502)) as any),
    ).rejects.toThrow('HTTP 502');
    expect(githubGraphqlUrl('https://ghe.northwind.test/api/v3')).toBe(
      'https://ghe.northwind.test/api/graphql',
    );
    expect(githubGraphqlUrl('')).toBe('https://api.github.com/graphql');
  });

  test('Bitbucket: a failed build on one of the newest open pull requests of the owner', async () => {
    const pr = (id: number, state = 'open', updated = id) => ({
      externalId: `https://bitbucket.test/harbor/api/pull-requests/${id}`,
      kind: 'pull_request',
      title: `PR ${id}`,
      state,
      updatedAtSource: updated,
      raw: { id, destination: { repository: { full_name: 'harbor/api' } } },
      searchText: '',
    });
    const urls: string[] = [];
    const facts = await loadBitbucketOwnerFacts(
      'https://api.bitbucket.test/2.0/',
      'user:app-password',
      [pr(1), pr(2), pr(3), pr(4, 'merged'), { ...pr(5), raw: {} }, pr(6)],
      (async (url: string, init: any) => {
        urls.push(url);
        expect(init.headers.authorization).toStartWith('Basic ');
        if (url.includes('/1/')) return json({ values: [{ state: 'FAILED' }] });
        if (url.includes('/2/')) return json({ values: [{ state: 'SUCCESSFUL' }] });
        if (url.includes('/3/')) return json({}, 500);
        if (url.includes('/6/')) throw new Error('network');
        return json({});
      }) as any,
    );
    expect(Object.fromEntries(facts)).toEqual({
      'https://bitbucket.test/harbor/api/pull-requests/1': ['checks_failed'],
    });
    expect(urls[0]).toBe(
      'https://api.bitbucket.test/2.0/repositories/harbor/api/pullrequests/6/statuses?pagelen=50',
    );
    expect(urls).toHaveLength(4);
  });

  test('only items with a fact change; raw keeps its other fields', () => {
    const items = [
      { externalId: 'a', kind: 'pull_request', title: 'A', searchText: 'A' },
      { externalId: 'b', kind: 'pull_request', title: 'B', searchText: 'B', raw: { id: 2 } },
      { externalId: 'c', kind: 'issue', title: 'C', searchText: 'C', raw: 'text' },
    ];
    expect(withOwnerFacts(items, null)).toBe(items);
    expect(withOwnerFacts(items, new Map())).toBe(items);
    const facts = new Map([
      ['b', ['checks_failed' as const]],
      ['c', ['assigned' as const]],
    ]);
    const out = withOwnerFacts(items, facts);
    expect(out[0]).toBe(items[0]);
    expect(out[1].raw).toEqual({ id: 2, ownerFacts: ['checks_failed'] });
    expect(out[2].raw).toEqual({ ownerFacts: ['assigned'] });
  });

  test('the sync adds the facts; a failed fact read keeps the items as the loader gave them', async () => {
    const row = (server: string, serverUrl: string) => ({
      connectionId: `${server}_conn`,
      server,
      serverUrl,
      authKind: 'token',
      status: 'connected',
      scopes: [],
      includeInBrief: true,
      includeInSearch: true,
    });
    const upserted: any[] = [];
    const deps = (
      server: 'github' | 'bitbucket',
      facts: () => Promise<Map<string, any>>,
    ): SyncConnectionDeps =>
      ({
        getConnectionToken: async () => ({
          row: row(server, server === 'github' ? 'https://api.github.com' : 'https://api.bitbucket.org/2.0'),
          token: 't',
        }),
        listUserConnections: async () => [],
        convexMutation: async (_fn: any, args: any) => {
          if (args.items) upserted.push(...args.items);
          return undefined;
        },
        loadGitHubItems: async () => ({
          viewer: 'octo',
          items: [{ externalId: 'a', kind: 'pull_request', title: 'A', searchText: 'A' }],
        }),
        loadBitbucketItems: async () => ({
          items: [{ externalId: 'b', kind: 'pull_request', title: 'B', searchText: 'B' }],
        }),
        loadGitHubOwnerFacts: facts,
        loadBitbucketOwnerFacts: facts,
      }) as any;
    await syncConnection(
      'u',
      'github_conn',
      deps('github', async () => new Map([['a', ['review_requested']]])),
    );
    await syncConnection(
      'u',
      'bitbucket_conn',
      deps('bitbucket', async () => new Map([['b', ['checks_failed']]])),
    );
    await syncConnection(
      'u',
      'github_conn',
      deps('github', async () => Promise.reject(new Error('rate limit'))),
    );
    await syncConnection(
      'u',
      'bitbucket_conn',
      deps('bitbucket', async () => Promise.reject(new Error('down'))),
    );
    expect(upserted.map((item) => item.raw)).toEqual([
      { ownerFacts: ['review_requested'] },
      { ownerFacts: ['checks_failed'] },
      undefined,
      undefined,
    ]);
  });
});
