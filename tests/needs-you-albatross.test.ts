import { describe, expect, spyOn, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createObligationAlbatrossPost } from '../app/api/obligations/[id]/albatross/route';
import { obligationAlbatrossDefaults } from '../app/api/obligations/[id]/albatross/shared';
import { StepRunStartError } from '../lib/albatross/step-run-start';
import { AuthRequiredError } from '../lib/auth/current-user';
import {
  OBLIGATION_RUN_NOTE_MAX,
  type ObligationAlbatrossDependencies,
  obligationAlbatrossText,
  startObligationInAlbatross,
} from '../lib/obligations/albatross';
import type { ObligationView } from '../lib/obligations/contract';
import { ObligationApiError } from '../lib/obligations/service';
import { RateLimitError } from '../lib/rate-limit';

// "Start in Albatross" (Needs you phase 3, S2). Invented people and companies only.

const NOW = Date.parse('2026-10-30T15:00:00Z');
const caller = { userId: 'u1', email: 'owner@example.test', name: 'Owner' };

function view(patch: Partial<ObligationView> = {}): ObligationView {
  return {
    id: 'ob1',
    kind: 'reply',
    state: 'open',
    source: 'mail',
    sourceKey: 'mail:acct:thread',
    accountId: 'acct',
    threadId: 'thread',
    messageId: 'm1',
    title: 'Could you confirm the start date?',
    asker: 'Dana Whitfield',
    why: 'Dana Whitfield asked you something that is still open.',
    excerpt: 'Could you confirm the start date for the SOW?',
    due: 'soon',
    pushLevel: 'normal',
    probability: 0.97,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

function harness(
  options: {
    flag?: boolean;
    record?: ObligationView | null;
    link?: (workId: string) => any;
    runs?: Array<{ id: string; state: string }> | (() => Promise<never>);
    steer?: boolean;
    start?: () => Promise<{ runId: string | null }>;
    captured?: string[];
  } = {},
) {
  const calls: Record<string, any[]> = {};
  const note = (name: string, value: any) => {
    calls[name] = [...(calls[name] ?? []), value];
  };
  const deps: ObligationAlbatrossDependencies = {
    flag: (userId) => {
      note('flag', userId);
      return options.flag ?? true;
    },
    get: async (userId, id) => {
      note('get', { userId, id });
      const obligation = options.record === undefined ? view() : options.record;
      return obligation ? { obligation, sourceMessageId: 'm1', undo: null, draft: null } : null;
    },
    link: async (input) => {
      note('link', input);
      if (options.link) return options.link(input.workId);
      return {
        ok: true,
        obligation: view({ workId: input.workId, workTitle: 'Renew the Northwind contract' }),
        workTitle: 'Renew the Northwind contract',
      };
    },
    runs: async (userId, workId) => {
      note('runs', { userId, workId });
      if (typeof options.runs === 'function') return options.runs();
      return options.runs ?? [];
    },
    steer: async (input) => {
      note('steer', input);
      return options.steer ?? true;
    },
    startRun: async (input) => {
      note('startRun', input);
      return options.start ? options.start() : { runId: 'run-new' };
    },
    capture: async (who, item) => {
      note('capture', { who, item });
      return { workIds: options.captured ?? ['work-new'] };
    },
  };
  return { deps, calls };
}

describe('obligationAlbatrossText', () => {
  test('names the item, the asker, the place, the evidence, and the source ids', () => {
    const text = obligationAlbatrossText(view());
    expect(text.title).toBe('Could you confirm the start date?');
    expect(text.note).toContain('Needs you: Could you confirm the start date?');
    expect(text.note).toContain('From Dana Whitfield (Mail).');
    expect(text.note).toContain('Excerpt: "Could you confirm the start date for the SOW?"');
    expect(text.note).toContain('Mail thread thread in account acct, message m1.');
    expect(text.note).toContain('Handle this item as part of this Albatross.');
  });

  test('a connected item names its place and link; an event names its id', () => {
    const slack = obligationAlbatrossText(
      view({
        source: 'slack',
        sourceLabel: '#release',
        url: 'https://northwind.slack.test/archives/C1/p1',
        accountId: undefined,
        threadId: undefined,
        messageId: undefined,
        why: undefined,
        excerpt: undefined,
        asker: '',
        title: '',
      }),
    );
    expect(slack.title).toBe('Needs you');
    expect(slack.note).toContain('From an unknown sender (Slack, #release).');
    expect(slack.note).toContain('Link: https://northwind.slack.test/archives/C1/p1');
    expect(slack.note).not.toContain('Mail thread');
    const event = obligationAlbatrossText(
      view({ source: 'calendar', eventId: 'evt-9', threadId: undefined, messageId: undefined }),
    );
    expect(event.note).toContain('Calendar event evt-9.');
    expect(obligationAlbatrossText(view({ threadId: 'thread', messageId: undefined })).note).toContain(
      'Mail thread thread in account acct.',
    );
  });

  test('a secret shape never reaches the run, and the note stays inside the steer cap', () => {
    const secret = obligationAlbatrossText(
      view({ excerpt: 'The key is sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c' }),
    );
    expect(secret.note).not.toContain('sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c');
    const long = obligationAlbatrossText(view({ excerpt: 'word '.repeat(2_000), why: 'why '.repeat(500) }));
    expect(long.note.length).toBeLessThanOrEqual(OBLIGATION_RUN_NOTE_MAX);
  });
});

describe('startObligationInAlbatross', () => {
  test('outside the flag, or another user id: 404 before any read or write', async () => {
    const off = harness({ flag: false });
    await expect(startObligationInAlbatross(caller, 'ob1', off.deps)).rejects.toMatchObject({ status: 404 });
    expect(off.calls.get).toBeUndefined();
    const missing = harness({ record: null });
    await expect(startObligationInAlbatross(caller, 'ob1', missing.deps)).rejects.toMatchObject({
      status: 404,
    });
    expect(missing.calls.link).toBeUndefined();
  });

  test('a code is 400 and a closed item is 409', async () => {
    const code = harness({ record: view({ kind: 'code' }) });
    await expect(startObligationInAlbatross(caller, 'ob1', code.deps)).rejects.toMatchObject({ status: 400 });
    const closed = harness({ record: view({ state: 'done', closeReason: 'user_done', closedAt: NOW }) });
    await expect(startObligationInAlbatross(caller, 'ob1', closed.deps)).rejects.toMatchObject({
      status: 409,
    });
    expect(closed.calls.capture).toBeUndefined();
  });

  test('with a workId and a run that works now: the item goes to that run as a note', async () => {
    const { deps, calls } = harness({
      record: view({ workId: 'work-1', state: 'snoozed', snoozedUntil: NOW + 1 }),
      runs: [
        { id: 'run-old', state: 'done' },
        { id: 'run-live', state: 'running' },
      ],
    });
    const response = await startObligationInAlbatross(caller, 'ob1', deps);
    expect(response).toEqual({
      workId: 'work-1',
      created: false,
      runId: 'run-live',
      obligation: view({ workId: 'work-1', workTitle: 'Renew the Northwind contract' }),
    });
    expect(calls.link).toEqual([{ userId: 'u1', id: 'ob1', workId: 'work-1' }]);
    expect(calls.steer).toEqual([
      { userId: 'u1', runId: 'run-live', note: obligationAlbatrossText(view()).note },
    ]);
    expect(calls.startRun).toBeUndefined();
    expect(calls.capture).toBeUndefined();
  });

  test('with a workId and no open run: a run starts with the note', async () => {
    const { deps, calls } = harness({
      record: view({ workId: 'work-1' }),
      runs: [{ id: 'run-q', state: 'queued' }],
      steer: false,
    });
    const response = await startObligationInAlbatross(caller, 'ob1', deps);
    expect(response.runId).toBe('run-new');
    expect(response.created).toBe(false);
    expect(calls.steer).toHaveLength(1);
    expect(calls.startRun).toEqual([
      { userId: 'u1', workId: 'work-1', note: expect.stringContaining('Needs you:') },
    ]);
  });

  test('a refused or failed run start leaves the item in the thread without a run', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const refused = harness({
        record: view({ workId: 'work-1' }),
        start: async () => {
          throw new StepRunStartError('This step stays with you.', 403);
        },
      });
      const response = await startObligationInAlbatross(caller, 'ob1', refused.deps);
      expect(response).toMatchObject({ workId: 'work-1', created: false });
      expect(response).not.toHaveProperty('runId');
      const noRun = harness({ record: view({ workId: 'work-1' }), start: async () => ({ runId: null }) });
      expect(await startObligationInAlbatross(caller, 'ob1', noRun.deps)).not.toHaveProperty('runId');
      const down = harness({
        record: view({ workId: 'work-1' }),
        runs: async () => {
          throw 'convex down';
        },
      });
      expect(await startObligationInAlbatross(caller, 'ob1', down.deps)).not.toHaveProperty('runId');
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test('with a workId of a closed or deleted Albatross: a new Albatross starts from the item', async () => {
    for (const error of ['work_closed', 'work_missing']) {
      const { deps, calls } = harness({
        record: view({ workId: 'work-old' }),
        link: (workId) =>
          workId === 'work-old'
            ? { ok: false, error }
            : { ok: true, obligation: view({ workId, workTitle: 'Could you confirm' }), workTitle: 'x' },
      });
      const response = await startObligationInAlbatross(caller, 'ob1', deps);
      expect(response).toEqual({
        workId: 'work-new',
        created: true,
        obligation: view({ workId: 'work-new', workTitle: 'Could you confirm' }),
      });
      expect(calls.link.map((entry: any) => entry.workId)).toEqual(['work-old', 'work-new']);
      expect(calls.runs).toBeUndefined();
    }
    const gone = harness({
      record: view({ workId: 'work-old' }),
      link: () => ({ ok: false, error: 'not_found' }),
    });
    await expect(startObligationInAlbatross(caller, 'ob1', gone.deps)).rejects.toMatchObject({ status: 404 });
  });

  test('without a workId: the capture path makes one Albatross from the item and links it', async () => {
    const { deps, calls } = harness();
    const response = await startObligationInAlbatross(caller, 'ob1', deps);
    expect(response).toEqual({
      workId: 'work-new',
      created: true,
      obligation: view({ workId: 'work-new', workTitle: 'Renew the Northwind contract' }),
    });
    expect(calls.capture).toEqual([
      {
        who: caller,
        item: { title: 'Could you confirm the start date?', rawText: obligationAlbatrossText(view()).note },
      },
    ]);
    expect(calls.link).toEqual([{ userId: 'u1', id: 'ob1', workId: 'work-new' }]);
    expect(calls.startRun).toBeUndefined();
  });

  test('a capture with no Albatross, or a lost link, is an error the user can retry', async () => {
    const empty = harness({ captured: [] });
    await expect(startObligationInAlbatross(caller, 'ob1', empty.deps)).rejects.toMatchObject({
      status: 502,
    });
    const lost = harness({ link: () => ({ ok: false, error: 'work_missing' }) });
    await expect(startObligationInAlbatross(caller, 'ob1', lost.deps)).rejects.toMatchObject({ status: 502 });
    const gone = harness({ link: () => ({ ok: false, error: 'not_found' }) });
    await expect(startObligationInAlbatross(caller, 'ob1', gone.deps)).rejects.toMatchObject({ status: 404 });
  });
});

describe('POST /api/obligations/[id]/albatross', () => {
  const context = { params: Promise.resolve({ id: 'ob1' }) };
  const request = () => new NextRequest('http://localhost/api/obligations/ob1/albatross', { method: 'POST' });

  function route(overrides: Record<string, any> = {}, albatross = harness().deps) {
    return createObligationAlbatrossPost({
      requireCurrentUser: (async () => ({ ...caller, source: 'clerk' })) as any,
      enforceUserRateLimit: (async () => undefined) as any,
      albatross,
      ...overrides,
    });
  }

  test('no session is 401; over the rate limit is 429', async () => {
    const signedOut = route({
      requireCurrentUser: async () => {
        throw new AuthRequiredError('Sign in first.');
      },
    });
    expect((await signedOut(request(), context)).status).toBe(401);
    const limited = route({
      enforceUserRateLimit: async () => {
        throw new RateLimitError('Slow down.', 5_000, 20);
      },
    });
    expect((await limited(request(), context)).status).toBe(429);
  });

  test('gives ObligationAlbatrossResponse, with the rate limit of the route', async () => {
    const limits: any[] = [];
    const response = await route({
      enforceUserRateLimit: async (input: any) => {
        limits.push(input);
      },
    })(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workId: 'work-new',
      created: true,
      obligation: view({ workId: 'work-new', workTitle: 'Renew the Northwind contract' }),
    });
    expect(limits).toEqual([{ userId: 'u1', key: 'obligation-albatross', limit: 20, windowMs: 60_000 }]);
  });

  test('the service status and message come back: 404, 400, 409', async () => {
    const notFound = await route({}, harness({ flag: false }).deps)(request(), context);
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ ok: false, error: 'Not found.' });
    expect(
      (await route({}, harness({ record: view({ kind: 'code' }) }).deps)(request(), context)).status,
    ).toBe(400);
    const closed = harness({ record: view({ state: 'dismissed', closeReason: 'not_mine', closedAt: NOW }) });
    expect((await route({}, closed.deps)(request(), context)).status).toBe(409);
  });

  test('an unexpected failure is a fixed 500 text', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const broken = harness();
      broken.deps.get = async () => {
        throw new Error('Convex timeout with private detail');
      };
      const response = await route({}, broken.deps)(request(), context);
      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain('private detail');
    } finally {
      error.mockRestore();
    }
  });

  test('the real dependencies read the flag from LAB86_NEEDS_YOU', () => {
    const previous = process.env.LAB86_NEEDS_YOU;
    try {
      process.env.LAB86_NEEDS_YOU = 'u1';
      expect(obligationAlbatrossDefaults.flag('u1')).toBe(true);
      expect(obligationAlbatrossDefaults.flag('u2')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.LAB86_NEEDS_YOU;
      else process.env.LAB86_NEEDS_YOU = previous;
    }
    expect(new ObligationApiError('x', 418).status).toBe(418);
  });
});
