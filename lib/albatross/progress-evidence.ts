import { z } from 'zod';

const sourceKinds = z.enum([
  'mail_thread',
  'calendar_event',
  'task',
  'area_fact',
  'github_issue',
  'github_pull_request',
  'github_project',
  'github_project_item',
  'github_commit',
  'mcp_item',
  'manual',
]);

/** Accept the source reference returned by search, but never guess its account. */
export const progressEvidenceSchema = z
  .object({
    sourceKind: sourceKinds,
    sourceId: z
      .string()
      .min(1)
      .max(500)
      .describe('Provider source ID, or mail:<accountId>:<threadId> from search.'),
    accountId: z
      .string()
      .min(1)
      .max(320)
      .optional()
      .describe('Required for mail unless sourceId is a composite mail reference.'),
    title: z.string().min(1).max(300),
    summary: z.string().max(1_200).optional(),
    claim: z.string().min(1).max(600).optional(),
    limits: z.string().max(600).optional(),
    url: z.string().max(2_000).optional(),
    connectionId: z.string().max(180).optional(),
    occurredAt: z.number().optional(),
    trust: z
      .enum(['observed', 'inferred'])
      .default('observed')
      .describe(
        'Source evidence only. Do not add the user report here: claim is recorded as confirmed by the server.',
      ),
  })
  .transform((row, ctx) => {
    if (row.sourceKind !== 'mail_thread') return row;
    const match = /^mail:([^:]+):(.+)$/.exec(row.sourceId);
    if (match) {
      if (row.accountId && row.accountId !== match[1]) {
        ctx.addIssue({
          code: 'custom',
          path: ['accountId'],
          message: 'Mail reference and accountId must identify the same account.',
        });
        return z.NEVER;
      }
      return { ...row, accountId: match[1], sourceId: match[2] };
    }
    if (!row.accountId) {
      ctx.addIssue({
        code: 'custom',
        path: ['accountId'],
        message:
          'Mail evidence requires accountId and the provider thread ID. Copy them from the source result.',
      });
      return z.NEVER;
    }
    return row;
  });
