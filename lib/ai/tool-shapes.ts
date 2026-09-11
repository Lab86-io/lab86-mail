// Result shapes for chat tool calls (docs/chat-agentic-pass.md, section 3).
//
// The agent stream follows every tool result with a `data-tool-shape` part
// built here. Web, iOS, and macOS render one view per shape kind and execute
// the listed actions. Nothing downstream re-derives cards from raw output.
// Display tools (show_*) keep their designed components and get no shape.

import { toolSentences } from '../albatross/teach-ui';

export const SHAPE_LIST_LIMIT = 8;

export type ShapeAction =
  | { kind: 'open_thread'; account: string; threadId: string }
  | { kind: 'reply_thread'; account: string; threadId: string }
  | { kind: 'archive_thread'; account: string; threadId: string }
  | { kind: 'snooze_thread'; account: string; threadId: string; messageId?: string }
  | { kind: 'open_event'; account: string; calendarId?: string; eventId: string; startIso?: string }
  | { kind: 'rsvp_event'; account: string; calendarId?: string; eventId: string }
  | { kind: 'delete_event'; account: string; calendarId?: string; eventId: string }
  | { kind: 'hold_slot'; account?: string; startIso: string; endIso: string; title?: string }
  | { kind: 'open_task'; boardId?: string; cardId: string }
  | { kind: 'complete_task'; cardId: string }
  | { kind: 'open_board'; boardId: string }
  | { kind: 'open_work'; workId: string }
  | { kind: 'open_area'; areaId: string }
  | { kind: 'open_document'; documentId: string; path?: string }
  | { kind: 'open_url'; url: string; label?: string }
  | { kind: 'import_file'; connectionId: string; fileId: string; mimeType?: string }
  | { kind: 'undo_operation'; operationId: string }
  | { kind: 'remember_sender'; email: string };

export interface ShapeActivity {
  running: string;
  done: string;
  failed: string;
}

interface ShapeBase {
  /** Short heading for the card. */
  title: string;
  /** One sentence under the heading. Optional. */
  summary?: string;
  /** The activity sentences for the tool row that owns this shape. */
  activity: ShapeActivity;
  actions: ShapeAction[];
  account?: string;
}

export interface ThreadRow {
  account: string;
  threadId: string;
  messageId?: string;
  subject: string;
  from: string;
  fromEmail?: string;
  dateIso?: string;
  snippet?: string;
  unread?: boolean;
  messageCount?: number;
  attachmentCount?: number;
  actions: ShapeAction[];
}

export interface EventRow {
  account: string;
  calendarId?: string;
  eventId: string;
  title: string;
  startIso?: string;
  endIso?: string;
  allDay?: boolean;
  location?: string;
  attendees?: string[];
  calendarName?: string;
  status?: string;
  actions: ShapeAction[];
}

export interface SlotRow {
  startIso: string;
  endIso: string;
  actions: ShapeAction[];
}

export interface TaskRow {
  cardId: string;
  boardId?: string;
  title: string;
  description?: string;
  column?: string;
  dueIso?: string;
  priority?: string;
  labels?: string[];
  completed?: boolean;
  actions: ShapeAction[];
}

export interface WorkRow {
  workId: string;
  title: string;
  shape?: string;
  horizon?: string;
  status?: string;
  currentStep?: string;
  progress?: { done: number; total: number };
  actions: ShapeAction[];
}

export interface FileRow {
  connectionId: string;
  fileId: string;
  name: string;
  kind?: string;
  source?: string;
  mimeType?: string;
  webUrl?: string;
  modifiedIso?: string;
  actions: ShapeAction[];
}

export interface SourceRow {
  title: string;
  url?: string;
  snippet?: string;
  source?: string;
  actions: ShapeAction[];
}

export type ToolShape =
  | (ShapeBase & { kind: 'threads'; items: ThreadRow[]; total?: number })
  | (ShapeBase & { kind: 'thread'; item: ThreadRow; excerpt?: string })
  | (ShapeBase & { kind: 'events'; items: EventRow[]; total?: number })
  | (ShapeBase & { kind: 'event'; item: EventRow })
  | (ShapeBase & { kind: 'slots'; items: SlotRow[] })
  | (ShapeBase & { kind: 'tasks'; items: TaskRow[]; boardId?: string; boardTitle?: string })
  | (ShapeBase & { kind: 'task'; item: TaskRow })
  | (ShapeBase & {
      kind: 'board';
      boardId: string;
      columns: Array<{ name: string; count: number }>;
    })
  | (ShapeBase & { kind: 'work'; item: WorkRow })
  | (ShapeBase & { kind: 'works'; items: WorkRow[] })
  | (ShapeBase & {
      kind: 'area';
      areaId: string;
      name: string;
      areaKind?: string;
      domain?: string;
      description?: string;
    })
  | (ShapeBase & {
      kind: 'document';
      documentId: string;
      docKind?: string;
      status?: string;
      revision?: number;
      path?: string;
      webUrl?: string;
    })
  | (ShapeBase & { kind: 'files'; items: FileRow[] })
  | (ShapeBase & {
      kind: 'contact';
      name?: string;
      email: string;
      totalMessages?: number;
      lastSeenIso?: string;
      memory?: string;
    })
  | (ShapeBase & { kind: 'count'; value: number; label: string })
  | (ShapeBase & {
      kind: 'receipt';
      surface: 'mail' | 'calendar' | 'tasks' | 'albatross' | 'documents' | 'memory' | 'other';
      operationId?: string;
      target?: Record<string, unknown>;
    })
  | (ShapeBase & { kind: 'sources'; items: SourceRow[] })
  | (ShapeBase & { kind: 'text'; text: string });

export type ToolShapeKind = ToolShape['kind'];

type Rec = Record<string, unknown>;

export function asRecord(value: unknown): Rec {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : {};
}

export function asArray(value: unknown): Rec[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Epoch ms, epoch seconds, or an ISO string → ISO string. */
export function iso(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
  return undefined;
}

export function clip(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function base(toolName: string, input: unknown, output: unknown, title: string, summary?: string) {
  return { title, summary, activity: toolSentences(toolName, input, output) };
}

// ---------------------------------------------------------------------------
// Per-tool mappers. Each returns null when the output does not fit its shape,
// so a malformed payload falls through to the generic shape.
// ---------------------------------------------------------------------------

type Mapper = (input: Rec, output: Rec, toolName: string) => ToolShape | null;
type ReceiptShape = Extract<ToolShape, { kind: 'receipt' }>;

/** "Ada Lovelace <ada@example.com>" → { name: "Ada Lovelace", email: "ada@example.com" } */
export function parseSender(value: unknown): { name: string; email?: string } {
  const raw = str(value).trim();
  const match = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) {
    const name = match[1].trim();
    const email = match[2].trim();
    return { name: name || email, email };
  }
  if (raw.includes('@')) return { name: raw, email: raw };
  return { name: raw };
}

function threadActions(account: string, threadId: string, messageId?: string): ShapeAction[] {
  return [
    { kind: 'open_thread', account, threadId },
    { kind: 'archive_thread', account, threadId },
    { kind: 'snooze_thread', account, threadId, messageId },
  ];
}

function threadRow(row: Rec, fallbackAccount?: string): ThreadRow | null {
  const account = str(row.account) || str(row.accountId) || fallbackAccount || '';
  const threadId = str(row._id) || str(row.threadId) || str(row.id);
  if (!account || !threadId) return null;
  const sender = parseSender(row.fromAddress || row.from);
  const messageId = str(row.messageId) || undefined;
  return {
    account,
    threadId,
    messageId,
    subject: str(row.subject) || '(no subject)',
    from: sender.name,
    fromEmail: str(row.senderEmail) || str(row.fromEmail) || sender.email,
    dateIso: iso(row.lastDate ?? row.date ?? row.receivedAt),
    snippet: row.snippet ? clip(str(row.snippet), 140) : undefined,
    unread: typeof row.unread === 'boolean' ? row.unread : undefined,
    messageCount: num(row.messageCount),
    actions: threadActions(account, threadId, messageId),
  };
}

function threadsShape(
  toolName: string,
  input: Rec,
  output: Rec,
  rows: Rec[],
  title: string,
): ToolShape | null {
  const items = rows
    .map((row) => threadRow(row, str(input.account) || undefined))
    .filter((row): row is ThreadRow => Boolean(row))
    .slice(0, SHAPE_LIST_LIMIT);
  if (!items.length) return null;
  const total = rows.length;
  return {
    kind: 'threads',
    ...base(toolName, input, output, title, `${total} thread${total === 1 ? '' : 's'}`),
    account: str(input.account) || undefined,
    items,
    total,
    actions: [],
  };
}

function singleThreadShape(
  toolName: string,
  input: Rec,
  output: Rec,
  messages: Rec[],
  excerptText?: string,
): ToolShape | null {
  const account = str(output.account) || str(input.account);
  const threadId = str(output.threadId) || str(input.threadId);
  if (!account || !threadId) return null;
  const latest = messages.at(-1) ?? {};
  const first = messages[0] ?? {};
  const sender = parseSender(latest.from ?? first.from);
  const attachments = messages.reduce(
    (count, message) => count + (Array.isArray(message.attachments) ? message.attachments.length : 0),
    0,
  );
  const subject = str(output.subject) || str(first.subject) || str(latest.subject) || '(no subject)';
  const item: ThreadRow = {
    account,
    threadId,
    messageId: str(latest._id) || undefined,
    subject,
    from: sender.name,
    fromEmail: str(latest.fromEmail) || sender.email,
    dateIso: iso(latest.date),
    snippet: latest.snippet ? clip(str(latest.snippet), 140) : undefined,
    messageCount: num(output.messageCount) ?? (messages.length || undefined),
    attachmentCount: attachments || undefined,
    actions: [
      { kind: 'open_thread', account, threadId },
      { kind: 'reply_thread', account, threadId },
      { kind: 'archive_thread', account, threadId },
      { kind: 'snooze_thread', account, threadId, messageId: str(latest._id) || undefined },
    ],
  };
  const excerptSource = excerptText ?? str(latest.body) ?? str(latest.textBody) ?? str(latest.snippet);
  return {
    kind: 'thread',
    ...base(toolName, input, output, subject),
    account,
    item,
    excerpt: excerptSource ? clip(excerptSource, 320) : undefined,
    actions: [],
  };
}

function attendeeNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .map((entry) =>
      typeof entry === 'string' ? entry : str(asRecord(entry).name) || str(asRecord(entry).email),
    )
    .filter(Boolean);
  return names.length ? names.slice(0, 8) : undefined;
}

function eventRow(row: Rec, fallbackAccount?: string): EventRow | null {
  const account = str(row.accountId) || str(row.account) || fallbackAccount || '';
  const eventId = str(row.eventId) || str(row.id);
  if (!account || !eventId) return null;
  const calendarId = str(row.calendarId) || undefined;
  const startIso = iso(row.startIso ?? row.startAt ?? row.startsAt);
  return {
    account,
    calendarId,
    eventId,
    title: str(row.title) || '(untitled)',
    startIso,
    endIso: iso(row.endIso ?? row.endAt ?? row.endsAt),
    allDay: typeof row.allDay === 'boolean' ? row.allDay : undefined,
    location: str(row.location) || undefined,
    attendees: attendeeNames(row.participants ?? row.attendees),
    status: str(row.status) || undefined,
    actions: [
      { kind: 'open_event', account, calendarId, eventId, startIso },
      { kind: 'rsvp_event', account, calendarId, eventId },
    ],
  };
}

function eventsShape(
  toolName: string,
  input: Rec,
  output: Rec,
  rows: Rec[],
  title: string,
): ToolShape | null {
  const fallback = Array.isArray(input.accountIds) ? str(input.accountIds[0]) : str(input.account);
  const items = rows
    .map((row) => eventRow(row, fallback || undefined))
    .filter((row): row is EventRow => Boolean(row))
    .slice(0, SHAPE_LIST_LIMIT);
  if (!items.length) return null;
  const total = rows.length;
  return {
    kind: 'events',
    ...base(toolName, input, output, title, `${total} event${total === 1 ? '' : 's'}`),
    items,
    total,
    actions: [],
  };
}

function taskRow(row: Rec, fallbackBoardId?: string): TaskRow | null {
  const cardId = str(row.cardId) || str(row.id);
  if (!cardId) return null;
  const boardId = str(row.boardId) || fallbackBoardId || undefined;
  const completed =
    typeof row.completed === 'boolean'
      ? row.completed
      : row.completedAt != null
        ? Boolean(row.completedAt)
        : undefined;
  return {
    cardId,
    boardId,
    title: str(row.title) || '(untitled)',
    description: row.description ? clip(str(row.description), 160) : undefined,
    column: str(row.columnName) || str(row.column) || undefined,
    dueIso: iso(row.dueIso ?? row.dueAt),
    priority: str(row.priority) || undefined,
    labels: Array.isArray(row.labels) ? row.labels.map(str).filter(Boolean) : undefined,
    completed,
    actions: [
      { kind: 'open_task', boardId, cardId },
      ...(completed ? [] : [{ kind: 'complete_task', cardId } as ShapeAction]),
    ],
  };
}

function receipt(
  toolName: string,
  input: Rec,
  output: Rec,
  surface: Extract<ToolShape, { kind: 'receipt' }>['surface'],
  actions: ShapeAction[],
  target?: Rec,
  summary?: string,
): ReceiptShape {
  const activity = toolSentences(toolName, input, output);
  const operationId = str(output.operationId) || undefined;
  return {
    kind: 'receipt',
    title: activity.done,
    summary: summary || str(output.summary) || undefined,
    activity,
    surface,
    operationId,
    target,
    actions: [...actions, ...(operationId ? [{ kind: 'undo_operation', operationId } as ShapeAction] : [])],
  };
}

function textShape(toolName: string, input: Rec, output: Rec, title: string, text: string): ToolShape | null {
  const clean = clip(text, 600);
  if (!clean) return null;
  return { kind: 'text', ...base(toolName, input, output, title), text: clean, actions: [] };
}

function workRow(
  row: Rec,
  actionsFor: (workId: string) => ShapeAction[] = (workId) => [{ kind: 'open_work', workId }],
): WorkRow | null {
  const workId = str(row.id) || str(row.workId) || str(row._id);
  if (!workId) return null;
  const horizon = row.horizon;
  return {
    workId,
    title: str(row.title) || str(row.rawText) || '(untitled)',
    shape: str(row.shape) || undefined,
    horizon:
      typeof horizon === 'string' ? horizon : horizon ? str(asRecord(horizon).kind) || undefined : undefined,
    status: str(row.state) || str(row.status) || undefined,
    currentStep: str(row.currentStep) || undefined,
    actions: actionsFor(workId),
  };
}

function documentShape(toolName: string, input: Rec, output: Rec, status?: string): ToolShape | null {
  const documentId = str(output.documentId) || str(input.documentId);
  if (!documentId) return null;
  const path = str(output.openPath) || undefined;
  const webUrl = str(output.googleUrl) || str(output.webUrl) || undefined;
  const actions: ShapeAction[] = [{ kind: 'open_document', documentId, path }];
  if (webUrl) actions.push({ kind: 'open_url', url: webUrl, label: 'Open in Google' });
  return {
    kind: 'document',
    ...base(toolName, input, output, str(output.title) || 'Document', str(output.summary) || undefined),
    documentId,
    docKind: str(output.kind) || undefined,
    status: status ?? (str(output.status) || undefined),
    revision: num(output.revision),
    path,
    webUrl,
    actions,
  };
}

function sourcesShape(
  toolName: string,
  input: Rec,
  output: Rec,
  rows: Rec[],
  title: string,
): ToolShape | null {
  const items: SourceRow[] = rows
    .map((row): SourceRow | null => {
      const url = str(row.url) || undefined;
      const heading = str(row.title) || str(row.name) || url || '';
      if (!heading) return null;
      return {
        title: clip(heading, 120),
        url,
        snippet: clip(str(row.summary) || str(row.snippet) || str(row.description), 160) || undefined,
        source: str(row.server) || str(row.source) || str(row.provider) || undefined,
        actions: url ? [{ kind: 'open_url', url } as ShapeAction] : [],
      };
    })
    .filter((row): row is SourceRow => Boolean(row))
    .slice(0, SHAPE_LIST_LIMIT);
  if (!items.length) return null;
  return {
    kind: 'sources',
    ...base(toolName, input, output, title, `${rows.length} result${rows.length === 1 ? '' : 's'}`),
    items,
    actions: [],
  };
}

const mailMutationTarget = (input: Rec): Rec => ({
  account: str(input.account),
  threadId: str(input.threadId) || undefined,
  messageId: str(input.messageId) || undefined,
});

function mailReceipt(input: Rec, output: Rec, toolName: string): ReceiptShape {
  const account = str(input.account);
  const threadId = str(input.threadId);
  const actions: ShapeAction[] = account && threadId ? [{ kind: 'open_thread', account, threadId }] : [];
  return receipt(toolName, input, output, 'mail', actions, mailMutationTarget(input));
}

function taskReceipt(input: Rec, output: Rec, toolName: string): ReceiptShape {
  const cardId = str(input.cardId) || str(output.cardId);
  const boardId = str(input.boardId) || str(output.boardId) || undefined;
  const actions: ShapeAction[] = cardId
    ? [{ kind: 'open_task', boardId, cardId }]
    : boardId
      ? [{ kind: 'open_board', boardId }]
      : [];
  return receipt(toolName, input, output, 'tasks', actions, { cardId: cardId || undefined, boardId });
}

function taskStateShape(input: Rec, output: Rec, toolName: string): ToolShape | null {
  const card = asRecord(output.card);
  const cardId = str(card.cardId) || str(output.cardId) || str(input.cardId);
  if (!cardId) return null;
  const item = taskRow({ ...input, ...card, cardId }, str(input.boardId) || undefined);
  if (!item) return null;
  const operationId = str(output.operationId) || undefined;
  return {
    kind: 'task',
    ...base(toolName, input, output, item.title, str(card.boardTitle) || undefined),
    item,
    actions: operationId ? [{ kind: 'undo_operation', operationId }] : [],
  };
}

function calendarReceipt(input: Rec, output: Rec, toolName: string): ReceiptShape | null {
  if (output.needsDisambiguation) return null;
  const account = str(input.account) || str(output.accountId);
  const eventId = str(output.eventId) || str(input.eventId);
  const calendarId = str(output.calendarId) || str(input.calendarId) || undefined;
  const startIso = iso(input.startIso);
  const actions: ShapeAction[] =
    account && eventId && toolName !== 'calendar_delete_event'
      ? [{ kind: 'open_event', account, calendarId, eventId, startIso }]
      : [];
  const title = str(input.title) || str(output.deletedTitle) || str(input.matchTitle) || undefined;
  return receipt(
    toolName,
    input,
    output,
    'calendar',
    actions,
    { account, eventId, calendarId, title },
    title,
  );
}

const MAPPERS: Record<string, Mapper> = {
  // --- Mail reads ---
  search_threads: (input, output, tool) =>
    threadsShape(tool, input, output, asArray(output.items), `Mail matching “${clip(str(input.query), 60)}”`),
  list_smart_category: (input, output, tool) =>
    threadsShape(tool, input, output, asArray(output.items), `${str(input.category) || 'Category'} mail`),
  recent_threads: (input, output, tool) =>
    threadsShape(tool, input, output, asArray(output.threads), 'Recent mail'),
  list_account_threads: (input, output, tool) =>
    threadsShape(tool, input, output, asArray(output.threads), 'Recent mail'),
  preview_smart_label: (input, output, tool) =>
    threadsShape(tool, input, output, asArray(output.items), `Preview of “${clip(str(input.name), 40)}”`),
  corpus_search: (input, output, tool) => {
    const items = asArray(output.items);
    const mail = items.filter((row) => !row.source || row.source === 'mail');
    const shape = threadsShape(tool, input, output, mail, `Mail matching “${clip(str(input.query), 60)}”`);
    if (shape) return shape;
    const connected = items.filter((row) => row.source === 'mcp');
    return sourcesShape(
      tool,
      input,
      output,
      connected,
      `Connected results for “${clip(str(input.query), 60)}”`,
    );
  },
  read_thread: (input, output, tool) => singleThreadShape(tool, input, output, asArray(output.messages)),
  get_thread: (input, output, tool) =>
    singleThreadShape(tool, input, output, asArray(output.messages), str(output.summary) || undefined),
  get_message: (input, output, tool) =>
    singleThreadShape(tool, input, { ...output, messages: [output] }, [output]),
  thread_timeline: (input, output, tool) => singleThreadShape(tool, input, output, asArray(output.messages)),
  sender_profile: (input, output, tool) => {
    const email = str(output.email) || str(input.email);
    if (!email) return null;
    const total = num(output.totalMessages);
    return {
      kind: 'contact',
      ...base(
        tool,
        input,
        output,
        str(output.name) || email,
        total != null ? `${total} messages` : undefined,
      ),
      name: str(output.name) || undefined,
      email,
      totalMessages: total,
      lastSeenIso: iso(output.lastSeen),
      memory: str(asRecord(output.memory).notes) || undefined,
      actions: [{ kind: 'remember_sender', email }],
    };
  },
  corpus_count: (input, output, tool) => {
    const value = num(output.total);
    if (value == null) return null;
    const label = str(input.query) ? `messages matching “${clip(str(input.query), 60)}”` : 'messages';
    return { kind: 'count', ...base(tool, input, output, 'Mail count'), value, label, actions: [] };
  },
  calendar_count_events: (input, output, tool) => {
    const value = num(output.total);
    if (value == null) return null;
    return {
      kind: 'count',
      ...base(tool, input, output, 'Event count'),
      value,
      label: 'events',
      actions: [],
    };
  },
  summarize_thread: (input, output, tool) => textShape(tool, input, output, 'Summary', str(output.summary)),
  triage_thread: (input, output, tool) =>
    textShape(
      tool,
      input,
      output,
      `Priority ${str(output.priority)}: ${str(output.action)}`,
      str(output.reason),
    ),
  draft_reply: (input, output, tool) => textShape(tool, input, output, 'Draft reply', str(output.draft)),
  extract_action_items: (input, output, tool) => {
    const items = Array.isArray(output.items) ? output.items.map(str).filter(Boolean) : [];
    return items.length
      ? textShape(tool, input, output, 'Action items', items.map((item) => `• ${item}`).join('\n'))
      : null;
  },
  translate_thread: (input, output, tool) =>
    textShape(tool, input, output, 'Translation', str(output.translation)),
  pre_send_critique: (input, output, tool) => {
    const notes = Array.isArray(output.notes) ? output.notes.map(str).filter(Boolean) : [];
    return textShape(
      tool,
      input,
      output,
      output.verdict === 'ok' ? 'Ready to send' : 'Review before sending',
      notes.join('\n'),
    );
  },
  list_accounts: (input, output, tool) => {
    const accounts = asArray(output.accounts);
    if (!accounts.length) return null;
    return textShape(
      tool,
      input,
      output,
      'Connected accounts',
      accounts.map((row) => str(row.email) || str(row.accountId)).join('\n'),
    );
  },
  // --- Mail mutations ---
  archive_thread: mailReceipt,
  trash_thread: mailReceipt,
  mute_thread: mailReceipt,
  mark_read: mailReceipt,
  mark_unread: mailReceipt,
  star: mailReceipt,
  unstar: mailReceipt,
  add_label: mailReceipt,
  remove_label: mailReceipt,
  snooze_thread: (input, output, tool) => {
    const shape = mailReceipt(input, output, tool);
    const until = iso(output.untilIso ?? input.untilTs);
    return until ? { ...shape, target: { ...shape.target, untilIso: until } } : shape;
  },
  unsnooze_thread: mailReceipt,
  create_label: (input, output, tool) => receipt(tool, input, output, 'mail', [], { name: str(input.name) }),
  save_draft: (input, output, tool) => {
    const draft = asRecord(output.draft);
    const account = str(draft.account) || str(input.account);
    const threadId = str(draft.threadId) || str(input.threadId);
    const actions: ShapeAction[] = account && threadId ? [{ kind: 'open_thread', account, threadId }] : [];
    return receipt(
      tool,
      input,
      output,
      'mail',
      actions,
      { account, draftId: str(draft._id) || undefined },
      str(draft.subject) || undefined,
    );
  },
  schedule_send: (input, output, tool) =>
    receipt(
      tool,
      input,
      output,
      'mail',
      [],
      { account: str(input.account), scheduleId: str(output.scheduleId) || undefined },
      iso(input.scheduledFor),
    ),
  cancel_scheduled: (input, output, tool) =>
    receipt(tool, input, output, 'mail', [], { scheduleId: str(input.scheduleId) }),
  undo_send: (input, output, tool) =>
    receipt(tool, input, output, 'mail', [], { pendingId: str(input.pendingId) }),
  create_smart_label: (input, output, tool) =>
    receipt(tool, input, output, 'mail', [], { name: str(asRecord(output.label).name) || str(input.name) }),
  update_smart_label: (input, output, tool) =>
    receipt(tool, input, output, 'mail', [], { id: str(input.id) }),
  delete_smart_label: (input, output, tool) =>
    receipt(tool, input, output, 'mail', [], { id: str(input.id) }),
  create_smart_rule: (input, output, tool) =>
    receipt(tool, input, output, 'mail', [], { name: str(asRecord(output.rule).name) || str(input.name) }),
  set_smart_rule_enabled: (input, output, tool) =>
    receipt(tool, input, output, 'mail', [], { id: str(input.id), enabled: input.enabled }),
  apply_smart_correction: (input, output, tool) => mailReceipt(input, output, tool),
  // --- Calendar ---
  calendar_list_events: (input, output, tool) =>
    eventsShape(tool, input, output, asArray(output.events), 'Calendar'),
  calendar_search_events: (input, output, tool) =>
    eventsShape(
      tool,
      input,
      output,
      asArray(output.events),
      `Events matching “${clip(str(input.query), 60)}”`,
    ),
  calendar_event_detail: (input, output, tool) => {
    const item = eventRow(asRecord(output.event), str(input.account) || undefined);
    if (!item) return null;
    item.actions.push({
      kind: 'delete_event',
      account: item.account,
      calendarId: item.calendarId,
      eventId: item.eventId,
    });
    return {
      kind: 'event',
      ...base(tool, input, output, item.title, item.location),
      account: item.account,
      item,
      actions: [],
    };
  },
  calendar_suggest_times: (input, output, tool) => {
    const account = Array.isArray(input.accountIds) ? str(input.accountIds[0]) || undefined : undefined;
    const items: SlotRow[] = asArray(output.suggestions)
      .map((row) => {
        const startIso = iso(row.startIso);
        const endIso = iso(row.endIso);
        if (!startIso || !endIso) return null;
        return {
          startIso,
          endIso,
          actions: [{ kind: 'hold_slot', account, startIso, endIso } as ShapeAction],
        };
      })
      .filter((row): row is SlotRow => Boolean(row))
      .slice(0, SHAPE_LIST_LIMIT);
    if (!items.length) return null;
    return { kind: 'slots', ...base(tool, input, output, 'Open times'), account, items, actions: [] };
  },
  calendar_create_event: calendarReceipt,
  calendar_update_event: calendarReceipt,
  calendar_delete_event: calendarReceipt,
  calendar_rsvp_event: (input, output, tool) => {
    const shape = calendarReceipt(input, output, tool);
    return shape ? { ...shape, target: { ...shape.target, status: str(input.status) } } : null;
  },
  calendar_delete_recurring_series: (input, output, tool) =>
    receipt(tool, input, output, 'calendar', [], { deleted: num(output.deleted) }),
  calendar_unsubscribe_calendar: (input, output, tool) =>
    receipt(tool, input, output, 'calendar', [], {
      calendarId: str(output.calendarId),
      name: str(output.name) || undefined,
    }),
  salvage_context: (input, output, tool) => {
    const events = asArray(output.events);
    const tasks = asArray(output.tasks);
    const summary = `${events.length} event${events.length === 1 ? '' : 's'} left today, ${tasks.length} open task${tasks.length === 1 ? '' : 's'}`;
    const shape = eventsShape(tool, input, output, events, 'Rest of today');
    if (shape) return { ...shape, summary };
    const taskItems = tasks
      .map((row) => taskRow(row))
      .filter((row): row is TaskRow => Boolean(row))
      .slice(0, SHAPE_LIST_LIMIT);
    if (!taskItems.length) return null;
    return {
      kind: 'tasks',
      ...base(tool, input, output, 'Open tasks', summary),
      items: taskItems,
      actions: [],
    };
  },
  // --- Tasks ---
  tasks_get_board: (input, output, tool) => {
    const board = asRecord(output.board);
    const boardId = str(board.boardId) || str(input.boardId);
    if (!boardId) return null;
    const cards = asArray(board.cards);
    const columns = asArray(board.columns).map((column) => ({
      name: str(column.name),
      count: cards.filter((card) => str(card.columnId) === str(column.columnId) && !card.completedAt).length,
    }));
    return {
      kind: 'board',
      ...base(
        tool,
        input,
        output,
        str(board.title) || 'Board',
        `${cards.length} card${cards.length === 1 ? '' : 's'}`,
      ),
      boardId,
      columns,
      actions: [{ kind: 'open_board', boardId }],
    };
  },
  tasks_list_boards: (input, output, tool) => {
    const boards = asArray(output.boards);
    if (!boards.length) return null;
    return textShape(
      tool,
      input,
      output,
      'Boards',
      boards
        .map((row) => str(row.title))
        .filter(Boolean)
        .join('\n'),
    );
  },
  tasks_due_cards: (input, output, tool) => {
    const items = asArray(output.cards)
      .map((row) => taskRow(row))
      .filter((row): row is TaskRow => Boolean(row))
      .slice(0, SHAPE_LIST_LIMIT);
    if (!items.length) return null;
    return { kind: 'tasks', ...base(tool, input, output, 'Due tasks'), items, actions: [] };
  },
  tasks_for_thread: (input, output, tool) => {
    const items = asArray(output.cards)
      .map((row) => taskRow(row))
      .filter((row): row is TaskRow => Boolean(row))
      .slice(0, SHAPE_LIST_LIMIT);
    if (!items.length) return null;
    return { kind: 'tasks', ...base(tool, input, output, 'Linked tasks'), items, actions: [] };
  },
  tasks_create_card: (input, output, tool) => {
    const cardId = str(output.cardId);
    if (!cardId) return null;
    const item = taskRow({ ...input, cardId, dueIso: input.dueIso }, str(input.boardId) || undefined);
    if (!item) return null;
    const operationId = str(output.operationId) || undefined;
    return {
      kind: 'task',
      ...base(tool, input, output, item.title, item.column ? `In ${item.column}` : undefined),
      item,
      actions: operationId ? [{ kind: 'undo_operation', operationId }] : [],
    };
  },
  tasks_update_card: taskStateShape,
  tasks_move_card: taskStateShape,
  tasks_delete_card: taskReceipt,
  tasks_add_comment: taskReceipt,
  tasks_attach_link: taskReceipt,
  tasks_attach_file: taskReceipt,
  tasks_attach_calendar_event_link: taskReceipt,
  tasks_create_board: (input, output, tool) => {
    const boardId = str(output.boardId);
    return receipt(
      tool,
      input,
      output,
      'tasks',
      boardId ? [{ kind: 'open_board', boardId }] : [],
      { boardId, title: str(input.title) },
      str(input.title) || undefined,
    );
  },
  tasks_rename_board: taskReceipt,
  tasks_delete_board: taskReceipt,
  tasks_create_column: taskReceipt,
  tasks_rename_column: taskReceipt,
  tasks_delete_column: taskReceipt,
  mcp_create_task: taskReceipt,
  // --- Albatross work ---
  albatross_get_work_context: (input, output, tool) => {
    const context = asRecord(output.context);
    const work = asRecord(context.work);
    const plan = asRecord(context.plan);
    const item = workRow({ ...work, currentStep: str(plan.summary) || str(plan.outcome) || undefined });
    if (!item) return null;
    return {
      kind: 'work',
      ...base(tool, input, output, item.title, str(plan.outcome) || undefined),
      item,
      actions: [],
    };
  },
  albatross_capture_work: (input, output, tool) => {
    const rows = asArray(output.work)
      .map((row) => workRow(row))
      .filter((row): row is WorkRow => Boolean(row));
    if (!rows.length) return null;
    if (rows.length === 1)
      return { kind: 'work', ...base(tool, input, output, rows[0].title), item: rows[0], actions: [] };
    return {
      kind: 'works',
      ...base(tool, input, output, 'Captured', `${rows.length} items`),
      items: rows.slice(0, SHAPE_LIST_LIMIT),
      actions: [],
    };
  },
  albatross_replan_work: (input, output, tool) => {
    const item = workRow({ id: output.workId, title: output.title, currentStep: output.currentStep });
    if (!item) return null;
    return {
      kind: 'work',
      ...base(tool, input, output, item.title, str(output.summary) || undefined),
      item,
      actions: [],
    };
  },
  albatross_record_progress: (input, output, tool) => {
    const workId = str(output.workId) || str(input.workId);
    return receipt(
      tool,
      input,
      output,
      'albatross',
      workId ? [{ kind: 'open_work', workId }] : [],
      { workId },
      str(output.summary) || str(output.claim) || undefined,
    );
  },
  albatross_split_work: (input, output, tool) => {
    const proposed = asArray(output.proposed)
      .map((row) => str(row.title))
      .filter(Boolean);
    const summary = str(output.summary);
    if (output.committed) {
      const workId = str(output.workId);
      return receipt(
        tool,
        input,
        output,
        'albatross',
        workId ? [{ kind: 'open_work', workId }] : [],
        { workIds: output.workIds },
        summary || undefined,
      );
    }
    return textShape(
      tool,
      input,
      output,
      'Proposed split',
      [summary, ...proposed.map((title) => `• ${title}`)].filter(Boolean).join('\n'),
    );
  },
  albatross_list_add: (input, output, tool) => {
    const workId = str(output.workId) || str(input.workId);
    return receipt(
      tool,
      input,
      output,
      'albatross',
      workId ? [{ kind: 'open_work', workId }] : [],
      { workId, item: str(asRecord(output.item).text) },
      str(output.summary) || undefined,
    );
  },
  albatross_metric_log: (input, output, tool) => {
    const workId = str(output.workId) || str(input.workId);
    return receipt(
      tool,
      input,
      output,
      'albatross',
      workId ? [{ kind: 'open_work', workId }] : [],
      { workId, value: asRecord(output.entry).value },
      str(output.summary) || undefined,
    );
  },
  albatross_list_projects: (input, output, tool) => {
    const rows = asArray(output.projects)
      .map((row) => workRow({ ...row, id: row._id }, () => []))
      .filter((row): row is WorkRow => Boolean(row));
    if (!rows.length) return null;
    return {
      kind: 'works',
      ...base(tool, input, output, 'Projects', `${rows.length} project${rows.length === 1 ? '' : 's'}`),
      items: rows.slice(0, SHAPE_LIST_LIMIT),
      actions: [],
    };
  },
  albatross_create_project: (input, output, tool) =>
    receipt(
      tool,
      input,
      output,
      'albatross',
      [],
      { projectId: str(output.projectId), title: str(input.title) },
      str(input.title) || undefined,
    ),
  albatross_create_sprint: (input, output, tool) =>
    receipt(
      tool,
      input,
      output,
      'albatross',
      [],
      { sprintId: str(output.sprintId), title: str(input.title) },
      str(input.title) || undefined,
    ),
  albatross_create_routine: (input, output, tool) =>
    receipt(
      tool,
      input,
      output,
      'albatross',
      [],
      { routineId: str(output.routineId), status: str(output.status) },
      str(input.title) || undefined,
    ),
  albatross_set_routine_consent: (input, output, tool) =>
    receipt(tool, input, output, 'albatross', [], { routineId: str(input.routineId) }),
  albatross_run_routine_now: (input, output, tool) =>
    receipt(tool, input, output, 'albatross', [], { routineId: str(input.routineId) }),
  // --- Areas ---
  area_create: (input, output, tool) => {
    const areaId = str(output.areaId);
    if (!areaId) return null;
    return {
      kind: 'area',
      ...base(
        tool,
        input,
        output,
        str(output.name) || str(input.name) || 'Area',
        str(input.description) || undefined,
      ),
      areaId,
      name: str(output.name) || str(input.name),
      areaKind: str(input.kind) || undefined,
      domain: str(input.primaryDomain) || undefined,
      description: str(input.description) || undefined,
      actions: [{ kind: 'open_area', areaId }],
    };
  },
  area_list: (input, output, tool) => {
    const areas = asArray(output.areas);
    if (!areas.length) return null;
    return textShape(
      tool,
      input,
      output,
      'Areas',
      areas
        .map((row) => str(row.name))
        .filter(Boolean)
        .join('\n'),
    );
  },
  area_add_fact: (input, output, tool) => {
    const areaId = str(input.areaId);
    return receipt(
      tool,
      input,
      output,
      'albatross',
      areaId ? [{ kind: 'open_area', areaId }] : [],
      { areaId, factId: str(output.factId), status: str(output.status) },
      str(input.value) || undefined,
    );
  },
  area_update_identity: (input, output, tool) =>
    receipt(
      tool,
      input,
      output,
      'albatross',
      str(input.areaId) ? [{ kind: 'open_area', areaId: str(input.areaId) }] : [],
      { areaId: str(input.areaId) },
    ),
  area_archive: (input, output, tool) =>
    receipt(tool, input, output, 'albatross', [], { areaId: str(input.areaId) }),
  // --- Documents and files ---
  document_create: (input, output, tool) => documentShape(tool, input, output, 'created'),
  document_edit: (input, output, tool) => documentShape(tool, input, output),
  document_suggest_changes: (input, output, tool) =>
    documentShape(
      tool,
      input,
      { ...output, title: str(output.title), summary: str(output.description) },
      'proposed',
    ),
  document_apply_instruction: (input, output, tool) => documentShape(tool, input, output, 'applied'),
  document_get: (input, output, tool) => {
    const document = asRecord(output.document);
    return documentShape(tool, input, {
      ...output,
      documentId: document.documentId,
      title: document.title,
      kind: document.kind,
      revision: document.currentRevision,
      googleUrl: asRecord(document.google).webUrl,
    });
  },
  document_export: (input, output, tool) => {
    const shape = documentShape(
      tool,
      input,
      { ...output, title: str(input.title) || 'Export' },
      str(output.fidelity) || undefined,
    );
    if (!shape || shape.kind !== 'document') return shape;
    const downloadPath = str(output.downloadPath);
    if (downloadPath) shape.actions.unshift({ kind: 'open_url', url: downloadPath, label: 'Download' });
    return { ...shape, summary: str(output.warning) || shape.summary };
  },
  document_publish_google: (input, output, tool) => {
    const webUrl = str(output.webUrl);
    return receipt(
      tool,
      input,
      output,
      'documents',
      webUrl ? [{ kind: 'open_url', url: webUrl, label: 'Open in Google' }] : [],
      { documentId: str(input.documentId), fileId: str(output.fileId) },
    );
  },
  google_file_import: (input, output, tool) =>
    documentShape(tool, input, output, output.existing ? 'existing' : 'imported'),
  document_list: (input, output, tool) => {
    const documents = asArray(output.documents);
    if (!documents.length) return null;
    return textShape(
      tool,
      input,
      output,
      'Documents',
      documents
        .map((row) => str(row.title))
        .filter(Boolean)
        .join('\n'),
    );
  },
  cloud_file_search: (input, output, tool) => {
    const items: FileRow[] = asArray(output.files)
      .map((row): FileRow | null => {
        const fileId = str(row.id);
        const connectionId = str(row.connectionId) || str(input.connectionId);
        if (!fileId || !connectionId) return null;
        const mimeType = str(row.mimeType) || undefined;
        const webUrl = str(row.webUrl) || undefined;
        const actions: ShapeAction[] = row.isFolder
          ? []
          : [{ kind: 'import_file', connectionId, fileId, mimeType }];
        if (webUrl) actions.push({ kind: 'open_url', url: webUrl });
        return {
          connectionId,
          fileId,
          name: str(row.name) || fileId,
          kind: row.isFolder ? 'folder' : undefined,
          source: str(row.provider) || undefined,
          mimeType,
          webUrl,
          modifiedIso: iso(row.modifiedAt),
          actions,
        };
      })
      .filter((row): row is FileRow => Boolean(row))
      .slice(0, SHAPE_LIST_LIMIT);
    if (!items.length) return null;
    return {
      kind: 'files',
      ...base(tool, input, output, `Files matching “${clip(str(input.query), 60)}”`),
      items,
      actions: [],
    };
  },
  // --- Memory ---
  remember: (input, output, tool) =>
    receipt(
      tool,
      input,
      output,
      'memory',
      [],
      { email: str(input.email) },
      str(input.notes) ? clip(str(input.notes), 160) : undefined,
    ),
  forget: (input, output, tool) => receipt(tool, input, output, 'memory', [], { email: str(input.email) }),
  recall: (input, output, tool) => {
    const memory = asRecord(output.memory);
    const notes = str(memory.notes);
    return notes
      ? textShape(tool, input, output, str(memory.email) || str(input.email) || 'Memory', notes)
      : null;
  },
  // --- Connected tools and web ---
  mcp_search: (input, output, tool) =>
    sourcesShape(
      tool,
      input,
      output,
      asArray(output.items),
      `Connected results for “${clip(str(input.query), 60)}”`,
    ),
  github_search: (input, output, tool) =>
    sourcesShape(
      tool,
      input,
      output,
      asArray(output.items),
      `GitHub results for “${clip(str(input.query), 60)}”`,
    ),
  mcp_list_items: (input, output, tool) =>
    sourcesShape(
      tool,
      input,
      output,
      asArray(output.items),
      `Recent from ${str(input.server) || 'connected tools'}`,
    ),
  browserbase_search: (input, output, tool) =>
    sourcesShape(
      tool,
      input,
      output,
      asArray(output.results),
      `Web results for “${clip(str(input.query), 60)}”`,
    ),
  // --- Operations ---
  undo_operation: (input, output, tool) =>
    receipt(
      tool,
      input,
      output,
      'other',
      [],
      { operationId: str(input.operationId) },
      str(output.undone) || undefined,
    ),
  list_recent_operations: (input, output, tool) => {
    const operations = asArray(output.operations);
    if (!operations.length) return null;
    return textShape(
      tool,
      input,
      output,
      'Recent changes',
      operations
        .map((row) => str(row.summary))
        .filter(Boolean)
        .join('\n'),
    );
  },
};

/** Tools that never get a shape: designed display components own them. */
const NO_SHAPE_PREFIXES = ['show_', 'ask_', 'ui_'];

function genericShape(toolName: string, input: Rec, output: Rec): ToolShape | null {
  const summary = str(output.summary) || str(output.message);
  const activity = toolSentences(toolName, input, output);
  if (summary) {
    return { kind: 'text', title: activity.done, text: clip(summary, 400), activity, actions: [] };
  }
  return null;
}

/**
 * Resolve the display shape for one completed tool call. Returns null when no
 * card should render (display tools, failures, or outputs with nothing to
 * show). Failures stay on the activity row; the row already carries the
 * failure detail.
 */
const NO_SHAPE_NAMES = new Set(['enable_tools']);

export function resolveToolShape(toolName: string, input: unknown, output: unknown): ToolShape | null {
  if (NO_SHAPE_NAMES.has(toolName) || NO_SHAPE_PREFIXES.some((prefix) => toolName.startsWith(prefix)))
    return null;
  const out = asRecord(output);
  if (out.ok === false) return null;
  const args = asRecord(input);
  const mapper = MAPPERS[toolName];
  const shape = mapper ? mapper(args, out, toolName) : null;
  return shape ?? genericShape(toolName, args, out);
}

export const SHAPED_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(MAPPERS));
