/**
 * "UI tools": agent-callable actions that change the host UI, not the mailbox.
 * The server handler only acknowledges the call. The chat client reads the call
 * from the stream and runs the UI change (components/shell/AIBar.tsx).
 *
 * The acknowledgement comes before the client acts, so it never says that the
 * UI changed. When the client fails, the user sees a notice, and the next
 * request tells the model (lib/ai/ui-tool-calls.ts). A restored chat does not
 * run its old calls again.
 */
import { z } from 'zod';
import { defineTool } from './registry';

const ack = z.object({ acknowledged: z.literal(true), hint: z.string().optional() });

export const uiFocusThread = defineTool({
  name: 'ui_focus_thread',
  description:
    "Open and focus a specific thread in the user's reader pane. Call this after search_threads when you've identified the thread the user is asking about.",
  category: 'meta',
  mutating: false,
  input: z.object({
    threadId: z.string().describe('The provider thread id (from search_threads or get_thread).'),
    account: z.string().optional().describe('Override the active account, if needed.'),
  }),
  output: ack,
  async handler({ threadId }) {
    return { acknowledged: true as const, hint: `The app was asked to focus thread ${threadId}.` };
  },
});

export const uiSetQuery = defineTool({
  name: 'ui_set_query',
  description:
    "Set the inbox's search bar to a typed mail query. The UI will run the search and show matching threads. Use this to filter the visible inbox when the user asks 'show me emails from X'.",
  category: 'meta',
  mutating: false,
  input: z.object({
    query: z.string().describe('Mail search query (e.g. "from:tori kogler newer_than:60d").'),
    label: z.string().optional().describe("Short label for the mailbox heading, e.g. 'From Tori'."),
  }),
  output: ack,
  async handler({ query }) {
    return { acknowledged: true as const, hint: `The app was asked to run "${query}".` };
  },
});

export const uiOpenCompose = defineTool({
  name: 'ui_open_compose',
  description:
    'Open the inline compose pane in the UI, optionally pre-populated. Use when the user asks to write/draft/compose a new email. The user reviews and clicks Send themselves — never claim the message was sent.',
  category: 'meta',
  mutating: false,
  input: z.object({
    to: z.string().optional(),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
  }),
  output: ack,
  async handler() {
    return {
      acknowledged: true as const,
      hint: 'The app was asked to open the compose pane. The user reviews and sends.',
    };
  },
});

export const uiOpenReply = defineTool({
  name: 'ui_open_reply',
  description:
    "Open an inline reply composer on the user's currently-focused thread, optionally pre-populated. If you just found a thread, include threadId and account so the UI can focus it and open the reply in one action. The user reviews and clicks Send themselves.",
  category: 'meta',
  mutating: false,
  input: z.object({
    threadId: z.string().optional(),
    account: z.string().optional(),
    body: z.string().optional(),
  }),
  output: ack,
  async handler() {
    return { acknowledged: true as const };
  },
});

export const uiToast = defineTool({
  name: 'ui_toast',
  description:
    'Show a toast notification to the user. Use sparingly for important confirmations or warnings.',
  category: 'meta',
  mutating: false,
  input: z.object({
    message: z.string(),
    kind: z.enum(['info', 'success', 'warning', 'error']).optional(),
  }),
  output: ack,
  async handler() {
    return { acknowledged: true as const };
  },
});

export const uiCloseBar = defineTool({
  name: 'ui_close_bar',
  description:
    'Dismiss the AI bar overlay. Call this when the work is fully complete and the user should look at the page.',
  category: 'meta',
  mutating: false,
  input: z.object({}).optional(),
  output: ack,
  async handler() {
    return { acknowledged: true as const };
  },
});

export const uiSwitchAccount = defineTool({
  name: 'ui_switch_account',
  description: 'Switch the active account in the UI to a different connected mail account.',
  category: 'meta',
  mutating: false,
  input: z.object({ account: z.string() }),
  output: ack,
  async handler({ account }) {
    return { acknowledged: true as const, hint: `The app was asked to switch to ${account}.` };
  },
});
