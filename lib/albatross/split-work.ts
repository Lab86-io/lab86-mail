import { z } from 'zod';
import { generateTextForCurrentUser } from '@/lib/ai/gateway';
import { contentSlug, uniqueExternalId } from '@/lib/albatross/tomorrow-split';
import { advanceWork } from '@/lib/albatross/work-orchestrator';
import { WORK_SHAPE_GUIDE, WORK_SHAPES } from '@/lib/albatross/work-shape';
import { preserveCaptureText } from '@/lib/albatross/work-v2';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';

/**
 * Split one existing Work into independent sibling Works. A blob like "book a
 * massage, get new sheets, reserve dinner" defeats every verification layer at
 * once: its proofs are a grab bag and its evidence dilutes. The affordance is
 * permanent: it also lifts an oversized step out of a plan into its own Work.
 *
 * A split never merges and never deletes. Children are created first; the
 * parent is then released with a provenance record. On any failure the parent
 * stays open.
 */

export interface SplitWorkChild {
  title: string;
  rawText: string;
  shape?: (typeof WORK_SHAPES)[number];
}

export const workSplitProposalSchema = z.object({
  work: z
    .array(
      z.object({
        title: z.string().min(1).max(180),
        rawText: z.string().min(1).max(20_000),
        shape: z.enum(WORK_SHAPES).optional().catch(undefined),
      }),
    )
    .min(2)
    .max(6),
});

const SPLIT_WORK_SYSTEM = `You split one existing Work into independent desired outcomes called Work.

Rules:
- Preserve the user's meaning and important detail. Never invent a goal.
- Each child can be completed, paused, or abandoned independently.
- Together the children cover the whole parent. Never drop a part of the parent.
- A shared person, day, or theme is not one outcome by itself. Split when the parts can finish independently.
- Use the plan steps to find the seams between outcomes.
- When the focus names one part, lift that part into its own child and keep the rest together.
- A title is short, concrete, and sentence case.
- Return between 2 and 6 children.

${WORK_SHAPE_GUIDE}

Return one JSON object only:
{"work":[{"title":string,"rawText":string,"shape":"quick"|"project"|"practice"|"decision"|"monitor"|"recurring"}]}`;

export function parseWorkSplitProposal(raw: string): SplitWorkChild[] {
  let text = String(raw || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('A split could not be proposed.');
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('A split could not be proposed.');
  }
  const parsed = workSplitProposalSchema.safeParse(json);
  if (!parsed.success) throw new Error('A split could not be proposed.');
  const items = parsed.data.work
    .map((item) => ({
      title: item.title.trim(),
      rawText: preserveCaptureText(item.rawText),
      shape: item.shape,
    }))
    .filter((item) => item.title && item.rawText);
  if (items.length < 2) throw new Error('A split could not be proposed.');
  return items;
}

interface SplitWorkDependencies {
  generate: typeof generateTextForCurrentUser;
  query: typeof convexQuery;
  mutate: typeof convexMutation;
  advance: typeof advanceWork;
  nowMs: () => number;
}

const defaultDependencies: SplitWorkDependencies = {
  generate: generateTextForCurrentUser,
  query: convexQuery,
  mutate: convexMutation,
  advance: advanceWork,
  nowMs: () => Date.now(),
};

export interface ProposeWorkSplitInput {
  userId: string;
  userEmail?: string;
  userName?: string;
  workId: string;
  focus?: string;
}

export async function proposeWorkSplit(
  input: ProposeWorkSplitInput,
  dependencies: Partial<SplitWorkDependencies> = {},
): Promise<{ workTitle: string; items: SplitWorkChild[] }> {
  const deps = { ...defaultDependencies, ...dependencies };
  const detail = await deps.query<any>((api as any).albatrossWorkV2.workDetail, {
    userId: input.userId,
    workId: input.workId,
  });
  if (!detail?.work) throw new Error('Work not found.');
  const workTitle = String(detail.plan?.outcome || detail.work.title || detail.work.rawText || '');
  const planSteps = [
    ...(detail.plan?.digitalActions || []).map((action: any) => String(action.title || '')),
    ...(detail.plan?.physicalActions || []).map((action: any) => String(action.title || '')),
  ].filter(Boolean);
  const { text } = await deps.generate({
    feature: 'albatross_capture_split',
    speed: 'fast',
    userId: input.userId,
    userEmail: input.userEmail,
    userName: input.userName,
    system: SPLIT_WORK_SYSTEM,
    prompt: JSON.stringify(
      {
        title: workTitle.slice(0, 300),
        rawText: String(detail.work.rawText || '').slice(0, 8_000),
        planSteps: planSteps.slice(0, 24),
        focus: input.focus?.slice(0, 300) || undefined,
      },
      null,
      2,
    ),
  });
  return { workTitle, items: parseWorkSplitProposal(text) };
}

export interface CommitWorkSplitInput {
  userId: string;
  userEmail?: string;
  userName?: string;
  workId: string;
  items: SplitWorkChild[];
  timezone?: string;
  /** Planning budget; children beyond it wait for the work conductor. */
  planBudgetMs?: number;
}

export async function commitWorkSplit(
  input: CommitWorkSplitInput,
  dependencies: Partial<SplitWorkDependencies> = {},
): Promise<{ workIds: string[]; releasedParent: boolean }> {
  const deps = { ...defaultDependencies, ...dependencies };
  const items = input.items
    .map((item) => ({
      title: String(item.title || '')
        .trim()
        .slice(0, 180),
      rawText: preserveCaptureText(String(item.rawText || '')),
      shape: item.shape,
    }))
    .filter((item) => item.title && item.rawText);
  if (items.length < 2 || items.length > 6) {
    throw new Error('A split needs between 2 and 6 Works.');
  }
  const detail = await deps.query<any>((api as any).albatrossWorkV2.workDetail, {
    userId: input.userId,
    workId: input.workId,
  });
  if (!detail?.work) throw new Error('Work not found.');
  const parentState = String(detail.work.workState || 'active');
  if (parentState === 'released' || parentState === 'archived' || parentState === 'done') {
    throw new Error('This Work is already settled.');
  }

  const taken = new Set<string>();
  const workIds: string[] = [];
  for (const item of items) {
    const externalId = uniqueExternalId(`split:${input.workId}:${contentSlug(item.title)}`, taken);
    taken.add(externalId);
    const upserted = await deps.mutate<any>((api as any).albatrossIntents.createIntent, {
      userId: input.userId,
      externalId,
      rawText: item.rawText,
      source: 'text',
      title: item.title,
      areaId: detail.work.primaryAreaId ? String(detail.work.primaryAreaId) : undefined,
      replaceRawText: true,
      returnMetadata: true,
    });
    const childId = String(upserted?.workId || '');
    if (!childId) throw new Error('A child Work could not be created.');
    workIds.push(childId);
  }

  // Provenance on the parent, then release. The children already exist, so a
  // failure after this point never loses work.
  const titles = items.map((item) => item.title);
  await deps
    .mutate((api as any).albatrossWorkV2.attachProof, {
      userId: input.userId,
      workId: input.workId,
      claim: `Split into ${workIds.length} Works: ${titles.join('; ')}`.slice(0, 900),
      title: 'Split this work',
      sourceKind: 'manual',
      sourceId: `split:${input.workId}`,
      trust: 'confirmed',
      settleContract: false,
    })
    .catch((error) => {
      // The split still stands without provenance, but silence would hide a
      // recurring storage failure.
      console.error('[split-work] provenance evidence failed', input.workId, error);
      return undefined;
    });
  await deps.mutate((api as any).albatrossWorkV2.releaseWork, {
    userId: input.userId,
    workId: input.workId,
    reason: `Split into: ${titles.join('; ')}`.slice(0, 400),
    proposedBy: 'user',
  });

  const deadline = deps.nowMs() + (input.planBudgetMs ?? 230_000);
  for (const childId of workIds) {
    if (deps.nowMs() > deadline) break;
    await deps
      .advance({
        userId: input.userId,
        userEmail: input.userEmail,
        userName: input.userName,
        workId: childId,
        timezone: input.timezone,
      })
      .catch(() => undefined);
  }

  return { workIds, releasedParent: true };
}
