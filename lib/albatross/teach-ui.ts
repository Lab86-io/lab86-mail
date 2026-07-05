// Pure view-model helpers for the Teach conversation (components/albatross/
// TeachAreas.tsx) and the tabbed settings page (app/settings/page.tsx).
// No React, no DOM — everything here is bun:test-able.

// ---------------------------------------------------------------------------
// Settings tabs
// ---------------------------------------------------------------------------

export type SettingsTabId =
  | 'mailboxes'
  | 'connections'
  | 'areas'
  | 'sending'
  | 'ai'
  | 'shortcuts'
  | 'account';

export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTabId; label: string }> = [
  { id: 'mailboxes', label: 'Mailboxes' },
  { id: 'connections', label: 'Connections' },
  { id: 'areas', label: 'Areas' },
  { id: 'sending', label: 'Sending' },
  { id: 'ai', label: 'AI' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'account', label: 'Account' },
];

export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'mailboxes';

// /settings?tab=areas deep-links straight to a tab; anything unrecognized
// lands on the default so stale links never 404 the pane.
export function settingsTabFromSearch(value: string | null | undefined): SettingsTabId {
  const wanted = String(value || '')
    .trim()
    .toLowerCase();
  const match = SETTINGS_TABS.find((tab) => tab.id === wanted);
  return match ? match.id : DEFAULT_SETTINGS_TAB;
}

// ---------------------------------------------------------------------------
// Teach chat session identity
// ---------------------------------------------------------------------------

// One persisted conversation per user: saving under this reserved title and
// re-finding it by title is what makes "adding more later" the SAME chat.
export const TEACH_CHAT_TITLE = 'Teach: areas';

export function teachChatTitle(): string {
  return TEACH_CHAT_TITLE;
}

export function isTeachChatSession(session: { title?: unknown } | null | undefined): boolean {
  return typeof session?.title === 'string' && session.title.trim().startsWith(TEACH_CHAT_TITLE);
}

// ---------------------------------------------------------------------------
// Tool-part helpers
// ---------------------------------------------------------------------------

// Tool calls arrive either as static `tool-<name>` parts or as `dynamic-tool`
// parts carrying `toolName` (OpenRouter does this) — resolve both shapes.
export function toolPartName(part: { type?: unknown; toolName?: unknown } | null | undefined): string {
  const type = typeof part?.type === 'string' ? part.type : '';
  if (type === 'dynamic-tool') return typeof part?.toolName === 'string' ? part.toolName : '';
  return type.startsWith('tool-') ? type.slice(5) : '';
}

// ---------------------------------------------------------------------------
// area_domain_activity → sender cards
// ---------------------------------------------------------------------------

export interface TeachSenderCard {
  email: string;
  name?: string;
  initials: string;
  threads: number;
  lastDate?: number;
  lastSubject?: string;
}

export function senderInitials(name: string | undefined, email: string): string {
  const cleaned = String(name || '').trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1 && words[0].length >= 2 && !words[0].includes('@')) {
    return words[0].slice(0, 2).toUpperCase();
  }
  const local = String(email || '').split('@')[0] || '';
  const parts = local.split(/[.\-_+]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (local || '?').slice(0, 2).toUpperCase();
}

// Maps the area_domain_activity output ({ senders: [...] }) to render-ready
// cards: initials avatar, headline name, thread count, the freshest subject.
// Defensive against partial or garbage tool output — bad rows are dropped.
export function senderCardsFromToolOutput(output: unknown): TeachSenderCard[] {
  const senders = Array.isArray((output as any)?.senders) ? ((output as any).senders as any[]) : [];
  return senders
    .filter((sender) => typeof sender?.email === 'string' && sender.email.includes('@'))
    .map((sender) => {
      const email = String(sender.email).trim().toLowerCase();
      const name = typeof sender.name === 'string' && sender.name.trim() ? sender.name.trim() : undefined;
      const subjects = Array.isArray(sender.recentSubjects)
        ? sender.recentSubjects.filter((s: unknown) => typeof s === 'string' && s.trim())
        : [];
      return {
        email,
        name,
        initials: senderInitials(name, email),
        threads: Number.isFinite(sender.threads) ? Number(sender.threads) : 0,
        lastDate: Number.isFinite(sender.lastDate) ? Number(sender.lastDate) : undefined,
        lastSubject: subjects[0],
      };
    })
    .sort((a, b) => b.threads - a.threads);
}

// ---------------------------------------------------------------------------
// area_* mutations → quiet confirmation rows
// ---------------------------------------------------------------------------

export interface TeachFactRow {
  tone: 'created' | 'verified' | 'candidate' | 'retired';
  text: string;
}

// One quiet line per recorded change ("CardHunt created", "Verified: …").
// Returns null for tools this renderer does not summarize.
export function factRowFromToolOutput(toolName: string, input: any, output: any): TeachFactRow | null {
  if (!output || output.ok === false) return null;
  switch (toolName) {
    case 'area_create': {
      const name = String(input?.name || output?.name || '').trim();
      // Close the loop the user actually cares about: the new area is live in
      // the sidebar rail the moment this row renders.
      return { tone: 'created', text: `${name || 'Area'} created — in your sidebar` };
    }
    case 'area_add_fact': {
      const value = String(input?.value || '').trim();
      if (!value) return null;
      return output.status === 'verified'
        ? { tone: 'verified', text: `Verified: ${value}` }
        : { tone: 'candidate', text: `To confirm: ${value}` };
    }
    case 'area_archive': {
      const reason = String(input?.reason || '').trim();
      return { tone: 'retired', text: reason ? `Area archived — ${reason}` : 'Area archived — history kept' };
    }
    case 'area_fact_set_status': {
      const status = input?.status;
      if (status === 'verified') return { tone: 'verified', text: 'Fact verified' };
      if (status === 'rejected') return { tone: 'retired', text: 'Fact rejected' };
      if (status === 'superseded') return { tone: 'retired', text: 'Fact superseded' };
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Collapsed-strip state
// ---------------------------------------------------------------------------

// The Teach pane opens expanded for a first-time user (there is nothing else
// to show) and as a compact "Teach Albatross more" strip when a prior
// conversation exists — expanding resumes that same thread.
export interface TeachPaneState {
  loaded: boolean;
  collapsed: boolean;
}

export type TeachPaneEvent =
  | { type: 'loaded'; messageCount: number }
  | { type: 'expand' }
  | { type: 'collapse' }
  | { type: 'send' };

export const TEACH_PANE_INITIAL: TeachPaneState = { loaded: false, collapsed: false };

export function teachPaneReducer(state: TeachPaneState, event: TeachPaneEvent): TeachPaneState {
  switch (event.type) {
    case 'loaded':
      return { loaded: true, collapsed: event.messageCount > 0 };
    case 'expand':
      return { ...state, collapsed: false };
    case 'collapse':
      return { ...state, collapsed: true };
    case 'send':
      return { ...state, collapsed: false };
    default:
      return state;
  }
}
