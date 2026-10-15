import { describe, expect, test } from 'bun:test';
import {
  activeTabKey,
  CHECKLIST_STATE_WORD,
  checklistCount,
  durationLabel,
  fileKindWord,
  formatFileSize,
  GOAL_RUN_COPY,
  hostOf,
  isGoalRun,
  isGoalWork,
  itemForTarget,
  itemStateLine,
  liveLine,
  newestGoalRun,
  newestPackageRun,
  packageLine,
  packageRows,
  packageTabs,
  runSources,
  runWhenLine,
  savedFileDownloadUrl,
  savedFilePreviewUrl,
  sourceChip,
  sourceChipName,
  sourceLocator,
  tabPane,
  visibleMessages,
  webUrl,
} from '../lib/albatross/goal-run-view';
import {
  GOAL_DRAFT_ID,
  GOAL_INVOICE_DOCUMENT_ID,
  GOAL_W9_FILE_ID,
  goalDetailFixture,
  goalItemsFixture,
  goalMessageFixtures,
  goalRunFixtures,
  goalSourceFixtures,
  threadDetailFixture,
  threadRunFixtures,
} from '../lib/albatross/thread-fixtures';

/* The goal run block, as the web client reads it: the header, the messages
 * and their fold, the source chips, the checklist, the package rows, and the
 * document tabs (docs/research/goal-runs-web-design-2026-10-15.md). */

const NOW = Date.UTC(2026, 9, 15, 18, 44, 0);
const runs = goalRunFixtures(NOW);
const steps = threadRunFixtures(NOW);

describe('a goal run', () => {
  test('is one with the goal flag, or with messages, a checklist, or items', () => {
    expect(isGoalRun(runs.goalRunning)).toBe(true);
    expect(isGoalRun({ goal: false, messages: [], checklist: [], items: goalItemsFixture() })).toBe(true);
    expect(isGoalRun(steps.running)).toBe(false);
    expect(isGoalRun(null)).toBe(false);
  });

  test('a goal Work says so, or has a goal run', () => {
    expect(isGoalWork(goalDetailFixture(NOW), [])).toBe(true);
    expect(isGoalWork(threadDetailFixture(NOW), [runs.goalRunning])).toBe(true);
    expect(isGoalWork(threadDetailFixture(NOW), [steps.running])).toBe(false);
  });
});

describe('the header line', () => {
  test('a run at work says when it started', () => {
    expect(runWhenLine(runs.goalRunning, { timeZone: 'UTC' })).toEqual({
      text: 'Started 6:38 PM',
      duration: null,
    });
    expect(runWhenLine(runs.goalQueued, { timeZone: 'UTC' })).toEqual({
      text: 'Started 6:43 PM',
      duration: null,
    });
  });

  test('a finished run says the start time and the duration beside it, with no dot', () => {
    expect(runWhenLine(runs.goalPackage, { timeZone: 'UTC' })).toEqual({
      text: '6:31 PM',
      duration: '11 min',
    });
    expect(runWhenLine(runs.goalStoppedTime, { timeZone: 'UTC' })).toEqual({
      text: '6:13 PM',
      duration: '30 min',
    });
  });

  test('durations read as minutes, then hours', () => {
    expect(durationLabel(20_000)).toBe('under a minute');
    expect(durationLabel(13 * 60_000)).toBe('13 min');
    expect(durationLabel(72 * 60_000)).toBe('1 h 12 min');
    expect(durationLabel(120 * 60_000)).toBe('2 h');
  });
});

describe('messages', () => {
  const messages = goalMessageFixtures(NOW, 11);

  test('six stay open while the run works, three after it ends', () => {
    const working = visibleMessages(messages, { working: true });
    expect(working.open.length).toBe(6);
    expect(working.folded.length).toBe(5);
    expect(working.open[5].id).toBe('msg_11');
    const finished = visibleMessages(messages, { working: false });
    expect(finished.open.length).toBe(3);
    expect(finished.folded.length).toBe(8);
  });

  test('a short run folds nothing, and showAll opens every message', () => {
    expect(visibleMessages(messages.slice(0, 3), { working: false }).folded).toEqual([]);
    expect(visibleMessages(messages, { working: false, showAll: true }).open.length).toBe(11);
  });

  test('the sources of a run list once, in order of first use', () => {
    const sources = runSources({ messages });
    expect(sources.map((source) => source.title)).toEqual([
      'BP-214 worklog, July',
      'July hours',
      'Invoice 0006',
      'Rate for the autumn work',
      'Form W-9 (Rev. March 2024)',
    ]);
  });
});

describe('source chips', () => {
  test('a web chip shows the host and opens a new tab', () => {
    const chip = sourceChip(goalSourceFixtures.w9);
    expect(chip.text).toBe('Form W-9 (Rev. March 2024)');
    expect(chip.locator).toBe('irs.gov');
    expect(chip.external).toBe(true);
    expect(chip.behaviour).toEqual({
      kind: 'open_url',
      url: 'https://www.irs.gov/forms-pubs/about-form-w-9',
    });
    expect(sourceChipName(chip)).toBe('Form W-9 (Rev. March 2024), irs.gov, opens in a new tab');
    expect(chip.title).toContain('https://www.irs.gov/');
  });

  test('a mail chip opens the thread in its account; its locator is the server detail', () => {
    const chip = sourceChip(goalSourceFixtures.mailHours);
    expect(chip.locator).toBe('Priya, Jul 30');
    expect(sourceChip({ ...goalSourceFixtures.mailHours, detail: undefined }).locator).toBeNull();
    expect(sourceChipName(chip)).toBe('July hours, Priya, Jul 30');
    expect(chip.behaviour).toEqual({
      kind: 'open_mail',
      threadId: 'thread_july_hours',
      accountId: 'sam.rivera@example.com',
    });
    expect(chip.external).toBe(false);
  });

  test('a Jira chip shows the server detail and opens its URL; without one it is text', () => {
    const chip = sourceChip(goalSourceFixtures.jira);
    expect(chip.behaviour?.kind).toBe('open_url');
    expect(chip.locator).toBe('BP-214');
    expect(sourceChip({ kind: 'jira', title: 'BP-9', id: 'BP-9' }).behaviour).toBeNull();
    expect(sourceChip({ kind: 'jira', title: 'An issue', id: '10042' }).locator).toBeNull();
    expect(sourceChip({ kind: 'jira', title: 'An issue', id: '10042', detail: 'BP-9' }).locator).toBe('BP-9');
  });

  test('a document chip opens the package tab when the item is in it, else the document', () => {
    const tabs = packageTabs(runs.goalPackage);
    const inPackage = sourceChip(
      { kind: 'document', title: 'Invoice 0007', id: GOAL_INVOICE_DOCUMENT_ID },
      tabs,
    );
    expect(inPackage.behaviour).toEqual({ kind: 'open_tab', key: `document:${GOAL_INVOICE_DOCUMENT_ID}` });
    const elsewhere = sourceChip(goalSourceFixtures.invoice0006, tabs);
    expect(elsewhere.behaviour).toEqual({
      kind: 'open_document',
      url: '/?view=files&document=doc_invoice_0006',
      id: 'doc_invoice_0006',
    });
  });

  test('a file chip needs a server link; a calendar chip needs an id', () => {
    expect(sourceChip({ kind: 'file', title: 'Notes', id: 'upload_1' }).behaviour).toBeNull();
    expect(
      sourceChip({ kind: 'file', title: 'Notes', id: 'upload_1', url: '/?view=files&file=upload_1' })
        .behaviour,
    ).toEqual({ kind: 'open_file', url: '/?view=files&file=upload_1', id: 'upload_1' });
    expect(sourceChip(goalSourceFixtures.calendar).behaviour).toEqual({
      kind: 'open_calendar',
      id: 'evt_invoice_day',
    });
  });

  test('a long title is cut for the chip and kept in the tooltip', () => {
    const chip = sourceChip({
      kind: 'web',
      title: 'A very long page title that runs on and on past the chip width',
      url: 'https://example.com/a',
    });
    expect(chip.text.length).toBeLessThanOrEqual(33);
    expect(chip.title.startsWith('A very long page title that runs on and on')).toBe(true);
  });

  test('only http and https URLs open', () => {
    expect(webUrl('javascript:alert(1)')).toBeNull();
    expect(webUrl('https://example.com/x')).toBe('https://example.com/x');
    expect(hostOf('https://www.irs.gov/forms')).toBe('irs.gov');
    expect(hostOf('not a url')).toBeNull();
    expect(sourceChip({ kind: 'web', title: 'Bad', url: 'javascript:alert(1)' }).behaviour).toBeNull();
  });

  test('the locator is the server detail, the host for a web page without one, else nothing', () => {
    expect(sourceLocator(goalSourceFixtures.w9)).toBe('irs.gov');
    expect(sourceLocator({ ...goalSourceFixtures.w9, detail: 'irs.gov forms' })).toBe('irs.gov forms');
    expect(sourceLocator(goalSourceFixtures.invoice0006)).toBeNull();
    expect(sourceLocator({ kind: 'calendar', title: 'Invoice day', id: 'evt_1', detail: 'Oct 15' })).toBe(
      'Oct 15',
    );
    for (const source of Object.values(goalSourceFixtures))
      expect(sourceLocator(source) ?? '').not.toContain('·');
  });
});

describe('the checklist and the live line', () => {
  test('the count is done over all items', () => {
    expect(checklistCount(runs.goalRunning.checklist).text).toBe('2 of 7');
    expect(checklistCount([]).text).toBe('0 of 0');
  });

  test('the leading column word: Done, Yours, nothing for todo and doing', () => {
    expect(CHECKLIST_STATE_WORD.done).toBe('Done');
    expect(CHECKLIST_STATE_WORD.yours).toBe('Yours');
    expect(CHECKLIST_STATE_WORD.todo).toBeNull();
    expect(CHECKLIST_STATE_WORD.doing).toBeNull();
  });

  test('the live line is the doing item, else the newest log line', () => {
    expect(liveLine(runs.goalRunning)).toBe('Make the invoice from the template');
    expect(liveLine({ state: 'running', checklist: [], log: runs.goalRunning.log })).toBe(
      'Made Invoice 0007 from the invoice template',
    );
    expect(liveLine({ state: 'running', checklist: [], log: [] })).toBe('In progress');
    expect(liveLine(runs.goalQueued)).toBe('Starts soon');
    expect(liveLine(runs.goalQueued, { pastCap: true })).toBe('Starts when a run ends');
  });
});

describe('the package', () => {
  const items = goalItemsFixture();

  test('every item with a pane becomes a tab, in package order', () => {
    const tabs = packageTabs(runs.goalPackage);
    expect(tabs.map((tab) => tab.pane.kind)).toEqual(['draft', 'document', 'document', 'file']);
    expect(tabs.map((tab) => tab.stillYours)).toEqual([true, true, false, true]);
    expect(tabs[0].label).toBe('Invoice 0007 to Priya Natarajan');
    expect(
      packageTabs({
        items: [{ ...goalItemsFixture()[0], title: 'A very long draft title that runs past the tab width' }],
      })[0].label.length,
    ).toBeLessThanOrEqual(32);
  });

  test('an approval, an event, or a page has no pane; a file needs a server link', () => {
    expect(tabPane({ kind: 'approval', id: 'ap_1', title: 'Approve', state: 'check' })).toBeNull();
    expect(tabPane({ kind: 'event', id: 'evt_1', title: 'Call', state: 'ready' })).toBeNull();
    expect(tabPane({ kind: 'file', id: 'upload_2', title: 'A file', state: 'ready' })).toBeNull();
    expect(tabPane({ kind: 'draft', title: 'No id', state: 'check' })).toBeNull();
    expect(
      tabPane({ kind: 'sheet', url: '/?view=files&office=off_1', title: 'Sheet', state: 'ready' }),
    ).toEqual({
      kind: 'document',
      target: { provider: 'office', id: 'off_1' },
    });
  });

  test('the active tab is the next.target item, else the first', () => {
    const tabs = packageTabs(runs.goalPackage);
    expect(activeTabKey(tabs, runs.goalPackage.next)).toBe(`document:${GOAL_INVOICE_DOCUMENT_ID}`);
    expect(activeTabKey(tabs, null)).toBe(`draft:${GOAL_DRAFT_ID}`);
    expect(activeTabKey([], runs.goalPackage.next)).toBeNull();
  });

  test('rows carry the kind word, the state line, the note, and what a press opens', () => {
    const rows = packageRows(runs.goalPackage);
    expect(rows.map((row) => row.kindWord)).toEqual(['Draft', 'Document', 'Sheet', 'File']);
    expect(rows.map((row) => row.stateText)).toEqual(['Check it.', 'Fill in rate.', 'Ready.', 'Check it.']);
    expect(rows.map((row) => row.tone)).toEqual(['blank', 'blank', 'muted', 'blank']);
    expect(rows[3].note).toBe('The tax ID fills in when you send.');
    expect(rows.every((row) => row.behaviour?.kind === 'open_tab')).toBe(true);
  });

  test('a sent draft says so when this client knows it', () => {
    const rows = packageRows(runs.goalPackage, { sent: { [GOAL_DRAFT_ID]: '3:02 PM' } });
    expect(rows[0].stateText).toBe('Sent 3:02 PM.');
    expect(rows[0].tone).toBe('done');
  });

  test('rows without a pane open in place', () => {
    const rows = packageRows({
      items: [
        { kind: 'approval', id: 'ap_1', title: 'Approve the payment', state: 'check' },
        { kind: 'event', id: 'evt_1', title: 'Call Priya', state: 'ready' },
        { kind: 'page', url: 'https://example.com/portal', title: 'Vendor portal', state: 'ready' },
        { kind: 'page', url: 'javascript:alert(1)', title: 'Bad page', state: 'ready' },
      ],
    });
    expect(rows[0].behaviour).toEqual({ kind: 'open_approval', id: 'ap_1' });
    expect(rows[1].behaviour).toEqual({ kind: 'open_calendar', id: 'evt_1' });
    expect(rows[2].behaviour).toEqual({ kind: 'open_url', url: 'https://example.com/portal' });
    expect(rows[3].behaviour).toBeNull();
  });

  test('the state line of an item', () => {
    expect(itemStateLine({ state: 'blanks', blanks: ['hours', 'rate'] }).text).toBe(
      'Fill in hours and rate.',
    );
    expect(itemStateLine({ state: 'blanks', blanks: [] }).text).toBe('Check it.');
    expect(itemStateLine({ state: 'ready' })).toEqual({ text: 'Ready.', tone: 'muted' });
  });

  test('the list line counts the items and names them', () => {
    expect(packageLine(items)).toBe(
      '4 items: Invoice 0007 to Priya Natarajan, Invoice 0007, Hours, July, Form W-9, filled',
    );
    expect(packageLine([items[0]])).toBe('1 item: Invoice 0007 to Priya Natarajan');
    expect(packageLine([])).toBe('');
    expect(packageLine(items, 40).length).toBeLessThanOrEqual(40);
  });

  test('the newest goal run and the newest package', () => {
    expect(newestGoalRun([steps.running, runs.goalRunning])?.id).toBe('run_goal_running');
    expect(newestGoalRun([steps.running])).toBeNull();
    expect(newestPackageRun([runs.goalPackage, runs.goalDone])?.id).toBe('run_goal_package');
    expect(newestPackageRun([runs.goalRunning])).toBeNull();
  });

  test('a document target finds its item', () => {
    expect(itemForTarget(items, { provider: 'albatross', id: GOAL_INVOICE_DOCUMENT_ID })?.title).toBe(
      'Invoice 0007',
    );
    expect(itemForTarget(items, { provider: 'albatross', id: 'doc_other' })).toBeNull();
  });
});

describe('saved files', () => {
  test('the bytes routes are named once', () => {
    expect(savedFilePreviewUrl(GOAL_W9_FILE_ID)).toBe('/api/files/saved/upload_w9_filled?preview=1');
    expect(savedFileDownloadUrl('a b')).toBe('/api/files/saved/a%20b');
  });

  test('kind words and sizes', () => {
    expect(fileKindWord('application/pdf', 'x.pdf')).toBe('PDF');
    expect(
      fileKindWord('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx'),
    ).toBe('Word file');
    expect(fileKindWord(null, 'Hours.xlsx')).toBe('Excel file');
    expect(fileKindWord('image/png', 'a.png')).toBe('Image');
    expect(fileKindWord('application/octet-stream', 'a.bin')).toBe('File');
    expect(formatFileSize(86_016)).toBe('84 KB');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(formatFileSize(null)).toBeNull();
  });

  test('the copy has no AI, assistant, or agent', () => {
    const text = JSON.stringify(GOAL_RUN_COPY).toLowerCase();
    for (const word of [' ai ', 'assistant', 'agent']) expect(text.includes(word)).toBe(false);
  });
});
