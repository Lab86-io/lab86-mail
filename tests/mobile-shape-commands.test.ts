import { describe, expect, test } from 'bun:test';
import { executeMobileCommand, mobileCommandDomain } from '../lib/mobile/v1/command-executor';
import {
  MobileCommandSchema,
  MobileContractV1,
  SyncChangeSchema,
  WorkShapeSyncChangeSchema,
} from '../lib/mobile/v1/contract';
import { mobileOpenAPIV1 } from '../lib/mobile/v1/openapi';

const user = {
  userId: 'user_shape_commands',
  email: 'owner@example.com',
  name: 'Owner',
  source: 'clerk' as const,
};
const createdAt = '2026-09-03T09:00:00.000Z';

function command(kind: string, payload: Record<string, unknown>, idempotencyKey = `${kind}-1`) {
  return MobileCommandSchema.parse({ idempotencyKey, kind, payload, clientCreatedAt: createdAt });
}

function recording(results: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const deps = {
    invoke: async () => ({ ok: true }),
    enqueueApproval: async () => 'approval-1',
    capture: async () => ({ captureId: 'c', status: 'split' as const, workIds: ['w'] }),
    workShapeMutation: async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      return results[name] ?? null;
    },
  } as any;
  return { calls, deps };
}

const listItems = [
  { id: 'li_1', text: 'Heat', done: true, addedAt: 1, doneAt: 5 },
  { id: 'li_2', text: 'Alien', done: false, addedAt: 2 },
];

describe('the contract', () => {
  test('every shape command parses and maps to the work domain', () => {
    const commands = [
      command('work.listAdd', { workID: 'w1', text: 'Blade Runner' }),
      command('work.listToggle', { workID: 'w1', itemID: 'li_1' }),
      command('work.listRemove', { workID: 'w1', itemID: 'li_1' }),
      command('work.metricLog', { workID: 'w2', value: 182.4, at: createdAt, note: 'morning' }),
      command('work.milestoneToggle', { workID: 'w3', milestoneID: 'ms_1' }),
      command('work.setShape', { workID: 'w1', shape: 'list' }),
    ];
    for (const entry of commands) expect(mobileCommandDomain(entry)).toBe('work');
  });

  test('rejects a bad shape word, empty text, and a non-finite value', () => {
    expect(() => command('work.setShape', { workID: 'w1', shape: 'banana' })).toThrow();
    expect(() => command('work.listAdd', { workID: 'w1', text: '   ' })).toThrow();
    expect(() => command('work.metricLog', { workID: 'w1', value: Number.NaN })).toThrow();
  });

  test('the workShape sync change carries only the touched fields', () => {
    const change = SyncChangeSchema.parse({
      entityID: 'w1',
      revision: 3,
      operation: 'upsert',
      domain: 'work',
      entityKind: 'workShape',
      payload: { workID: 'w1', listItems },
    });
    expect(change.entityKind).toBe('workShape');
    expect(
      WorkShapeSyncChangeSchema.safeParse({
        entityID: 'w1',
        revision: 4,
        operation: 'upsert',
        domain: 'work',
        entityKind: 'workShape',
        payload: { workID: 'w1', unknown: true },
      }).success,
    ).toBe(false);
  });

  test('the shape schemas are published and the OpenAPI discriminators map every command', () => {
    for (const name of [
      'WorkShape',
      'WorkListItem',
      'WorkMetric',
      'WorkMetricEntry',
      'WorkMetricSummary',
      'WorkMilestone',
      'WorkShapeSyncChange',
      'WorkListAddCommand',
      'WorkSetShapeCommand',
    ]) {
      expect(MobileContractV1.schemas).toHaveProperty(name);
    }
    const document = mobileOpenAPIV1() as any;
    const mapping = document.components.schemas.MobileCommand.discriminator.mapping;
    for (const kind of MobileContractV1.schemas.MobileCommand.options.map(
      (option: any) => option.shape.kind.value,
    )) {
      expect(mapping[kind]).toBeDefined();
    }
    expect(mapping['calendar.resync']).toBe('#/components/schemas/CalendarResyncCommand');
    expect(document.components.schemas.SyncChange.discriminator.mapping.workShape).toBe(
      '#/components/schemas/WorkShapeSyncChange',
    );
  });
});

describe('the executor', () => {
  test('work.listAdd calls addListItem and reports the whole list', async () => {
    const { calls, deps } = recording({ addListItem: { item: listItems[1], listItems } });
    const result = await executeMobileCommand(
      command('work.listAdd', { workID: 'w1', text: 'Alien' }),
      user,
      deps,
    );
    expect(calls).toEqual([
      { name: 'addListItem', input: { userId: user.userId, workId: 'w1', text: 'Alien' } },
    ]);
    expect(result).toEqual({
      status: 'applied',
      syncDomain: 'work',
      entityKind: 'workShape',
      entityID: 'w1',
      syncPayload: { workID: 'w1', listItems },
    });
  });

  test('work.listToggle and work.listRemove pass the item id', async () => {
    const { calls, deps } = recording({ toggleListItem: { listItems }, removeListItem: { listItems: [] } });
    await executeMobileCommand(command('work.listToggle', { workID: 'w1', itemID: 'li_1' }), user, deps);
    const removed = await executeMobileCommand(
      command('work.listRemove', { workID: 'w1', itemID: 'li_2' }),
      user,
      deps,
    );
    expect(calls.map((call) => [call.name, call.input.itemId])).toEqual([
      ['toggleListItem', 'li_1'],
      ['removeListItem', 'li_2'],
    ]);
    expect(removed.syncPayload).toEqual({ workID: 'w1', listItems: [] });
  });

  test('work.metricLog converts the ISO date and reports the entry, metric, and summary', async () => {
    const at = Date.parse(createdAt);
    const { calls, deps } = recording({
      logMetric: {
        entry: { _id: 'me_1', at, value: 182.4, note: 'morning' },
        metric: { name: 'weight', unit: 'lb', target: 170, direction: 'down' },
        summary: { latest: 182.4, latestAt: at, count: 2, weeksWithEntry: 2 },
      },
    });
    const result = await executeMobileCommand(
      command('work.metricLog', { workID: 'w2', value: 182.4, at: createdAt, note: 'morning' }),
      user,
      deps,
    );
    expect(calls[0]).toEqual({
      name: 'logMetric',
      input: { userId: user.userId, workId: 'w2', value: 182.4, at, note: 'morning' },
    });
    expect(result.syncPayload).toEqual({
      workID: 'w2',
      metric: { name: 'weight', unit: 'lb', target: 170, direction: 'down' },
      metricEntry: { id: 'me_1', at, value: 182.4, note: 'morning' },
      metricSummary: { latest: 182.4, latestAt: at, count: 2, weeksWithEntry: 2 },
    });
    expect(
      SyncChangeSchema.safeParse({
        entityID: 'w2',
        revision: 1,
        operation: 'upsert',
        domain: 'work',
        entityKind: 'workShape',
        payload: result.syncPayload,
      }).success,
    ).toBe(true);
  });

  test('work.milestoneToggle reports the rail; work.setShape reports the word', async () => {
    const milestones = [{ id: 'ms_1', title: 'Build passes', done: true, doneAt: 9, order: 0 }];
    const { calls, deps } = recording({
      toggleMilestone: { milestone: milestones[0], milestones },
      setShape: { shape: 'project', previous: 'list' },
    });
    const toggled = await executeMobileCommand(
      command('work.milestoneToggle', { workID: 'w3', milestoneID: 'ms_1' }),
      user,
      deps,
    );
    expect(toggled.syncPayload).toEqual({ workID: 'w3', milestones });
    const shaped = await executeMobileCommand(
      command('work.setShape', { workID: 'w1', shape: 'project' }),
      user,
      deps,
    );
    expect(calls[1]).toEqual({
      name: 'setShape',
      input: { userId: user.userId, workId: 'w1', shape: 'project' },
    });
    expect(shaped.syncPayload).toEqual({ workID: 'w1', shape: 'project' });
  });
});
