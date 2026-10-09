import { describe, expect, test } from 'bun:test';
import {
  ANNOUNCE_EVERY_MS,
  announcementText,
  countThreads,
  elapsedLabel,
  formOpensInPlace,
  holdThreadOrder,
  hopDirection,
  isTextFieldTarget,
  listThreadGroups,
  RAIL_EMPTY_COPY,
  railThreadGroups,
  sinceLabel,
  statusWordTone,
  THREAD_FILTER_LABEL,
  THREAD_GROUP_LABEL,
  THREAD_ROW_ACTION_LABEL,
  threadEvents,
  threadGroupKey,
  threadRowAccessibleName,
  threadRowActions,
  threadRowRecedes,
  threadTimeLabel,
  threadTone,
} from '../lib/albatross/thread-list-view';
import { THREAD_STATUS_LABEL, type ThreadRow, type ThreadStatus } from '../lib/albatross/threads';

// The thread list as the web shows it (docs/albatross-threads.md, lead
// decisions 1, 2, 4, 7, 10): groups, voices, time labels, actions, the order
// hold, announcements, and the hop keys.

const NOW = Date.UTC(2026, 9, 8, 14, 0, 0);

function row(over: Partial<ThreadRow> & { status: ThreadStatus }): ThreadRow {
  const working =
    over.status === 'in_progress' || over.status === 'starts_soon' || over.status === 'answering';
  const needsYou =
    over.status === 'needs_answer' ||
    over.status === 'your_turn' ||
    over.status === 'ready_for_you' ||
    over.status === 'did_not_finish';
  return {
    workId: `w_${over.status}`,
    title: 'Renew the car registration',
    areaName: 'Home',
    statusLabel: THREAD_STATUS_LABEL[over.status],
    preview: "Typed your saved Driver's license on dmv.ny.gov",
    stepTitle: 'Renew online',
    nextLabel: null,
    blanks: [],
    needsYou,
    working,
    latestRunId: 'r1',
    workingRunId: working ? 'r1' : null,
    runStartedAt: over.status === 'in_progress' ? NOW - 72_000 : null,
    lastActivityAt: NOW - 3 * 60_000,
    seenAt: null,
    unread: false,
    closed: over.status === 'done',
    ...over,
  };
}

describe('filters and groups', () => {
  test('the filter words are All, Needs you, In progress (lead decision 1)', () => {
    expect(Object.values(THREAD_FILTER_LABEL)).toEqual(['All', 'Needs you', 'In progress']);
  });

  test('did not finish sits with needs you; waiting and paused are their own list groups', () => {
    expect(threadGroupKey(row({ status: 'did_not_finish' }))).toBe('needs_you');
    expect(threadGroupKey(row({ status: 'starts_soon' }))).toBe('working');
    expect(threadGroupKey(row({ status: 'idle' }))).toBe('open');
    expect(threadGroupKey(row({ status: 'waiting' }))).toBe('waiting');
    expect(threadGroupKey(row({ status: 'paused' }))).toBe('paused');
    expect(threadGroupKey(row({ status: 'done' }))).toBe('finished');
    expect(THREAD_GROUP_LABEL.open).toBe('Open');
  });

  test('the list orders its groups and drops empty ones', () => {
    const groups = listThreadGroups([
      row({ status: 'idle', workId: 'a' }),
      row({ status: 'in_progress', workId: 'b' }),
      row({ status: 'needs_answer', workId: 'c' }),
      row({ status: 'done', workId: 'd' }),
    ]);
    expect(groups.map((group) => group.key)).toEqual(['needs_you', 'working', 'open', 'finished']);
  });

  test('the rail folds waiting and paused into Open and leaves finished rows to the foot', () => {
    const groups = railThreadGroups([
      row({ status: 'waiting', workId: 'a' }),
      row({ status: 'paused', workId: 'b' }),
      row({ status: 'done', workId: 'c' }),
      row({ status: 'answering', workId: 'd' }),
    ]);
    expect(groups.map((group) => [group.key, group.rows.map((item) => item.workId)])).toEqual([
      ['working', ['d']],
      ['open', ['a', 'b']],
    ]);
    expect(
      countThreads([row({ status: 'done' }), row({ status: 'your_turn' }), row({ status: 'answering' })]),
    ).toEqual({ all: 2, needsYou: 1, working: 1, finished: 1 });
  });
});

describe('the voice of a row', () => {
  test('needs you is steady accent, work is accent-2 with the halo, starts soon is hollow', () => {
    expect(threadTone('needs_answer')).toBe('needs_you');
    expect(threadTone('did_not_finish')).toBe('needs_you');
    expect(threadTone('in_progress')).toBe('working');
    expect(threadTone('answering')).toBe('working');
    expect(threadTone('starts_soon')).toBe('starts_soon');
    expect(threadTone('done')).toBe('done');
    expect(threadTone('stopped')).toBe('quiet');
    expect(statusWordTone('did_not_finish')).toBe('failed');
    expect(statusWordTone('your_turn')).toBe('needs_you');
  });

  test('work recedes, needs you and the open thread never do, unread rows keep full strength', () => {
    expect(threadRowRecedes(row({ status: 'in_progress' }), false)).toBe(true);
    expect(threadRowRecedes(row({ status: 'in_progress' }), true)).toBe(false);
    expect(threadRowRecedes(row({ status: 'needs_answer' }), false)).toBe(false);
    expect(threadRowRecedes(row({ status: 'idle', unread: true }), false)).toBe(false);
    expect(threadRowRecedes(row({ status: 'idle', unread: false }), false)).toBe(true);
  });
});

describe('the time label', () => {
  test('elapsed time while a run works', () => {
    expect(elapsedLabel(10_000)).toBe('now');
    expect(elapsedLabel(12 * 60_000)).toBe('12m');
    expect(elapsedLabel(64 * 60_000)).toBe('1h 4m');
    expect(elapsedLabel(120 * 60_000)).toBe('2h');
    expect(threadTimeLabel(row({ status: 'in_progress', runStartedAt: NOW - 72_000 }), NOW)).toBe('1m');
  });

  test('time since activity otherwise', () => {
    expect(sinceLabel(NOW - 20_000, NOW, 'en-US', 'UTC')).toBe('now');
    expect(sinceLabel(NOW - 3 * 60_000, NOW, 'en-US', 'UTC')).toBe('3m');
    expect(sinceLabel(NOW - 5 * 3_600_000, NOW, 'en-US', 'UTC')).toBe('5h');
    expect(sinceLabel(NOW - 20 * 3_600_000, NOW, 'en-US', 'UTC')).toBe('Yesterday');
    expect(sinceLabel(NOW - 3 * 86_400_000, NOW, 'en-US', 'UTC')).toBe('Mon');
    expect(sinceLabel(Date.UTC(2026, 9, 1), NOW, 'en-US', 'UTC')).toBe('Oct 1');
    expect(sinceLabel(Date.UTC(2025, 9, 1), NOW, 'en-US', 'UTC')).toBe('Oct 1, 2025');
    expect(
      threadTimeLabel(row({ status: 'idle', lastActivityAt: NOW - 3 * 60_000 }), NOW, 'en-US', 'UTC'),
    ).toBe('3m');
  });
});

describe('hover actions (T10)', () => {
  test('each status offers its verbs, with one primary', () => {
    const labels = (status: ThreadStatus) =>
      threadRowActions(row({ status })).map((action) => `${action.label}${action.primary ? '*' : ''}`);
    expect(labels('needs_answer')).toEqual(['Answer*']);
    expect(labels('your_turn')).toEqual(['Open*']);
    expect(labels('ready_for_you')).toEqual(['Open*']);
    expect(labels('in_progress')).toEqual(['Steer*', 'Stop']);
    expect(labels('starts_soon')).toEqual(['Stop']);
    expect(labels('answering')).toEqual(['Stop']);
    expect(labels('did_not_finish')).toEqual(['Try again*']);
    expect(labels('stopped')).toEqual(['Handle it*']);
    expect(labels('idle')).toEqual([]);
    expect(labels('done')).toEqual([]);
    expect(THREAD_ROW_ACTION_LABEL.handle).toBe('Handle it');
  });

  test('a run without a working run id offers nothing to steer', () => {
    expect(threadRowActions(row({ status: 'in_progress', workingRunId: null }))).toEqual([]);
  });

  test('a small form opens in place; a long or structured one opens the thread', () => {
    const field = (kind: string) => ({ kind });
    expect(formOpensInPlace({ fields: [field('choice'), field('phone')] })).toBe(true);
    expect(formOpensInPlace({ fields: [field('choice'), field('address')] })).toBe(false);
    expect(formOpensInPlace({ fields: Array.from({ length: 5 }, () => field('text')) })).toBe(false);
    expect(formOpensInPlace(null)).toBe(false);
  });
});

describe('the order hold', () => {
  const a = row({ status: 'idle', workId: 'a' });
  const b = row({ status: 'idle', workId: 'b' });
  const c = row({ status: 'idle', workId: 'c' });

  test('without a hold the fresh order wins', () => {
    expect(holdThreadOrder([a, b], [b, a], false).map((item) => item.workId)).toEqual(['b', 'a']);
  });

  test('with a hold shown rows keep their place, a new row takes its fresh place, a gone row leaves', () => {
    const held = holdThreadOrder([a, b, c], [c, b, { ...a, status: 'in_progress' }], true);
    expect(held.map((item) => item.workId)).toEqual(['a', 'b', 'c']);
    expect(held[0].status).toBe('in_progress');
    const added = holdThreadOrder([a, b], [{ ...c }, b, a], true);
    expect(added.map((item) => item.workId)).toEqual(['c', 'a', 'b']);
    expect(holdThreadOrder([a, b, c], [c, a], true).map((item) => item.workId)).toEqual(['a', 'c']);
  });
});

describe('announcements', () => {
  test('three event kinds, merged into one sentence each, the open thread skipped', () => {
    const before = [
      row({ status: 'in_progress', workId: 'a', title: 'Plan the Lisbon trip' }),
      row({ status: 'in_progress', workId: 'b', title: 'Pay the water bill' }),
      row({ status: 'in_progress', workId: 'c', title: 'Order a new passport photo' }),
      row({ status: 'answering', workId: 'd', title: 'Reply to Sam Rivera about the lease' }),
      row({ status: 'in_progress', workId: 'e', title: 'Renew the car registration' }),
    ];
    const after = [
      row({ status: 'needs_answer', workId: 'a', title: 'Plan the Lisbon trip' }),
      row({ status: 'your_turn', workId: 'b', title: 'Pay the water bill' }),
      row({ status: 'did_not_finish', workId: 'c', title: 'Order a new passport photo' }),
      row({ status: 'idle', workId: 'd', title: 'Reply to Sam Rivera about the lease' }),
      row({ status: 'needs_answer', workId: 'e', title: 'Renew the car registration' }),
    ];
    const events = threadEvents(before, after, 'e');
    expect(events.map((event) => event.kind)).toEqual([
      'needs_you',
      'needs_you',
      'did_not_finish',
      'finished',
    ]);
    expect(announcementText(events)).toBe(
      'Two Albatrosses need you: Plan the Lisbon trip, Pay the water bill. Finished: Reply to Sam Rivera about the lease. Did not finish: Order a new passport photo.',
    );
    expect(announcementText([])).toBeNull();
    expect(announcementText([{ kind: 'needs_you', title: 'Plan the Lisbon trip' }])).toBe(
      'One Albatross needs you: Plan the Lisbon trip.',
    );
    expect(ANNOUNCE_EVERY_MS).toBe(5_000);
  });

  test('a row that appears for the first time announces nothing', () => {
    expect(threadEvents([], [row({ status: 'needs_answer' })])).toEqual([]);
  });
});

describe('the hop keys (lead decision 4)', () => {
  const key = (over: Partial<Parameters<typeof hopDirection>[0]>) => ({
    key: 'ArrowDown',
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });

  test('⌘↑ and ⌘↓ outside a text field, ⌥⌘ inside one', () => {
    expect(hopDirection(key({}), false)).toBe('next');
    expect(hopDirection(key({ key: 'ArrowUp' }), false)).toBe('previous');
    expect(hopDirection(key({}), true)).toBeNull();
    expect(hopDirection(key({ altKey: true }), true)).toBe('next');
    expect(hopDirection(key({ key: 'ArrowUp', altKey: true }), true)).toBe('previous');
  });

  test('⌥⌘↩ goes to the next thread that needs you; shift, and plain arrows, do nothing', () => {
    expect(hopDirection(key({ key: 'Enter', altKey: true }), true)).toBe('needs_you');
    expect(hopDirection(key({ key: 'Enter' }), false)).toBeNull();
    expect(hopDirection(key({ shiftKey: true }), false)).toBeNull();
    expect(hopDirection(key({ metaKey: false }), false)).toBeNull();
    expect(hopDirection(key({ metaKey: false, ctrlKey: true }), false)).toBe('next');
  });

  test('text fields are inputs, textareas, selects, and editable elements', () => {
    expect(isTextFieldTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTextFieldTarget({ tagName: 'input' })).toBe(true);
    expect(isTextFieldTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTextFieldTarget({ tagName: 'BUTTON', closest: () => null })).toBe(false);
    expect(isTextFieldTarget(null)).toBe(false);
  });
});

describe('accessibility and empty states', () => {
  test('the accessible name reads title, status, preview, time, and unread', () => {
    expect(threadRowAccessibleName(row({ status: 'needs_answer', unread: true }), '3m')).toBe(
      "Renew the car registration, Needs your answer, Typed your saved Driver's license on dmv.ny.gov, 3m, unread",
    );
    expect(threadRowAccessibleName(row({ status: 'idle', preview: 'Next: Renew online' }), 'Mon')).toBe(
      'Renew the car registration, Next: Renew online, Mon',
    );
  });

  test('each filter has its own empty state', () => {
    expect(RAIL_EMPTY_COPY.needs_you.title).toBe('Nothing needs you.');
    expect(RAIL_EMPTY_COPY.working.title).toBe('No run is in progress.');
  });
});
