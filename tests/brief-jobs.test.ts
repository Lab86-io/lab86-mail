import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { createBriefJobPost } from '../app/api/cron/brief-job/route';
import { api, internal } from '../convex/_generated/api';
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

test('failed jobs retain the same edition and retry without an attempt quota', async () => {
  const t = convexTest(schema, modules);
  const { jobId }: any = await t.mutation(functions.enqueue, daily);
  const owner = { ...caller, id: jobId, token: 'worker' };
  await t.run((ctx) => ctx.db.patch(jobId, { attempts: 1000 }));
  await t.mutation(functions.claim, owner);
  expect(await t.mutation(functions.settle, { ...owner, error: 'retry' })).toBe(true);
  const job: any = await t.query(functions.get, { ...caller, id: jobId });
  expect(job).toMatchObject({ state: 'queued', active: true, attempts: 1001, reportId: 'edition' });
  expect(job.availableAt).toBeGreaterThan(Date.now());
  const report = await t.run((ctx) => ctx.db.query('userDocs').first());
  expect(report?.doc).toMatchObject({ status: 'partial', progress: { stage: 'Retrying the writer' } });
  await t.finishInProgressScheduledFunctions();
});

test('a later local day can start without cancelling a slow earlier edition', async () => {
  const t = convexTest(schema, modules);
  const first: any = await t.mutation(functions.enqueue, daily);
  await t.finishInProgressScheduledFunctions();
  const now = Date.now();
  const clock = spyOn(Date, 'now').mockReturnValue(now + 2 * 86_400_000);
  try {
    const later: any = await t.mutation(functions.enqueue, { ...daily, reportId: 'later-edition' });
    expect(later.started).toBe(true);
    expect(later.jobId).not.toBe(first.jobId);
    expect(await t.query(functions.get, { ...caller, id: first.jobId })).toMatchObject({ active: true });
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
    readDaily: mock(async () => null),
    notify: mock(async () => {}),
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
