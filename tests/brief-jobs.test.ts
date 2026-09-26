import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { createBriefJobPost } from '../app/api/cron/brief-job/route';
import { api, internal } from '../convex/_generated/api';
import { BRIEF_JOB_MAX_ATTEMPTS } from '../convex/briefJobState';
import schema from '../convex/schema';
import { getAiRequestContext } from '../lib/ai/context';
import * as hosted from '../lib/hosted/convex';
import * as environment from '../lib/hosted/env';
import { runBriefJob, waitForBriefJob } from '../lib/mail/brief-jobs';
import { generateDailyReportTool } from '../lib/tools/daily-report';
import { editorialFixture } from './fixtures/editorial';
import { withToolContext } from './tools/harness';

const functions = (api as any).briefJobs;
const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/briefJobs.ts': () => import('../convex/briefJobs'),
  '../convex/userData.ts': () => import('../convex/userData'),
  '../convex/albatrossAreaPulse.ts': () => import('../convex/albatrossAreaPulse'),
  '../convex/accounts.ts': () => import('../convex/accounts'),
};
const originalSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
const originalUrl = process.env.LAB86_MAIL_PUBLIC_URL;
beforeEach(() => {
  process.env.LAB86_CONVEX_INTERNAL_SECRET = 'job-test';
  delete process.env.LAB86_MAIL_PUBLIC_URL;
});
afterEach(() => {
  for (const [key, value] of Object.entries({
    LAB86_CONVEX_INTERNAL_SECRET: originalSecret,
    LAB86_MAIL_PUBLIC_URL: originalUrl,
  }))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});
const caller = { internalSecret: 'job-test', userId: 'owner' };
const daily = {
  ...caller,
  kind: 'daily',
  edition: 'morning',
  reportId: 'edition',
  timezone: 'America/New_York',
};

test('enqueue is atomic, deduplicates active editions, and immediately exposes the new generation', async () => {
  const t = convexTest(schema, modules);
  const first: any = await t.mutation(functions.enqueue, daily);
  const duplicate: any = await t.mutation(functions.enqueue, { ...daily, reportId: 'duplicate' });
  expect(duplicate).toEqual({ ...first, started: false });
  const reports = await t.run((ctx) => ctx.db.query('userDocs').collect());
  expect(reports).toHaveLength(1);
  expect(reports[0].doc).toMatchObject({ _id: 'edition', status: 'partial', progress: { stage: 'queued' } });
  await expect(t.mutation(functions.enqueue, { ...daily, internalSecret: 'wrong' })).rejects.toThrow();
  expect(await t.query(functions.get, { ...caller, id: first.jobId, userId: 'stranger' })).toBeNull();
  expect(
    await t.mutation(functions.claim, { ...caller, id: first.jobId, token: 'a', userId: 'stranger' }),
  ).toBeNull();
  await t.finishInProgressScheduledFunctions();
});

test('heartbeats allow arbitrarily old runs, lost workers are reclaimed, and stale workers cannot publish', async () => {
  const t = convexTest(schema, modules);
  const { jobId }: any = await t.mutation(functions.enqueue, daily);
  const owner = { ...caller, id: jobId, token: 'first-worker' };
  expect(await t.mutation(functions.claim, owner)).toMatchObject({ state: 'running', attempts: 1 });
  await t.run((ctx) => ctx.db.patch(jobId, { createdAt: Date.now() - 7 * 86_400_000 }));
  expect(await t.mutation(functions.heartbeat, owner)).toBe(true);
  expect(await t.query((internal as any).briefJobs.due, {})).toEqual([]);
  expect(await t.mutation(functions.claim, { ...owner, token: 'duplicate' })).toBeNull();
  await t.run((ctx) => ctx.db.patch(jobId, { availableAt: Date.now() - 1 }));
  const next = { ...owner, token: 'replacement-worker' };
  expect(await t.mutation(functions.claim, next)).toMatchObject({ attempts: 2 });
  const save = (token: string, key = 'edition') =>
    t.mutation(api.userData.upsertDoc, {
      ...caller,
      kind: 'dailyReport',
      key,
      doc: { status: 'ready' },
      briefJob: { id: jobId, token },
    });
  await expect(save(owner.token)).rejects.toThrow('ownership changed');
  await expect(save(next.token, 'another-edition')).rejects.toThrow('ownership changed');
  expect(await t.mutation(functions.heartbeat, owner)).toBe(false);
  expect(await t.mutation(functions.settle, owner)).toBe(false);
  expect(await save(next.token)).toMatchObject({ ok: true });
  expect(await t.mutation(functions.settle, next)).toBe(true);
  expect(await t.query(functions.get, { ...caller, id: jobId })).toMatchObject({
    state: 'completed',
    active: false,
  });
  await expect(save(next.token)).rejects.toThrow('ownership changed');
  const fresh: any = await t.mutation(functions.enqueue, { ...daily, reportId: 'new-edition' });
  expect(fresh.started).toBe(true);
  await t.finishInProgressScheduledFunctions();
});

test('failed jobs retain the same edition and retry until the attempt cap', async () => {
  const t = convexTest(schema, modules);
  const { jobId }: any = await t.mutation(functions.enqueue, daily);
  const owner = { ...caller, id: jobId, token: 'worker' };
  await t.run((ctx) => ctx.db.patch(jobId, { attempts: 1 }));
  await t.mutation(functions.claim, owner);
  expect(await t.mutation(functions.settle, { ...owner, error: 'retry' })).toBe(true);
  const job: any = await t.query(functions.get, { ...caller, id: jobId });
  expect(job).toMatchObject({ state: 'queued', active: true, attempts: 2, reportId: 'edition' });
  expect(job.availableAt).toBeGreaterThan(Date.now());
  const report = await t.run((ctx) => ctx.db.query('userDocs').first());
  // Only the empty placeholder shows a progress state while the writer retries.
  expect(report?.doc).toMatchObject({ status: 'partial', progress: { stage: 'Retrying the writer' } });

  // The last allowed attempt publishes what the edition holds and closes the job.
  await t.run((ctx) => ctx.db.patch(jobId, { attempts: BRIEF_JOB_MAX_ATTEMPTS - 1, availableAt: 0 }));
  await t.mutation(functions.claim, { ...owner, token: 'last' });
  expect(await t.mutation(functions.settle, { ...owner, token: 'last', error: 'retry' })).toBe(true);
  expect(await t.query(functions.get, { ...caller, id: jobId })).toMatchObject({
    state: 'completed',
    active: false,
    error: 'retry',
  });
  const published: any = await t.run((ctx) => ctx.db.query('userDocs').first());
  expect(published.doc.status).toBe('ready');
  expect(published.doc.progress).toBeUndefined();
  expect(published.doc.narrative).toContain('could not be written');
  // Write can start a new edition at once.
  expect(((await t.mutation(functions.enqueue, { ...daily, reportId: 'again' })) as any).started).toBe(true);
  await t.finishInProgressScheduledFunctions();
});

test('a terminal writer failure completes the job and keeps the fallback edition ready', async () => {
  const t = convexTest(schema, modules);
  const { jobId }: any = await t.mutation(functions.enqueue, daily);
  const owner = { ...caller, id: jobId, token: 'worker' };
  await t.mutation(functions.claim, owner);
  await t.mutation(api.userData.upsertDoc, {
    ...caller,
    kind: 'dailyReport',
    key: 'edition',
    doc: { _id: 'edition', status: 'ready', document: { version: 2 }, editorial: { mode: 'fallback' } },
    briefJob: { id: jobId, token: owner.token },
  });
  // A retry keeps the published fallback readable and marks it retrying.
  await t.mutation(functions.settle, { ...owner, error: 'retry' });
  let row: any = await t.run((ctx) => ctx.db.query('userDocs').first());
  expect(row.doc).toMatchObject({ status: 'ready', retrying: true });
  expect(row.doc.progress).toBeUndefined();

  await t.run((ctx) => ctx.db.patch(jobId, { availableAt: 0 }));
  await t.mutation(functions.claim, { ...owner, token: 'second' });
  await t.mutation(functions.settle, { ...owner, token: 'second', error: 'No access', terminal: true });
  expect(await t.query(functions.get, { ...caller, id: jobId })).toMatchObject({
    state: 'completed',
    active: false,
    attempts: 2,
  });
  row = await t.run((ctx) => ctx.db.query('userDocs').first());
  expect(row.doc.status).toBe('ready');
  expect(row.doc.retrying).toBeUndefined();
  expect(row.doc.narrative).toBeUndefined();
  await t.finishInProgressScheduledFunctions();
});

test('an area brief leaves generating when its job ends without a writer', async () => {
  const t = convexTest(schema, modules);
  const areaId = await t.run((ctx) =>
    ctx.db.insert('areas', {
      userId: 'owner',
      name: 'Studio',
      kind: 'project',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  for (const lede of ['', 'An earlier account.']) {
    const job: any = await t.mutation(functions.enqueue, { ...caller, kind: 'area', areaId, force: true });
    await t.run(async (ctx) => {
      const brief = await ctx.db.query('albatrossAreaBriefs').first();
      await ctx.db.patch(brief!._id, { lede });
    });
    const owner = { ...caller, id: job.jobId, token: `area-${lede.length}` };
    await t.mutation(functions.claim, owner);
    await t.mutation(functions.settle, { ...owner, error: 'No access', terminal: true });
    expect(await t.run((ctx) => ctx.db.query('albatrossAreaBriefs').first())).toMatchObject({
      status: lede ? 'ready' : 'error',
    });
  }
  await t.finishInProgressScheduledFunctions();
});

test('a later local day starts a new edition and cancels the earlier day unfinished job', async () => {
  const t = convexTest(schema, modules);
  const first: any = await t.mutation(functions.enqueue, daily);
  const area = await t.run((ctx) =>
    ctx.db.insert('areas', {
      userId: 'owner',
      name: 'Studio',
      kind: 'project',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  const areaJob: any = await t.mutation(functions.enqueue, { ...caller, kind: 'area', areaId: area });
  await t.finishInProgressScheduledFunctions();
  const now = Date.now();
  const clock = spyOn(Date, 'now').mockReturnValue(now + 2 * 86_400_000);
  try {
    const later: any = await t.mutation(functions.enqueue, { ...daily, reportId: 'later-edition' });
    expect(later.started).toBe(true);
    expect(later.jobId).not.toBe(first.jobId);
    expect(await t.query(functions.get, { ...caller, id: first.jobId })).toMatchObject({
      active: false,
      state: 'cancelled',
    });
    // Other job kinds are not touched.
    expect(await t.query(functions.get, { ...caller, id: areaJob.jobId })).toMatchObject({ active: true });
    const earlier: any = await t.run((ctx) =>
      ctx.db
        .query('userDocs')
        .filter((q) => q.eq(q.field('key'), 'edition'))
        .first(),
    );
    expect(earlier.doc.status).toBe('ready');
  } finally {
    clock.mockRestore();
  }
  await t.finishInProgressScheduledFunctions();
});

test('a lost completion acknowledgment never downgrades the newly finished edition', async () => {
  const t = convexTest(schema, modules);
  const { jobId }: any = await t.mutation(functions.enqueue, daily);
  const owner = { ...caller, id: jobId, token: 'worker' };
  await t.mutation(functions.claim, owner);
  await t.mutation(api.userData.upsertDoc, {
    ...caller,
    kind: 'dailyReport',
    key: 'edition',
    doc: { status: 'ready', artifactStatus: 'ready', editorial: { mode: 'generated' } },
    briefJob: { id: jobId, token: owner.token },
  });
  await t.mutation(functions.settle, { ...owner, error: 'Completion acknowledgment interrupted' });
  expect(await t.run((ctx) => ctx.db.query('userDocs').first())).toMatchObject({ doc: { status: 'ready' } });
  await t.finishInProgressScheduledFunctions();
});

test('deleting an account revokes running writers before purging their data', async () => {
  const t = convexTest(schema, modules);
  const { jobId }: any = await t.mutation(functions.enqueue, daily);
  const owner = { ...caller, id: jobId, token: 'worker' };
  await t.mutation(functions.claim, owner);
  await t.mutation(api.accounts.deleteUserCascade, caller);
  expect(await t.mutation(functions.heartbeat, owner)).toBe(false);
  await expect(
    t.mutation(api.userData.upsertDoc, {
      ...caller,
      kind: 'dailyReport',
      key: 'edition',
      doc: {},
      briefJob: { id: jobId, token: owner.token },
    }),
  ).rejects.toThrow('ownership changed');
  await t.finishInProgressScheduledFunctions();
});

test('area queues validate ownership and use separate jobs per area', async () => {
  const t = convexTest(schema, modules);
  await expect(t.mutation(functions.enqueue, { ...caller, kind: 'area' })).rejects.toThrow('Area not found');
  await expect(t.mutation(functions.enqueue, { ...caller, kind: 'daily' })).rejects.toThrow(
    'Edition required',
  );
  const areaId = await t.run((ctx) =>
    ctx.db.insert('areas', {
      userId: 'owner',
      name: 'Studio',
      kind: 'personal',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    } as any),
  );
  await expect(
    t.mutation(functions.enqueue, { ...caller, userId: 'stranger', kind: 'area', areaId }),
  ).rejects.toThrow('Area not found');
  const job: any = await t.mutation(functions.enqueue, { ...caller, kind: 'area', areaId, force: true });
  expect(job.started).toBe(true);
  expect(await t.run((ctx) => ctx.db.query('albatrossAreaBriefs').first())).toMatchObject({
    status: 'generating',
  });
  const owner = { ...caller, id: job.jobId, token: 'area-worker' };
  await t.mutation(functions.claim, owner);
  const pulse = {
    lastChange: 'Changed',
    nextMove: 'Review',
    openQuestion: '',
    prose: 'Latest account.',
    model: 'glm',
  };
  await expect(
    t.mutation((api as any).albatrossAreaPulse.saveAreaPulse, {
      ...caller,
      areaId,
      pulse,
      briefJob: { id: job.jobId, token: 'stale' },
    }),
  ).rejects.toThrow('ownership changed');
  await t.mutation((api as any).albatrossAreaPulse.saveAreaPulse, {
    ...caller,
    areaId,
    pulse,
    briefJob: { id: job.jobId, token: owner.token },
  });
  await t.mutation(functions.settle, { ...owner, error: 'Retry' });
  expect(await t.run((ctx) => ctx.db.query('albatrossAreaBriefs').first())).toMatchObject({
    status: 'generating',
  });
  await t.finishInProgressScheduledFunctions();
});

test('forced refresh is honored during a background area check, and archived areas cancel their jobs', async () => {
  const t = convexTest(schema, modules);
  const areaId = await t.run((ctx) =>
    ctx.db.insert('areas', {
      userId: 'owner',
      name: 'Studio',
      kind: 'project',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  const { jobId }: any = await t.mutation(functions.enqueue, {
    ...caller,
    kind: 'area',
    areaId,
    force: false,
  });
  const owner = { ...caller, id: jobId, token: 'check' };
  expect(await t.mutation(functions.claim, owner)).toMatchObject({ force: false });
  expect(await t.mutation(functions.enqueue, { ...caller, kind: 'area', areaId, force: true })).toMatchObject(
    { jobId, started: false },
  );
  await t.mutation(functions.settle, { ...owner, force: false });
  expect(await t.query(functions.get, { ...caller, id: jobId })).toMatchObject({
    state: 'queued',
    force: true,
  });
  const forced = { ...owner, token: 'forced' };
  expect(await t.mutation(functions.claim, forced)).toMatchObject({ force: true });
  await t.mutation(functions.settle, { ...forced, force: true });
  const next: any = await t.mutation(functions.enqueue, { ...caller, kind: 'area', areaId, force: true });
  await t.run((ctx) => ctx.db.patch(areaId, { status: 'archived' }));
  expect(await t.mutation(functions.claim, { ...owner, id: next.jobId })).toBeNull();
  expect(await t.query(functions.get, { ...caller, id: next.jobId })).toMatchObject({
    state: 'cancelled',
    active: false,
  });
  await t.finishInProgressScheduledFunctions();
});

function worker(kind = 'daily') {
  const calls: Array<{ name: string; args: any }> = [];
  const { edition } = editorialFixture();
  const deps = {
    mutation: (async (fn: any, args: any) => {
      const name = getFunctionName(fn);
      calls.push({ name, args });
      if (name === 'briefJobs:claim')
        return {
          kind,
          edition: 'morning',
          reportId: edition._id,
          areaId: 'area',
          timezone: 'America/New_York',
          createdAt: 10,
        };
      return true;
    }) as any,
    query: (async () => ({ livingBrief: null })) as any,
    daily: mock(async (input: any) => {
      expect(getAiRequestContext()).toMatchObject({ userId: 'owner', briefJob: { id: 'job' } });
      expect(input).toMatchObject({ reportId: edition._id, now: 10 });
      return edition;
    }),
    area: mock(async () => ({ pulse: { model: 'glm' } })),
    narrative: mock(async () => ({ status: 'ready' })),
    readDaily: mock(async () => null as any),
    notify: mock(async () => {}),
    noAccess: mock(async () => false),
    now: () => 100,
  };
  return { deps, calls, edition };
}

test('worker completes the saved edition before notification and reuses completed output after restart', async () => {
  for (const checkpoint of [false, true]) {
    const { deps, calls, edition } = worker();
    if (checkpoint) deps.readDaily.mockResolvedValue({ ...edition, artifactStatus: 'ready' } as any);
    await runBriefJob('owner', 'job', deps as any);
    expect(deps.daily.mock.calls).toHaveLength(checkpoint ? 0 : 1);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)?.name).toBe('briefJobs:settle');
    expect(calls.at(-1)?.args.error).toBeUndefined();
  }
});

test('worker retries failed layouts and provider failures without announcing completion', async () => {
  for (const kind of ['daily', 'area', 'narrative']) {
    const { deps, calls, edition } = worker(kind);
    deps.daily.mockResolvedValue({ ...edition, editorial: { mode: 'fallback' } } as any);
    deps.area.mockResolvedValue({ pulse: { model: 'local' } });
    deps.narrative.mockResolvedValue({ status: 'partial' });
    await runBriefJob('owner', 'job', deps as any);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(calls.at(-1)).toMatchObject({
      name: 'briefJobs:settle',
      args: { error: 'The writer will retry automatically.' },
    });
  }
});

test('an availability error from an earlier run stays recoverable', async () => {
  const { deps, calls, edition } = worker();
  deps.daily.mockResolvedValue({
    ...edition,
    editorial: { mode: 'fallback' },
    artifactErrors: [{ stage: 'ai_availability', message: 'old', at: 1 }],
  } as any);
  await runBriefJob('owner', 'job', deps as any);
  expect(deps.notify).not.toHaveBeenCalled();
  expect(calls.at(-1)).toMatchObject({
    name: 'briefJobs:settle',
    args: { error: 'The writer will retry automatically.' },
  });
});

test('no model access during this run publishes the fallback edition and completes the job', async () => {
  const { deps, calls, edition } = worker();
  deps.daily.mockResolvedValue({
    ...edition,
    editorial: { mode: 'fallback' },
    artifactErrors: [{ stage: 'ai_availability', message: 'Choose a plan', at: 100 }],
  } as any);
  await runBriefJob('owner', 'job', deps as any);
  expect(deps.notify).toHaveBeenCalledTimes(1);
  expect(calls.at(-1)?.name).toBe('briefJobs:settle');
  expect(calls.at(-1)?.args.error).toBeUndefined();
});

test('area and narrative writers with no model access, or on the last attempt, complete', async () => {
  for (const kind of ['area', 'narrative']) {
    const { deps, calls } = worker(kind);
    deps.area.mockResolvedValue({ pulse: { model: 'local' } });
    deps.narrative.mockResolvedValue({ status: 'partial' });
    deps.noAccess.mockResolvedValue(true);
    await runBriefJob('owner', 'job', deps as any);
    expect(deps.noAccess).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)?.args.error).toBeUndefined();
  }
  for (const kind of ['daily', 'area', 'narrative']) {
    const { deps, calls, edition } = worker(kind);
    const base = deps.mutation;
    deps.mutation = async (fn: any, args: any) => {
      const result = await base(fn, args);
      return getFunctionName(fn) === 'briefJobs:claim'
        ? { ...result, attempts: BRIEF_JOB_MAX_ATTEMPTS }
        : result;
    };
    deps.daily.mockResolvedValue({ ...edition, editorial: { mode: 'fallback' } } as any);
    deps.area.mockResolvedValue({ pulse: { model: 'local' } });
    deps.narrative.mockResolvedValue({ status: 'partial' });
    await runBriefJob('owner', 'job', deps as any);
    expect(deps.noAccess).not.toHaveBeenCalled();
    expect(calls.at(-1)?.args.error).toBeUndefined();
  }
});

test('a thrown access or credit error settles as terminal, and other errors retry', async () => {
  for (const [error, terminal] of [
    [Object.assign(new Error('Payment required'), { statusCode: 402 }), true],
    [Object.assign(new Error('Plan'), { name: 'AiAccessError' }), true],
    [new Error('socket hang up'), false],
  ] as const) {
    const { deps, calls } = worker();
    deps.daily.mockRejectedValue(error);
    await runBriefJob('owner', 'job', deps as any);
    expect(calls.at(-1)?.args).toMatchObject(
      terminal
        ? { error: 'The writer is unavailable. The edition was published without it.', terminal: true }
        : { error: 'The writer will retry automatically.' },
    );
    if (!terminal) expect(calls.at(-1)?.args.terminal).toBeUndefined();
  }
});

test('a retry over a published fallback edition runs quietly', async () => {
  const { deps, edition } = worker();
  deps.readDaily.mockResolvedValue({ ...edition, status: 'ready', editorial: { mode: 'fallback' } } as any);
  await runBriefJob('owner', 'job', deps as any);
  expect(deps.daily.mock.calls[0][0]).toMatchObject({ quiet: true });
  deps.readDaily.mockResolvedValue({ _id: edition._id, status: 'partial' } as any);
  await runBriefJob('owner', 'job', deps as any);
  expect(deps.daily.mock.calls[1][0]).toMatchObject({ quiet: false });
});

test('area and narrative workers complete, and duplicate deliveries do no model work', async () => {
  for (const kind of ['area', 'narrative']) {
    const { deps, calls } = worker(kind);
    await runBriefJob('owner', 'job', deps as any);
    expect(calls.at(-1)?.args.error).toBeUndefined();
  }
  const { deps } = worker();
  deps.mutation = async () => null as any;
  await runBriefJob('owner', 'job', deps as any);
  expect(deps.daily).not.toHaveBeenCalled();
});

test('area recovery rewrites missing or local pulses even when the source revision is unchanged', async () => {
  for (const model of [undefined, 'local', 'glm']) {
    for (const force of [false, true]) {
      const { deps, calls } = worker('area');
      const mutation = deps.mutation;
      deps.mutation = async (fn: any, args: any) => {
        const result = await mutation(fn, args);
        return getFunctionName(fn) === 'briefJobs:claim' ? { ...result, force } : result;
      };
      deps.query = async () => ({ livingBrief: { status: 'ready', pulseUpdatedAt: 9, pulse: { model } } });
      await runBriefJob('owner', 'job', deps as any);
      expect(deps.area).toHaveBeenCalledWith({
        userId: 'owner',
        areaId: 'area',
        force: force || model !== 'glm',
      });
      expect(calls.at(-1)?.args.error).toBeUndefined();
    }
  }
});

test('aborting a caller stops polling without cancelling the persisted generation', async () => {
  const query = spyOn(hosted, 'convexQuery').mockResolvedValue({ state: 'running' });
  const mutation = spyOn(hosted, 'convexMutation').mockResolvedValue(null);
  try {
    const disconnected = new AbortController();
    disconnected.abort(new Error('Caller disconnected'));
    await expect(waitForBriefJob('owner', 'job', disconnected.signal)).rejects.toThrow('Caller disconnected');
    expect(query).not.toHaveBeenCalled();

    const controller = new AbortController();
    const waiting = waitForBriefJob('owner', 'job', controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(waiting).rejects.toThrow('aborted');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][2]).toBe(controller.signal);
    expect(mutation).not.toHaveBeenCalled();
  } finally {
    query.mockRestore();
    mutation.mockRestore();
  }
});

test('delivery acknowledges before the writer runs and enforces internal authentication', async () => {
  const callbacks: Array<() => Promise<void>> = [];
  const run = mock(async () => {});
  const deps = { authorized: () => true, after: (callback: any) => callbacks.push(callback), run };
  const request = (body: unknown) =>
    new NextRequest('https://test/api/cron/brief-job', { method: 'POST', body: JSON.stringify(body) });
  const post = createBriefJobPost(deps as any);
  expect((await post(request({ id: 'job', userId: 'owner' }))).status).toBe(202);
  expect(run).not.toHaveBeenCalled();
  await callbacks[0]();
  expect(run.mock.calls[0]).toEqual(['owner', 'job']);
  expect((await post(request({}))).status).toBe(400);
  deps.authorized = () => false;
  expect((await post(request({ id: 'job', userId: 'owner' }))).status).toBe(401);
});

test('hosted manual generation uses the durable queue with optional waiting and preserves the tenant', async () => {
  const configured = spyOn(environment, 'isConvexConfigured').mockReturnValue(true);
  const signal = new AbortController().signal;
  const mutations: any[] = [];
  const { edition } = editorialFixture();
  let reads = 0;
  const mutation = spyOn(hosted, 'convexMutation').mockImplementation((async (fn: any, args: any) => {
    mutations.push({ name: getFunctionName(fn), args });
    return { jobId: 'job', reportId: edition._id, started: true };
  }) as any);
  const query = spyOn(hosted, 'convexQuery').mockImplementation((async (fn: any) =>
    getFunctionName(fn) === 'briefJobs:get'
      ? { state: ++reads === 1 ? 'running' : 'completed' }
      : { doc: edition }) as any);
  try {
    for (const wait of [false, true])
      await withToolContext(
        async () => {
          const result = await generateDailyReportTool.handler({ kind: 'manual', wait }, {
            userId: 'owner',
            abortSignal: signal,
          } as any);
          expect(result.report?._id).toBe(edition._id);
          expect(result.started).toBe(true);
        },
        { userId: 'owner' },
      );
    expect(mutations.every((row) => row.name === 'briefJobs:enqueue' && row.args.userId === 'owner')).toBe(
      true,
    );
    expect(mutations.every((row) => row.args.kind === 'daily' && row.args.reportId)).toBe(true);
    expect(
      query.mock.calls
        .filter((call) => getFunctionName(call[0]) === 'briefJobs:get')
        .every((call) => call[2] === signal),
    ).toBe(true);
    await expect(generateDailyReportTool.handler({ kind: 'manual', wait: false }, {} as any)).rejects.toThrow(
      'Sign in',
    );
    query.mockResolvedValue(null);
    await expect(waitForBriefJob('owner', 'missing')).rejects.toThrow('not found');
    query.mockResolvedValue({ state: 'cancelled' });
    await expect(waitForBriefJob('owner', 'cancelled')).rejects.toThrow('cancelled');
  } finally {
    query.mockRestore();
    mutation.mockRestore();
    configured.mockRestore();
  }
});

test('heartbeat loss prevents completion while provider errors remain recoverable', async () => {
  let beat!: () => void;
  const timer = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    beat = callback;
    return 0;
  }) as any);
  try {
    const { deps, calls, edition } = worker();
    const base = deps.mutation;
    deps.mutation = async (fn: any, args: any) =>
      getFunctionName(fn) === 'briefJobs:heartbeat' ? false : base(fn, args);
    deps.daily.mockImplementation(async () => {
      beat();
      await Promise.resolve();
      return edition;
    });
    await runBriefJob('owner', 'job', deps as any);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(calls.some((row) => row.name === 'briefJobs:settle')).toBe(false);
  } finally {
    timer.mockRestore();
  }
});
