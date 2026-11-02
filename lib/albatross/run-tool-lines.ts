// What a run says when a tool starts, in plain words. The row stays until the
// tool ends. Then the past-tense line of describeToolCall takes its place, or
// the row goes if the tool reports nothing. A tool with no entry stays quiet:
// it works on the run itself (the checklist, the handoff).

function clip(value: unknown, max = 80): string {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function hostOf(value: unknown): string {
  const raw = clip(value, 2_000);
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return raw;
  }
}

const quoted = (value: string) => `“${value}”`;

const FIXED_LINES: Record<string, string> = {
  get_thread: 'Reads a mail thread.',
  read_thread: 'Reads a mail thread.',
  get_message: 'Reads a mail.',
  thread_timeline: 'Reads the history of a mail thread.',
  summarize_thread: 'Reads a mail thread.',
  extract_action_items: 'Reads a mail thread.',
  sender_profile: 'Looks up a sender.',
  list_attachments: 'Looks at the attachments of a mail.',
  list_accounts: 'Looks at your mail accounts.',
  draft_reply: 'Writes a reply.',
  pre_send_critique: 'Checks the draft.',
  list_drafts: 'Looks at your drafts.',
  update_draft: 'Changes the draft.',
  recall: 'Looks at your notes.',
  list_memories: 'Looks at your notes.',
  remember: 'Saves a note for later.',
  personal_details_get: 'Looks at your saved details.',
  personal_details_save: 'Saves your details.',
  secure_details_list: 'Looks at what you saved in Passwords and IDs.',
  contact_lookup: 'Looks up a contact.',
  expand_alias: 'Looks up a contact.',
  calendar_list_calendars: 'Checks your calendar.',
  calendar_get_primary: 'Checks your calendar.',
  calendar_list_events: 'Checks your calendar.',
  calendar_search_events: 'Checks your calendar.',
  calendar_event_detail: 'Reads a calendar event.',
  calendar_free_busy: 'Checks your calendar.',
  calendar_suggest_times: 'Looks for free times.',
  tasks_list_boards: 'Looks at your tasks.',
  tasks_get_board: 'Looks at your tasks.',
  tasks_update_card: 'Changes a task.',
  tasks_add_comment: 'Adds a note to a task.',
  tasks_attach_link: 'Adds a link to a task.',
  albatross_get_work_context: 'Reads what is known about this work.',
  albatross_list_add: 'Adds to the list.',
  google_document_get: 'Reads a Google document.',
  google_file_import: 'Imports a Google file.',
  mcp_search: 'Searches your connected tools.',
  mcp_list_items: 'Reads your connected tools.',
  slack_search: 'Searches Slack.',
  slack_read_thread: 'Reads a Slack thread.',
  narrative_search: 'Reads your history.',
  narrative_read: 'Reads your history.',
  document_list: 'Looks at your documents.',
  document_get: 'Reads a document.',
  word_document_get: 'Reads a document.',
  document_edit: 'Changes the document.',
  document_apply_instruction: 'Changes the document.',
  word_document_edit: 'Changes the document.',
  document_export: 'Exports the document.',
  document_publish_google: 'Saves the document to Google Drive.',
  cloud_file_search: 'Searches your files.',
  browser_snapshot: 'Reads the page.',
  browser_click: 'Works on the page.',
  browser_type: 'Works on the page.',
  browser_select: 'Works on the page.',
  browser_press: 'Works on the page.',
  browser_back: 'Works on the page.',
  browser_wait: 'Waits for the page.',
  browser_download: 'Saves a file from the page.',
  presentation_plan: 'Plans the presentation.',
  document_review_slides: 'Checks the slides.',
  pdf_form_fields: 'Reads the fields of the form.',
  secure_fetch: 'Reads a site with your saved key.',
  jira_read_issue: 'Reads a Jira issue.',
  atlassian_search: 'Searches Jira and Confluence.',
  github_search: 'Searches GitHub.',
};

/** The present-tense row for a tool that starts, or null for a quiet tool. */
export function toolStartLine(name: string, args: any): string | null {
  switch (name) {
    case 'search_threads':
    case 'corpus_search':
    case 'content_search':
    case 'nl_search':
      return clip(args?.query)
        ? `Searches your mail for ${quoted(clip(args.query))}.`
        : 'Searches your mail.';
    case 'save_draft':
      return clip(args?.subject) ? `Saves a draft: ${quoted(clip(args.subject))}.` : 'Saves a draft.';
    case 'calendar_create_event':
      return clip(args?.title)
        ? `Adds a hold to your calendar: ${quoted(clip(args.title))}.`
        : 'Adds a hold to your calendar.';
    case 'calendar_rsvp_event':
      return 'Prepares your answer to the invite.';
    case 'tasks_create_card':
      return clip(args?.title) ? `Adds a task: ${quoted(clip(args.title))}.` : 'Adds a task.';
    case 'document_create':
    case 'word_document_create':
      return clip(args?.title) ? `Writes ${quoted(clip(args.title))}.` : 'Writes a document.';
    case 'browserbase_search':
      return clip(args?.query) ? `Searches the web for ${quoted(clip(args.query))}.` : 'Searches the web.';
    case 'browserbase_fetch':
      return clip(args?.url) ? `Reads ${hostOf(args.url)}.` : 'Reads a web page.';
    case 'browser_open':
      return clip(args?.url) ? `Opens ${hostOf(args.url)}.` : 'Opens a page.';
    case 'web_research':
      return clip(args?.question) ? `Researches ${quoted(clip(args.question))}.` : 'Researches on the web.';
    case 'web_file_save':
      return clip(args?.url) ? `Saves a file from ${hostOf(args.url)}.` : 'Saves a file.';
    case 'mail_attachment_save':
      return 'Saves an attachment from mail.';
    case 'pdf_form_fill':
      return 'Fills in the form.';
    default:
      return FIXED_LINES[name] ?? null;
  }
}
