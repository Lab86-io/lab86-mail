import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runWithAiRequestContext } from '../ai/context';
import { type BriefNode, parseBriefDocument } from '../shared/brief-document';
import { getDailyReport } from '../store/daily-reports';
import { kvCompareAndSwap, kvGet } from '../store/kv';
import { interactiveBriefComponents, parseBriefComponentAnswer } from './component-catalog';

export const componentIdentitySchema = z
  .object({ reportId: z.string().min(1).max(240), componentId: z.string().regex(/^[a-z][a-z0-9-]{0,70}$/) })
  .strict();
export const componentWriteSchema = componentIdentitySchema
  .extend({ stamp: z.string().length(64), revision: z.string().uuid().nullable(), value: z.unknown() })
  .strict();
export class BriefComponentError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'BriefComponentError';
  }
}
export type BriefToolUiNode = Extract<BriefNode, { kind: 'tool_ui' }>;
export interface BriefComponentState {
  stamp: string;
  revision: string | null;
  value: unknown;
  updatedAt: number | null;
}
export function componentStamp(node: BriefToolUiNode) {
  return createHash('sha256').update(JSON.stringify(node)).digest('hex');
}
export function findBriefComponent(regions: Array<{ tree: BriefNode }>, id: string): BriefToolUiNode | null {
  const visit = (node: BriefNode): BriefToolUiNode | null => {
    if (node.kind === 'tool_ui' && node.id === id) return node;
    if ('children' in node)
      for (const child of node.children) {
        const match = visit(child);
        if (match) return match;
      }
    return null;
  };
  for (const region of regions) {
    const node = visit(region.tree);
    if (node) return node;
  }
  return null;
}
const defaults = {
  report: getDailyReport,
  get: kvGet<BriefComponentState>,
  save: kvCompareAndSwap<BriefComponentState & { revision: string }>,
};
export function createBriefComponentStore(deps = defaults) {
  async function load(identity: z.infer<typeof componentIdentitySchema>) {
    const report = await deps.report(identity.reportId);
    if (!report?.document) throw new BriefComponentError('This edition is no longer available.', 404);
    const node = findBriefComponent(parseBriefDocument(report.document).regions, identity.componentId);
    if (!node || !interactiveBriefComponents.has(node.component))
      throw new BriefComponentError('This input is no longer available.', 404);
    const stamp = componentStamp(node);
    const key = `${identity.reportId}:${identity.componentId}`;
    const saved = await deps.get('briefComponentState', key);
    return {
      node,
      key,
      state:
        saved?.stamp === stamp
          ? saved
          : { stamp, revision: saved?.revision ?? null, value: null, updatedAt: null },
    };
  }
  return {
    read: (userId: string, input: unknown) =>
      runWithAiRequestContext({ userId }, () => load(componentIdentitySchema.parse(input))),
    write: (userId: string, raw: unknown) =>
      runWithAiRequestContext({ userId }, async () => {
        const input = componentWriteSchema.parse(raw);
        const { node, key, state } = await load({ reportId: input.reportId, componentId: input.componentId });
        if (state.stamp !== input.stamp)
          throw new BriefComponentError('This component changed. Reload it before saving.', 409);
        let value: unknown;
        try {
          value = parseBriefComponentAnswer(node.component, node.props, input.value);
        } catch {
          throw new BriefComponentError('The answer does not match this component.', 400);
        }
        const next = { stamp: state.stamp, revision: randomUUID(), value, updatedAt: Date.now() };
        if (!(await deps.save('briefComponentState', key, input.revision, next, input.reportId)))
          throw new BriefComponentError('An answer was saved in another tab. Reload to review it.', 409);
        return next;
      }),
  };
}
export const briefComponentStore = createBriefComponentStore();
