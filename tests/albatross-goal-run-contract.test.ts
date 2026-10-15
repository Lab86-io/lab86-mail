import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  appendRunMessage,
  CHECKLIST_MAX,
  checklistInputSchema,
  cleanChecklist,
  cleanHandoffItems,
  cleanSources,
  cleanUnsure,
  GOAL_STEP_KEY,
  goalAutoIdentity,
  goalRunsEnabled,
  goalStepIdentity,
  HANDOFF_ITEMS_MAX,
  handoffItemsInputSchema,
  isGoalStepKey,
  RUN_MESSAGE_MAX,
  RUN_MESSAGE_SOURCES_MAX,
  RUN_MESSAGE_TEXT_MAX,
  UNSURE_MAX,
  unsureInputSchema,
} from '../lib/albatross/goal-run-contract';

describe('goal run identity', () => {
  test('one fixed step key, one identity for each Work and each day', () => {
    expect(GOAL_STEP_KEY).toBe('goal');
    expect(isGoalStepKey('goal')).toBe(true);
    expect(isGoalStepKey('step-1')).toBe(false);
    expect(isGoalStepKey(null)).toBe(false);
    expect(goalStepIdentity('w1')).toBe('goal:w1');
    expect(goalAutoIdentity('w1', '2026-10-15')).toBe('goal:w1:2026-10-15');
  });

  test('the switch reads all, a user list, or off', () => {
    expect(goalRunsEnabled('u1', {})).toBe(false);
    expect(goalRunsEnabled('u1', { LAB86_GOAL_RUNS: 'off' })).toBe(false);
    expect(goalRunsEnabled('u1', { LAB86_GOAL_RUNS: 'all' })).toBe(true);
    expect(goalRunsEnabled('u1', { LAB86_GOAL_RUNS: ' u2 , u1 ' })).toBe(true);
    expect(goalRunsEnabled('u3', { LAB86_GOAL_RUNS: 'u2,u1' })).toBe(false);
  });
});

describe('checklist', () => {
  test('keeps text and known states, gives ids, and caps the list', () => {
    const items = cleanChecklist([
      { text: '  Find   the July hours ', state: 'doing' },
      { text: '', state: 'todo' },
      { text: 'Sign the W-9', state: 'yours' },
      { text: 'Odd state', state: 'later' },
    ]);
    expect(items).toEqual([
      { id: 'c1', text: 'Find the July hours', state: 'doing' },
      { id: 'c2', text: 'Sign the W-9', state: 'yours' },
      { id: 'c3', text: 'Odd state', state: 'todo' },
    ]);
    const many = cleanChecklist(
      Array.from({ length: 20 }, (_, index) => ({ text: `Item ${index}`, state: 'todo' })),
    );
    expect(many).toHaveLength(CHECKLIST_MAX);
    expect(cleanChecklist(undefined)).toEqual([]);
  });

  test('the model schema takes the full list', () => {
    expect(
      checklistInputSchema.safeParse({ items: [{ text: 'Find the hours', state: 'todo' }] }).success,
    ).toBe(true);
    expect(checklistInputSchema.safeParse({ items: [] }).success).toBe(false);
    expect(checklistInputSchema.safeParse({ items: [{ text: 'x', state: 'maybe' }] }).success).toBe(false);
    // Model-facing schemas carry no regex patterns (OpenAI Responses rejects them).
    expect(JSON.stringify(z.toJSONSchema(checklistInputSchema))).not.toContain('"pattern"');
  });
});

describe('run messages and sources', () => {
  test('sources need a known kind, a title, and a link or id; duplicates drop', () => {
    const sources = cleanSources([
      { kind: 'web', title: 'IRS Form W-9', url: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf' },
      { kind: 'web', title: 'Same page again', url: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf' },
      { kind: 'mail', title: 'Hours for July', id: 'thread-1', accountId: 'a@example.com' },
      { kind: 'jira', title: 'No link or id' },
      { kind: 'rumor' as any, title: 'Bad kind', url: 'https://example.com' },
    ]);
    expect(sources).toEqual([
      { kind: 'web', title: 'IRS Form W-9', url: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf' },
      { kind: 'mail', title: 'Hours for July', id: 'thread-1', accountId: 'a@example.com' },
    ]);
    const many = cleanSources(
      Array.from({ length: 12 }, (_, index) => ({
        kind: 'web' as const,
        title: `Page ${index}`,
        url: `https://example.com/${index}`,
      })),
    );
    expect(many).toHaveLength(RUN_MESSAGE_SOURCES_MAX);
  });

  test('a message is trimmed, empty text adds nothing, and the newest messages stay', () => {
    expect(appendRunMessage([], { id: 'm0', at: 1, text: '   ' })).toEqual([]);
    const long = appendRunMessage([], { id: 'm1', at: 1, text: 'x'.repeat(RUN_MESSAGE_TEXT_MAX + 50) });
    expect(long[0].text.length).toBeLessThanOrEqual(RUN_MESSAGE_TEXT_MAX);
    expect(long[0].sources).toEqual([]);
    let messages = long;
    for (let index = 2; index <= RUN_MESSAGE_MAX + 5; index += 1)
      messages = appendRunMessage(messages, { id: `m${index}`, at: index, text: `Message ${index}` });
    expect(messages).toHaveLength(RUN_MESSAGE_MAX);
    expect(messages.at(-1)?.id).toBe(`m${RUN_MESSAGE_MAX + 5}`);
  });
});

describe('package items and unsure lines', () => {
  test('items keep known kinds, drop duplicates, cap the list, and mark blanks', () => {
    const items = cleanHandoffItems([
      { kind: 'draft', id: 'd1', title: 'Invoice email to StatPearls', state: 'check' },
      { kind: 'draft', id: 'd1', title: 'Same draft again', state: 'ready' },
      {
        kind: 'document',
        id: 'o1',
        title: 'Invoice',
        state: 'ready',
        blanks: ['invoice number', 'Invoice Number', ''],
      },
      {
        kind: 'file',
        id: 'f1',
        title: 'W-9',
        state: 'odd' as any,
        note: '  The tax ID fills when you send. ',
      },
      { kind: 'spaceship' as any, id: 'x', title: 'Bad kind', state: 'ready' },
      { kind: 'deck', title: '   ', state: 'ready' },
    ]);
    expect(items).toEqual([
      { kind: 'draft', id: 'd1', title: 'Invoice email to StatPearls', state: 'check' },
      { kind: 'document', id: 'o1', title: 'Invoice', state: 'blanks', blanks: ['invoice number'] },
      { kind: 'file', id: 'f1', title: 'W-9', state: 'check', note: 'The tax ID fills when you send.' },
    ]);
    const many = cleanHandoffItems(
      Array.from({ length: 12 }, (_, index) => ({
        kind: 'document' as const,
        id: `d${index}`,
        title: `Doc ${index}`,
        state: 'ready' as const,
      })),
    );
    expect(many).toHaveLength(HANDOFF_ITEMS_MAX);
  });

  test('unsure lines are single lines, unique, and capped', () => {
    expect(
      cleanUnsure(['  I used 78 hours\nfrom Jira. ', 'I used 78 hours from Jira.', '', 'a', 'b', 'c', 'd']),
    ).toEqual(['I used 78 hours from Jira.', 'a', 'b', 'c']);
    expect(cleanUnsure(undefined)).toEqual([]);
    expect(UNSURE_MAX).toBe(4);
  });

  test('the model schemas accept a package and reject too many items', () => {
    expect(
      handoffItemsInputSchema.safeParse([{ kind: 'deck', id: 'p1', title: 'Quarter review', state: 'check' }])
        .success,
    ).toBe(true);
    expect(
      handoffItemsInputSchema.safeParse(
        Array.from({ length: HANDOFF_ITEMS_MAX + 1 }, (_, index) => ({
          kind: 'draft',
          title: `D${index}`,
          state: 'ready',
        })),
      ).success,
    ).toBe(false);
    expect(unsureInputSchema.safeParse(['One line']).success).toBe(true);
    expect(JSON.stringify(z.toJSONSchema(handoffItemsInputSchema))).not.toContain('"pattern"');
  });
});
