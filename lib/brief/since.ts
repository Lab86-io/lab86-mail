import { api, convexQuery } from '../hosted/convex';
import type { BriefDocumentV2, BriefNode, BriefRegion } from '../shared/brief-document';
import type { DailyReport, DailyReportSinceLastEdition } from '../shared/types';

// "Since yesterday" (FEATURES item 7). The Brief opens with what Albatross
// did since the last edition, read from the operations log that Activity
// shows. Each row carries Undo when the operation has an inverse. The rows
// are `derived` refs with the id `operation:<operationId>`, and the Undo
// action is `undo_operation` with `payload.operationId`.

export const SINCE_REGION_ID = 'since';
export const SINCE_REGION_TITLE = 'What Albatross did';
export const SINCE_ACTION_LIMIT = 8;

const SURFACE_LABELS: Record<string, string> = {
  mail: 'Mail',
  calendar: 'Calendar',
  tasks: 'Tasks',
  albatross: 'Work',
};

export function operationRefId(operationId: string) {
  return `operation:${operationId}`;
}

function whenLabel(at: number, timezone: string) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** The operations of the look back that a row can name. */
export function sinceActions(since: DailyReportSinceLastEdition | null | undefined) {
  return (since?.agentActions ?? [])
    .filter((action) => action.operationId && action.summary && action.status !== 'undone')
    .slice(0, SINCE_ACTION_LIMIT);
}

/** The "What Albatross did" region, or null when Albatross did nothing. */
export function sinceRegion(
  since: DailyReportSinceLastEdition | null | undefined,
  timezone: string,
): BriefRegion | null {
  const actions = sinceActions(since);
  if (!actions.length) return null;
  const undoable = actions.filter((action) => action.undoable).length;
  return {
    id: SINCE_REGION_ID,
    summary: `Albatross took ${actions.length} ${actions.length === 1 ? 'action' : 'actions'} since the last edition${
      undoable ? `; ${undoable} can be undone` : ''
    }.`,
    tree: {
      kind: 'entity_list',
      emphasis: 'standard',
      tone: 'neutral',
      title: SINCE_REGION_TITLE,
      variant: 'rows',
      items: actions.map((action) => ({
        ref: {
          kind: 'derived' as const,
          id: operationRefId(action.operationId!),
          label: action.summary.slice(0, 480),
        },
        framing: {
          lane: SINCE_REGION_ID,
          sender: `${SURFACE_LABELS[action.surface] ?? 'Albatross'} · ${whenLabel(action.createdAt, timezone)}`,
          ...(action.reason ? { reason: action.reason.slice(0, 480) } : {}),
        },
        actions: action.undoable
          ? [
              {
                action: 'undo_operation',
                label: 'Undo',
                payload: { operationId: action.operationId, summary: action.summary.slice(0, 200) },
                style: 'quiet' as const,
              },
            ]
          : [],
      })),
    } as BriefNode,
  };
}

/** The operation ids a stored edition names in its look back. */
export function sinceOperationIds(report: Pick<DailyReport, 'sections'>): string[] {
  return (report.sections?.since?.agentActions ?? [])
    .map((action) => action.operationId)
    .filter((id): id is string => Boolean(id))
    .slice(0, 24);
}

function withoutRefs(node: BriefNode, gone: ReadonlySet<string>): BriefNode {
  if (node.kind === 'entity_list') {
    const items = node.items.filter((item) => !(item.ref.kind === 'derived' && gone.has(item.ref.id)));
    return items.length === node.items.length ? node : { ...node, items };
  }
  if (node.kind === 'tool_ui') {
    const sources = node.sources.filter(
      (source) => !(source.ref.kind === 'derived' && gone.has(source.ref.id)),
    );
    return sources.length === node.sources.length ? node : { ...node, sources };
  }
  if ('children' in node && Array.isArray(node.children)) {
    return { ...node, children: node.children.map((child) => withoutRefs(child, gone)) } as BriefNode;
  }
  return node;
}

/**
 * The live state of the look back: an operation the user undid since the
 * edition (here or in Activity) leaves the edition, and one whose undo
 * failed keeps its Undo. Never writes over the stored edition.
 */
export function applySinceOperationStates(
  report: DailyReport,
  states: ReadonlyMap<string, string>,
): DailyReport {
  const since = report.sections?.since;
  if (!since?.agentActions.length || !states.size) return report;
  const gone = new Set<string>();
  const agentActions = since.agentActions.map((action) => {
    const status = action.operationId ? states.get(action.operationId) : undefined;
    if (!status || status === action.status) return action;
    if (status === 'undone' || status === 'undoing') gone.add(operationRefId(action.operationId!));
    return { ...action, status };
  });
  const next: DailyReport = {
    ...report,
    sections: { ...report.sections, since: { ...since, agentActions } },
  };
  if (gone.size && report.document) {
    const document: BriefDocumentV2 = {
      ...report.document,
      regions: report.document.regions.map((region) => ({ ...region, tree: withoutRefs(region.tree, gone) })),
    };
    next.document = document;
  }
  return next;
}

export async function loadOperationStates(
  userId: string,
  ids: string[],
  query: typeof convexQuery = convexQuery,
): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await query<Array<{ id: string; status: string }>>(api.dailyReports.operationStates, {
    userId,
    ids,
  });
  return new Map((rows || []).map((row) => [row.id, row.status]));
}
