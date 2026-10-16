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
import { getAiRequestContext } from '../ai/context';
import { runSecureFetch } from '../secure/fetch';
import { SecureLeak, SecureNeedsAllow, SecureRefused, type SecureRunAccess } from '../secure/runner-access';
import { truncateText } from '../shared/text';
import { saveBrowserDownload } from '../web/file-pull';
import { type AgentBrowser, BrowserHandoffRequired, type PageView } from './browser-agent';
import {
  type ChecklistItem,
  checklistInputSchema,
  handoffItemsInputSchema,
  type RunSource,
  unsureInputSchema,
} from './goal-run-contract';
import {
  type GoalUpdateInput,
  goalUpdateInputSchema,
  sealedFileId,
  sourcesFromToolResult,
} from './goal-runs';
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
  // Passwords and IDs: what is saved, without values.
  'secure_details_list',
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
  'slack_search',
  'slack_read_thread',
  'atlassian_search',
  'jira_read_issue',
  'narrative_search',
  'narrative_read',
  // Goal runs only (GOAL_RUN_ONLY_TOOLS). A name that the registry does not
  // have yet is skipped, so these can ship before their tools do.
  'presentation_plan',
  'document_review_slides',
  'web_research',
  'web_file_save',
  'mail_attachment_save',
  'pdf_form_fields',
  'pdf_form_fill',
] as const;

/** Registry tools that only a goal run gets (docs/albatross-goal-runs.md). A step run keeps its old set. */
export const GOAL_RUN_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'presentation_plan',
  'document_review_slides',
  'web_research',
  'web_file_save',
  'mail_attachment_save',
  'pdf_form_fields',
  'pdf_form_fill',
]);

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
  kind: 'document' | 'draft' | 'event' | 'card' | 'approval' | 'page' | 'deck' | 'file';
  id?: string;
  title: string;
  url?: string;
  accountId?: string;
};

const OUTCOME_DESCRIPTION =
  'done: the step is complete and you have proof. ready_for_you: a draft, document, or approval waits for the user. your_turn: only the user can do the next part (sign in, sign, pay, call, visit). needs_answer: one fact only the user knows blocks you.';

const GOAL_OUTCOME_DESCRIPTION =
  'done: the outcome of the goal is true now and you have proof. ready_for_you: things you made wait for the user (drafts, documents, files, approvals). your_turn: only the user can do the next part (sign in, sign, pay, call, visit). needs_answer: facts or a choice that only the user has block you.';

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
  'allow_secure',
] as const;

export const handoffInputSchema = z.object({
  outcome: z.enum(['done', 'ready_for_you', 'your_turn', 'needs_answer']).describe(OUTCOME_DESCRIPTION),
  summary: z
    .string()
    .min(1)
    .max(600)
    .describe('What you did, in one to three short past-tense sentences. Plain words. No "AI".'),
  next: z
    .object({
      kind: z
        .enum(NEXT_KINDS)
        .describe(
          'allow_secure: only after a saved ID or date was not allowed on this site yet (browser_type answered needs_allow). The server fills in what is asked.',
        ),
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
      blanks: z
        .array(z.string().min(1).max(40))
        .max(6)
        .optional()
        .describe(
          'The empty fields the user fills in, by short name, in page order: for example ["hours for each week", "hourly rate", "invoice number"]. Only for fields in the draft, document, or form that you left empty for the user. Omit when nothing is left blank.',
        ),
      doneLabel: z
        .string()
        .max(32)
        .optional()
        .describe(
          'sign_in and finish_on_page only: the button the user presses after doing their part on the page, for example "I signed in" or "I paid". Default "Continue".',
        ),
      target: z
        .object({
          kind: z.enum([
            'draft',
            'document',
            'approval',
            'session',
            'question',
            'url',
            'card',
            'event',
            'secure',
          ]),
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
  // Goal runs (docs/albatross-goal-runs.md, G3): the package and the doubts.
  items: handoffItemsInputSchema.optional(),
  unsure: unsureInputSchema.optional(),
});
export type HandoffInput = z.infer<typeof handoffInputSchema>;

/** The handoff of a run on one step: no package (the old contract). */
export const stepHandoffInputSchema = handoffInputSchema.omit({ items: true, unsure: true });

/** The handoff of a goal run: the outcome is about the goal, and the package is part of it. */
export const goalHandoffInputSchema = handoffInputSchema.extend({
  outcome: z.enum(['done', 'ready_for_you', 'your_turn', 'needs_answer']).describe(GOAL_OUTCOME_DESCRIPTION),
});

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
  /** The run's access to Passwords and IDs, or null when the store is off for the user. */
  secure?: SecureRunAccess | null;
  /**
   * Stop the run at once and give the user the page: a value this run typed
   * showed on a page outside its sites (lib/secure/runner-access.ts SecureLeak).
   */
  stopForLeak?: (leak: SecureLeak) => void;
  /** A goal run (docs/albatross-goal-runs.md): the goal tools, the package, and the sources. */
  goal?: boolean;
  /** Goal runs: store the full checklist. Returns the clean list. */
  checklist?(items: Array<{ text: string; state: string }>): Promise<ChecklistItem[]>;
  /** Goal runs: change the outcome or the proofs of the Work's contract. */
  updateGoal?(update: GoalUpdateInput): Promise<{ ok: boolean; message?: string }>;
  /** Goal runs: what a finished tool call read, for the next run message. */
  sources?(sources: RunSource[]): void;
  /** Goal runs: a thing that an edit tool changed, so it goes into the package. */
  touch?(artifact: RunArtifact): Promise<void>;
  /** Goal runs: a filled PDF whose ID numbers stay sealed until send or download. */
  sealed?(fileId: string): void;
  /** The user's time zone: the dates in source details are the user's days. */
  timezone?: string;
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
    // Goal runs (docs/albatross-goal-runs.md).
    case 'goal_update':
      return str(args?.outcome)
        ? `Changed the goal: “${str(args.outcome, 90)}”.`
        : 'Changed what proves the goal.';
    case 'presentation_plan':
      return 'Planned the presentation.';
    case 'document_review_slides':
      return 'Checked the slides.';
    case 'web_research':
      return str(args?.question) ? `Researched “${str(args.question, 80)}”.` : 'Researched on the web.';
    case 'web_file_save': {
      const from = str(result?.sourceUrl || args?.url, 2_000);
      const name = str(result?.title || args?.name, 90);
      return `Saved ${name ? `“${name}”` : 'a file'}${from ? ` from ${hostOf(from)}` : ''}.`;
    }
    case 'mail_attachment_save': {
      const name = str(result?.title || args?.name, 90);
      return `Saved ${name ? `“${name}”` : 'an attachment'} from mail.`;
    }
    case 'pdf_form_fields':
      return 'Read the fields of the form.';
    case 'pdf_form_fill':
      return `Filled in ${str(result?.title || args?.title, 90) ? `“${str(result?.title || args?.title, 90)}”` : 'the form'}.`;
    case 'document_export':
      return result?.fileId ? `Made a PDF: “${str(result.title, 90) || 'document'}”.` : null;
    default:
      return null;
  }
}

/** The artifact of a saved file result (web_file_save, mail_attachment_save, pdf_form_fill, document_export as PDF). */
function fileArtifact(result: any): RunArtifact | null {
  if (!result?.fileId) return null;
  return {
    kind: 'file',
    id: String(result.fileId),
    title: str(result.title, 200) || 'File',
    ...(result.openPath ? { url: String(result.openPath) } : {}),
  };
}

/**
 * The artifact a finished tool call made, if any. A goal run also records a
 * deck as a deck (a step run keeps it as a document, as before).
 */
export function artifactFromToolResult(
  name: string,
  args: any,
  result: any,
  options: { goal?: boolean } = {},
): RunArtifact | null {
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
            kind:
              options.goal && name === 'document_create' && (result.kind || args?.kind) === 'deck'
                ? 'deck'
                : 'document',
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
    case 'web_file_save':
    case 'mail_attachment_save':
    case 'pdf_form_fill':
    case 'document_export':
      return fileArtifact(result);
    default:
      return null;
  }
}

/**
 * The thing an edit tool changed (goal runs): an earlier run's draft or
 * document that this run worked on goes into the package as well.
 */
export function touchedArtifact(name: string, args: any, result: any): RunArtifact | null {
  if (!result || result.ok === false) return null;
  switch (name) {
    case 'update_draft': {
      const id = str(args?.id, 300);
      return id ? { kind: 'draft', id, title: str(args?.patch?.subject, 200) || 'Draft' } : null;
    }
    case 'document_edit':
    case 'document_apply_instruction':
    case 'word_document_edit':
    case 'document_review_slides': {
      if (result.status && result.status !== 'applied') return null;
      const id = str(result.documentId || args?.documentId, 300);
      if (!id) return null;
      const deck = name === 'document_review_slides' || result.kind === 'deck';
      return {
        kind: deck ? 'deck' : 'document',
        id,
        title: str(result.title, 200) || (deck ? 'Presentation' : 'Document'),
        ...(result.openPath ? { url: String(result.openPath) } : {}),
      };
    }
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

function pageResultWith(view: PageView) {
  return { ...pageResult(view), ...(view.secure ? { secure: view.secure } : {}) };
}

/** The goal tools (docs/albatross-goal-runs.md): the checklist and the goal itself. */
function addGoalTools(tools: Record<string, any>, host: RunnerToolHost) {
  tools.checklist_set = aiTool({
    description:
      'Set your checklist for the goal: the full list, in order, each time. The user reads it in the thread. Mark the part you work on now as doing, and a part only the user can do as yours.',
    inputSchema: checklistInputSchema,
    execute: async ({ items }: { items: Array<{ text: string; state: string }> }) => {
      const saved = host.checklist ? await host.checklist(items) : [];
      return { ok: true, items: saved.length };
    },
  });
  tools.goal_update = aiTool({
    description:
      'Change what done means for this goal: the outcome sentence, or the full list of things that prove it. Use it only when the goal is wrong or vague, not for progress.',
    inputSchema: goalUpdateInputSchema,
    execute: async (input: GoalUpdateInput) => {
      if (!input.outcome && !input.proofs?.length)
        return { ok: false, message: 'Send outcome, proofs, or both.' };
      const result = host.updateGoal
        ? await host.updateGoal(input)
        : { ok: false, message: 'The goal cannot change now.' };
      if (result.ok) {
        const line = describeToolCall('goal_update', input, result);
        if (line) await host.log(line);
      }
      return result;
    },
  });
}

/**
 * The tool set of one run. `lifted` is the output of liftToolsForAgent for
 * this run; only the chosen registry tools are kept.
 */
export function buildRunnerTools(lifted: Record<string, any>, host: RunnerToolHost): Record<string, any> {
  const tools: Record<string, any> = {};
  const goal = host.goal === true;
  for (const name of RUNNER_REGISTRY_TOOLS) {
    if (!goal && GOAL_RUN_ONLY_TOOLS.has(name)) continue;
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
        const artifact = artifactFromToolResult(name, args, result, { goal });
        if (artifact) await host.artifact(artifact);
        if (goal) {
          const sources = sourcesFromToolResult(name, args, result, { timezone: host.timezone });
          if (sources.length) host.sources?.(sources);
          const touched = artifact ? null : touchedArtifact(name, args, result);
          if (touched) await host.touch?.(touched);
          const sealed = sealedFileId(name, result);
          if (sealed) host.sealed?.(sealed);
        }
        return result;
      },
    });
  }

  if (goal) addGoalTools(tools, host);
  else
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
    description: goal
      ? 'End the run. Call it exactly once, as your last call, with the outcome, what you did, every thing you made or changed (items), what the user must check (unsure), and the one main next action.'
      : 'End the run. Call it exactly once, as your last call, with the outcome, what you did, and the one next action for the user.',
    inputSchema: goal ? goalHandoffInputSchema : stepHandoffInputSchema,
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
      if (input.next?.kind === 'allow_secure' && !host.secure?.pendingAllow())
        return {
          ok: false,
          message:
            'allow_secure is only for a saved value that browser_type could not use on this site yet. Choose another next.kind.',
        };
      finished = true;
      host.finish(input);
      return { ok: true };
    },
  });

  if (!host.browserAvailable) return tools;

  let openBrowser: AgentBrowser | null = null;
  const pageAction =
    (status: (args: any) => string, act: (browser: AgentBrowser, args: any) => Promise<PageView>) =>
    async (args: any) => {
      try {
        const browser = await host.browser();
        openBrowser = browser;
        await host.browserStatus(status(args));
        return pageResultWith(await act(browser, args));
      } catch (error) {
        if (error instanceof SecureLeak) {
          host.stopForLeak?.(error);
          return { ok: false, status: 'stopped', message: error.message };
        }
        if (error instanceof SecureNeedsAllow)
          return { ok: false, status: 'needs_allow', message: error.message };
        if (error instanceof SecureRefused) return { ok: false, message: error.message };
        // A browser error or a handoff reason can quote the page; saved values never reach the model.
        const clean = async (text: string) =>
          openBrowser ? openBrowser.cleanMessage(text).catch(() => 'The page action failed.') : text;
        if (error instanceof BrowserHandoffRequired)
          return { ...handoffResult(error), message: truncateText(await clean(error.message), 500) };
        const message = error instanceof Error ? error.message : 'The page action failed.';
        return { ok: false, message: truncateText(await clean(message), 300) };
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
    description: host.secure
      ? 'Type text into the field with this ref. submit presses Enter, only in search-like fields. For a saved password, ID number, or date of birth, the text is exactly one reference: {{secure:<id>.<field>}} or {{secure:<id>.<field>|FORMAT}} (ids from secure_details_list). You never see the value; it goes in only on the sites it is saved for. Codes and card data are refused.'
      : 'Type text into the field with this ref. Never for passwords, codes, or card data (refused). submit presses Enter, only in search-like fields.',
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
    description: host.secure
      ? 'Choose options in the select element with this ref. A saved date part is one value: {{secure:<id>.date|MM}} (or M, MONTH, DD, D, YYYY).'
      : 'Choose options in the select element with this ref.',
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

  // browser_download (lib/web/file-pull.ts saveBrowserDownload): a file from
  // the shared browser into Files, through the Browserbase Downloads API.
  tools.browser_download = aiTool({
    description:
      "Save a file from the shared browser in the user's Files (the user's saved sign-ins apply): PDF, Word (DOCX), Excel (XLSX), PowerPoint (PPTX), CSV, PNG, or JPEG, max 25 MB. Pass ref for a download link or button in the latest snapshot, or url for a file address. With neither, it saves the file the current page shows. Returns fileId, title, size, contentType, sourceUrl, and sha256, not the contents.",
    inputSchema: z.object({
      ref: z.string().min(1).max(20).optional(),
      url: z.string().min(1).max(2000).optional(),
      name: z.string().max(120).optional().describe('The file name to show in Files.'),
    }),
    execute: async (args: { ref?: string; url?: string; name?: string }) => {
      try {
        const userId = getAiRequestContext().userId;
        if (!userId) return { ok: false, message: 'Sign in required to save a file.' };
        const browser = await host.browser();
        openBrowser = browser;
        await host.browserStatus('Saving a file');
        const saved = await saveBrowserDownload({ userId, browser, ...args });
        await host.artifact({ kind: 'file', id: saved.fileId, title: saved.title, url: saved.openPath });
        await host.log(
          `Saved ${truncateText(saved.title, 90)}${saved.sourceUrl ? ` from ${hostOf(saved.sourceUrl)}` : ''}.`,
        );
        return {
          ok: true,
          fileId: saved.fileId,
          title: saved.title,
          openPath: saved.openPath,
          size: saved.size,
          contentType: saved.contentType,
          ...(saved.sourceUrl ? { sourceUrl: saved.sourceUrl } : {}),
          sha256: saved.sha256,
        };
      } catch (error) {
        const clean = async (text: string) =>
          openBrowser ? openBrowser.cleanMessage(text).catch(() => 'The download failed.') : text;
        if (error instanceof BrowserHandoffRequired)
          return { ...handoffResult(error), message: truncateText(await clean(error.message), 500) };
        const message = error instanceof Error ? error.message : 'The download failed.';
        return { ok: false, message: truncateText(await clean(message), 300) };
      }
    },
  });
  return tools;
}

/** secure_fetch: added to a run when the user has Passwords and IDs. It needs no browser. */
export function addSecureFetchTool(tools: Record<string, any>, secure: SecureRunAccess | null | undefined) {
  if (!secure) return tools;
  tools.secure_fetch = aiTool({
    description:
      'Call an API with a saved key from Passwords and IDs. https only, GET or HEAD only, to a host the key is saved for, with no redirects. Put the key as one reference in a header value, for example { name: "Authorization", value: "Bearer {{secure:<id>.key}}" }. You never see the key. The answer is cut to 20 KB, with saved values removed.',
    inputSchema: z.object({
      url: z.string().min(1).max(2_000),
      method: z.enum(['GET', 'HEAD']).optional(),
      headers: z
        .array(z.object({ name: z.string().min(1).max(60), value: z.string().max(4_100) }))
        .max(10)
        .optional(),
    }),
    execute: async (args: {
      url: string;
      method?: 'GET' | 'HEAD';
      headers?: Array<{ name: string; value: string }>;
    }) =>
      runSecureFetch(
        {
          url: args.url,
          method: args.method,
          headers: Object.fromEntries((args.headers || []).map((header) => [header.name, header.value])),
        },
        secure,
      ),
  });
  return tools;
}
