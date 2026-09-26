import type { WorkHorizon as StoredWorkHorizon } from '@/lib/albatross/horizon';
import type { CurrentUser } from '@/lib/auth/current-user';
import { api, type ConvexCallArgs, convexMutation } from '@/lib/hosted/convex';
import { getTool } from '@/lib/tools';
import { invokeTool } from '@/lib/tools/registry';
import type { MobileCommand, MobileDomain, MobileSyncExecution } from './contract';
import { MobileNotFoundError } from './http';

export type MobileCommandExecution = {
  status: 'applied' | 'needsApproval';
  operationID?: string;
  approvalID?: string;
  undoExpiresAt?: number;
} & MobileSyncExecution;

interface MobileCommandExecutorDependencies {
  invoke: (name: string, argumentsValue: Record<string, unknown>, user: CurrentUser) => Promise<any>;
  enqueueApproval: (input: ConvexCallArgs<typeof api.albatrossWork.enqueueApproval>) => Promise<string>;
  setWorkHorizon: (input: {
    userId: string;
    workId: string;
    horizon: StoredWorkHorizon | null;
  }) => Promise<{ horizon: StoredWorkHorizon | null; dormant: boolean }>;
  /** One seam for every shape mutation in `albatrossWorkV2`. */
  workShapeMutation: (name: WorkShapeMutationName, input: Record<string, unknown>) => Promise<any>;
}

export type WorkShapeMutationName =
  | 'addListItem'
  | 'toggleListItem'
  | 'removeListItem'
  | 'logMetric'
  | 'toggleMilestone'
  | 'setShape';

const defaultDependencies: MobileCommandExecutorDependencies = {
  async invoke(name, argumentsValue, user) {
    const tool = getTool(name);
    if (!tool) throw new Error(`Mobile command references unknown domain tool: ${name}`);
    return invokeTool(tool, argumentsValue, {
      agent: 'user',
      account: typeof argumentsValue.account === 'string' ? argumentsValue.account : undefined,
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
    });
  },
  enqueueApproval(input) {
    return convexMutation<string>(api.albatrossWork.enqueueApproval, input);
  },
  setWorkHorizon(input) {
    return convexMutation(api.albatrossWorkV2.setHorizon, input);
  },
  // The mutation is picked by name, so its own validators check the input.
  workShapeMutation(name, input) {
    return convexMutation<unknown>(api.albatrossWorkV2[name], input);
  },
};

function listItemsPayload(items: any[] | undefined) {
  return (items || []).map((item) => ({
    id: String(item.id),
    text: String(item.text),
    done: Boolean(item.done),
    addedAt: Number(item.addedAt),
    ...(typeof item.doneAt === 'number' ? { doneAt: item.doneAt } : {}),
  }));
}

function milestonesPayload(items: any[] | undefined) {
  return (items || []).map((item) => ({
    id: String(item.id),
    title: String(item.title),
    done: Boolean(item.done),
    order: Number(item.order),
    ...(typeof item.doneAt === 'number' ? { doneAt: item.doneAt } : {}),
  }));
}

function metricPayload(metric: any) {
  return {
    name: String(metric?.name || 'value'),
    unit: String(metric?.unit || ''),
    ...(typeof metric?.target === 'number' ? { target: metric.target } : {}),
    ...(metric?.direction === 'down' || metric?.direction === 'up' ? { direction: metric.direction } : {}),
  };
}

export function mobileCommandDomain(command: MobileCommand): MobileDomain {
  const prefix = command.kind.split('.')[0];
  switch (prefix) {
    case 'mail':
      return 'mail';
    case 'calendar':
      return 'calendar';
    case 'task':
      return 'tasks';
    case 'work':
      return 'work';
    default:
      throw new Error(`Unsupported mobile command domain: ${prefix}`);
  }
}

function resultMetadata(result: any) {
  return {
    operationID:
      typeof result?.operationId === 'string' && result.operationId ? result.operationId : undefined,
    undoExpiresAt: typeof result?.undoExpiresAt === 'number' ? result.undoExpiresAt : undefined,
  };
}

// The newest message of a thread. A list row knows only its thread, so a
// star or unread change from the list acts on the newest message, as the
// native list did before these actions moved to the command outbox.
async function newestMessageID(
  dependencies: MobileCommandExecutorDependencies,
  accountID: string,
  threadID: string,
  user: CurrentUser,
): Promise<string> {
  const thread = await dependencies.invoke('get_thread', { account: accountID, threadId: threadID }, user);
  let newest: { id: string; at: number } | undefined;
  for (const message of Array.isArray(thread?.messages) ? thread.messages : []) {
    const id = String(message?._id || message?.id || '');
    if (!id) continue;
    const at = Number(message?.date) || 0;
    if (!newest || at >= newest.at) newest = { id, at };
  }
  if (!newest) throw new MobileNotFoundError('This conversation has no message to change.');
  return newest.id;
}

export async function executeMobileCommand(
  command: MobileCommand,
  user: CurrentUser,
  dependencies: MobileCommandExecutorDependencies = defaultDependencies,
): Promise<MobileCommandExecution> {
  switch (command.kind) {
    case 'mail.archive': {
      const result = await dependencies.invoke(
        'archive_thread',
        { account: command.payload.accountID, threadId: command.payload.threadID },
        user,
      );
      return {
        status: 'applied',
        ...resultMetadata(result),
        syncDomain: 'mail',
        entityKind: 'thread',
        entityID: command.payload.threadID,
        syncPayload: { accountID: command.payload.accountID, archived: true },
      };
    }
    case 'mail.trash': {
      const result = await dependencies.invoke(
        'trash_thread',
        { account: command.payload.accountID, threadId: command.payload.threadID },
        user,
      );
      return {
        status: 'applied',
        ...resultMetadata(result),
        syncDomain: 'mail',
        entityKind: 'thread',
        entityID: command.payload.threadID,
        syncPayload: { accountID: command.payload.accountID, trashed: true },
      };
    }
    case 'mail.markRead': {
      const result = await dependencies.invoke(
        'mark_thread_read',
        { account: command.payload.accountID, threadId: command.payload.threadID },
        user,
      );
      return {
        status: 'applied',
        ...resultMetadata(result),
        syncDomain: 'mail',
        entityKind: 'thread',
        entityID: command.payload.threadID,
        syncPayload: { accountID: command.payload.accountID, unread: false },
      };
    }
    case 'mail.markUnread':
    case 'mail.star':
    case 'mail.unstar': {
      const toolName =
        command.kind === 'mail.markUnread' ? 'mark_unread' : command.kind === 'mail.star' ? 'star' : 'unstar';
      const messageID =
        command.payload.messageID ||
        (await newestMessageID(dependencies, command.payload.accountID, command.payload.threadID, user));
      const result = await dependencies.invoke(
        toolName,
        { account: command.payload.accountID, messageId: messageID },
        user,
      );
      return {
        status: 'applied',
        ...resultMetadata(result),
        syncDomain: 'mail',
        entityKind: 'message',
        entityID: messageID,
        syncPayload: {
          accountID: command.payload.accountID,
          ...(command.kind === 'mail.markUnread'
            ? { unread: true }
            : { starred: command.kind === 'mail.star' }),
        },
      };
    }
    case 'mail.snooze': {
      const untilTs = Date.parse(command.payload.untilAt);
      const result = await dependencies.invoke(
        'snooze_thread',
        {
          account: command.payload.accountID,
          messageId: command.payload.messageID,
          threadId: command.payload.threadID,
          untilTs,
        },
        user,
      );
      return {
        status: 'applied',
        ...resultMetadata(result),
        syncDomain: 'mail',
        entityKind: 'thread',
        entityID: command.payload.threadID,
        syncPayload: { accountID: command.payload.accountID, snoozedUntil: untilTs },
      };
    }
    case 'mail.unsnooze': {
      const result = await dependencies.invoke(
        'unsnooze_thread',
        {
          account: command.payload.accountID,
          messageId: command.payload.messageID,
          threadId: command.payload.threadID,
        },
        user,
      );
      return {
        status: 'applied',
        ...resultMetadata(result),
        syncDomain: 'mail',
        entityKind: 'thread',
        entityID: command.payload.threadID,
        syncPayload: { accountID: command.payload.accountID, snoozeCleared: true },
      };
    }
    case 'mail.restore': {
      const result = await dependencies.invoke(
        'restore_from_trash',
        { account: command.payload.accountID, threadId: command.payload.threadID },
        user,
      );
      return {
        status: 'applied',
        ...resultMetadata(result),
        syncDomain: 'mail',
        entityKind: 'thread',
        entityID: command.payload.threadID,
        syncPayload: { accountID: command.payload.accountID, archived: false, trashed: false },
      };
    }
    case 'calendar.create': {
      const toolArguments = {
        account: command.payload.accountID,
        calendarId: command.payload.calendarID,
        title: command.payload.title,
        startIso: command.payload.startAt,
        endIso: command.payload.endAt,
        allDay: command.payload.allDay,
        description: command.payload.description,
        location: command.payload.location,
        attendees: command.payload.attendees,
        recurrence: command.payload.recurrence,
        busy: command.payload.busy,
      };
      if (command.payload.attendees.length > 0) {
        const approvalID = await dependencies.enqueueApproval({
          userId: user.userId,
          kind: 'calendar_invite',
          title: `Create “${command.payload.title}” and invite attendees`,
          detail: `${command.payload.attendees.length} attendee${command.payload.attendees.length === 1 ? '' : 's'} will be notified.`,
          artifactKind: 'calendarEvent',
          artifactId: command.idempotencyKey,
          toolName: 'calendar_create_event',
          toolArgs: toolArguments,
          risk: 'Human-facing calendar invitations require explicit approval before the provider write.',
        });
        return {
          status: 'needsApproval',
          approvalID,
          syncDomain: 'activity',
          entityKind: 'approval',
          entityID: approvalID,
          syncPayload: { approvalID, commandKind: command.kind },
        };
      }
      const result = await dependencies.invoke('calendar_create_event', toolArguments, user);
      const entityID = String(result?.eventId || command.idempotencyKey);
      return {
        status: 'applied',
        ...resultMetadata(result),
        syncDomain: 'calendar',
        entityKind: 'event',
        entityID,
        syncPayload: { accountID: command.payload.accountID, eventID: entityID },
      };
    }
    case 'task.setCompleted': {
      const result = await dependencies.invoke(
        'tasks_update_card',
        { cardId: command.payload.cardID, completed: command.payload.completed },
        user,
      );
      return {
        status: 'applied',
        ...resultMetadata(result),
        syncDomain: 'tasks',
        entityKind: 'task',
        entityID: command.payload.cardID,
        syncPayload: { cardID: command.payload.cardID, completed: command.payload.completed },
      };
    }
    case 'work.setHorizon': {
      const requested = command.payload.horizon;
      const horizon: StoredWorkHorizon | null = requested
        ? {
            kind: requested.kind,
            ...(requested.notBeforeAt ? { notBefore: Date.parse(requested.notBeforeAt) } : {}),
            ...(requested.byAt ? { by: Date.parse(requested.byAt) } : {}),
            ...(requested.label ? { label: requested.label } : {}),
          }
        : null;
      const result = await dependencies.setWorkHorizon({
        userId: user.userId,
        workId: command.payload.workID,
        horizon,
      });
      return {
        status: 'applied',
        syncDomain: 'work',
        entityKind: 'workHorizon',
        entityID: command.payload.workID,
        syncPayload: {
          workID: command.payload.workID,
          ...(result?.horizon ? { horizon: result.horizon } : { horizonCleared: true as const }),
        },
      };
    }
    case 'work.listAdd':
    case 'work.listToggle':
    case 'work.listRemove': {
      const name =
        command.kind === 'work.listAdd'
          ? 'addListItem'
          : command.kind === 'work.listToggle'
            ? 'toggleListItem'
            : 'removeListItem';
      const result = await dependencies.workShapeMutation(name, {
        userId: user.userId,
        workId: command.payload.workID,
        ...(command.kind === 'work.listAdd'
          ? { text: command.payload.text }
          : { itemId: command.payload.itemID }),
      });
      return {
        status: 'applied',
        syncDomain: 'work',
        entityKind: 'workShape',
        entityID: command.payload.workID,
        syncPayload: { workID: command.payload.workID, listItems: listItemsPayload(result?.listItems) },
      };
    }
    case 'work.metricLog': {
      const at = command.payload.at ? Date.parse(command.payload.at) : undefined;
      const result = await dependencies.workShapeMutation('logMetric', {
        userId: user.userId,
        workId: command.payload.workID,
        value: command.payload.value,
        ...(typeof at === 'number' && Number.isFinite(at) ? { at } : {}),
        ...(command.payload.note ? { note: command.payload.note } : {}),
      });
      return {
        status: 'applied',
        syncDomain: 'work',
        entityKind: 'workShape',
        entityID: command.payload.workID,
        syncPayload: {
          workID: command.payload.workID,
          metric: metricPayload(result?.metric),
          metricEntry: {
            id: String(result?.entry?._id || command.idempotencyKey),
            at: Number(result?.entry?.at ?? at ?? Date.now()),
            value: Number(result?.entry?.value ?? command.payload.value),
            note: result?.entry?.note ?? null,
          },
          ...(result?.summary
            ? {
                metricSummary: {
                  latest: result.summary.latest ?? null,
                  latestAt: result.summary.latestAt ?? null,
                  count: Number(result.summary.count || 0),
                  weeksWithEntry: Number(result.summary.weeksWithEntry || 0),
                },
              }
            : {}),
        },
      };
    }
    case 'work.milestoneToggle': {
      const result = await dependencies.workShapeMutation('toggleMilestone', {
        userId: user.userId,
        workId: command.payload.workID,
        milestoneId: command.payload.milestoneID,
      });
      return {
        status: 'applied',
        syncDomain: 'work',
        entityKind: 'workShape',
        entityID: command.payload.workID,
        syncPayload: { workID: command.payload.workID, milestones: milestonesPayload(result?.milestones) },
      };
    }
    case 'work.setShape': {
      const result = await dependencies.workShapeMutation('setShape', {
        userId: user.userId,
        workId: command.payload.workID,
        shape: command.payload.shape,
      });
      return {
        status: 'applied',
        syncDomain: 'work',
        entityKind: 'workShape',
        entityID: command.payload.workID,
        syncPayload: { workID: command.payload.workID, shape: result?.shape ?? command.payload.shape },
      };
    }
  }
}
