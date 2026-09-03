import { captureFromChat } from '@/lib/albatross/capture-from-chat';
import { captureWork } from '@/lib/albatross/capture-work';
import type { WorkHorizon as StoredWorkHorizon } from '@/lib/albatross/horizon';
import type { CurrentUser } from '@/lib/auth/current-user';
import { startCalendarResync } from '@/lib/calendar/resync';
import { api, convexMutation } from '@/lib/hosted/convex';
import { getTool } from '@/lib/tools';
import { invokeTool } from '@/lib/tools/registry';
import type { MobileCommand, MobileDomain, MobileSyncExecution } from './contract';

// A command that changes no entity (for example `calendar.resync`) records
// no sync change. It still names its domain for the command row.
export type MobileSilentExecution = {
  syncDomain: MobileDomain;
  entityKind?: undefined;
  entityID?: undefined;
  syncPayload?: undefined;
};

export type MobileCommandExecution = {
  status: 'applied' | 'needsApproval';
  operationID?: string;
  approvalID?: string;
  undoExpiresAt?: number;
} & (MobileSyncExecution | MobileSilentExecution);

interface MobileCommandExecutorDependencies {
  invoke: (name: string, argumentsValue: Record<string, unknown>, user: CurrentUser) => Promise<any>;
  enqueueApproval: (input: Record<string, unknown>) => Promise<string>;
  capture: typeof captureWork;
  captureFromChat: typeof captureFromChat;
  resyncCalendar: typeof startCalendarResync;
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
    return convexMutation<string>((api as any).albatrossWork.enqueueApproval, input);
  },
  capture: captureWork,
  captureFromChat,
  resyncCalendar: startCalendarResync,
  setWorkHorizon(input) {
    return convexMutation((api as any).albatrossWorkV2.setHorizon, input);
  },
  workShapeMutation(name, input) {
    return convexMutation((api as any).albatrossWorkV2[name], input);
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
    case 'approval':
      return 'activity';
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
      const result = await dependencies.invoke(
        toolName,
        { account: command.payload.accountID, messageId: command.payload.messageID },
        user,
      );
      return {
        status: 'applied',
        ...resultMetadata(result),
        syncDomain: 'mail',
        entityKind: 'message',
        entityID: command.payload.messageID,
        syncPayload: {
          accountID: command.payload.accountID,
          ...(command.kind === 'mail.markUnread'
            ? { unread: true }
            : { starred: command.kind === 'mail.star' }),
        },
      };
    }
    case 'mail.addLabel':
    case 'mail.removeLabel': {
      const adding = command.kind === 'mail.addLabel';
      const result = await dependencies.invoke(
        adding ? 'add_label' : 'remove_label',
        {
          account: command.payload.accountID,
          messageId: command.payload.messageID,
          label: command.payload.label,
        },
        user,
      );
      return {
        status: 'applied',
        ...resultMetadata(result),
        syncDomain: 'mail',
        entityKind: 'message',
        entityID: command.payload.messageID,
        syncPayload: {
          accountID: command.payload.accountID,
          ...(adding ? { labelsAdded: [command.payload.label] } : { labelsRemoved: [command.payload.label] }),
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
        { account: command.payload.accountID, messageId: command.payload.messageID },
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
    case 'mail.mute': {
      const result = await dependencies.invoke(
        'mute_thread',
        { account: command.payload.accountID, threadId: command.payload.threadID },
        user,
      );
      return {
        status: 'applied',
        ...resultMetadata(result),
        syncDomain: 'mail',
        entityKind: 'thread',
        entityID: command.payload.threadID,
        syncPayload: { accountID: command.payload.accountID, muted: true },
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
    case 'mail.send': {
      const payload = command.payload;
      const result =
        payload.mode === 'new'
          ? await dependencies.invoke(
              'send_message',
              {
                account: payload.accountID,
                to: payload.to,
                cc: payload.cc,
                bcc: payload.bcc,
                subject: payload.subject ?? '',
                body: payload.bodyText,
                html: payload.bodyHTML,
              },
              user,
            )
          : payload.mode === 'forward'
            ? await dependencies.invoke(
                'forward',
                {
                  account: payload.accountID,
                  messageId: payload.messageID,
                  to: payload.to,
                  cc: payload.cc,
                  bcc: payload.bcc,
                  body: payload.bodyText,
                  html: payload.bodyHTML,
                },
                user,
              )
            : await dependencies.invoke(
                payload.mode === 'reply' ? 'reply' : 'reply_all',
                {
                  account: payload.accountID,
                  messageId: payload.messageID,
                  threadId: payload.threadID,
                  body: payload.bodyText,
                  html: payload.bodyHTML,
                },
                user,
              );
      // A brand-new send has no client-side thread; the provider's thread id
      // is the real identity, and only failing that does the idempotency key
      // stand in so the sync change still has a stable key.
      const providerThreadID =
        typeof result?.threadId === 'string' && result.threadId ? String(result.threadId) : undefined;
      const threadID = payload.threadID || providerThreadID || command.idempotencyKey;
      return {
        status: 'applied',
        ...resultMetadata(result),
        syncDomain: 'mail',
        entityKind: 'thread',
        entityID: threadID,
        syncPayload: { accountID: payload.accountID },
      };
    }
    case 'mail.saveDraft': {
      const payload = command.payload;
      // Tri-state, like snooze: an ISO time schedules, `scheduleCleared`
      // unschedules (explicit null in the patch), absent leaves it alone.
      const scheduledFor = payload.scheduleCleared
        ? null
        : payload.scheduledFor
          ? Date.parse(payload.scheduledFor)
          : undefined;
      if (payload.draftID) {
        const result = await dependencies.invoke(
          'update_draft',
          {
            id: payload.draftID,
            patch: {
              to: payload.to,
              cc: payload.cc,
              bcc: payload.bcc,
              subject: payload.subject,
              body: payload.bodyText,
              html: payload.bodyHTML,
              scheduledFor,
            },
          },
          user,
        );
        return {
          status: 'applied',
          ...resultMetadata(result),
          syncDomain: 'mail',
          entityKind: 'draft',
          entityID: payload.draftID,
          syncPayload: { accountID: payload.accountID, draftID: payload.draftID },
        };
      }
      const result = await dependencies.invoke(
        'save_draft',
        {
          account: payload.accountID,
          threadId: payload.threadID,
          inReplyToMessageId: payload.inReplyToMessageID,
          to: payload.to,
          cc: payload.cc,
          bcc: payload.bcc,
          subject: payload.subject,
          body: payload.bodyText,
          html: payload.bodyHTML,
          scheduledFor: scheduledFor ?? undefined,
        },
        user,
      );
      const draftID = String(result?.draft?._id || command.idempotencyKey);
      return {
        status: 'applied',
        ...resultMetadata(result),
        syncDomain: 'mail',
        entityKind: 'draft',
        entityID: draftID,
        syncPayload: { accountID: payload.accountID, draftID },
      };
    }
    case 'mail.deleteDraft': {
      const result = await dependencies.invoke('delete_draft', { id: command.payload.draftID }, user);
      return {
        status: 'applied',
        ...resultMetadata(result),
        syncDomain: 'mail',
        entityKind: 'draft',
        entityID: command.payload.draftID,
        syncPayload: {
          accountID: command.payload.accountID,
          draftID: command.payload.draftID,
          deleted: true,
        },
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
    case 'calendar.resync': {
      await dependencies.resyncCalendar({
        userId: user.userId,
        accountId: command.payload.accountID,
        reason: command.payload.reason,
      });
      return { status: 'applied', syncDomain: 'calendar' };
    }
    case 'task.create': {
      const result = await dependencies.invoke(
        'tasks_create_card',
        {
          boardId: command.payload.boardID,
          column: command.payload.column,
          title: command.payload.title,
          description: command.payload.description,
          priority: command.payload.priority,
          dueIso: command.payload.dueAt,
          source: { kind: 'manual' },
        },
        user,
      );
      const entityID = String(result?.cardId || command.idempotencyKey);
      return {
        status: 'applied',
        ...resultMetadata(result),
        syncDomain: 'tasks',
        entityKind: 'task',
        entityID,
        syncPayload: { cardID: entityID, title: command.payload.title },
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
    case 'work.capture': {
      const result = await dependencies.capture(
        {
          rawText: command.payload.rawText,
          transcript: command.payload.transcript,
          source: command.payload.source,
          areaId: command.payload.areaID,
        },
        user,
      );
      const entityID = result.workIds[0] || result.captureId;
      return {
        status: 'applied',
        syncDomain: 'work',
        entityKind: 'work',
        entityID,
        syncPayload: {
          captureID: result.captureId,
          workIDs: result.workIds,
          fallback: result.fallback ?? false,
        },
      };
    }
    case 'work.captureFromChat': {
      const result = await dependencies.captureFromChat(
        {
          text: command.payload.text,
          replyText: command.payload.replyText,
          conversationId: command.payload.conversationID,
          sourceMessageId: command.payload.sourceMessageID,
        },
        user,
      );
      const entityID = result.workIds[0] || result.captureId || command.idempotencyKey;
      return {
        status: 'applied',
        syncDomain: 'work',
        entityKind: 'workCaptured',
        entityID,
        syncPayload: { workIDs: result.workIds, existing: result.existing },
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
    case 'approval.approve': {
      const result = await dependencies.invoke(
        'albatross_approve_action',
        {
          approvalId: command.payload.approvalID,
          editedArgs: command.payload.editedArguments,
        },
        user,
      );
      const operationID = result?.result?.operationId || result?.operationId;
      return {
        status: 'applied',
        operationID: typeof operationID === 'string' && operationID ? operationID : undefined,
        undoExpiresAt:
          typeof result?.approval?.undoExpiresAt === 'number' ? result.approval.undoExpiresAt : undefined,
        syncDomain: 'activity',
        entityKind: 'approval',
        entityID: command.payload.approvalID,
        syncPayload: { approvalID: command.payload.approvalID, status: 'approved' },
      };
    }
    case 'approval.reject': {
      const result = await dependencies.invoke(
        'albatross_reject_action',
        { approvalId: command.payload.approvalID, reason: command.payload.reason },
        user,
      );
      return {
        status: 'applied',
        ...resultMetadata(result),
        syncDomain: 'activity',
        entityKind: 'approval',
        entityID: command.payload.approvalID,
        syncPayload: { approvalID: command.payload.approvalID, status: 'rejected' },
      };
    }
  }
}
