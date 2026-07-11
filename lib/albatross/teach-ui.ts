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
  | 'notifications'
  | 'ai'
  | 'shortcuts'
  | 'account';

export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTabId; label: string }> = [
  { id: 'mailboxes', label: 'Mailboxes' },
  { id: 'connections', label: 'Connections' },
  { id: 'areas', label: 'Areas' },
  { id: 'sending', label: 'Sending' },
  { id: 'notifications', label: 'Notifications' },
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
// Human-in-the-loop tools — the calls that pause the stream for a user answer
// (rendered as forms; results returned via addToolResult).
// ---------------------------------------------------------------------------

export const HITL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'ask_user',
  'ask_approval',
  'ask_parameters',
  'ask_preferences',
  'ask_question_flow',
]);

export function isHitlToolName(name: string): boolean {
  return HITL_TOOL_NAMES.has(name);
}

// sendAutomaticallyWhen predicate shared by both chat surfaces: continue the
// run ONLY after the user answered a paused human-in-the-loop tool call.
export function lastMessageAnsweredHitl(messages: Array<{ role?: string; parts?: unknown[] }>): boolean {
  const last = messages[messages.length - 1] as { role?: string; parts?: any[] } | undefined;
  if (!last || last.role !== 'assistant') return false;
  return (last.parts || []).some(
    (part: any) => isHitlToolName(toolPartName(part)) && part?.state === 'output-available',
  );
}

// ---------------------------------------------------------------------------
// Multi-select helpers (ask_user option lists)
// ---------------------------------------------------------------------------

// Which option id was toggled between two selections (added wins over removed).
export function toggledOptionId(prev: string[], next: string[]): string | null {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  for (const id of next) if (!prevSet.has(id)) return id;
  for (const id of prev) if (!nextSet.has(id)) return id;
  return null;
}

// Shift-click range selection over an ordered option-id list: selects the
// inclusive span between the anchor (last plain click) and the clicked id,
// unioned with the previous selection. Falls back to the plain next selection
// when there is no valid anchor.
export function rangeSelection(
  orderedIds: string[],
  prevSelected: string[],
  clickedId: string | null,
  anchorId: string | null,
): string[] {
  if (!clickedId) return prevSelected;
  const clickedIndex = orderedIds.indexOf(clickedId);
  const anchorIndex = anchorId ? orderedIds.indexOf(anchorId) : -1;
  if (clickedIndex === -1 || anchorIndex === -1) {
    return prevSelected.includes(clickedId) ? prevSelected : [...prevSelected, clickedId];
  }
  const [from, to] = anchorIndex <= clickedIndex ? [anchorIndex, clickedIndex] : [clickedIndex, anchorIndex];
  const span = orderedIds.slice(from, to + 1);
  const union = new Set([...prevSelected, ...span]);
  // Preserve the on-screen order for a predictable answer string.
  return orderedIds.filter((id) => union.has(id));
}

// ---------------------------------------------------------------------------
// Tool activity grammar — ONE quiet sentence per tool call, shared by every
// chat surface (Teach + the floating assistant). Rendered by
// components/ai-elements/tool-activity.tsx.
// ---------------------------------------------------------------------------

export type ToolActivityState = 'running' | 'done' | 'failed';

export interface ToolActivity {
  state: ToolActivityState;
  text: string;
}

// Normalize an AI SDK tool-part state into the three states the activity row
// renders. Crucially, `output-available` with `{ ok: false }` is a FAILURE —
// tools that report application-level errors without throwing must never
// render as a quiet success (that's exactly how hallucinated writes hid).
export function toolActivityState(partState: unknown, output?: unknown): ToolActivityState {
  if (partState === 'output-error') return 'failed';
  if (partState === 'output-available') {
    if (output && typeof output === 'object' && (output as { ok?: unknown }).ok === false) return 'failed';
    return 'done';
  }
  return 'running';
}

// "area_domain_activity" → "area domain activity": unknown tools still get a
// readable line, never the raw underscored identifier.
export function humanToolName(toolName: string): string {
  const words = String(toolName || '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return words || 'a step';
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clip(value: string, max = 120): string {
  const line = value.split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function resultCount(output: unknown): number | null {
  const out = output as Record<string, unknown> | null | undefined;
  for (const key of ['items', 'threads', 'results', 'events', 'senders', 'areas', 'verdicts']) {
    const value = out?.[key];
    if (Array.isArray(value)) return value.length;
  }
  return null;
}

interface ToolSentences {
  running: string;
  done: string;
  failed: string;
}

type SentenceBuilder = (args: Record<string, unknown>, output: Record<string, unknown>) => ToolSentences;

const fixed =
  (running: string, done: string, failed: string): SentenceBuilder =>
  () => ({ running, done, failed });

function searchSentences(what: string, failed: string): SentenceBuilder {
  return (a, out) => {
    const q = str(a.query) || str(a.description);
    const n = resultCount(out);
    const scope = q ? ` for “${q}”` : '';
    return {
      running: `Searching ${what}${scope}`,
      done:
        n != null
          ? `Searched ${what}${scope} — ${n} result${n === 1 ? '' : 's'}`
          : `Searched ${what}${scope}`,
      failed,
    };
  };
}

// The full grammar: teach/area tools plus the general assistant's tools. Every
// entry is sentence case, concrete, and free of raw tool identifiers. Exported
// so tests can prove every sentence obeys the style rules.
export const TOOL_SENTENCES: Record<string, SentenceBuilder> = {
  // --- Teach / areas ---
  corpus_search: searchSentences('your mail', 'Mail search failed'),
  corpus_count: fixed('Counting matching mail', 'Counted the matching mail', 'Mail count failed'),
  thread_timeline: fixed(
    'Reading the thread history',
    'Read the thread history',
    'Reading the thread history failed',
  ),
  sender_profile: (a) => {
    const who = str(a.email);
    return {
      running: who ? `Looking up ${who}` : 'Looking up the sender',
      done: who ? `Looked up ${who}` : 'Looked up the sender',
      failed: 'Sender lookup failed',
    };
  },
  area_domain_activity: (a) => {
    const scope = str(a.domain) || str(a.senderEmail);
    return {
      running: scope ? `Checking recent senders for ${scope}` : 'Checking recent senders',
      done: scope ? `Checked recent senders for ${scope}` : 'Checked recent senders',
      failed: 'Checking recent senders failed',
    };
  },
  area_list: fixed('Checking saved areas', 'Checked saved areas', 'Checking saved areas failed'),
  area_create: (a, out) => {
    const name = str(a.name) || str(out.name);
    return {
      running: name ? `Creating area ${name}` : 'Creating the area',
      done: name ? `Created area ${name}` : 'Created the area',
      failed: name ? `Creating area ${name} failed` : 'Creating the area failed',
    };
  },
  area_archive: (a) => {
    const reason = str(a.reason);
    return {
      running: 'Archiving the area',
      done: reason ? `Area archived — ${reason}` : 'Area archived — history kept',
      failed: 'Archiving the area failed',
    };
  },
  area_add_fact: (a, out) => {
    const value = str(a.value);
    const verified = out.status === 'verified' || (out.status == null && a.confirmedByUser === true);
    return {
      running: value ? `Recording ${clip(value, 80)}` : 'Recording a fact',
      done: verified ? 'Recorded fact — verified' : 'Recorded fact — to confirm',
      failed: 'Recording the fact failed',
    };
  },
  area_fact_set_status: (a) => {
    const status = str(a.status);
    if (status === 'verified')
      return { running: 'Verifying the fact', done: 'Fact verified', failed: 'Verifying the fact failed' };
    if (status === 'rejected')
      return { running: 'Rejecting the fact', done: 'Fact rejected', failed: 'Rejecting the fact failed' };
    if (status === 'superseded')
      return { running: 'Retiring the fact', done: 'Fact superseded', failed: 'Retiring the fact failed' };
    return { running: 'Updating the fact', done: 'Fact updated', failed: 'Updating the fact failed' };
  },
  salvage_context: fixed(
    'Recovering earlier context',
    'Recovered earlier context',
    'Recovering earlier context failed',
  ),
  // ask_* tools render as their own forms; these lines only cover transcripts
  // where the form is not shown (e.g. streamed input).
  ask_user: fixed('Asking you a question', 'You answered', 'The question failed'),
  ask_approval: fixed('Waiting for your approval', 'You decided', 'The approval failed'),
  ask_parameters: fixed('Waiting for your numbers', 'You set the values', 'The parameter form failed'),
  ask_preferences: fixed(
    'Waiting for your preferences',
    'You set your preferences',
    'The preferences form failed',
  ),
  ask_question_flow: fixed(
    'Walking you through the steps',
    'You finished the steps',
    'The guided steps failed',
  ),

  // --- Display tools (rich cards render on success; these cover running/failed) ---
  show_weather: (a) => {
    const place = str(a.place);
    return {
      running: place ? `Checking the weather in ${place}` : 'Checking the weather',
      done: place ? `Fetched the weather for ${place}` : 'Fetched the weather',
      failed: 'Weather lookup failed',
    };
  },
  show_chart: (a) => {
    const title = str(a.title);
    return {
      running: title ? `Drawing “${clip(title, 60)}”` : 'Drawing a chart',
      done: title ? `Drew “${clip(title, 60)}”` : 'Drew the chart',
      failed: 'Drawing the chart failed',
    };
  },
  show_stats: fixed('Laying out the numbers', 'Laid out the numbers', 'Laying out the numbers failed'),
  show_table: fixed('Building the table', 'Built the table', 'Building the table failed'),
  show_code: fixed('Formatting the code', 'Formatted the code', 'Formatting the code failed'),
  show_code_diff: fixed('Building the diff', 'Built the diff', 'Building the diff failed'),
  show_terminal: fixed('Formatting the output', 'Formatted the output', 'Formatting the output failed'),
  show_plan: fixed('Laying out the plan', 'Laid out the plan', 'Laying out the plan failed'),
  show_progress: fixed(
    'Summarizing the progress',
    'Summarized the progress',
    'Summarizing the progress failed',
  ),
  show_citations: fixed('Collecting the sources', 'Collected the sources', 'Collecting the sources failed'),
  show_link_preview: fixed('Previewing the link', 'Previewed the link', 'Previewing the link failed'),
  show_image: fixed('Preparing the image', 'Showed the image', 'Preparing the image failed'),
  show_image_gallery: fixed('Preparing the gallery', 'Showed the gallery', 'Preparing the gallery failed'),
  show_video: fixed('Preparing the video', 'Showed the video', 'Preparing the video failed'),
  show_audio: fixed('Preparing the audio', 'Showed the audio', 'Preparing the audio failed'),
  show_map: fixed('Placing the map markers', 'Placed the map markers', 'Placing the map markers failed'),
  show_carousel: fixed(
    'Laying out the collection',
    'Laid out the collection',
    'Laying out the collection failed',
  ),
  show_order_summary: fixed('Itemizing the order', 'Itemized the order', 'Itemizing the order failed'),
  show_social_post: fixed('Rendering the post', 'Rendered the post', 'Rendering the post failed'),
  show_message_draft: fixed(
    'Preparing the draft',
    'Prepared the draft for review',
    'Preparing the draft failed',
  ),

  // --- Mail reads ---
  search_threads: searchSentences('your mail', 'Mail search failed'),
  nl_search: searchSentences('your mail', 'Mail search failed'),
  get_thread: fixed('Loading the thread', 'Read the thread', 'Loading the thread failed'),
  get_message: fixed('Loading the message', 'Read the message', 'Loading the message failed'),
  recent_threads: fixed('Loading recent threads', 'Loaded recent threads', 'Loading recent threads failed'),
  list_account_threads: fixed('Loading the mailbox', 'Loaded the mailbox', 'Loading the mailbox failed'),
  list_accounts: fixed(
    'Checking connected accounts',
    'Checked your connected accounts',
    'Checking accounts failed',
  ),
  list_labels: fixed('Listing your labels', 'Listed your labels', 'Listing labels failed'),
  list_attachments: fixed('Listing attachments', 'Listed the attachments', 'Listing attachments failed'),

  // --- Mail mutations ---
  archive_thread: fixed('Archiving the thread', 'Archived the thread', 'Archiving the thread failed'),
  trash_thread: fixed('Moving the thread to trash', 'Moved the thread to trash', 'Moving to trash failed'),
  restore_from_trash: fixed('Restoring from trash', 'Restored from trash', 'Restoring from trash failed'),
  mark_read: fixed('Marking as read', 'Marked as read', 'Marking as read failed'),
  mark_unread: fixed('Marking as unread', 'Marked as unread', 'Marking as unread failed'),
  star: fixed('Starring the thread', 'Starred the thread', 'Starring the thread failed'),
  unstar: fixed('Unstarring the thread', 'Unstarred the thread', 'Unstarring the thread failed'),
  add_label: (a) => {
    const label = str(a.label);
    return {
      running: label ? `Adding the “${label}” label` : 'Adding a label',
      done: label ? `Added the “${label}” label` : 'Added a label',
      failed: label ? `Adding the “${label}” label failed` : 'Adding the label failed',
    };
  },
  remove_label: (a) => {
    const label = str(a.label);
    return {
      running: label ? `Removing the “${label}” label` : 'Removing a label',
      done: label ? `Removed the “${label}” label` : 'Removed a label',
      failed: 'Removing the label failed',
    };
  },
  create_label: (a) => {
    const name = str(a.name) || str(a.label);
    return {
      running: name ? `Creating the “${name}” label` : 'Creating a label',
      done: name ? `Created the “${name}” label` : 'Created a label',
      failed: 'Creating the label failed',
    };
  },
  mute_thread: fixed('Muting the thread', 'Muted the thread', 'Muting the thread failed'),
  snooze_thread: (a) => {
    const until = Number.isFinite(a.untilTs) ? new Date(Number(a.untilTs)).toLocaleString() : '';
    return {
      running: 'Snoozing the thread',
      done: until ? `Snoozed until ${until}` : 'Snoozed the thread',
      failed: 'Snoozing the thread failed',
    };
  },
  unsnooze_thread: fixed('Unsnoozing the thread', 'Unsnoozed the thread', 'Unsnoozing the thread failed'),

  // --- Compose / send ---
  save_draft: fixed('Saving the draft', 'Saved the draft', 'Saving the draft failed'),
  update_draft: fixed('Updating the draft', 'Updated the draft', 'Updating the draft failed'),
  delete_draft: fixed('Deleting the draft', 'Deleted the draft', 'Deleting the draft failed'),
  list_drafts: fixed('Listing your drafts', 'Listed your drafts', 'Listing drafts failed'),
  send_message: composeSentences('Sending the message'),
  reply: composeSentences('Writing the reply'),
  reply_all: composeSentences('Writing the reply to everyone'),
  forward: composeSentences('Forwarding the message'),
  schedule_send: fixed('Scheduling the send', 'Scheduled the send', 'Scheduling the send failed'),
  cancel_scheduled: fixed(
    'Canceling the scheduled send',
    'Canceled the scheduled send',
    'Canceling the scheduled send failed',
  ),
  undo_send: fixed('Undoing the send', 'Undid the send', 'Undoing the send failed'),

  // --- AI over mail ---
  summarize_thread: fixed('Summarizing the thread', 'Summarized the thread', 'Summarizing failed'),
  triage_thread: (_a, out) => ({
    running: 'Triaging the thread',
    done: str(out.reason) ? `Triaged — ${clip(str(out.reason))}` : 'Triaged the thread',
    failed: 'Triaging the thread failed',
  }),
  draft_reply: fixed('Drafting a reply', 'Drafted a reply for your review', 'Drafting the reply failed'),
  bulk_triage: fixed('Triaging the batch', 'Triaged the batch', 'Triaging the batch failed'),
  extract_action_items: fixed(
    'Pulling out action items',
    'Pulled out the action items',
    'Pulling action items failed',
  ),
  translate_thread: fixed('Translating the thread', 'Translated the thread', 'Translating failed'),
  pre_send_critique: fixed('Reviewing the draft', 'Reviewed the draft', 'Reviewing the draft failed'),
  classify_threads: fixed(
    'Re-checking smart categories',
    'Re-checked smart categories',
    'Re-checking smart categories failed',
  ),

  // --- Memory ---
  remember: (a) => {
    const who = str(a.email);
    return {
      running: who ? `Saving a note about ${who}` : 'Saving a note',
      done: who ? `Saved a note about ${who}` : 'Saved a note',
      failed: 'Saving the note failed',
    };
  },
  recall: (a) => {
    const who = str(a.email);
    return {
      running: who ? `Recalling notes about ${who}` : 'Recalling notes',
      done: who ? `Recalled notes about ${who}` : 'Recalled my notes',
      failed: 'Recalling notes failed',
    };
  },
  forget: fixed('Forgetting that note', 'Forgot that note', 'Forgetting the note failed'),
  list_memories: fixed('Listing saved notes', 'Listed the saved notes', 'Listing notes failed'),

  // --- Calendar ---
  calendar_free_busy: fixed(
    'Checking your availability',
    'Checked your calendar availability',
    'Checking availability failed',
  ),
  calendar_suggest_times: fixed(
    'Suggesting meeting times',
    'Suggested some meeting times',
    'Suggesting times failed',
  ),
  calendar_create_event: (a) => {
    const title = str(a.title);
    return {
      running: title ? `Creating the event “${title}”` : 'Creating a calendar event',
      done: title ? `Created the event “${title}”` : 'Created a calendar event',
      failed: 'Creating the event failed',
    };
  },
  calendar_list_events: (_a, out) => {
    const n = Array.isArray(out.events) ? out.events.length : null;
    return {
      running: 'Checking your calendar',
      done: n != null ? `Found ${n} calendar event${n === 1 ? '' : 's'}` : 'Listed your calendar events',
      failed: 'Checking the calendar failed',
    };
  },
  calendar_update_event: fixed('Updating the event', 'Updated the event', 'Updating the event failed'),
  calendar_delete_event: fixed('Deleting the event', 'Deleted the event', 'Deleting the event failed'),
  calendar_delete_recurring_series: fixed(
    'Deleting the recurring series',
    'Deleted the recurring series',
    'Deleting the series failed',
  ),
  calendar_unsubscribe_calendar: fixed(
    'Unsubscribing the calendar',
    'Unsubscribed the calendar',
    'Unsubscribing the calendar failed',
  ),

  // --- Tasks ---
  tasks_list_boards: fixed('Listing your boards', 'Listed your boards', 'Listing boards failed'),
  tasks_get_board: fixed('Loading the board', 'Loaded the board', 'Loading the board failed'),
  tasks_create_board: fixed('Creating the board', 'Created the board', 'Creating the board failed'),
  tasks_create_card: (a) => {
    const title = str(a.title);
    return {
      running: title ? `Creating task “${title}”` : 'Creating a task',
      done: title ? `Created task “${title}”` : 'Created a task',
      failed: 'Creating the task failed',
    };
  },
  tasks_update_card: (a, out) => {
    const card = (out.card || {}) as Record<string, unknown>;
    const title = str(card.title) || str(a.title) || 'the task';
    const column = str(card.columnName);
    return {
      running: 'Updating the task',
      done:
        a.completed === true && column
          ? `Marked “${title}” complete in ${column}`
          : column
            ? `Updated “${title}” in ${column}`
            : 'Updated the task',
      failed: 'Updating the task failed',
    };
  },
  tasks_move_card: (a, out) => {
    const card = (out.card || {}) as Record<string, unknown>;
    const column = str(card.columnName) || str(a.column);
    return {
      running: 'Moving the task',
      done: out.noOp
        ? `Task already in ${column || 'that column'}`
        : column
          ? `Moved the task to ${column}`
          : 'Moved the task',
      failed: 'Moving the task failed',
    };
  },
  tasks_delete_card: fixed('Deleting the task', 'Deleted the task', 'Deleting the task failed'),
  tasks_attach_link: (a) => {
    const url = str(a.url);
    return {
      running: 'Attaching a link to the task',
      done: url ? `Attached ${clip(url, 80)} to the task` : 'Attached a link to the task',
      failed: 'Attaching the link failed',
    };
  },
  tasks_attach_file: (_a, out) => {
    const name = str(out.name);
    return {
      running: 'Attaching a file to the task',
      done: name ? `Attached ${name} to the task` : 'Attached a file to the task',
      failed: 'Attaching the file failed',
    };
  },
  tasks_attach_calendar_event_link: (_a, out) => {
    const name = str(out.name);
    return {
      running: 'Attaching a calendar link to the task',
      done: name ? `Attached calendar link “${name}” to the task` : 'Attached a calendar link to the task',
      failed: 'Attaching the calendar link failed',
    };
  },

  // --- Contacts / web / audit ---
  contact_lookup: fixed('Looking up the contact', 'Looked up the contact', 'Contact lookup failed'),
  expand_alias: fixed('Expanding the alias', 'Expanded the alias', 'Expanding the alias failed'),
  browserbase_search: (a) => {
    const q = str(a.query);
    return {
      running: q ? `Searching the web for “${q}”` : 'Searching the web',
      done: q ? `Searched the web for “${q}”` : 'Searched the web',
      failed: 'Web search failed',
    };
  },
  browserbase_fetch: (a) => {
    const url = str(a.url);
    return {
      running: url ? `Reading ${clip(url, 80)}` : 'Fetching a web page',
      done: url ? `Read ${clip(url, 80)}` : 'Read a web page',
      failed: 'Reading the page failed',
    };
  },
  log_action: fixed('Logging the action', 'Logged the action', 'Logging the action failed'),
  list_audit: fixed('Checking the audit log', 'Checked the audit log', 'Checking the audit log failed'),

  // --- UI actions ---
  ui_focus_thread: fixed(
    'Opening the thread',
    'Opened that thread in your reader',
    'Opening the thread failed',
  ),
  ui_set_query: (a) => {
    const q = str(a.query);
    return {
      running: 'Filtering your inbox',
      done: q ? `Filtered your inbox to “${q}”` : 'Filtered your inbox',
      failed: 'Filtering the inbox failed',
    };
  },
  ui_open_compose: (a) => {
    const to = str(a.to);
    return {
      running: 'Opening the composer',
      done: to ? `Opened the composer to ${to}` : 'Opened the composer',
      failed: 'Opening the composer failed',
    };
  },
  ui_open_reply: fixed('Opening a reply', 'Opened a reply for you to review', 'Opening the reply failed'),
  ui_toast: fixed('Sending a notification', 'Notified you', 'Sending the notification failed'),
  ui_close_bar: fixed('Closing the assistant', 'Closed the assistant', 'Closing the assistant failed'),
  ui_switch_account: (a) => {
    const account = str(a.account);
    return {
      running: account ? `Switching to ${account}` : 'Switching accounts',
      done: account ? `Switched to ${account}` : 'Switched accounts',
      failed: 'Switching accounts failed',
    };
  },
};

function composeSentences(running: string): SentenceBuilder {
  return (a) => {
    const to = str(a.to);
    return {
      running,
      done: to ? `Prepared a message to ${to} for your review` : 'Prepared a message for your review',
      failed: `${running} failed`,
    };
  };
}

function genericSentences(toolName: string, output: Record<string, unknown>): ToolSentences {
  const human = humanToolName(toolName);
  const n = resultCount(output);
  const capitalized = human.charAt(0).toUpperCase() + human.slice(1);
  return {
    running: `Running ${human}`,
    done: n != null ? `Finished ${human} — ${n} result${n === 1 ? '' : 's'}` : `Finished ${human}`,
    failed: `${capitalized} failed`,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function failureDetail(result: unknown, errorText: string | undefined): string {
  const fromError = str(errorText);
  if (fromError) return clip(fromError);
  const out = asRecord(result);
  const fromOutput = str(out.error) || str(out.message);
  return fromOutput ? clip(fromOutput) : '';
}

// The one activity sentence for a tool call, in every chat surface.
// `state` accepts the raw AI SDK part state ('input-streaming',
// 'input-available', 'output-available', 'output-error').
export function toolActivityLine(
  toolName: string,
  args: unknown,
  state: string,
  result?: unknown,
  errorText?: string,
): ToolActivity {
  const normalized = toolActivityState(state, result);
  const name = str(toolName) || 'tool';
  let sentences: ToolSentences;
  try {
    const builder = TOOL_SENTENCES[name];
    sentences = builder
      ? builder(asRecord(args), asRecord(result))
      : genericSentences(name, asRecord(result));
  } catch {
    // Grammar must never take the chat down over garbage args/output.
    sentences = genericSentences(name, {});
  }
  if (normalized === 'running') return { state: 'running', text: `${sentences.running}…` };
  if (normalized === 'done') return { state: 'done', text: sentences.done };
  const detail = failureDetail(result, errorText);
  return { state: 'failed', text: detail ? `${sentences.failed} — ${detail}` : sentences.failed };
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

// One quiet line per recorded change ("Area created", "Verified: …").
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
