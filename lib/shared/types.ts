export type AccountEmail = string;
export type AccountProvider = 'google' | 'microsoft' | 'icloud' | 'imap';

export interface Account {
  accountId: string;
  email: AccountEmail;
  provider: AccountProvider;
  authed: boolean;
  primary?: boolean;
  displayName?: string;
  services?: string[];
}

export interface Thread {
  _id: string; // gmail thread id (same as latest message id in some APIs)
  account: AccountEmail;
  subject: string;
  fromAddress: string;
  lastDate: number;
  snippet: string;
  labels: string[];
  unread: boolean;
  starred?: boolean;
  summary?: string | null;
  summaryAt?: number | null;
  triage?: {
    priority: 1 | 2 | 3;
    action: string;
    reason: string;
    at: number;
  } | null;
  smartCategory?: SmartCategory | null;
  readState?: {
    openedAt?: number;
    lastMarkedReadAt?: number;
  } | null;
  gmailLabelSync?: {
    labelsApplied: string[];
    pendingLabels: string[];
    lastAppliedAt?: number;
  } | null;
  cachedAt: number;
}

export interface Attachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

export interface Message {
  _id: string; // gmail message id
  threadId: string;
  account: AccountEmail;
  subject: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  date: number;
  snippet: string;
  textBody: string;
  htmlBody: string;
  labels: string[];
  // Provider-agnostic read state from the API (labels like 'UNREAD' are a
  // Gmail-only signal and must not be the sole source).
  unread?: boolean;
  attachments: Attachment[];
  headers: Record<string, string>;
  cachedAt: number;
}

export interface ChatMessage {
  _id?: string;
  account: AccountEmail;
  threadId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
}

export interface Memory {
  _id?: string;
  email: string;
  notes: string;
  updatedAt: number;
}

export interface AuditEntry {
  _id?: string;
  ts: number;
  tool: string;
  userId?: string | null;
  account: AccountEmail | null;
  args: Record<string, unknown>;
  result: 'ok' | 'error';
  detail?: string;
  agent: 'user' | 'ai' | 'codex';
}

export interface Pref {
  _id: string;
  value: string;
}

export interface Snooze {
  _id?: string;
  account: AccountEmail;
  messageId: string;
  threadId: string;
  untilTs: number;
  createdAt: number;
}

export interface Draft {
  _id?: string;
  account: AccountEmail;
  threadId?: string;
  inReplyToMessageId?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  html?: string;
  scheduledFor?: number;
  updatedAt: number;
}

export interface LabelRecord {
  id: string;
  name: string;
  type?: 'system' | 'user';
  messagesTotal?: number;
  threadsTotal?: number;
}

export type Priority = 1 | 2 | 3;
export type TriageAction = 'reply' | 'read' | 'archive' | 'delegate' | 'wait';
export type PrimaryView = 'daily_report' | 'mail' | 'calendar' | 'tasks';
export type SmartCategoryId =
  | 'main'
  | 'needs_reply'
  | 'codes'
  | 'orders'
  | 'finance_admin'
  | 'noise'
  | 'review';

// Daily-report lanes, ordered by descending priority for the lane clamp:
// reply_owed > follow_up_owed > new_people > time_sensitive > tracked > fyi > bulk.
export type ReportLane =
  | 'reply_owed'
  | 'follow_up_owed'
  | 'new_people'
  | 'time_sensitive'
  | 'tracked'
  | 'fyi'
  | 'bulk';

export interface SmartCategory {
  primary: SmartCategoryId;
  secondary: SmartCategoryId[];
  customLabels?: string[];
  confidence: number;
  reason: string;
  needsAttention: boolean;
  suggestedAction: 'reply' | 'read' | 'archive' | 'label' | 'snooze' | 'wait' | 'none';
  isHumanLike: boolean;
  isAutomated: boolean;
  allowNoReplyInMain: boolean;
  bulkSignals?: string[];
  ruleHits?: string[];
  signals: string[];
  classifiedAt: number;
  model?: string;
}

export interface SmartLabelDefinition {
  _id: string;
  name: string;
  slug: string;
  description: string;
  enabled: boolean;
  sidebarVisible: boolean;
  icon?: string;
  color?: string;
  gmailLabelName: string;
  aiMode: 'metadata_snippet';
  positiveExamples: string[];
  negativeExamples: string[];
  candidateQuery?: string;
  createdBy: 'user' | 'agent' | 'system';
  createdAt: number;
  updatedAt: number;
}

export interface SmartRule {
  _id: string;
  name: string;
  enabled: boolean;
  scope: 'thread' | 'sender' | 'domain' | 'subject_pattern' | 'header';
  match: string;
  effect: 'never_main' | 'always_noise' | 'always_category' | 'always_custom_label' | 'never_custom_label';
  category?: SmartCategoryId;
  customLabelId?: string;
  reason?: string;
  source: 'quick_fix' | 'agent' | 'settings';
  createdAt: number;
  updatedAt: number;
}

export interface SmartCorrection {
  _id: string;
  account: string;
  threadId: string;
  fromEmail?: string;
  fromDomain?: string;
  subject?: string;
  previousCategory?: SmartCategoryId;
  newCategory?: SmartCategoryId;
  customLabelId?: string;
  ruleId?: string;
  action: 'never_main' | 'always_noise' | 'move_to' | 'create_label_from_this' | 'undo';
  createdAt: number;
}

export type TrackedThreadStatus = 'open' | 'waiting' | 'due_soon' | 'resolved' | 'snoozed' | 'dismissed';

export interface TrackedThread {
  _id: string;
  account: AccountEmail;
  threadId: string;
  subject: string;
  participants: string[];
  status: TrackedThreadStatus;
  reason: string;
  openLoops: string[];
  nextAction?: string;
  dueAt?: number | null;
  snoozedUntil?: number | null;
  importance: 1 | 2 | 3;
  source: 'manual' | 'ai' | 'report' | 'correction';
  aiSuggestedResolved?: boolean;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number | null;
}

export interface ThreadInsight {
  _id: string;
  account: AccountEmail;
  threadId: string;
  subject: string;
  summary: string;
  people: string[];
  commitments: Array<{
    text: string;
    dueAt?: number | null;
    confidence: number;
  }>;
  openLoops: string[];
  needsReply: boolean;
  waitingOnSomeone: boolean;
  suggestedTrack: boolean;
  suggestedCategory: SmartCategoryId;
  reason: string;
  // Deterministic safety-floor signals (Stage 1 of the report pipeline).
  replyOwed: boolean;
  followUpOwed: boolean;
  isNewSender: boolean;
  isPersonal: boolean;
  isImportant: boolean;
  isPriorCorrespondent: boolean;
  // True when the floor guarantees this thread is never hidden in the bulk tail.
  floorProtected: boolean;
  // Final lane after the floor + (promote-only) LLM clamp.
  lane: ReportLane;
  // Human-readable provenance pills, e.g. ['reply_owed', 'category_personal'].
  surfacedBecause: string[];
  // Why a non-protected thread was demoted into the bulk tail (null when shown).
  demotionReason?: string | null;
  generatedAt: number;
  model?: string;
}

export interface DailyReportItem {
  account: AccountEmail;
  threadId: string;
  subject: string;
  people: string[];
  whyItMatters: string;
  nextAction?: string;
  openLoops?: string[];
  dueAt?: number | null;
  unread: boolean;
  trackedThreadId?: string;
  surfacedBecause?: string[];
  demotionReason?: string | null;
  isNewSender?: boolean;
  lane?: ReportLane;
  // Timestamp of the newest message — drives the "received N days ago" framing.
  receivedAt?: number | null;
}

export interface DailyReportTaskItem {
  cardId: string;
  boardId: string;
  columnId: string;
  boardTitle?: string;
  columnName?: string;
  title: string;
  description?: string;
  dueAt?: number | null;
  completedAt?: number | null;
  priority?: 'low' | 'medium' | 'high';
  labels?: string[];
  assignees?: string[];
  sourceTitle?: string;
  sourceUrl?: string;
  scope: 'week' | 'month';
}

export interface DailyReportCalendarItem {
  account: AccountEmail;
  eventId: string;
  calendarId?: string;
  calendarName?: string;
  title: string;
  startAt: number;
  endAt: number;
  allDay?: boolean;
  location?: string;
  htmlLink?: string;
  description?: string;
  scope: 'week' | 'month';
}

export interface DailyReport {
  _id: string;
  kind: 'morning' | 'evening' | 'manual';
  generatedAt: number;
  // Progressive generation: 'partial' editions stream lanes in as threads are
  // analyzed; 'ready' is the finished edition. Absent on pre-existing docs.
  status?: 'partial' | 'ready';
  progress?: { stage: string; done: number; total: number };
  accounts: AccountEmail[];
  title: string;
  narrative: string;
  sections: {
    replyOwed: DailyReportItem[];
    followUpOwed: DailyReportItem[];
    newPeople: DailyReportItem[];
    timeSensitive: DailyReportItem[];
    tracked: DailyReportItem[];
    fyi: DailyReportItem[];
    bulkTail: DailyReportItem[];
    tasks?: DailyReportTaskItem[];
    calendar?: DailyReportCalendarItem[];
    noiseSummary?: string;
  };
  stats: {
    scannedThreads: number;
    trackedThreads: number;
    needsReply: number;
    replyOwed: number;
    dueSoon: number;
    bulkTailCount: number;
    unread: number;
    openTasks?: number;
    completedTasks?: number;
    calendarEvents?: number;
  };
  model?: string;
  errors?: string[];
}

export interface SmartCategoryStat {
  _id: string;
  account: AccountEmail | '__all__';
  category: string;
  total: number;
  unread: number;
  needsAttention: number;
  tracked: number;
  computedAt: number;
  approximate: boolean;
}
