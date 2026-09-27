import { z } from 'zod';
import { isConvexConfigured } from '../hosted/env';
import {
  deleteSavedReply,
  listSavedReplies,
  SAVED_REPLY_BODY_MAX,
  SAVED_REPLY_NAME_MAX,
  saveSavedReply,
} from '../mail/saved-replies';
import {
  defaultSignature,
  listSignatures as listStoredSignatures,
  SIGNATURE_HTML_MAX,
  SIGNATURE_TEXT_MAX,
  saveSignature,
} from '../mail/signature';
import { listNylasAccounts, resolveConnectedAccount } from '../nylas/provider';
import { defineTool } from './registry';

// Signatures and saved replies (FEATURES item 11). Web Settings, the
// composer, native clients, and the assistant all use these tools.

const SignatureOutput = z.object({
  accountId: z.string(),
  email: z.string().optional(),
  displayName: z.string().optional(),
  enabled: z.boolean(),
  text: z.string(),
  html: z.string().optional(),
  updatedAt: z.number(),
});

export const listSignaturesTool = defineTool({
  name: 'list_signatures',
  description: 'List the signature of each connected mailbox, and whether it is added to outgoing mail.',
  category: 'compose',
  mutating: false,
  input: z.object({}).optional(),
  output: z.object({ signatures: z.array(SignatureOutput) }),
  async handler(_args, ctx) {
    const [accounts, stored] = await Promise.all([
      listNylasAccounts(ctx.userId).catch(() => []),
      listStoredSignatures(),
    ]);
    const byAccount = new Map(stored.map((signature) => [signature.accountId, signature]));
    const connected = accounts.map((account) => ({
      ...(byAccount.get(account.accountId) ?? defaultSignature(account.accountId)),
      email: account.email,
      ...(account.displayName ? { displayName: account.displayName } : {}),
    }));
    // A mailbox that is not connected right now keeps its signature.
    const others = stored.filter(
      (signature) => !accounts.some((account) => account.accountId === signature.accountId),
    );
    return { signatures: [...connected, ...others] };
  },
});

export const setSignatureTool = defineTool({
  name: 'set_signature',
  description:
    'Set the signature for one mailbox. When enabled, it is added below new mail, replies, and forwards from that mailbox.',
  category: 'compose',
  mutating: true,
  risk: 'write_self',
  input: z.object({
    account: z.string(),
    enabled: z.boolean(),
    text: z.string().max(SIGNATURE_TEXT_MAX),
    html: z.string().max(SIGNATURE_HTML_MAX).optional(),
  }),
  output: z.object({ signature: SignatureOutput }),
  async handler({ account, enabled, text, html }, ctx) {
    let accountId = account;
    if (ctx.userId && isConvexConfigured()) {
      const row = await resolveConnectedAccount(ctx.userId, account);
      if (!row) throw new Error('No connected mailbox matches this account.');
      accountId = row.accountId;
    }
    const signature = await saveSignature({ accountId, enabled, text, html });
    return { signature };
  },
});

const SavedReplyOutput = z.object({
  id: z.string(),
  name: z.string(),
  body: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const listSavedRepliesTool = defineTool({
  name: 'list_saved_replies',
  description:
    "List the user's saved replies: named text snippets in their own words. Use one when it fits the reply the user wants, and adapt names and details to the thread.",
  category: 'compose',
  mutating: false,
  input: z.object({}).optional(),
  output: z.object({ replies: z.array(SavedReplyOutput) }),
  async handler() {
    return { replies: await listSavedReplies() };
  },
});

export const saveSavedReplyTool = defineTool({
  name: 'save_saved_reply',
  description: 'Create a saved reply, or update one by id.',
  category: 'compose',
  mutating: true,
  risk: 'write_self',
  input: z.object({
    id: z.string().optional(),
    name: z.string().max(SAVED_REPLY_NAME_MAX),
    body: z.string().max(SAVED_REPLY_BODY_MAX),
  }),
  output: z.object({ reply: SavedReplyOutput }),
  async handler(args) {
    return { reply: await saveSavedReply(args) };
  },
});

export const deleteSavedReplyTool = defineTool({
  name: 'delete_saved_reply',
  description: 'Delete a saved reply by id. Returns the deleted reply, so it can be saved again.',
  category: 'compose',
  mutating: true,
  risk: 'destructive',
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean(), deleted: z.boolean(), reply: SavedReplyOutput }),
  async handler({ id }) {
    const reply = await deleteSavedReply(id);
    if (!reply) throw new Error('Saved reply not found.');
    return { ok: true, deleted: true, reply };
  },
});
