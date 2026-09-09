import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { withDeadline } from '../lib/shared/deadline';

test('optional context timeout releases a stalled caller with its empty fallback', async () => {
  const stalled = new Promise<null>(() => {});
  expect(await withDeadline(stalled, 5, 'Narrative turn capture').catch(() => null)).toBeNull();
  expect(await withDeadline(stalled, 5, 'Plan narrative context').catch(() => '')).toBe('');
  const agent = readFileSync('app/api/agent/route.ts', 'utf8');
  expect(agent).toMatch(/withDeadline\(\s*captureNarrativeTurn\(/);
  expect(agent).toContain("'Narrative turn capture'");
  const planner = readFileSync('lib/albatross/intent-plan.ts', 'utf8');
  expect(planner).toMatch(/withDeadline\(\s*narrativePrompt\(/);
  expect(planner).toContain('150_000 - (Date.now() - planStartedAt)');
  expect(planner).toContain('abortSignal: AbortSignal.timeout(planRemainingMs)');
  const loop = readFileSync('lib/ai/loop.ts', 'utf8');
  expect(loop).toContain('withDeadline(read(userId, query), 8000,');
  expect(loop).toContain('await boundedAgentNarrativeContext(userId, memoryQuery)');
  expect(loop).toContain("'Agent narrative context'");
});
