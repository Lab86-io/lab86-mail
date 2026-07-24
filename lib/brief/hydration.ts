import type { BriefDocumentV2, BriefNode, BriefQueryName, BriefSourceRefV2 } from '../shared/brief-document';
import type { BriefHydratedEntity } from '../shared/brief-hydration';

export function briefRefKey(ref: {
  kind: BriefSourceRefV2['kind'] | BriefHydratedEntity['kind'];
  id: string;
  account?: string;
}): string {
  return [ref.kind, ref.account ?? '', ref.id].join(':');
}

export function hydratedEntityKey(entity: Pick<BriefHydratedEntity, 'kind' | 'id' | 'account'>): string {
  return [entity.kind, entity.account ?? '', entity.id].join(':');
}

export function collectBriefRefs(document: BriefDocumentV2): BriefSourceRefV2[] {
  const refs = new Map<string, BriefSourceRefV2>();
  const add = (ref: BriefSourceRefV2 | undefined) => {
    if (!ref || !['thread', 'task', 'event', 'card', 'work'].includes(ref.kind)) return;
    refs.set(briefRefKey(ref), ref);
  };
  const visit = (node: BriefNode) => {
    switch (node.kind) {
      case 'entity_list':
        node.items.forEach((item) => {
          add(item.ref);
          item.handoff?.recommendations?.forEach((move) => {
            add(move.ref);
          });
          item.handoff?.evidence.forEach((evidence) => {
            add(evidence.ref);
          });
        });
        break;
      case 'chart':
        node.sourceRefs.forEach((ref) => {
          add(ref);
        });
        break;
      case 'timeline':
        node.items.forEach((item) => {
          add(item.ref);
        });
        break;
      case 'checklist':
        node.items.forEach((item) => {
          add(item.ref);
        });
        break;
      case 'collection':
        node.items.forEach((item) => {
          add(item.ref);
        });
        break;
      case 'stack':
      case 'grid':
      case 'split':
      case 'hero':
      case 'group':
        node.children.forEach((child) => {
          visit(child);
        });
        break;
    }
  };
  document.regions.forEach((region) => {
    visit(region.tree);
  });
  return [...refs.values()];
}

export const briefQueryKeys = {
  refBatch: (refs: BriefSourceRefV2[]) =>
    ['brief-v2', 'refs', refs.map(briefRefKey).sort().join('|')] as const,
  query: (name: BriefQueryName, areaId?: string, limit?: number) =>
    ['brief-v2', 'query', name, areaId ?? '', limit ?? 12] as const,
};
