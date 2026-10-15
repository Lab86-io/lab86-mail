import { z } from 'zod';

export const UPDATE_SUMMARY_THRESHOLD = 3;

const changeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  kind: z.enum(['new', 'improved', 'fixed']),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
});

const screenshotSchema = z
  .object({
    caption: z.string().trim().min(1),
    image: z.string().regex(/^\/updates\/[a-zA-Z0-9][a-zA-Z0-9_/-]*\.(png|jpe?g|webp|avif)$/),
    alt: z.string().trim().min(1),
    width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096),
  })
  .strict();

const htmlPreviewSchema = z
  .object({
    caption: z.string().trim().min(1),
    html: z.string().trim().min(1).max(40_000),
    interactive: z.boolean().optional(),
  })
  .strict();

const updateSummarySchema = z
  .object({
    text: z.string().trim().min(1),
    demo: htmlPreviewSchema.omit({ interactive: true }),
  })
  .strict();

export const productUpdateSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    publishedAt: z.iso.date(),
    version: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1),
    summary: updateSummarySchema.optional(),
    changes: z.array(changeSchema).min(1),
    preview: z.union([htmlPreviewSchema, screenshotSchema]).optional(),
  })
  .superRefine((update, context) => {
    if (update.changes.length > UPDATE_SUMMARY_THRESHOLD && !update.summary) {
      context.addIssue({
        code: 'custom',
        path: ['summary'],
        message: 'Batches over 3 changes need a summary with its own HTML demo.',
      });
    }
    if (new Set(update.changes.map((change) => change.id)).size !== update.changes.length) {
      context.addIssue({
        code: 'custom',
        path: ['changes'],
        message: 'Change IDs must be unique in a batch.',
      });
    }
  });

export type ProductUpdate = z.infer<typeof productUpdateSchema>;

export function parseProductUpdates(input: unknown): ProductUpdate[] {
  const updates = z.array(productUpdateSchema).parse(input);
  if (new Set(updates.map((update) => update.id)).size !== updates.length) {
    throw new Error('Update IDs must be unique.');
  }
  return updates.sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
}

export function shouldSummarizeUpdate(update: Pick<ProductUpdate, 'changes'>): boolean {
  return update.changes.length > UPDATE_SUMMARY_THRESHOLD;
}

export function formatUpdateDate(date: string): string {
  // Release dates are calendar dates, independent of the reader's time zone.
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}
