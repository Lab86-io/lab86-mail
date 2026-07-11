import { z } from 'zod';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { defineTool } from './registry';

export { TEACH_SYSTEM_PROMPT } from '@/lib/albatross/teach-prompt';

// Agent tool belt for the Teach conversation over the Albatross context graph
// (convex/albatross.ts). Trust model, enforced server-side and repeated in the
// tool descriptions: facts are candidates until the user explicitly confirms
// them; sensitive kinds can never be verified without a user confirmation ref;
// nothing is deleted — areas archive, facts supersede or reject.

const defaultDeps = {
  api: api as any,
  convexQuery,
  convexMutation,
  now: () => Date.now(),
};

let deps = defaultDeps;

export function __setAreaToolDepsForTest(overrides: Partial<typeof defaultDeps> = {}) {
  deps = { ...defaultDeps, ...overrides };
}

function areasApi() {
  return (deps.api as any).albatross;
}

function requireUserId(userId: string | null | undefined): string {
  if (!userId) throw new Error('Not authenticated.');
  return userId;
}

const sourceRefSchema = z.object({
  kind: z.string(),
  id: z.string(),
  label: z.string().optional(),
  accountId: z.string().optional(),
  url: z.string().optional(),
});

// The one place user confirmations are minted: the server stamps the ref so a
// model can never fabricate the timestamp or the confirming identity.
function teachConfirmationRef(userId: string, subject: string) {
  const ts = deps.now();
  return {
    kind: 'userConfirmation',
    id: `teach:${subject}:${ts}`,
    confirmedAt: ts,
    confirmedBy: userId,
    prompt: 'Confirmed in the Teach conversation',
  };
}

export const areaList = defineTool({
  name: 'area_list',
  description:
    "List the user's areas (parts of life: job, family, property, project) with per-area verified and candidate fact counts. Archived areas are history, not garbage — include them only when the user asks about the past.",
  category: 'memory',
  mutating: false,
  input: z.object({
    status: z.enum(['active', 'archived']).optional().describe('Default: all areas'),
  }),
  output: z.object({ areas: z.array(z.any()) }),
  async handler(args, ctx) {
    const areas = await deps.convexQuery<any[]>(areasApi().listAreasOverview, {
      userId: requireUserId(ctx.userId),
      ...(args.status ? { status: args.status } : {}),
    });
    return { areas };
  },
});

export const areaCreate = defineTool({
  name: 'area_create',
  description:
    "Create an area — one part of life the user is responsible for. Create it as soon as the user names it, then investigate (area_domain_activity, corpus_search, sender_profile) before proposing facts. On success the area is active, appears in the sidebar rail immediately, and has its own task board — confirm both using the user's actual Area name. Re-creating an existing or archived area revives it and reuses its board, never duplicates. If this tool errors, the area was NOT created; say so and retry instead of narrating success.",
  category: 'memory',
  mutating: true,
  input: z.object({
    name: z.string().min(1).max(120),
    kind: z
      .string()
      .max(80)
      .optional()
      .describe('Short category like job, family, property, project, community'),
    description: z.string().max(600).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    areaId: z.string(),
    name: z.string(),
    status: z.literal('active'),
    boardId: z.string().optional(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const areaId = await deps.convexMutation<string>(areasApi().createArea, {
      userId,
      name: args.name,
      kind: args.kind,
      description: args.description,
    });
    // The mutation also created (or revived) the area's task board; read the
    // linkage back so the chat can point at it truthfully. Best-effort — the
    // area exists even when this read fails.
    const area = await deps
      .convexQuery<any>(areasApi().getArea, { userId, areaId: String(areaId) })
      .catch(() => null);
    // Echo enough for the chat to confirm truthfully ("[Area] is in your
    // sidebar now, with its own task board") without a follow-up read.
    return {
      ok: true,
      areaId: String(areaId),
      name: args.name,
      status: 'active' as const,
      ...(area?.boardId ? { boardId: String(area.boardId) } : {}),
    };
  },
});

export const areaArchive = defineTool({
  name: 'area_archive',
  description:
    'Archive an area the user has left (quit the job, sold the house, ended the project). Archiving NEVER deletes — the area and its history remain. Confirm with the user first, and supersede its now-wrong facts via area_fact_set_status instead of deleting anything.',
  category: 'memory',
  mutating: true,
  input: z.object({
    areaId: z.string(),
    reason: z.string().max(500).optional().describe("Why it ended, in the user's words"),
  }),
  output: z.object({ ok: z.boolean() }),
  async handler(args, ctx) {
    await deps.convexMutation(areasApi().archiveArea, {
      userId: requireUserId(ctx.userId),
      areaId: args.areaId,
    });
    return { ok: true };
  },
});

export const areaAddFact = defineTool({
  name: 'area_add_fact',
  description:
    'Record one fact about an area (domain, email, person, role, note, …). Set confirmedByUser=true ONLY after the user explicitly said yes to THIS exact fact in the conversation — an explicit yes to this fact, not a general vibe, not silence, not a yes to a different fact. Everything else is a candidate the user can confirm later.',
  category: 'memory',
  mutating: true,
  input: z.object({
    areaId: z.string(),
    kind: z.string().min(1).max(80).describe('Fact kind: domain, email, person, role, organization, note, …'),
    value: z.string().min(1).max(1200),
    confirmedByUser: z
      .boolean()
      .describe('true ONLY after the user explicitly confirmed this exact fact in this conversation'),
    sourceRefs: z.array(sourceRefSchema).optional().describe('Evidence this fact came from'),
  }),
  output: z.object({ ok: z.boolean(), factId: z.string(), status: z.enum(['candidate', 'verified']) }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const status = args.confirmedByUser ? ('verified' as const) : ('candidate' as const);
    const factId = await deps.convexMutation<string>(areasApi().addAreaFact, {
      userId,
      areaId: args.areaId,
      kind: args.kind,
      value: args.value,
      status,
      sourceRefs: args.sourceRefs,
      ...(args.confirmedByUser
        ? { confirmationRefs: [teachConfirmationRef(userId, `fact:${args.kind}`)] }
        : {}),
    });
    return { ok: true, factId: String(factId), status };
  },
});

export const areaFactSetStatus = defineTool({
  name: 'area_fact_set_status',
  description:
    'Move one area fact to verified, rejected, or superseded. verified requires the user to have explicitly said yes to THIS fact in the conversation — same rule as area_add_fact. superseded is how wrong or outdated facts retire; nothing is ever deleted.',
  category: 'memory',
  mutating: true,
  input: z.object({
    factId: z.string(),
    status: z.enum(['verified', 'rejected', 'superseded']),
    reason: z.string().max(500).optional(),
  }),
  output: z.object({ ok: z.boolean() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    if (args.status === 'verified') {
      await deps.convexMutation(areasApi().verifyAreaFact, {
        userId,
        factId: args.factId,
        confirmationRefs: [teachConfirmationRef(userId, `verify:${args.factId}`)],
      });
      return { ok: true };
    }
    if (args.status === 'rejected') {
      await deps.convexMutation(areasApi().rejectAreaFact, {
        userId,
        factId: args.factId,
        reason: args.reason,
      });
      return { ok: true };
    }
    await deps.convexMutation(areasApi().supersedeAreaFact, {
      userId,
      factId: args.factId,
    });
    return { ok: true };
  },
});

export const areaDomainActivity = defineTool({
  name: 'area_domain_activity',
  description:
    "Investigate a domain or one sender against the local mail index: top senders with thread counts and recent subjects. Use this to ground Area questions in the user's real evidence. Provide domain OR senderEmail.",
  category: 'mail',
  mutating: false,
  input: z
    .object({
      domain: z.string().max(200).optional().describe("Bare domain from the user's connected data"),
      senderEmail: z.string().max(200).optional().describe('One full address'),
      max: z.number().int().min(1).max(25).default(10),
    })
    .refine((value) => Boolean(value.domain || value.senderEmail), {
      message: 'Provide domain or senderEmail',
    }),
  output: z.object({
    domain: z.string().nullable(),
    senderEmail: z.string().nullable(),
    threadsScanned: z.number(),
    threadsMatched: z.number(),
    senders: z.array(z.any()),
  }),
  async handler(args, ctx) {
    return await deps.convexQuery<any>(areasApi().domainActivity, {
      userId: requireUserId(ctx.userId),
      domain: args.domain,
      senderEmail: args.senderEmail,
      max: args.max,
    });
  },
});
