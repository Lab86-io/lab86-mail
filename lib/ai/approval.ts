// Server-enforced approval for agent tools that reach another person.
//
// The agent marks these tools with the AI SDK `needsApproval` flag. The SDK
// then stops at a `tool-approval-request` chunk and runs the tool only when
// the next request carries an approved response for that call. The client
// cannot skip the step, and the model cannot approve its own call.
//
// Pure module: the web chat imports approvalSummary to draw the card, and the
// agent stream sends the same summary to native clients as a
// `data-tool-approval` chunk.

type Rec = Record<string, unknown>;

/**
 * What one tool call can touch.
 * - `read`: nothing changes.
 * - `write_self`: the user's own data changes, and Activity shows it with Undo.
 * - `reach_person`: another person sees the result (mail, invitations, answers).
 * - `destructive`: the change cannot be undone.
 */
export type ToolRisk = 'read' | 'write_self' | 'reach_person' | 'destructive';
export const TOOL_RISKS: readonly ToolRisk[] = ['read', 'write_self', 'reach_person', 'destructive'];

/** Risk classes whose agent calls always wait for the user's answer. */
export const APPROVAL_RISKS: ReadonlySet<ToolRisk> = new Set<ToolRisk>(['reach_person', 'destructive']);

export interface ApprovalSummary {
  title: string;
  description?: string;
  metadata: Array<{ label: string; value: string }>;
  confirmLabel: string;
  denyLabel: string;
  intent: 'default' | 'destructive';
}

/** Tools whose calls can reach another person. Each is gated by toolNeedsApproval. */
export const APPROVAL_GATED_TOOLS: ReadonlySet<string> = new Set([
  'schedule_send',
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
  'calendar_delete_recurring_series',
  // reach_person: the list owner gets the request, and it cannot be undone.
  'unsubscribe_sender',
]);

function rec(value: unknown): Rec {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function attendeeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const row = rec(entry);
      const email = text(row.email);
      const name = text(row.name);
      return name && email ? `${name} <${email}>` : email || name;
    })
    .filter(Boolean);
}

/** True when this call reaches another person and must wait for the user. */
export function toolNeedsApproval(toolName: string, input: unknown): boolean {
  const args = rec(input);
  switch (toolName) {
    case 'schedule_send':
    case 'unsubscribe_sender':
      return true;
    case 'calendar_create_event':
      return attendeeList(args.attendees).length > 0;
    case 'calendar_update_event':
      return attendeeList(args.attendees).length > 0 || args.notifyParticipants === true;
    case 'calendar_delete_event':
    case 'calendar_delete_recurring_series':
      return args.notifyParticipants === true;
    default:
      return false;
  }
}

const UNSUBSCRIBE_METHODS: Record<string, string> = {
  one_click: 'One-click request',
  mailto: 'An email from your mailbox',
  link: 'The sender’s web page',
};

function joinPeople(people: string[], max = 4): string {
  if (people.length <= max) return people.join(', ');
  return `${people.slice(0, max).join(', ')}, and ${people.length - max} more`;
}

function whenText(value: unknown, timeZone?: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    try {
      return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
        new Date(value),
      );
    } catch {
      return new Date(value).toISOString();
    }
  }
  const raw = text(value);
  if (!raw) return '';
  // A timestamp with a zone converts to the user's zone. A naive timestamp is
  // already the user's wall-clock time, so it shows as written.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) && !Number.isNaN(Date.parse(raw))) {
    return whenText(Date.parse(raw), timeZone);
  }
  return raw.replace('T', ' ').slice(0, 16);
}

function eventName(args: Rec): string {
  return text(args.title) || text(args.matchTitle) || 'this event';
}

function row(label: string, value: string) {
  return value ? [{ label, value }] : [];
}

/** The approval card for one gated call. */
export function approvalSummary(toolName: string, input: unknown, timeZone?: string): ApprovalSummary {
  const args = rec(input);
  const attendees = attendeeList(args.attendees);
  switch (toolName) {
    case 'schedule_send': {
      const to = text(args.to);
      const when = whenText(args.scheduledFor, timeZone);
      return {
        title: `Schedule this email to ${to || 'the recipient'}`,
        description: `The email goes out${when ? ` at ${when}` : ''} with no further check.`,
        metadata: [
          ...row('To', to),
          ...row('Cc', text(args.cc)),
          ...row('Bcc', text(args.bcc)),
          ...row('Subject', text(args.subject)),
          ...row('Send at', when),
          ...row('From', text(args.from) || text(args.account)),
        ],
        confirmLabel: 'Schedule',
        denyLabel: 'Cancel',
        intent: 'default',
      };
    }
    case 'calendar_create_event':
      return {
        title: `Send invitations for “${eventName(args)}”`,
        description: 'This creates the event and emails an invitation to each attendee.',
        metadata: [
          ...row('Event', eventName(args)),
          ...row('Starts', whenText(args.startIso, timeZone)),
          ...row('Ends', whenText(args.endIso, timeZone)),
          ...row('Invitees', joinPeople(attendees)),
          ...row('Calendar', text(args.account)),
        ],
        confirmLabel: 'Send invitations',
        denyLabel: 'Cancel',
        intent: 'default',
      };
    case 'calendar_update_event': {
      const notify = args.notifyParticipants === true;
      const current = text(args.matchTitle) || eventName(args);
      const renamed =
        text(args.matchTitle) && text(args.title) !== text(args.matchTitle) ? text(args.title) : '';
      return {
        title: `Update “${current}”`,
        description: [
          attendees.length ? 'This changes who is invited.' : '',
          notify ? 'Each attendee gets an email about the change.' : '',
        ]
          .filter(Boolean)
          .join(' '),
        metadata: [
          ...row('Event', current),
          ...row('New title', renamed),
          ...row('Starts', whenText(args.startIso, timeZone)),
          ...row('Ends', whenText(args.endIso, timeZone)),
          ...row('Invitees', joinPeople(attendees)),
        ],
        confirmLabel: notify ? 'Update and notify' : 'Update event',
        denyLabel: 'Cancel',
        intent: 'default',
      };
    }
    case 'calendar_delete_event':
    case 'calendar_delete_recurring_series':
      return {
        title: `Cancel “${eventName(args)}” and notify attendees`,
        description:
          toolName === 'calendar_delete_recurring_series' || args.deleteSeries === true
            ? 'This deletes every event in the series and emails a cancellation to each attendee.'
            : 'This deletes the event and emails a cancellation to each attendee.',
        metadata: [...row('Event', eventName(args))],
        confirmLabel: 'Cancel event',
        denyLabel: 'Keep it',
        intent: 'destructive',
      };
    case 'unsubscribe_sender':
      return {
        title: 'Unsubscribe from this mailing list',
        description: 'The sender gets an unsubscribe request. This cannot be undone.',
        metadata: [
          ...row('How', UNSUBSCRIBE_METHODS[text(args.method)] || 'The way the sender offers'),
          ...row('Mailbox', text(args.account)),
        ],
        confirmLabel: 'Unsubscribe',
        denyLabel: 'Keep getting it',
        intent: 'destructive',
      };
    default:
      return {
        title: 'Approve this action',
        metadata: [],
        confirmLabel: 'Approve',
        denyLabel: 'Cancel',
        intent: 'default',
      };
  }
}

type ChatMessageLike = { role?: string; parts?: unknown[] };

/** Approval ids the user answered in the last assistant message, still waiting for the server. */
export function respondedApprovalIds(messages: ChatMessageLike[]): string[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return [];
  return (last.parts || [])
    .map((part) => rec(part))
    .filter((part) => part.state === 'approval-responded')
    .map((part) => text(rec(part.approval).id))
    .filter(Boolean);
}

/**
 * sendAutomaticallyWhen predicate for approval answers. It continues the run
 * once per answered approval, and only when the SDK agrees that every call of
 * the last step is settled.
 */
export function createApprovalAutoContinueGuard(isComplete: (messages: ChatMessageLike[]) => boolean) {
  const continued = new Set<string>();
  return (messages: ChatMessageLike[]): boolean => {
    const ids = respondedApprovalIds(messages).filter((id) => !continued.has(id));
    if (!ids.length || !isComplete(messages)) return false;
    for (const id of ids) continued.add(id);
    return true;
  };
}
