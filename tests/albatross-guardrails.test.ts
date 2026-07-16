import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { completionDelta } from '../convex/albatrossWork';

// Albatross 0.9 guardrails audit (issue #89 / epic issue 20).
//
// Epic bullet -> covering test file:
// - "Unit tests for context status transitions"
//   -> tests/albatross-context-graph.test.ts ("candidate to verified/rejected
//      and verified to superseded are the only status transitions").
// - "Unit tests for intent parser output shapes"
//   -> tests/albatross-intent-plan.test.ts (parsePlanGeneration describe:
//      clean JSON, fence stripping, malformed-entry repair, kind coercion,
//      hard failures).
// - "Tests for old task cards with missing area/project/sprint fields"
//   -> this file ("legacy cards without albatross fields flow through
//      completion math") plus tests/tools-salvage.test.ts (salvage pack
//      tolerates cards with no dueAt/priority/area).
// - "Tests that applying plans uses tool registry"
//   -> tests/tools-albatross.test.ts (apply_intent_plan executes steps through
//      the injected invokeTool seam with registry tools tasks_create_card /
//      save_draft, and approvals only execute allowlisted registry tools).
// - "Tests that no permanent facts become verified without confirmation"
//   -> tests/albatross-context-graph.test.ts ("verified facts require explicit
//      user confirmation refs", "sensitive people/job/finance facts are
//      recognized as explicit-confirmation only" — direct
//      assertVerifiedFactAllowed unit tests).
// - "Tests that every intent has an intent plan"
//   -> tests/albatross-intent-plan.test.ts (happy path asserts a savePlan
//      mutation for every parsed generation; unparseable output records
//      planError instead of silently dropping the intent).
// - "Tests that completion events are stored when tasks/intents/projects
//   complete" -> this file (completionDelta pure math + source-level wiring of
//   every completion hook: boards updateCard/moveCard, intents done,
//   markPlanApplied, updateProject done) and the schema/cascade checks below.
// - "Tests that verified facts expose confirmation refs"
//   -> tests/albatross-context-graph.test.ts (ref normalization tests keep
//      confirmation refs bounded and queryable; hasUserConfirmation).
// - "Feature flag off has no visible regression"
//   -> tests/albatross-shell.test.ts (flag-off normalizePrimaryView fallback,
//      persisted-view migration) plus the direct fallback re-check below.
// - "Logging for candidate fact creation, confirmation, rejection, and plan
//   apply" -> partially covered operationally: plan applies record
//   albatrossPlanApplications rows and aiOperations (asserted in
//   tests/tools-albatross.test.ts); fact lifecycle has no dedicated log
//   assertions yet — tracked as a known gap, not silently claimed.

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('completion event math (issue #87/#18 data layer)', () => {
  test('early completion sets completedEarlyByMs only', () => {
    expect(completionDelta(1_000, 5_000)).toEqual({ completedEarlyByMs: 4_000 });
  });

  test('late completion sets completedLateByMs only', () => {
    expect(completionDelta(9_000, 5_000)).toEqual({ completedLateByMs: 4_000 });
  });

  test('completing exactly on the due date counts as 0ms early, not late', () => {
    expect(completionDelta(5_000, 5_000)).toEqual({ completedEarlyByMs: 0 });
  });

  test('no due date yields neither side (distinguishes "no deadline" from "on deadline")', () => {
    expect(completionDelta(5_000)).toEqual({});
    expect(completionDelta(5_000, undefined)).toEqual({});
  });

  test('non-finite inputs record nothing rather than a bogus delta', () => {
    expect(completionDelta(Number.NaN, 5_000)).toEqual({});
    expect(completionDelta(5_000, Number.NaN)).toEqual({});
  });

  test('legacy cards without albatross fields flow through completion math', () => {
    // Pre-albatross cards have no areaId/projectId/sprintId and often no due
    // date; completion recording must not require any of them.
    const legacyCard = { _id: 'card_old', title: 'Old card' } as { dueAt?: number };
    expect(completionDelta(Date.now(), legacyCard.dueAt)).toEqual({});
  });
});

describe('completionEvents storage contract', () => {
  test('schema defines completionEvents with the reporting indexes', () => {
    const schema = read('convex/schema.ts');
    expect(schema).toContain('completionEvents: defineTable(');
    const table = schema.slice(schema.indexOf('completionEvents: defineTable('));
    for (const index of ['by_user', 'by_user_completedAt', 'by_user_project', 'by_user_artifact']) {
      expect(table).toContain(`.index('${index}'`);
    }
    for (const field of [
      'artifactKind',
      'artifactId',
      'completedAt',
      'completedEarlyByMs',
      'completedLateByMs',
    ]) {
      expect(table).toContain(field);
    }
  });

  test('completionEvents is in the account-deletion cascade', () => {
    const accounts = read('convex/accounts.ts');
    const cascade = accounts.slice(accounts.indexOf('deleteUserCascade'));
    expect(cascade).toContain("'completionEvents'");
  });

  test('both card completion paths record a completion event', () => {
    const boards = read('convex/boards.ts');
    // The shared recorder exists and is best-effort via recordCompletionEvent.
    expect(boards).toContain('async function recordCardCompletion(');
    expect(boards).toContain('recordCompletionEvent(ctx, {');
    // updateCard: the completed:true flip records history before the patch.
    const updateCard = boards.slice(
      boards.indexOf('export const updateCard'),
      boards.indexOf('export const moveCard'),
    );
    expect(updateCard).toContain('recordCardCompletion(ctx, userId, card,');
    // moveCard: dragging into the Done column records history too.
    const moveCard = boards.slice(
      boards.indexOf('export const moveCard'),
      boards.indexOf('export const getCardState'),
    );
    expect(moveCard).toContain('recordCardCompletion(ctx, userId, card,');
  });

  test('intent, intent plan, and project completions record events on real transitions only', () => {
    const intents = read('convex/albatrossIntents.ts');
    const work = read('convex/albatrossWork.ts');
    // updateIntent -> 'done' records an 'intent' event, guarded by prior status.
    expect(intents).toContain("args.status === 'done' && intent.status !== 'done'");
    expect(intents).toContain("artifactKind: 'intent'");
    // markPlanApplied records an 'intent_plan' event on first apply only.
    expect(intents).toContain("plan.status !== 'applied'");
    expect(intents).toContain("artifactKind: 'intent_plan'");
    // updateProject -> 'done' records a 'project' event, guarded by prior status.
    expect(work).toContain("args.status === 'done' && project.status !== 'done'");
    expect(work).toContain("artifactKind: 'project'");
    // The recorder itself never throws into the calling mutation.
    expect(work).toContain('// Non-fatal by design');
  });
});

describe('projects lens progress contract (frozen shape)', () => {
  // listProjectsWithProgress counts albatrossProjectLinks by artifactKind.
  // albatross_apply_intent_plan writes exactly these kinds for created
  // artifacts (asserted behaviorally in tests/tools-albatross.test.ts); this
  // pins the query side so a rename on either end fails a test instead of
  // silently zeroing the Projects lens.
  test('listProjectsWithProgress derives taskCount/completedTaskCount/intentCount/eventCount from project links', () => {
    const work = read('convex/albatrossWork.ts');
    const query = work.slice(
      work.indexOf('export const listProjectsWithProgress'),
      work.indexOf('export const projectTasks'),
    );
    expect(query).toContain("albatrossProjectLinks'");
    expect(query).toContain("link.artifactKind === 'task'");
    expect(query).toContain("link.artifactKind === 'intent'");
    expect(query).toContain("link.artifactKind === 'calendarEvent'");
    for (const field of ['taskCount', 'completedTaskCount', 'intentCount', 'eventCount']) {
      expect(query).toContain(field);
    }
    // completedTaskCount resolves the linked board cards and checks completedAt.
    expect(query).toContain("normalizeId('cards'");
    expect(query).toContain('card.completedAt');
  });

  test('the apply tool links created artifacts under the kinds the progress query counts', () => {
    const tool = read('lib/tools/albatross.ts');
    expect(tool).toContain("? 'calendarEvent'");
    expect(tool).toContain("? 'emailDraft'");
    expect(tool).toContain(": 'task'");
    expect(tool).toContain("artifactKind: 'intent'");
  });
});

describe('feature flag off regression guard (re-check)', () => {
  test('albatross views fall back when the flag is off', async () => {
    const { normalizePrimaryView } = await import('../lib/shared/types');
    expect(normalizePrimaryView('mail', false)).toBe('mail');
    expect(normalizePrimaryView('areas', false)).not.toBe('areas');
    expect(normalizePrimaryView('intents', false)).not.toBe('intents');
  });
});

describe('agent loop tool belt exposure', () => {
  // Registration in TOOLS is not enough: the agent loop only surfaces tools
  // named in AGENT_TOOL_NAMES. A prompt that briefs a tool the loop withholds
  // produces "tried to call unavailable tool" at runtime (seen live with
  // area_domain_activity in the Teach chat).
  test('every prompt-briefed albatross tool is in the loop allowlist', async () => {
    const { AGENT_TOOL_NAMES } = await import('../lib/ai/loop');
    const { TOOLS } = await import('../lib/tools/index');
    const briefed = [
      'area_list',
      'area_create',
      'area_archive',
      'area_add_fact',
      'area_fact_set_status',
      'area_domain_activity',
      'salvage_context',
    ];
    for (const name of briefed) {
      expect(TOOLS[name as keyof typeof TOOLS]).toBeTruthy();
      expect(AGENT_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  test('every tool name mentioned in the Teach prompt resolves to an exposed tool', async () => {
    const { AGENT_TOOL_NAMES } = await import('../lib/ai/loop');
    const { TEACH_SYSTEM_PROMPT } = await import('../lib/albatross/teach-prompt');
    const mentioned = new Set(TEACH_SYSTEM_PROMPT.match(/\b(?:area|salvage)_[a-z_]+\b/g) ?? []);
    expect(mentioned.size).toBeGreaterThan(0);
    for (const name of mentioned) {
      expect(AGENT_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  test('connected-source tools promised by the system prompt are exposed', async () => {
    const { AGENT_TOOL_NAMES } = await import('../lib/ai/loop');
    const { SYSTEM_PROMPT } = await import('../lib/ai/system-prompt');
    const { TOOLS } = await import('../lib/tools/index');
    for (const name of ['mcp_search', 'mcp_list_items', 'mcp_create_task']) {
      expect(SYSTEM_PROMPT).toContain(name);
      expect(TOOLS[name as keyof typeof TOOLS]).toBeTruthy();
      expect(AGENT_TOOL_NAMES.has(name)).toBe(true);
    }
  });
});

describe('salvage_context registration (issue #86/#17)', () => {
  test('salvage_context is registered as a read-only tool and briefed in the system prompt', async () => {
    const { TOOLS } = await import('../lib/tools/index');
    const tool = TOOLS.salvage_context;
    expect(tool).toBeTruthy();
    expect(tool.mutating).toBe(false);
    const { SYSTEM_PROMPT } = await import('../lib/ai/system-prompt');
    expect(SYSTEM_PROMPT).toContain('salvage_context');
    expect(SYSTEM_PROMPT).toContain('Salvage Today');
    // Tone contract from the epic: confrontational-but-kind, never shaming.
    expect(SYSTEM_PROMPT).toContain('never shaming');
  });
});
