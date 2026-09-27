import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import './tools/harness';
import * as hosted from '../lib/hosted/convex';
import {
  getBriefPreferencesTool,
  getBriefSourcesTool,
  saveBriefPreferencesTool,
} from '../lib/tools/daily-report';
import { runTool } from './tools/harness';

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()?.();
});
function mockConvex(handlers: Record<string, (args: any) => unknown>) {
  const calls: Array<{ name: string; args: any }> = [];
  const run = async (fn: any, args: any) => {
    const name = getFunctionName(fn);
    const key = Object.keys(handlers).find((candidate) => name.endsWith(`:${candidate}`));
    calls.push({ name: key ?? name, args });
    if (!key) throw new Error(`Unexpected Convex call ${name}`);
    return handlers[key](args);
  };
  const query = spyOn(hosted, 'convexQuery').mockImplementation(run as any);
  const mutation = spyOn(hosted, 'convexMutation').mockImplementation(run as any);
  restores.push(
    () => query.mockRestore(),
    () => mutation.mockRestore(),
  );
  return calls;
}

describe('brief preference tools', () => {
  test('read and save the delivery schedule for the signed-in user', async () => {
    const stored = {
      deliveryHour: 7,
      weekendMode: 'light',
      weeklyReview: true,
      emailEnabled: false,
      timezone: null,
    };
    const calls = mockConvex({
      briefPreferences: () => stored,
      saveBriefPreferences: (args) => Object.assign(stored, { deliveryHour: args.deliveryHour }),
    });
    const read = await runTool(getBriefPreferencesTool.handler, {});
    expect(read.preferences).toMatchObject({ deliveryHour: 7, weekendMode: 'light' });
    expect(read.preferences.email.available).toBe(false);
    const saved = await runTool(saveBriefPreferencesTool.handler, { deliveryHour: 10 });
    expect(saved.preferences.deliveryHour).toBe(10);
    expect(calls.find((call) => call.name === 'saveBriefPreferences')?.args).toMatchObject({
      userId: 'test_user_tools',
      deliveryHour: 10,
      timezone: 'America/New_York',
    });
    await expect(runTool(getBriefPreferencesTool.handler, {}, { userId: null })).rejects.toThrow('Sign in');
  });
});

describe('brief source tool', () => {
  test('returns the health summary for the signed-in user', async () => {
    mockConvex({
      briefSourceRows: () => ({
        accounts: [{ accountId: 'a1', email: 'me@example.com', provider: 'google', status: 'connected' }],
        mailSync: [],
        calendarSync: [],
        connections: [],
        connectorSync: [],
      }),
    });
    const result = await runTool(getBriefSourcesTool.handler, {});
    expect(result.health.sources).toHaveLength(1);
    expect(result.health.line).toBe('From 1 mailbox.');
  });
});
