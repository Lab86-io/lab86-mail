import { toast } from 'sonner';
import { callTool } from '@/lib/api-client';

// One Undo for every mail change. The tool that made the change returns the
// operation it recorded; Undo runs the same inverse that Activity runs, so a
// change taken back from the toast also reads as undone in Activity.

type Notify = Pick<typeof toast, 'success' | 'error'>;
type Call = <T = any>(name: string, args?: any) => Promise<T>;

export async function undoMailOperation(operationId: string, call: Call = callTool) {
  return await call<{ ok: boolean; undone: string }>('undo_operation', { operationId });
}

/**
 * A success toast with an Undo action when the change was recorded. "Undone"
 * shows only after the server confirms the inverse ran.
 */
export function toastWithUndo(
  message: string,
  operationId: string | string[] | null | undefined,
  options: { onUndone?: () => void; call?: Call; notify?: Notify; description?: string } = {},
) {
  const notify = options.notify ?? toast;
  const ids = (Array.isArray(operationId) ? operationId : [operationId]).filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  if (!ids.length) {
    notify.success(message, options.description ? { description: options.description } : undefined);
    return;
  }
  notify.success(message, {
    ...(options.description ? { description: options.description } : {}),
    action: {
      label: 'Undo',
      onClick: () => {
        void (async () => {
          for (const id of ids) await undoMailOperation(id, options.call);
        })().then(
          () => {
            notify.success('Undone');
            options.onUndone?.();
          },
          (error: unknown) =>
            notify.error(error instanceof Error ? error.message : 'Could not undo this change.'),
        );
      },
    },
  });
}
