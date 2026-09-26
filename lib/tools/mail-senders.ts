import { z } from 'zod';
import { api, convexQuery } from '../hosted/convex';
import { isConvexConfigured } from '../hosted/env';
import { blockSender } from '../mail/sender-block';
import type { SenderCleanupRow } from '../mail/sender-cleanup';
import { unsubscribeFromThread, unsubscribeTarget } from '../mail/unsubscribe';
import { emailFromHeader } from '../shared/format';
import { resolveThread } from '../store/threads';
import { defineTool } from './registry';

// Unsubscribe, block sender, and sender cleanup (FEATURES item 13).

function requireUser(userId: string | null | undefined) {
  if (!userId) throw new Error('Sign in required.');
  return userId;
}

const MethodSchema = z.enum(['one_click', 'mailto', 'link']);

export const getUnsubscribeOptions = defineTool({
  name: 'get_unsubscribe_options',
  description:
    "How this thread's sender lets the user unsubscribe: one_click (RFC 8058), mailto (an email from the user's mailbox), link (a web page the user opens), or none.",
  category: 'mail',
  mutating: false,
  input: z.object({ account: z.string(), threadId: z.string() }),
  output: z.object({
    sender: z.string(),
    senderEmail: z.string().nullable(),
    listId: z.string().nullable(),
    method: MethodSchema.nullable(),
    methods: z.array(MethodSchema),
    /** Where the request goes, for the confirmation: a host, an address, or a page. */
    destination: z.string().nullable(),
    url: z.string().optional(),
  }),
  async handler({ account, threadId }, ctx) {
    const target = await unsubscribeTarget({ userId: requireUser(ctx.userId), account, threadId });
    const methods: Array<z.infer<typeof MethodSchema>> = [];
    if (target.options.oneClickUrl) methods.push('one_click');
    if (target.options.mailto) methods.push('mailto');
    if (target.options.httpUrl) methods.push('link');
    const destination =
      target.method === 'one_click'
        ? new URL(target.options.oneClickUrl as string).hostname
        : target.method === 'mailto'
          ? (target.options.mailto?.to ?? null)
          : target.method === 'link'
            ? new URL(target.options.httpUrl as string).hostname
            : null;
    return {
      sender: target.sender,
      senderEmail: target.senderEmail,
      listId: target.listId,
      method: target.method,
      methods,
      destination,
      ...(target.options.httpUrl ? { url: target.options.httpUrl } : {}),
    };
  },
});

export const unsubscribeSender = defineTool({
  name: 'unsubscribe_sender',
  description:
    "Unsubscribe from this thread's mailing list. It cannot be undone, so the user must confirm first (confirmed: true). A link-only sender returns the page for the user to open.",
  category: 'mail',
  mutating: true,
  input: z.object({
    account: z.string(),
    threadId: z.string(),
    method: MethodSchema.optional(),
    confirmed: z.literal(true).describe('The user confirmed. An unsubscribe cannot be undone.'),
  }),
  output: z.object({
    ok: z.boolean(),
    status: z.enum(['unsubscribed', 'requested', 'open_link']),
    method: MethodSchema,
    sender: z.string(),
    to: z.string().optional(),
    url: z.string().optional(),
    operationId: z.string().optional(),
  }),
  async handler({ account, threadId, method }, ctx) {
    const result = await unsubscribeFromThread({
      userId: requireUser(ctx.userId),
      account,
      threadId,
      method,
      agent: ctx.agent,
      batchId: ctx.operationBatchId,
    });
    return { ok: true, ...result };
  },
});

export const blockSenderTool = defineTool({
  name: 'block_sender',
  description:
    'Block a sender: their mail goes to Noise from now on, and their threads in the inbox move to the archive. Shows in Activity with Undo. Pass the sender address, or a thread to block its sender.',
  category: 'mail',
  mutating: true,
  input: z
    .object({
      sender: z.string().optional(),
      account: z.string().optional(),
      threadId: z.string().optional(),
      archiveExisting: z.boolean().optional(),
      reason: z.string().max(300).optional(),
    })
    .refine((value) => Boolean(value.sender || (value.account && value.threadId)), {
      message: 'Pass a sender, or an account and threadId.',
    }),
  output: z.object({
    ok: z.boolean(),
    sender: z.string(),
    ruleId: z.string(),
    archived: z.number(),
    failed: z.number(),
    operationId: z.string().optional(),
  }),
  async handler({ sender, account, threadId, archiveExisting, reason }, ctx) {
    let address = sender ? emailFromHeader(sender) : null;
    if (!address && account && threadId) {
      const thread = await resolveThread(account, threadId);
      address = emailFromHeader(thread?.fromAddress);
    }
    if (!address) throw new Error('Could not find the sender address to block.');
    return await blockSender({
      userId: requireUser(ctx.userId),
      sender: address,
      archiveExisting,
      reason,
      agent: ctx.agent,
      batchId: ctx.operationBatchId,
    });
  },
});

export const listSenderCleanup = defineTool({
  name: 'list_sender_cleanup',
  description:
    'Rank the senders whose recent mail goes unread or was sorted as Noise or promotions, for a batch unsubscribe or block.',
  category: 'mail',
  mutating: false,
  input: z.object({ limit: z.number().int().min(1).max(100).optional() }).optional(),
  output: z.object({ senders: z.array(z.any()), scanned: z.number() }),
  async handler(input, ctx) {
    if (!isConvexConfigured()) return { senders: [] as SenderCleanupRow[], scanned: 0 };
    return await convexQuery<{ senders: SenderCleanupRow[]; scanned: number }>(
      (api as any).mailCorpus.senderCleanupCandidates,
      { userId: requireUser(ctx.userId), limit: input?.limit },
    );
  },
});
