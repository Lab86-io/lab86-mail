// The step runner's tools: a chosen part of the chat registry, the shared
// browser, and the one handoff tool that ends a run.
//
// The registry tools come from liftToolsForAgent, so they keep the chat's
// argument checks, timeouts, checkpointed writes (a retried attempt replays a
// write instead of doing it twice), and the standing-order pause. The runner
// has no person in front of it, so a call that needs approval never waits:
// a calendar invite or an RSVP becomes an approval in the queue, and the run
// hands it to the user.

import { tool as aiTool } from 'ai';
import { z } from 'zod';
import { approvalConditionMet } from '../ai/approval';
import { truncateText } from '../shared/text';
import { type AgentBrowser, BrowserHandoffRequired, type PageView } from './browser-agent';
import { formQuestionSchema } from './thread-contract';

/** Registry tools a step run may use. Nothing here sends mail, deletes, or reaches a person alone. */
export const RUNNER_REGISTRY_TOOLS = [
  // Mail: read, and write drafts the user sends.
  'list_accounts',
  'search_threads',
  'corpus_search',
  'content_search',
  'nl_search',
  'sender_profile',
  'thread_timeline',
  'get_thread',
  'read_thread',
  'get_message',
  'list_attachments',
  'summarize_thread',
  'extract_action_items',
  'draft_reply',
  'pre_send_critique',
  'list_drafts',
  'save_draft',
  'update_draft',
  // Memory and people.
  'recall',
  'list_memories',
  'remember',
  'personal_details_get',
  'personal_details_save',
  'contact_lookup',
  'expand_alias',
  // Calendar: read, private holds, and invites through approval.
  'calendar_list_calendars',
  'calendar_get_primary',
  'calendar_list_events',
  'calendar_search_events',
  'calendar_event_detail',
  'calendar_free_busy',
  'calendar_suggest_times',
  'calendar_create_event',
  'calendar_rsvp_event',
  // Tasks.
  'tasks_list_boards',
  'tasks_get_board',
  'tasks_create_card',
  'tasks_update_card',
  'tasks_add_comment',
  'tasks_attach_link',
  // The Work itself.
  'albatross_get_work_context',
  'albatross_list_add',
  // Documents and files.
  'document_create',
  'document_list',
  'document_get',
  'document_edit',
  'document_apply_instruction',
  'document_export',
  'document_publish_google',
  'spreadsheet_capabilities',
  'word_document_create',
  'word_document_get',
  'word_document_edit',
  'google_document_get',
  'cloud_file_search',
  'google_file_import',
  // Research.
  'browserbase_search',
  'browserbase_fetch',
  'mcp_search',
  'mcp_list_items',
  'github_search',
  'narrative_search',
  'narrative_read',
] as const;

/** Calls that the queue holds for the user instead of running. */
const QUEUED_FOR_APPROVAL: Record<
  string,
  { kind: 'calendar_invite' | 'calendar_rsvp'; title: (args: any) => string }
> = {
  calendar_create_event: {
    kind: 'calendar_invite',
    title: (args) => `Send the invite: ${truncateText(String(args?.title || args?.summary || 'event'), 160)}`,
  },
  calendar_rsvp_event: {
    kind: 'calendar_rsvp',
    title: (args) =>
      `Answer the invite: ${truncateText(String(args?.status || args?.response || 'reply'), 60)}`,
  },
};

export type RunArtifact = {
  kind: 'document' | 'draft' | 'event' | 'card' | 'approval' | 'page';
  id?: string;
  title: string;
  url?: string;
  accountId?: string;
};

const NEXT_KINDS = [
  'review_draft',
  'review_document',
  'approve',
  'sign_in',
  'finish_on_page',
  'answer',
  'do_offline',
  'review',
  'continue',
] as const;

export const handoffInputSchema = z.object({
  outcome: z
    .enum(['done', 'ready_for_you', 'your_turn', 'needs_answer'])
    .describe(
      'done: the step is complete and you have proof. ready_for_you: a draft, document, or approval waits for the user. your_turn: only the user can do the next part (sign in, sign, pay, call, visit). needs_answer: one fact only the user knows blocks you.',
    ),
  summary: z
    .string()
    .min(1)
    .max(600)
    .describe('What you did, in one to three short past-tense sentences. Plain words. No "AI".'),
  next: z
    .object({
      kind: z.enum(NEXT_KINDS),
      label: z
        .string()
        .min(1)
        .max(48)
        .describe('The button text: a short concrete verb phrase, for example "Read and send" or "Sign in".'),
      detail: z
        .string()
        .min(1)
        .max(500)
        .describe('What the user does next, and what you do after that. One or two sentences.'),
      doneLabel: z
        .string()
        .max(32)
        .optional()
        .describe(
          'sign_in and finish_on_page only: the button the user presses after doing their part on the page, for example "I signed in" or "I paid". Default "Continue".',
        ),
      target: z
        .object({
          kind: z.enum(['draft', 'document', 'approval', 'session', 'question', 'url', 'card', 'event']),
          id: z.string().max(300).optional(),
          url: z.string().max(2000).optional(),
          accountId: z.string().max(300).optional(),
        })
        .optional()
        .describe('What the button opens: the draft, document, approval, or page you made or used.'),
    })
    .optional()
    .describe('Required unless outcome is done.'),
  question: z
    .object({
      form: formQuestionSchema
        .optional()
        .describe(
          'Preferred: one form with typed fields. A choice that belongs to the user (dates, times, plans) with calendar notes, plus the missing personal details (detailKey), together.',
        ),
      prompt: z
        .string()
        .min(1)
        .max(400)
        .optional()
        .describe('Only for a single plain question without form.'),
      options: z
        .array(z.object({ id: z.string().min(1).max(60), label: z.string().min(1).max(120) }))
        .max(5)
        .optional(),
    })
    .optional()
    .describe('Required when outcome is needs_answer: a form (preferred), or one prompt with choices.'),
  evidence: z
    .string()
    .max(1500)
    .optional()
    .describe(
      'For done: what proves the step is complete (a confirmation number, the file you made, the page text).',
    ),
});
export type HandoffInput = z.infer<typeof handoffInputSchema>;

export interface RunnerToolHost {
  /** One line of the live log. */
  log(line: string): Promise<void>;
  artifact(artifact: RunArtifact): Promise<void>;
  /** The run's browser, opened on first use. */
  browser(): Promise<AgentBrowser>;
  /** What the agent does on the page now; shown in the live view. */
  browserStatus(detail: string): Promise<void>;
  enqueueApproval(input: {
    kind: 'calendar_invite' | 'calendar_rsvp';
    title: string;
    toolName: string;
    toolArgs: unknown;
  }): Promise<string>;
  /** Called once by step_handoff. */
  finish(handoff: HandoffInput): void;
  browserAvailable: boolean;
}

function str(value: unknown, max = 160): string {
  return typeof value === 'string' ? truncateText(value.replace(/\s+/g, ' ').trim(), max) : '';
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** One plain log line for a finished tool call, or null for a quiet read. */
export function describeToolCall(name: string, args: any, result: any): string | null {
  switch (name) {
    case 'search_threads':
    case 'corpus_search':
    case 'nl_search':
      return str(args?.query) ? `Searched your mail for “${str(args.query, 80)}”.` : 'Searched your mail.';
    case 'get_thread':
    case 'read_thread':
      return 'Read a mail thread.';
    case 'save_draft':
      return `Saved a draft${str(result?.draft?.subject || args?.subject) ? `: “${str(result?.draft?.subject || args?.subject, 90)}”` : ''}.`;
    case 'update_draft':
      return 'Changed the draft.';
    case 'calendar_create_event':
      return `Added a hold to your calendar${str(args?.title) ? `: “${str(args.title, 90)}”` : ''}.`;
    case 'calendar_list_events':
    case 'calendar_search_events':
    case 'calendar_free_busy':
    case 'calendar_suggest_times':
      return 'Checked your calendar.';
    case 'tasks_create_card':
      return `Added a task${str(args?.title) ? `: “${str(args.title, 90)}”` : ''}.`;
    case 'document_create':
    case 'word_document_create':
      return `Wrote “${str(result?.title || args?.title, 90) || 'a document'}”.`;
    case 'document_edit':
    case 'document_apply_instruction':
    case 'word_document_edit':
      return 'Changed the document.';
    case 'document_publish_google':
      return 'Saved the document to Google Drive.';
    case 'browserbase_search':
      return str(args?.query) ? `Searched the web for “${str(args.query, 80)}”.` : 'Searched the web.';
    case 'browserbase_fetch':
      return str(args?.url) ? `Read ${hostOf(String(args.url))}.` : 'Read a web page.';
    case 'cloud_file_search':
      return 'Searched your files.';
    case 'remember':
      return 'Saved a note for later.';
    default:
      return null;
  }
}

/** The artifact a finished tool call made, if any. */
export function artifactFromToolResult(name: string, args: any, result: any): RunArtifact | null {
  if (!result || result.ok === false) return null;
  switch (name) {
    case 'save_draft': {
      const draft = result.draft || {};
      const id = str(draft.id || draft._id, 300);
      return {
        kind: 'draft',
        ...(id ? { id } : {}),
        title: str(draft.subject || args?.subject, 200) || 'Draft',
        ...(str(draft.account || draft.accountId || args?.account, 300)
          ? { accountId: str(draft.account || draft.accountId || args?.account, 300) }
          : {}),
      };
    }
    case 'document_create':
    case 'word_document_create':
      return result.documentId
        ? {
            kind: 'document',
            id: String(result.documentId),
            title: str(result.title || args?.title, 200) || 'Document',
            ...(result.openPath ? { url: String(result.openPath) } : {}),
          }
        : null;
    case 'calendar_create_event':
      return result.eventId
        ? {
            kind: 'event',
            id: String(result.eventId),
            title: str(args?.title, 200) || 'Calendar hold',
            ...(result.htmlLink ? { url: String(result.htmlLink) } : {}),
            ...(str(args?.account, 300) ? { accountId: str(args.account, 300) } : {}),
          }
        : null;
    case 'tasks_create_card':
      return result.cardId
        ? { kind: 'card', id: String(result.cardId), title: str(args?.title, 200) || 'Task' }
        : null;
    default:
      return null;
  }
}

function pageResult(view: PageView) {
  return {
    ok: true,
    url: view.url,
    title: view.title,
    snapshot: view.snapshot,
    ...(view.truncated ? { truncated: true } : {}),
  };
}

function handoffResult(error: BrowserHandoffRequired) {
  return { ok: false, status: 'needs_user', reason: error.reason, message: error.message };
}

/**
 * The tool set of one run. `lifted` is the output of liftToolsForAgent for
 * this run; only the chosen registry tools are kept.
 */
export function buildRunnerTools(lifted: Record<string, any>, host: RunnerToolHost): Record<string, any> {
  const tools: Record<string, any> = {};
  for (const name of RUNNER_REGISTRY_TOOLS) {
    const base = lifted[name];
    if (!base?.execute) continue;
    const queued = QUEUED_FOR_APPROVAL[name];
    tools[name] = aiTool({
      description: base.description,
      inputSchema: base.inputSchema,
      execute: async (args: any, options?: any) => {
        if (queued && (name === 'calendar_rsvp_event' || approvalConditionMet(name, args))) {
          const approvalId = await host.enqueueApproval({
            kind: queued.kind,
            title: queued.title(args),
            toolName: name,
            toolArgs: args,
          });
          await host.artifact({ kind: 'approval', id: approvalId, title: queued.title(args) });
          await host.log(
            name === 'calendar_rsvp_event'
              ? 'Prepared your answer to the invite.'
              : 'Prepared the invite for your approval.',
          );
          return {
            ok: true,
            status: 'queued_for_approval',
            approvalId,
            message:
              'This reaches other people, so it waits for the user. Hand off with outcome ready_for_you, next.kind approve, and target { kind: "approval", id }.',
          };
        }
        const result = await base.execute(args, options);
        const line = describeToolCall(name, args, result);
        if (line) await host.log(line);
        const artifact = artifactFromToolResult(name, args, result);
        if (artifact) await host.artifact(artifact);
        return result;
      },
    });
  }

  tools.step_note = aiTool({
    description:
      'Add one short line to the live log the user sees, for a real milestone ("Found the dispute form."). Do not narrate every call.',
    inputSchema: z.object({ line: z.string().min(1).max(160) }),
    execute: async ({ line }: { line: string }) => {
      await host.log(line);
      return { ok: true };
    },
  });

  let finished = false;
  tools.step_handoff = aiTool({
    description:
      'End the run. Call it exactly once, as your last call, with the outcome, what you did, and the one next action for the user.',
    inputSchema: handoffInputSchema,
    execute: async (input: HandoffInput) => {
      if (finished) return { ok: false, message: 'The run already ended.' };
      if (input.outcome !== 'done' && !input.next)
        return {
          ok: false,
          message: 'next is required unless the outcome is done. Call step_handoff again.',
        };
      if (input.outcome === 'needs_answer' && !input.question?.form && !input.question?.prompt)
        return {
          ok: false,
          message:
            'question.form (or question.prompt) is required for needs_answer. Call step_handoff again.',
        };
      finished = true;
      host.finish(input);
      return { ok: true };
    },
  });

  if (!host.browserAvailable) return tools;

  const pageAction =
    (status: (args: any) => string, act: (browser: AgentBrowser, args: any) => Promise<PageView>) =>
    async (args: any) => {
      try {
        const browser = await host.browser();
        await host.browserStatus(status(args));
        return pageResult(await act(browser, args));
      } catch (error) {
        if (error instanceof BrowserHandoffRequired) return handoffResult(error);
        return {
          ok: false,
          message: error instanceof Error ? truncateText(error.message, 300) : 'The page action failed.',
        };
      }
    };

  tools.browser_open = aiTool({
    description:
      "Open a web page in the shared browser (the user's saved sign-ins apply). Returns the page snapshot with element refs. Use it for steps that happen on a website.",
    inputSchema: z.object({ url: z.string().min(1).max(2000) }),
    execute: async (args: { url: string }) => {
      const result = await pageAction(
        (input) => `Opening ${hostOf(input.url)}`,
        (browser, input) => browser.open(input.url),
      )(args);
      if ((result as any).ok) await host.log(`Opened ${hostOf((result as any).url || args.url)}.`);
      return result;
    },
  });
  tools.browser_snapshot = aiTool({
    description:
      'Read the current page again as an accessibility snapshot with element refs. Pass find (words) to read only matching lines on a long page.',
    inputSchema: z.object({ find: z.string().max(120).optional() }),
    execute: pageAction(
      () => 'Reading the page',
      (browser, input) => browser.snapshot(input.find),
    ),
  });
  tools.browser_click = aiTool({
    description:
      'Click the element with this ref from the latest snapshot. Controls that pay, buy, sign, accept terms, send, delete, or submit are refused: hand that page to the user.',
    inputSchema: z.object({ ref: z.string().min(1).max(20), why: z.string().max(120).optional() }),
    execute: pageAction(
      (input) => (input.why ? truncateText(String(input.why), 120) : 'Working on the page'),
      (browser, input) => browser.click(input.ref),
    ),
  });
  tools.browser_type = aiTool({
    description:
      'Type text into the field with this ref. Never for passwords, codes, or card data (refused). submit presses Enter, only in search-like fields.',
    inputSchema: z.object({
      ref: z.string().min(1).max(20),
      text: z.string().max(4000),
      submit: z.boolean().optional(),
    }),
    execute: pageAction(
      () => 'Filling in the form',
      (browser, input) => browser.type(input.ref, input.text, input.submit === true),
    ),
  });
  tools.browser_select = aiTool({
    description: 'Choose options in the select element with this ref.',
    inputSchema: z.object({
      ref: z.string().min(1).max(20),
      values: z.array(z.string().max(200)).min(1).max(10),
    }),
    execute: pageAction(
      () => 'Choosing an option',
      (browser, input) => browser.select(input.ref, input.values),
    ),
  });
  tools.browser_press = aiTool({
    description:
      'Press one navigation key: Tab, Shift+Tab, Escape, arrows, PageDown, PageUp, Home, End. To press a control, use browser_click.',
    inputSchema: z.object({ key: z.string().min(1).max(20) }),
    execute: pageAction(
      () => 'Working on the page',
      (browser, input) => browser.press(input.key),
    ),
  });
  tools.browser_back = aiTool({
    description: 'Go back one page.',
    inputSchema: z.object({}),
    execute: pageAction(
      () => 'Going back',
      (browser) => browser.back(),
    ),
  });
  tools.browser_wait = aiTool({
    description: 'Wait for the page to load or change (1 to 10 seconds), then read it again.',
    inputSchema: z.object({ seconds: z.number().min(1).max(10) }),
    execute: pageAction(
      () => 'Waiting for the page',
      (browser, input) => browser.wait(input.seconds),
    ),
  });
  return tools;
}
