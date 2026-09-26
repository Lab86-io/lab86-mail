// Server-enforced approval for agent tools that reach another person or
// cannot be undone.
//
// Each tool in the registry declares a risk class (lib/tools/registry.ts).
// The agent marks every tool in an approval class with the AI SDK
// `needsApproval` flag. The SDK then stops at a `tool-approval-request` chunk
// and runs the tool only when the next request carries an approved response
// for that call. The client cannot skip the step, and the model cannot
// approve its own call.
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

/**
 * Agent tools in an approval risk class. This client-safe list mirrors the
 * registry: tests/agent-approval-platform.test.ts fails when an agent tool's
 * declared risk and this list disagree.
 */
export const APPROVAL_GATED_TOOLS: ReadonlySet<string> = new Set([
  // reach_person
  'schedule_send',
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
  'calendar_delete_recurring_series',
  'calendar_rsvp_event',
  // destructive
  'cancel_scheduled',
  'delete_draft',
  'delete_smart_label',
  'forget',
  'calendar_unsubscribe_calendar',
  'tasks_delete_board',
  'tasks_delete_column',
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

/**
 * For a gated tool, whether this exact call needs the user's answer. Calendar
 * writes reach another person only when they invite or notify someone; a
 * private hold or a silent delete (which Undo can restore) goes through.
 */
export function approvalConditionMet(toolName: string, input: unknown): boolean {
  const args = rec(input);
  switch (toolName) {
    case 'calendar_create_event':
      return attendeeList(args.attendees).length > 0;
    case 'calendar_update_event':
      return attendeeList(args.attendees).length > 0 || args.notifyParticipants === true;
    case 'calendar_delete_event':
    case 'calendar_delete_recurring_series':
      return args.notifyParticipants === true;
    default:
      return true;
  }
}

/** True when this call reaches another person or cannot be undone, and must wait for the user. */
export function toolNeedsApproval(toolName: string, input: unknown): boolean {
  return APPROVAL_GATED_TOOLS.has(toolName) && approvalConditionMet(toolName, input);
}

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
    case 'calendar_rsvp_event': {
      const answer = RSVP_ANSWERS[text(args.status)] || text(args.status);
      return {
        title: answer ? `Answer the invitation: ${answer}` : 'Answer the invitation',
        description: 'The organizer gets your answer by email.',
        metadata: [...row('Answer', answer), ...row('Calendar', text(args.account))],
        confirmLabel: 'Send answer',
        denyLabel: 'Cancel',
        intent: 'default',
      };
    }
    case 'cancel_scheduled':
      return {
        title: 'Cancel this scheduled email',
        description: 'The email does not go out. This cannot be undone.',
        metadata: [...row('From', text(args.account))],
        confirmLabel: 'Cancel email',
        denyLabel: 'Keep it',
        intent: 'destructive',
      };
    case 'delete_draft':
      return {
        title: 'Delete this draft',
        description: 'The draft is removed. This cannot be undone.',
        metadata: [],
        confirmLabel: 'Delete draft',
        denyLabel: 'Keep it',
        intent: 'destructive',
      };
    case 'delete_smart_label':
      return {
        title: 'Delete this label',
        description:
          'The label goes away, and the rules that file mail under it turn off. This cannot be undone.',
        metadata: [],
        confirmLabel: 'Delete label',
        denyLabel: 'Keep it',
        intent: 'destructive',
      };
    case 'forget':
      return {
        title: `Forget what Albatross knows about ${text(args.email) || 'this person'}`,
        description: 'Every stored note about this person is deleted. This cannot be undone.',
        metadata: [...row('Person', text(args.email))],
        confirmLabel: 'Forget',
        denyLabel: 'Keep notes',
        intent: 'destructive',
      };
    case 'calendar_unsubscribe_calendar':
      return {
        title: `Remove the calendar ${text(args.name) ? `“${text(args.name)}”` : 'from this account'}`,
        description: 'Its events leave Albatross. To get them back, you subscribe again with the provider.',
        metadata: [
          ...row('Calendar', text(args.name) || text(args.calendarId)),
          ...row('Account', text(args.account)),
        ],
        confirmLabel: 'Remove calendar',
        denyLabel: 'Keep it',
        intent: 'destructive',
      };
    case 'tasks_delete_board':
      return {
        title: 'Delete this board',
        description: 'The board, its columns, and every card on it are deleted. This cannot be undone.',
        metadata: [],
        confirmLabel: 'Delete board',
        denyLabel: 'Keep it',
        intent: 'destructive',
      };
    case 'tasks_delete_column':
      return {
        title: `Delete the column ${text(args.column) ? `“${text(args.column)}”` : ''}`.trim(),
        description: 'The column and every card in it are deleted. This cannot be undone.',
        metadata: [...row('Column', text(args.column))],
        confirmLabel: 'Delete column',
        denyLabel: 'Keep it',
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

const RSVP_ANSWERS: Record<string, string> = { yes: 'Yes', no: 'No', maybe: 'Maybe' };

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
