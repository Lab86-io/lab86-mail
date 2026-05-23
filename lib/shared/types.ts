export type AccountEmail = string;

export interface Account {
  email: AccountEmail;
  provider: 'gmail';
  authed: boolean;
  primary?: boolean;
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
export type SmartCategoryId =
  | 'main'
  | 'needs_reply'
  | 'waiting'
  | 'codes'
  | 'orders'
  | 'finance_admin'
  | 'newsletters'
  | 'noise'
  | 'review';

export interface SmartCategory {
  primary: SmartCategoryId;
  secondary: SmartCategoryId[];
  confidence: number;
  reason: string;
  needsAttention: boolean;
  suggestedAction: 'reply' | 'read' | 'archive' | 'label' | 'snooze' | 'wait' | 'none';
  isHumanLike: boolean;
  isAutomated: boolean;
  allowNoReplyInMain: boolean;
  signals: string[];
  classifiedAt: number;
  model?: string;
}
