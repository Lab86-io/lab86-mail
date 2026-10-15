// Goal runs as the web thread reads them (docs/albatross-goal-runs.md,
// docs/research/goal-runs-web-design-2026-10-15.md). Pure: the header line,
// the visible messages and their fold, the source chips and what a press
// opens, the checklist count and the live line, the package rows, the
// document tabs, and the copy. No React here; the components only render.

import { truncateText } from '../shared/text';
import { blankSentenceText } from './blanks';
import {
  type ChecklistItem,
  type ChecklistState,
  type HandoffItem,
  type HandoffItemKind,
  type HandoffItemState,
  isGoalStepKey,
  type RunMessage,
  type RunSource,
} from './goal-run-contract';
import { type DocumentTarget, documentTargetOf, type StepRunView } from './step-run-client';
import type { ThreadRunView } from './thread-contract';

export const GOAL_RUN_COPY = {
  started: (time: string) => `Started ${time}`,
  underMinute: 'under a minute',
  earlierMessages: 'Earlier messages',
  checklist: 'Checklist',
  yours: 'Yours',
  doneWord: 'Done',
  notSure: 'Not sure',
  itemReady: 'Ready.',
  itemCheck: 'Check it.',
  itemSent: (time: string) => `Sent ${time}.`,
  openPackage: 'Open the package',
  doneContinue: 'Done, continue',
  continueButton: 'Continue',
  handleIt: 'Handle it',
  stoppedTime: 'Albatross stopped at its time limit. The next run starts from the checklist.',
  stoppedCost: 'Albatross stopped at its cost limit. The next run starts from the checklist.',
  closed: 'Closed',
  earlierSteps: (count: number) =>
    count === 1 ? '1 step done before this' : `${count} steps done before this`,
  packageItems: (count: number) => (count === 1 ? '1 item' : `${count} items`),
  tabsClose: 'Close',
  tabSent: 'Sent',
  stillYours: 'Still yours',
  pdfPage: (page: number, pages: number) => `Page ${page} of ${pages}`,
  pdfDownload: 'Download',
  pdfOpenInFiles: 'Open in Files',
  pdfSealed: 'Fills in when you send',
  pdfSignature: 'Blank: sign it yourself, or send it without a signature.',
  pdfNotDownloaded: 'Not downloaded.',
  pdfFailed: 'The file did not open.',
  pdfLoading: 'The file opens in a moment.',
  blanksFilled: 'All blanks are filled in.',
  draftPlaceholder: 'Tell Albatross what to change in the mail',
  draftLoading: 'The draft opens in a moment.',
  draftGone: 'This draft is no longer available.',
  detailsChecklist: 'Checklist',
  detailsPackage: 'Package',
  detailsSources: 'Sources',
  noChecklist: 'No checklist yet. It appears when a run starts.',
  noPackage: 'Nothing handed over yet.',
  noSources: 'No sources yet.',
  startsWhenRunEnds: 'Starts when a run ends',
  inProgress: 'In progress',
  startsSoon: 'Starts soon',
  moreSources: (count: number) => `+${count}`,
  opensNewTab: 'opens in a new tab',
} as const;

export const KIND_WORD: Record<HandoffItemKind, string> = {
  draft: 'Draft',
  document: 'Document',
  sheet: 'Sheet',
  deck: 'Presentation',
  file: 'File',
  approval: 'Approval',
  event: 'Event',
  page: 'Page',
};

/**
 * The locator after a chip's title, in the muted voice: the server's
 * `detail` (the host of a web page, "Priya, Jul 30" for mail, the key of a
 * Jira issue, a short date for an event, a file kind when the title lacks
 * it). A web source without one shows its host. Nothing else when absent.
 * No generic kind word, and no middle dots (design critique, 2026-10-15).
 */
export function sourceLocator(source: Pick<RunSource, 'kind'> & Partial<RunSource>): string | null {
  const detail = source.detail?.trim() || null;
  const locator = detail ?? (source.kind === 'web' ? hostOf(source.url) : null);
  if (!locator) return null;
  // A title that already names it ("BP-214 worklog, July") shows it once.
  return String(source.title ?? '')
    .toLowerCase()
    .includes(locator.toLowerCase())
    ? null
    : locator;
}

/** A goal run: the server marks it `goal`, and its step key is `goal`. */
export function isGoalRun(
  run: { goal?: boolean | null; stepKey?: string | null } | null | undefined,
): boolean {
  return Boolean(run && (run.goal === true || isGoalStepKey(run.stepKey)));
}

/** A Work on goal runs: the detail says so, or one of its runs is a goal run. */
export function isGoalWork(
  detail: { goalRuns?: boolean | null } | null | undefined,
  runs: ReadonlyArray<Pick<ThreadRunView, 'goal' | 'messages' | 'checklist' | 'items'>>,
): boolean {
  if (detail?.goalRuns) return true;
  return runs.some(isGoalRun);
}

// ---------------------------------------------------------------------------
// The header.
// ---------------------------------------------------------------------------

export function formatRunTime(at: number, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(
    new Date(at),
  );
}

/** "under a minute", "13 min", "1 h 12 min", "2 h". */
export function durationLabel(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  if (minutes < 1) return GOAL_RUN_COPY.underMinute;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/**
 * The left of a goal run header: "Started 2:31 PM" while it works, and the
 * start time with the duration beside it after it ends (two spans, no dot).
 */
export function runWhenLine(
  run: Pick<ThreadRunView, 'state' | 'createdAt' | 'startedAt' | 'finishedAt' | 'updatedAt'>,
  format: { locale?: string; timeZone?: string } = {},
): { text: string; duration: string | null } {
  const start = run.startedAt ?? run.createdAt;
  const time = formatRunTime(start, format.locale, format.timeZone);
  if (run.state === 'queued' || run.state === 'running')
    return { text: GOAL_RUN_COPY.started(time), duration: null };
  const end = run.finishedAt ?? run.updatedAt;
  return { text: time, duration: durationLabel(end - start) };
}

// ---------------------------------------------------------------------------
// Messages.
// ---------------------------------------------------------------------------

/** The newest messages stay open; the rest fold under "Earlier messages". */
export const OPEN_MESSAGES_WORKING = 6;
export const OPEN_MESSAGES_FINISHED = 3;

export function visibleMessages(
  messages: readonly RunMessage[],
  options: { working: boolean; showAll?: boolean },
): { open: RunMessage[]; folded: RunMessage[] } {
  if (options.showAll) return { open: [...messages], folded: [] };
  const keep = options.working ? OPEN_MESSAGES_WORKING : OPEN_MESSAGES_FINISHED;
  if (messages.length <= keep) return { open: [...messages], folded: [] };
  return { open: messages.slice(messages.length - keep), folded: messages.slice(0, messages.length - keep) };
}

// ---------------------------------------------------------------------------
// Source chips.
// ---------------------------------------------------------------------------

/** Chips shown before the "+N" chip. */
export const SOURCE_CHIPS_OPEN = 4;
export const SOURCE_TITLE_MAX = 32;

/** What a press on a source chip does. Null: the chip is text. */
export type SourceBehaviour =
  | { kind: 'open_url'; url: string }
  | { kind: 'open_mail'; threadId: string; accountId: string | null }
  | { kind: 'open_tab'; key: string }
  | { kind: 'open_document'; url: string | null; id: string | null }
  | { kind: 'open_file'; url: string; id: string | null }
  | { kind: 'open_calendar'; id: string };

export interface SourceChipView {
  key: string;
  /** The title, cut for the chip. */
  text: string;
  /** The locator after the title, in the muted voice: "irs.gov", "BP-214", "Priya, Jul 30". Null for none. */
  locator: string | null;
  /** The full title, and the URL when there is one, for the tooltip. */
  title: string;
  /** True when the press opens a new tab. */
  external: boolean;
  behaviour: SourceBehaviour | null;
}

/** Only http and https reach window.open. */
export function webUrl(url: string | null | undefined): string | null {
  const raw = url?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** "irs.gov" from "https://www.irs.gov/forms/w9". Null when the URL is not a web URL. */
export function hostOf(url: string | null | undefined): string | null {
  const safe = webUrl(url);
  if (!safe) return null;
  try {
    return new URL(safe).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

export function sourceChip(source: RunSource, tabs: readonly DocumentTab[] = []): SourceChipView {
  const key = `${source.kind}:${source.id ?? source.url ?? source.title}`;
  const text = truncateText(source.title, SOURCE_TITLE_MAX);
  const url = webUrl(source.url);
  const title = url ? `${source.title}\n${url}` : source.title;
  const tab = source.id ? tabs.find((entry) => entry.item.id === source.id) : undefined;
  let behaviour: SourceBehaviour | null = null;
  switch (source.kind) {
    case 'web':
    case 'jira':
      behaviour = url ? { kind: 'open_url', url } : null;
      break;
    case 'mail':
      behaviour = source.id
        ? { kind: 'open_mail', threadId: source.id, accountId: source.accountId ?? null }
        : null;
      break;
    case 'file':
      if (tab) behaviour = { kind: 'open_tab', key: tab.key };
      else if (source.url) behaviour = { kind: 'open_file', url: source.url, id: source.id ?? null };
      break;
    case 'document':
      if (tab) behaviour = { kind: 'open_tab', key: tab.key };
      else if (documentTargetOf(source.url, source.id))
        behaviour = { kind: 'open_document', url: source.url ?? null, id: source.id ?? null };
      break;
    case 'calendar':
      behaviour = source.id ? { kind: 'open_calendar', id: source.id } : null;
      break;
    default:
      break;
  }
  return {
    key,
    text,
    locator: sourceLocator(source),
    title,
    external: behaviour?.kind === 'open_url',
    behaviour,
  };
}

/** The accessible name of a chip: the title, the locator, and ", opens in a new tab" for a link. */
export function sourceChipName(chip: Pick<SourceChipView, 'text' | 'locator' | 'external'>): string {
  const parts = [chip.text];
  if (chip.locator) parts.push(chip.locator);
  if (chip.external) parts.push(GOAL_RUN_COPY.opensNewTab);
  return parts.join(', ');
}

/** Every source of a run once, in order of first use, for the Details list. */
export function runSources(run: Pick<ThreadRunView, 'messages'>): RunSource[] {
  const out: RunSource[] = [];
  const seen = new Set<string>();
  for (const message of run.messages) {
    for (const source of message.sources) {
      const key = `${source.kind}:${source.url ?? source.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(source);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The checklist and the live line.
// ---------------------------------------------------------------------------

export function checklistCount(items: readonly ChecklistItem[]): {
  done: number;
  total: number;
  text: string;
} {
  const done = items.filter((item) => item.state === 'done').length;
  return { done, total: items.length, text: `${done} of ${items.length}` };
}

/** The word in the leading column: "Done", "Yours"; the doing row shows the live dot; todo shows nothing. */
export const CHECKLIST_STATE_WORD: Record<ChecklistState, string | null> = {
  done: GOAL_RUN_COPY.doneWord,
  doing: null,
  todo: null,
  yours: GOAL_RUN_COPY.yours,
};

/** The accessible state of a checklist row. */
export const CHECKLIST_STATE_NAME: Record<ChecklistState, string> = {
  done: 'done',
  doing: 'in progress',
  todo: 'to do',
  yours: 'yours',
};

export function doingLine(run: Pick<ThreadRunView, 'checklist'>): string | null {
  return run.checklist.find((item) => item.state === 'doing')?.text ?? null;
}

/** The one shimmer line of a run at work: the doing item, else the newest log line. */
export function liveLine(
  run: Pick<ThreadRunView, 'state' | 'checklist' | 'log'>,
  options: { pastCap?: boolean } = {},
): string {
  if (run.state === 'queued')
    return options.pastCap ? GOAL_RUN_COPY.startsWhenRunEnds : GOAL_RUN_COPY.startsSoon;
  const doing = doingLine(run);
  if (doing) return doing;
  const newest = [...run.log].sort((a, b) => a.at - b.at).at(-1)?.text;
  return newest ?? GOAL_RUN_COPY.inProgress;
}

// ---------------------------------------------------------------------------
// The package.
// ---------------------------------------------------------------------------

/** What one tab shows in document mode. */
export type TabPane =
  | { kind: 'draft'; id: string; accountId: string | null }
  | { kind: 'document'; target: DocumentTarget }
  | { kind: 'file'; id: string | null; url: string; title: string };

export interface DocumentTab {
  key: string;
  item: HandoffItem;
  /** The item title, cut for the tab. */
  label: string;
  pane: TabPane;
  /** The item still needs the user: a dot after the label. */
  stillYours: boolean;
}

export const TAB_LABEL_MAX = 32;

/** The pane of an item, or null when the item has no pane (an approval, an event, a page). */
export function tabPane(item: HandoffItem): TabPane | null {
  switch (item.kind) {
    case 'draft':
      return item.id ? { kind: 'draft', id: item.id, accountId: item.accountId ?? null } : null;
    case 'document':
    case 'sheet':
    case 'deck': {
      const target = documentTargetOf(item.url, item.id);
      return target ? { kind: 'document', target } : null;
    }
    case 'file':
      // The server writes the link of a saved file; the client never builds one.
      return item.url ? { kind: 'file', id: item.id ?? null, url: item.url, title: item.title } : null;
    default:
      return null;
  }
}

export function tabKey(item: HandoffItem, index: number): string {
  return `${item.kind}:${item.id ?? item.url ?? index}`;
}

/** The document tabs of a run: one for each item with a pane, in package order. */
export function packageTabs(run: Pick<ThreadRunView, 'items'>): DocumentTab[] {
  const tabs: DocumentTab[] = [];
  run.items.forEach((item, index) => {
    const pane = tabPane(item);
    if (!pane) return;
    tabs.push({
      key: tabKey(item, index),
      item,
      label: truncateText(item.title, TAB_LABEL_MAX),
      pane,
      stillYours: item.state !== 'ready',
    });
  });
  return tabs;
}

/** The tab the main button opens: the `next.target` item, else the first tab. */
export function activeTabKey(
  tabs: readonly DocumentTab[],
  next: { target?: { id?: string | null; url?: string | null } | null } | null | undefined,
): string | null {
  if (!tabs.length) return null;
  const id = next?.target?.id ?? null;
  const url = next?.target?.url ?? null;
  const match = tabs.find((tab) => (id && tab.item.id === id) || (url && tab.item.url === url));
  return (match ?? tabs[0]).key;
}

export type PackageBehaviour =
  | { kind: 'open_tab'; key: string }
  | { kind: 'open_approval'; id: string | null }
  | { kind: 'open_calendar'; id: string }
  | { kind: 'open_url'; url: string };

export interface PackageRowView {
  key: string;
  item: HandoffItem;
  kindWord: string;
  /** The state text: "Ready.", "Fill in rate.", "Check it.", "Sent 3:02 PM.". */
  stateText: string;
  tone: 'muted' | 'blank' | 'done';
  note: string | null;
  behaviour: PackageBehaviour | null;
}

export function itemStateLine(
  item: Pick<HandoffItem, 'state' | 'blanks'>,
  sentAt?: string | null,
): { text: string; tone: PackageRowView['tone'] } {
  if (sentAt) return { text: GOAL_RUN_COPY.itemSent(sentAt), tone: 'done' };
  switch (item.state) {
    case 'ready':
      return { text: GOAL_RUN_COPY.itemReady, tone: 'muted' };
    case 'blanks':
      return item.blanks?.length
        ? { text: blankSentenceText(item.blanks), tone: 'blank' }
        : { text: GOAL_RUN_COPY.itemCheck, tone: 'blank' };
    default:
      return { text: GOAL_RUN_COPY.itemCheck, tone: 'blank' };
  }
}

/**
 * The package rows of a run. `sent` names the drafts this client knows went
 * out, by draft id, with the time to show.
 */
export function packageRows(
  run: Pick<ThreadRunView, 'items'>,
  options: { sent?: Readonly<Record<string, string>> } = {},
): PackageRowView[] {
  const tabs = packageTabs(run);
  return run.items.map((item, index) => {
    const key = tabKey(item, index);
    const tab = tabs.find((entry) => entry.key === key);
    const sentAt = item.kind === 'draft' && item.id ? (options.sent?.[item.id] ?? null) : null;
    const state = itemStateLine(item, sentAt);
    let behaviour: PackageBehaviour | null = null;
    if (tab) behaviour = { kind: 'open_tab', key: tab.key };
    else if (item.kind === 'approval') behaviour = { kind: 'open_approval', id: item.id ?? null };
    else if (item.kind === 'event' && item.id) behaviour = { kind: 'open_calendar', id: item.id };
    else if (item.kind === 'page') {
      const url = webUrl(item.url);
      if (url) behaviour = { kind: 'open_url', url };
    }
    return {
      key,
      item,
      kindWord: KIND_WORD[item.kind],
      stateText: state.text,
      tone: state.tone,
      note: item.note ?? null,
      behaviour,
    };
  });
}

/** One line for a list row: "4 items: Invoice 0007 to Priya, Invoice 0007, ...". */
export function packageLine(items: ReadonlyArray<Pick<HandoffItem, 'title'>>, max = 160): string {
  if (!items.length) return '';
  const titles = items.map((item) => item.title).join(', ');
  return truncateText(`${GOAL_RUN_COPY.packageItems(items.length)}: ${titles}`, max);
}

/** The newest run of a Work that is a goal run, for the Details panel. */
export function newestGoalRun(runs: readonly ThreadRunView[]): ThreadRunView | null {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (isGoalRun(runs[index])) return runs[index];
  }
  return null;
}

/** The newest handoff with a package, for the Details panel and the Documents page. */
export function newestPackageRun(runs: readonly ThreadRunView[]): ThreadRunView | null {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run.state === 'handed_off' && run.items.length) return run;
  }
  return null;
}

/** The handoff item that a document target belongs to, if any. */
export function itemForTarget(items: readonly HandoffItem[], target: DocumentTarget): HandoffItem | null {
  return (
    items.find((item) => {
      if (item.kind !== 'document' && item.kind !== 'sheet' && item.kind !== 'deck') return false;
      const found = documentTargetOf(item.url, item.id);
      return found?.id === target.id;
    }) ?? null
  );
}

// ---------------------------------------------------------------------------
// Saved files.
// ---------------------------------------------------------------------------

/**
 * The bytes of a saved file, for the PDF pane (inline) and for Download. The
 * one place the client names this route (the files builder's
 * `GET /api/files/saved/<fileId>`; a sealed file answers 403 with
 * `code: 'verify_identity'` until the identity check passes).
 */
export function savedFilePreviewUrl(fileId: string): string {
  return `/api/files/saved/${encodeURIComponent(fileId)}?preview=1`;
}

export function savedFileDownloadUrl(fileId: string): string {
  return `/api/files/saved/${encodeURIComponent(fileId)}`;
}

/** The kind word of an attachment or a file, from its content type and name. */
export function fileKindWord(
  contentType: string | null | undefined,
  name: string | null | undefined,
): string {
  const type = String(contentType || '').toLowerCase();
  const ext = String(name || '')
    .toLowerCase()
    .split('.')
    .pop();
  if (type === 'application/pdf' || ext === 'pdf') return 'PDF';
  if (type.includes('wordprocessingml') || type === 'application/msword' || ext === 'docx' || ext === 'doc')
    return 'Word file';
  if (type.includes('spreadsheetml') || type.includes('excel') || ext === 'xlsx' || ext === 'xls')
    return 'Excel file';
  if (type.includes('presentationml') || type.includes('powerpoint') || ext === 'pptx' || ext === 'ppt')
    return 'Presentation';
  if (type === 'text/csv' || ext === 'csv') return 'CSV file';
  if (type.startsWith('image/')) return 'Image';
  return 'File';
}

export function formatFileSize(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** The old artifact kinds that a package item kind covers, for the Files section. */
export function artifactKindForItem(kind: HandoffItemKind): StepRunView['artifacts'][number]['kind'] | null {
  switch (kind) {
    case 'draft':
    case 'document':
    case 'approval':
    case 'event':
    case 'page':
    case 'deck':
    case 'file':
      return kind;
    case 'sheet':
      return 'document';
    default:
      return null;
  }
}

export type { HandoffItem, HandoffItemState };
