import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  __setAreaToolDepsForTest,
  areaAddFact,
  areaArchive,
  areaCreate,
  areaDomainActivity,
  areaFactSetStatus,
  areaHome,
  areaList,
  TEACH_SYSTEM_PROMPT,
  workHome,
} from '../lib/tools/areas';
import { runTool, TEST_USER } from './tools/harness';

const apiMock = {
  albatross: {
    listAreasOverview: 'albatross.listAreasOverview',
    createArea: 'albatross.createArea',
    getArea: 'albatross.getArea',
    archiveArea: 'albatross.archiveArea',
    areaHome: 'albatross.areaHome',
    addAreaFact: 'albatross.addAreaFact',
    verifyAreaFact: 'albatross.verifyAreaFact',
    rejectAreaFact: 'albatross.rejectAreaFact',
    supersedeAreaFact: 'albatross.supersedeAreaFact',
    domainActivity: 'albatross.domainActivity',
  },
  albatrossWorkV2: {
    areaWork: 'albatrossWorkV2.areaWork',
    workDetail: 'albatrossWorkV2.workDetail',
  },
};

const NOW = 1_760_000_000_000;
let mutationCalls: Array<{ fn: string; args: any }> = [];
let queryCalls: Array<{ fn: string; args: any }> = [];

beforeEach(() => {
  mutationCalls = [];
  queryCalls = [];
  __setAreaToolDepsForTest({
    api: apiMock as any,
    now: () => NOW,
    convexMutation: (async (fn: any, args: any) => {
      mutationCalls.push({ fn, args });
      if (fn === apiMock.albatross.createArea) return 'area_new';
      if (fn === apiMock.albatross.addAreaFact) return 'fact_new';
      return { ok: true };
    }) as any,
    convexQuery: (async (fn: any, args: any) => {
      queryCalls.push({ fn, args });
      if (fn === apiMock.albatross.listAreasOverview) {
        return [
          {
            _id: 'area_1',
            name: 'Cardhunt job',
            status: 'active',
            factCounts: { verified: 2, candidate: 1 },
          },
        ];
      }
      if (fn === apiMock.albatross.getArea) {
        return { _id: args.areaId, name: 'Cardhunt job', status: 'active', boardId: 'board_new' };
      }
      if (fn === apiMock.albatross.areaHome) {
        return {
          area: { _id: args.areaId, name: 'Cardhunt job', kind: 'job' },
          livingBrief: { status: 'ready', lede: 'Two things need you today.', summary: 'Steady.' },
          facts: { verified: [], candidate: [] },
          mail: [],
          events: [],
          tasks: [],
          plans: [],
          projects: [],
          places: [],
          counts: {
            facts: { verified: 2, candidate: 1 },
            mail: 0,
            events: 0,
            tasks: 0,
            plans: 0,
            projects: 0,
            places: 0,
          },
        };
      }
      if (fn === apiMock.albatrossWorkV2.areaWork) {
        return [
          {
            _id: 'work_1',
            title: 'Prepare the launch review',
            rawText: 'Get the launch review ready',
            status: 'ready',
            workState: 'active',
            agentState: 'idle',
            updatedAt: NOW,
          },
        ];
      }
      if (fn === apiMock.albatrossWorkV2.workDetail) {
        return {
          work: {
            _id: args.workId,
            title: 'Prepare the launch review',
            rawText: 'Get the launch review ready',
            status: 'ready',
            workState: 'active',
            agentState: 'idle',
            updatedAt: NOW,
          },
          plan: {
            _id: 'plan_1',
            status: 'ready',
            outcome: 'A launch review that is ready to send',
            summary: 'The evidence and next steps are assembled.',
            artifactHtml: '<main><h1>Launch review</h1></main>',
            assumptions: [],
            sourceRefs: [],
            digitalActions: [],
            physicalActions: [],
          },
          project: null,
          questions: [],
          areaLinks: [],
          application: null,
        };
      }
      if (fn === apiMock.albatross.domainActivity) {
        return {
          domain: args.domain ?? null,
          senderEmail: args.senderEmail ?? null,
          threadsScanned: 120,
          threadsMatched: 9,
          senders: [
            { email: 'alice@cardhunt.com', threads: 6, lastDate: NOW, recentSubjects: ['Standup notes'] },
          ],
        };
      }
      return null;
    }) as any,
  });
});

afterAll(() => {
  __setAreaToolDepsForTest();
});

describe('area_list', () => {
  test('returns areas with fact counts and forwards the status filter', async () => {
    const result: any = await runTool(areaList.handler, { status: 'active' });
    expect(result.areas).toHaveLength(1);
    expect(result.areas[0].factCounts).toEqual({ verified: 2, candidate: 1 });
    expect(queryCalls[0]).toMatchObject({
      fn: apiMock.albatross.listAreasOverview,
      args: { userId: TEST_USER.userId, status: 'active' },
    });
  });
});

describe('area_create', () => {
  test('creates the area with name, kind, and description, and echoes its task board', async () => {
    const result: any = await runTool(areaCreate.handler, {
      name: 'Cardhunt job',
      kind: 'job',
      description: 'Day job at cardhunt.com',
    });
    // The echo (name + active status + board) is what lets the Teach chat
    // truthfully confirm "it's in your sidebar now, with its own task board"
    // without a follow-up read.
    expect(result).toEqual({
      ok: true,
      areaId: 'area_new',
      name: 'Cardhunt job',
      status: 'active',
      boardId: 'board_new',
    });
    expect(mutationCalls[0]).toMatchObject({
      fn: apiMock.albatross.createArea,
      args: { userId: TEST_USER.userId, name: 'Cardhunt job', kind: 'job' },
    });
    // The board linkage is read back from the created area, never invented.
    expect(queryCalls[0]).toMatchObject({
      fn: apiMock.albatross.getArea,
      args: { userId: TEST_USER.userId, areaId: 'area_new' },
    });
  });

  test('a failed board read still reports the created area (boardId simply omitted)', async () => {
    __setAreaToolDepsForTest({
      api: apiMock as any,
      convexMutation: (async () => 'area_new') as any,
      convexQuery: (async () => {
        throw new Error('getArea unavailable');
      }) as any,
    });
    const result: any = await runTool(areaCreate.handler, { name: 'Cardhunt job' });
    expect(result).toEqual({ ok: true, areaId: 'area_new', name: 'Cardhunt job', status: 'active' });
  });

  test('the tool contract promises immediate sidebar visibility and a task board', () => {
    expect(areaCreate.description).toContain('sidebar');
    expect(areaCreate.description).toContain('task board');
    expect(areaCreate.description).toContain('reuses its board');
  });
});

describe('area_archive', () => {
  test('archives — never deletes — the area', async () => {
    const result: any = await runTool(areaArchive.handler, { areaId: 'area_1', reason: 'Quit the job' });
    expect(result).toEqual({ ok: true });
    expect(mutationCalls).toHaveLength(1);
    expect(mutationCalls[0].fn).toBe(apiMock.albatross.archiveArea);
    expect(mutationCalls[0].args).toMatchObject({ userId: TEST_USER.userId, areaId: 'area_1' });
  });

  test('the tool contract says archive, not delete', () => {
    expect(areaArchive.description).toContain('NEVER deletes');
  });
});

describe('area_add_fact', () => {
  test('confirmedByUser=true writes a verified fact with a server-minted confirmation ref', async () => {
    const result: any = await runTool(areaAddFact.handler, {
      areaId: 'area_1',
      kind: 'domain',
      value: 'cardhunt.com',
      confirmedByUser: true,
    });
    expect(result).toEqual({ ok: true, factId: 'fact_new', status: 'verified' });
    const args = mutationCalls[0].args;
    expect(mutationCalls[0].fn).toBe(apiMock.albatross.addAreaFact);
    expect(args.status).toBe('verified');
    expect(args.confirmationRefs).toHaveLength(1);
    expect(args.confirmationRefs[0]).toMatchObject({
      kind: 'userConfirmation',
      confirmedAt: NOW,
      confirmedBy: TEST_USER.userId,
      prompt: 'Confirmed in the Teach conversation',
    });
  });

  test('confirmedByUser=false stays a candidate with no confirmation refs', async () => {
    const result: any = await runTool(areaAddFact.handler, {
      areaId: 'area_1',
      kind: 'person',
      value: 'Alice — probably a coworker',
      confirmedByUser: false,
      sourceRefs: [{ kind: 'mailThread', id: 'thread_1' }],
    });
    expect(result.status).toBe('candidate');
    const args = mutationCalls[0].args;
    expect(args.status).toBe('candidate');
    expect(args.confirmationRefs).toBeUndefined();
    expect(args.sourceRefs).toHaveLength(1);
  });

  test('the tool contract demands an explicit per-fact yes', () => {
    expect(areaAddFact.description).toContain('ONLY after the user explicitly said yes to THIS exact fact');
  });
});

describe('area_fact_set_status', () => {
  test('verified routes to verifyAreaFact with a server-minted confirmation ref', async () => {
    await runTool(areaFactSetStatus.handler, { factId: 'fact_1', status: 'verified' });
    expect(mutationCalls[0].fn).toBe(apiMock.albatross.verifyAreaFact);
    expect(mutationCalls[0].args.confirmationRefs[0]).toMatchObject({
      kind: 'userConfirmation',
      confirmedAt: NOW,
      prompt: 'Confirmed in the Teach conversation',
    });
  });

  test('rejected routes to rejectAreaFact with the reason', async () => {
    await runTool(areaFactSetStatus.handler, {
      factId: 'fact_1',
      status: 'rejected',
      reason: 'Wrong person',
    });
    expect(mutationCalls[0]).toMatchObject({
      fn: apiMock.albatross.rejectAreaFact,
      args: { factId: 'fact_1', reason: 'Wrong person' },
    });
  });

  test('superseded routes to supersedeAreaFact', async () => {
    await runTool(areaFactSetStatus.handler, { factId: 'fact_1', status: 'superseded' });
    expect(mutationCalls[0].fn).toBe(apiMock.albatross.supersedeAreaFact);
  });
});

describe('area_home', () => {
  test('loads one area by id for the signed-in user and returns the combined home', async () => {
    const result: any = await runTool(areaHome.handler, { areaId: 'area_1' });
    expect(queryCalls.find((call) => call.fn === apiMock.albatross.areaHome)).toMatchObject({
      fn: apiMock.albatross.areaHome,
      args: { userId: TEST_USER.userId, areaId: 'area_1' },
    });
    expect(queryCalls.find((call) => call.fn === apiMock.albatrossWorkV2.areaWork)).toMatchObject({
      fn: apiMock.albatrossWorkV2.areaWork,
      args: { userId: TEST_USER.userId, areaId: 'area_1' },
    });
    expect(result.home.area._id).toBe('area_1');
    expect(result.home.livingBrief.status).toBe('ready');
    expect(result.home.work[0]._id).toBe('work_1');
    // The count block the native Area detail leads with is passed through intact.
    expect(result.home.counts.facts).toEqual({ verified: 2, candidate: 1 });
  });

  test('is read-only and requires an authenticated user', async () => {
    expect(areaHome.mutating).toBe(false);
    await expect(runTool(areaHome.handler, { areaId: 'area_1' }, { userId: null })).rejects.toThrow(
      'Not authenticated.',
    );
  });
});

describe('work_home', () => {
  test('loads the durable Work record and its rendered plan brief', async () => {
    const result: any = await runTool(workHome.handler, { workId: 'work_1' });
    expect(queryCalls[0]).toMatchObject({
      fn: apiMock.albatrossWorkV2.workDetail,
      args: { userId: TEST_USER.userId, workId: 'work_1' },
    });
    expect(result.detail.work._id).toBe('work_1');
    expect(result.detail.plan.artifactHtml).toContain('Launch review');
    expect(workHome.mutating).toBe(false);
  });

  test('requires the same authenticated user boundary as the Area', async () => {
    await expect(runTool(workHome.handler, { workId: 'work_1' }, { userId: null })).rejects.toThrow(
      'Not authenticated.',
    );
  });
});

describe('area_domain_activity', () => {
  test('returns top senders for a domain', async () => {
    const result: any = await runTool(areaDomainActivity.handler, { domain: 'cardhunt.com', max: 10 });
    expect(result.threadsMatched).toBe(9);
    expect(result.senders[0].email).toBe('alice@cardhunt.com');
    expect(queryCalls[0]).toMatchObject({
      fn: apiMock.albatross.domainActivity,
      args: { userId: TEST_USER.userId, domain: 'cardhunt.com', max: 10 },
    });
  });

  test('input schema rejects a call with neither domain nor senderEmail', () => {
    expect(areaDomainActivity.input.safeParse({ max: 5 }).success).toBe(false);
    expect(areaDomainActivity.input.safeParse({ senderEmail: 'a@b.com' }).success).toBe(true);
  });
});

describe('teach prompt', () => {
  test('mentions the task board that area_create gives every area', () => {
    expect(TEACH_SYSTEM_PROMPT).toContain('with its own task board');
  });

  test('encodes the conversation contract', () => {
    expect(TEACH_SYSTEM_PROMPT).toContain('confirmedByUser=true ONLY after the user explicitly said yes');
    expect(TEACH_SYSTEM_PROMPT).toContain('ask_user');
    expect(TEACH_SYSTEM_PROMPT).toContain('area_domain_activity');
    expect(TEACH_SYSTEM_PROMPT).toContain('any other areas');
    expect(TEACH_SYSTEM_PROMPT).toContain('Archiving never deletes');
    expect(TEACH_SYSTEM_PROMPT).not.toContain('!');
  });
});
