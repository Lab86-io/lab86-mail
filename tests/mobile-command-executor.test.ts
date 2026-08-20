import { describe, expect, test } from 'bun:test';
import { executeMobileCommand, mobileCommandDomain } from '../lib/mobile/v1/command-executor';
import { type MobileCommand, MobileCommandSchema } from '../lib/mobile/v1/contract';

const user = {
  userId: 'user_mobile_executor',
  email: 'owner@example.com',
  name: 'Owner',
  source: 'clerk' as const,
};

const createdAt = '2026-07-19T09:00:00.000Z';

function command(kind: string, payload: Record<string, unknown>, idempotencyKey = `${kind}-1`) {
  return MobileCommandSchema.parse({ idempotencyKey, kind, payload, clientCreatedAt: createdAt });
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    invoke: async () => ({ ok: true }),
    enqueueApproval: async () => 'approval-1',
    capture: async () => ({ captureId: 'capture-1', status: 'split' as const, workIds: ['work-1'] }),
    ...overrides,
  } as any;
}

function recordingDependencies(result: unknown = { ok: true }) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const deps = dependencies({
    invoke: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return result;
    },
  });
  return { calls, deps };
}

describe('mobileCommandDomain', () => {
  test('maps every command prefix onto its sync domain', () => {
    expect(mobileCommandDomain(command('mail.archive', { accountID: 'a', threadID: 't' }))).toBe('mail');
    expect(
      mobileCommandDomain(
        command('calendar.create', {
          accountID: 'a',
          title: 'Focus',
          startAt: createdAt,
          endAt: createdAt,
          allDay: false,
          attendees: [],
          busy: true,
        }),
      ),
    ).toBe('calendar');
    expect(mobileCommandDomain(command('task.create', { title: 'Ship' }))).toBe('tasks');
    expect(mobileCommandDomain(command('work.capture', { rawText: 'note', source: 'text' }))).toBe('work');
    expect(mobileCommandDomain(command('approval.approve', { approvalID: 'ap-1' }))).toBe('activity');
  });

  test('rejects unknown command domains instead of guessing', () => {
    expect(() => mobileCommandDomain({ kind: 'drive.upload' } as unknown as MobileCommand)).toThrow(
      /Unsupported mobile command domain: drive/,
    );
  });
});

describe('mail commands', () => {
  test('archive routes through archive_thread and reports the archived thread', async () => {
    const { calls, deps } = recordingDependencies({ operationId: 'op-archive', undoExpiresAt: 1_800 });

    const result = await executeMobileCommand(
      command('mail.archive', { accountID: 'account-1', threadID: 'thread-1' }),
      user,
      deps,
    );

    expect(calls).toEqual([{ name: 'archive_thread', args: { account: 'account-1', threadId: 'thread-1' } }]);
    expect(result).toEqual({
      status: 'applied',
      operationID: 'op-archive',
      undoExpiresAt: 1_800,
      syncDomain: 'mail',
      entityKind: 'thread',
      entityID: 'thread-1',
      syncPayload: { accountID: 'account-1', archived: true },
    });
  });

  test('trash routes through trash_thread and omits undo metadata the tool did not provide', async () => {
    const { calls, deps } = recordingDependencies({ ok: true });

    const result = await executeMobileCommand(
      command('mail.trash', { accountID: 'account-1', threadID: 'thread-2' }),
      user,
      deps,
    );

    expect(calls[0].name).toBe('trash_thread');
    expect(result.operationID).toBeUndefined();
    expect(result.undoExpiresAt).toBeUndefined();
    expect(result.syncPayload).toEqual({ accountID: 'account-1', trashed: true });
  });

  test('markRead flips the thread unread flag through the shared mail tool', async () => {
    const { calls, deps } = recordingDependencies();

    const result = await executeMobileCommand(
      command('mail.markRead', { accountID: 'account-1', threadID: 'thread-3' }),
      user,
      deps,
    );

    expect(calls).toEqual([
      { name: 'mark_thread_read', args: { account: 'account-1', threadId: 'thread-3' } },
    ]);
    expect(result).toMatchObject({
      entityKind: 'thread',
      entityID: 'thread-3',
      syncPayload: { accountID: 'account-1', unread: false },
    });
  });

  test('markUnread targets the message and reports it unread', async () => {
    const { calls, deps } = recordingDependencies();

    const result = await executeMobileCommand(
      command('mail.markUnread', { accountID: 'account-1', messageID: 'message-1' }),
      user,
      deps,
    );

    expect(calls).toEqual([{ name: 'mark_unread', args: { account: 'account-1', messageId: 'message-1' } }]);
    expect(result).toMatchObject({
      syncDomain: 'mail',
      entityKind: 'message',
      entityID: 'message-1',
      syncPayload: { accountID: 'account-1', unread: true },
    });
  });

  test('star and unstar report the resulting starred state, not the action name', async () => {
    const star = recordingDependencies();
    const starred = await executeMobileCommand(
      command('mail.star', { accountID: 'account-1', messageID: 'message-2' }),
      user,
      star.deps,
    );
    expect(star.calls).toEqual([{ name: 'star', args: { account: 'account-1', messageId: 'message-2' } }]);
    expect(starred.syncPayload).toEqual({ accountID: 'account-1', starred: true });

    const unstar = recordingDependencies();
    const unstarred = await executeMobileCommand(
      command('mail.unstar', { accountID: 'account-1', messageID: 'message-2' }),
      user,
      unstar.deps,
    );
    expect(unstar.calls[0].name).toBe('unstar');
    expect(unstarred.syncPayload).toEqual({ accountID: 'account-1', starred: false });
  });

  test('provider failures propagate instead of being swallowed as applied', async () => {
    const deps = dependencies({
      invoke: async () => {
        throw new Error('provider unavailable');
      },
    });

    await expect(
      executeMobileCommand(
        command('mail.archive', { accountID: 'account-1', threadID: 'thread-1' }),
        user,
        deps,
      ),
    ).rejects.toThrow('provider unavailable');
  });
});

describe('expanded mail commands', () => {
  test('addLabel and removeLabel target the message and report the label delta', async () => {
    const add = recordingDependencies();
    const added = await executeMobileCommand(
      command('mail.addLabel', {
        accountID: 'account-1',
        threadID: 'thread-1',
        messageID: 'message-1',
        label: 'MailOS/Receipts',
      }),
      user,
      add.deps,
    );
    expect(add.calls).toEqual([
      { name: 'add_label', args: { account: 'account-1', messageId: 'message-1', label: 'MailOS/Receipts' } },
    ]);
    expect(added).toMatchObject({
      entityKind: 'message',
      entityID: 'message-1',
      syncPayload: { accountID: 'account-1', labelsAdded: ['MailOS/Receipts'] },
    });

    const remove = recordingDependencies();
    const removed = await executeMobileCommand(
      command('mail.removeLabel', {
        accountID: 'account-1',
        threadID: 'thread-1',
        messageID: 'message-1',
        label: 'MailOS/Receipts',
      }),
      user,
      remove.deps,
    );
    expect(remove.calls[0].name).toBe('remove_label');
    expect(removed.syncPayload).toEqual({ accountID: 'account-1', labelsRemoved: ['MailOS/Receipts'] });
  });

  test('snooze converts the ISO deadline to epoch ms for the tool and the sync payload', async () => {
    const { calls, deps } = recordingDependencies();
    const untilAt = '2026-08-21T09:00:00.000Z';

    const result = await executeMobileCommand(
      command('mail.snooze', {
        accountID: 'account-1',
        threadID: 'thread-4',
        messageID: 'message-4',
        untilAt,
      }),
      user,
      deps,
    );

    expect(calls).toEqual([
      {
        name: 'snooze_thread',
        args: {
          account: 'account-1',
          messageId: 'message-4',
          threadId: 'thread-4',
          untilTs: Date.parse(untilAt),
        },
      },
    ]);
    expect(result).toMatchObject({
      entityKind: 'thread',
      entityID: 'thread-4',
      syncPayload: { accountID: 'account-1', snoozedUntil: Date.parse(untilAt) },
    });
  });

  test('unsnooze clears the snooze with an explicit null deadline', async () => {
    const { calls, deps } = recordingDependencies();

    const result = await executeMobileCommand(
      command('mail.unsnooze', { accountID: 'account-1', threadID: 'thread-4', messageID: 'message-4' }),
      user,
      deps,
    );

    expect(calls).toEqual([
      { name: 'unsnooze_thread', args: { account: 'account-1', messageId: 'message-4' } },
    ]);
    expect(result.syncPayload).toEqual({ accountID: 'account-1', snoozeCleared: true });
  });

  test('mute and restore route through their thread tools', async () => {
    const mute = recordingDependencies();
    const muted = await executeMobileCommand(
      command('mail.mute', { accountID: 'account-1', threadID: 'thread-5' }),
      user,
      mute.deps,
    );
    expect(mute.calls).toEqual([
      { name: 'mute_thread', args: { account: 'account-1', threadId: 'thread-5' } },
    ]);
    expect(muted.syncPayload).toEqual({ accountID: 'account-1', muted: true });

    const restore = recordingDependencies();
    const restored = await executeMobileCommand(
      command('mail.restore', { accountID: 'account-1', threadID: 'thread-6' }),
      user,
      restore.deps,
    );
    expect(restore.calls[0].name).toBe('restore_from_trash');
    expect(restored.syncPayload).toEqual({ accountID: 'account-1', archived: false, trashed: false });
  });

  test('send maps each mode onto its compose tool', async () => {
    const fresh = recordingDependencies();
    await executeMobileCommand(
      command('mail.send', {
        accountID: 'account-1',
        mode: 'new',
        to: 'sam@example.com',
        subject: 'Hello',
        bodyText: 'Plain body',
        bodyHTML: '<p>Plain body</p>',
      }),
      user,
      fresh.deps,
    );
    expect(fresh.calls).toEqual([
      {
        name: 'send_message',
        args: {
          account: 'account-1',
          to: 'sam@example.com',
          cc: undefined,
          bcc: undefined,
          subject: 'Hello',
          body: 'Plain body',
          html: '<p>Plain body</p>',
        },
      },
    ]);

    const reply = recordingDependencies();
    const replied = await executeMobileCommand(
      command('mail.send', {
        accountID: 'account-1',
        mode: 'reply',
        bodyText: 'Sounds good',
        threadID: 'thread-7',
        messageID: 'message-7',
      }),
      user,
      reply.deps,
    );
    expect(reply.calls[0]).toEqual({
      name: 'reply',
      args: {
        account: 'account-1',
        messageId: 'message-7',
        threadId: 'thread-7',
        body: 'Sounds good',
        html: undefined,
      },
    });
    expect(replied).toMatchObject({ entityKind: 'thread', entityID: 'thread-7' });

    const replyAll = recordingDependencies();
    await executeMobileCommand(
      command('mail.send', {
        accountID: 'account-1',
        mode: 'replyAll',
        bodyText: 'Everyone',
        messageID: 'message-8',
      }),
      user,
      replyAll.deps,
    );
    expect(replyAll.calls[0].name).toBe('reply_all');

    const forward = recordingDependencies();
    await executeMobileCommand(
      command('mail.send', {
        accountID: 'account-1',
        mode: 'forward',
        to: 'ari@example.com',
        bodyText: 'FYI',
        messageID: 'message-9',
      }),
      user,
      forward.deps,
    );
    expect(forward.calls[0]).toEqual({
      name: 'forward',
      args: {
        account: 'account-1',
        messageId: 'message-9',
        to: 'ari@example.com',
        cc: undefined,
        bcc: undefined,
        body: 'FYI',
        html: undefined,
      },
    });
  });

  test('send without a thread falls back to the idempotency key as identity', async () => {
    const { deps } = recordingDependencies();
    const result = await executeMobileCommand(
      command(
        'mail.send',
        { accountID: 'account-1', mode: 'new', to: 'sam@example.com', subject: 'Hi', bodyText: 'Body' },
        'send-key-1',
      ),
      user,
      deps,
    );
    expect(result.entityID).toBe('send-key-1');
    expect(result.syncPayload).toEqual({ accountID: 'account-1' });
  });

  test('saveDraft creates through save_draft and reports the stored draft id', async () => {
    const { calls, deps } = recordingDependencies({
      ok: true,
      draft: { _id: 'draft-11' },
      operationId: 'op-draft-11',
    });

    const result = await executeMobileCommand(
      command('mail.saveDraft', {
        accountID: 'account-1',
        to: 'sam@example.com',
        subject: 'Draft subject',
        bodyText: 'Draft body',
      }),
      user,
      deps,
    );

    expect(calls[0].name).toBe('save_draft');
    expect(calls[0].args).toMatchObject({
      account: 'account-1',
      to: 'sam@example.com',
      subject: 'Draft subject',
      body: 'Draft body',
    });
    expect(result).toMatchObject({
      operationID: 'op-draft-11',
      entityKind: 'draft',
      entityID: 'draft-11',
      syncPayload: { accountID: 'account-1', draftID: 'draft-11' },
    });
  });

  test('saveDraft with an existing id updates in place', async () => {
    const { calls, deps } = recordingDependencies();

    const result = await executeMobileCommand(
      command('mail.saveDraft', {
        accountID: 'account-1',
        draftID: 'draft-12',
        to: 'sam@example.com',
        subject: 'Edited',
        bodyText: 'Edited body',
      }),
      user,
      deps,
    );

    expect(calls[0].name).toBe('update_draft');
    expect(calls[0].args).toMatchObject({
      id: 'draft-12',
      patch: { subject: 'Edited', body: 'Edited body' },
    });
    expect(result.entityID).toBe('draft-12');
  });

  test('deleteDraft reports the deletion in the sync payload', async () => {
    const { calls, deps } = recordingDependencies();

    const result = await executeMobileCommand(
      command('mail.deleteDraft', { accountID: 'account-1', draftID: 'draft-13' }),
      user,
      deps,
    );

    expect(calls).toEqual([{ name: 'delete_draft', args: { id: 'draft-13' } }]);
    expect(result.syncPayload).toEqual({ accountID: 'account-1', draftID: 'draft-13', deleted: true });
  });
});

describe('calendar commands', () => {
  const basePayload = {
    accountID: 'account-1',
    title: 'Design review',
    startAt: '2026-07-21T13:00:00.000Z',
    endAt: '2026-07-21T14:00:00.000Z',
    allDay: false,
    busy: true,
  };

  test('private holds execute immediately and fall back to the idempotency key as identity', async () => {
    const { calls, deps } = recordingDependencies({ ok: true });

    const result = await executeMobileCommand(
      command('calendar.create', { ...basePayload, attendees: [] }, 'calendar-hold-1'),
      user,
      deps,
    );

    expect(calls[0].name).toBe('calendar_create_event');
    expect(calls[0].args).toMatchObject({
      account: 'account-1',
      title: 'Design review',
      startIso: '2026-07-21T13:00:00.000Z',
      endIso: '2026-07-21T14:00:00.000Z',
    });
    expect(result).toMatchObject({
      status: 'applied',
      syncDomain: 'calendar',
      entityKind: 'event',
      entityID: 'calendar-hold-1',
      syncPayload: { accountID: 'account-1', eventID: 'calendar-hold-1' },
    });
  });

  test('a single attendee produces a durable approval with singular human copy', async () => {
    let invoked = false;
    let approvalInput: Record<string, unknown> | undefined;
    const deps = dependencies({
      invoke: async () => {
        invoked = true;
        return {};
      },
      enqueueApproval: async (input: Record<string, unknown>) => {
        approvalInput = input;
        return 'approval-invite-9';
      },
    });

    const result = await executeMobileCommand(
      command(
        'calendar.create',
        { ...basePayload, attendees: [{ email: 'ari@example.com' }] },
        'calendar-invite-9',
      ),
      user,
      deps,
    );

    expect(invoked).toBe(false);
    expect(approvalInput).toMatchObject({
      userId: user.userId,
      kind: 'calendar_invite',
      detail: '1 attendee will be notified.',
      artifactId: 'calendar-invite-9',
      toolName: 'calendar_create_event',
    });
    expect(result).toEqual({
      status: 'needsApproval',
      approvalID: 'approval-invite-9',
      syncDomain: 'activity',
      entityKind: 'approval',
      entityID: 'approval-invite-9',
      syncPayload: { approvalID: 'approval-invite-9', commandKind: 'calendar.create' },
    });
  });

  test('multiple attendees pluralize the approval copy', async () => {
    let approvalInput: Record<string, unknown> | undefined;
    const deps = dependencies({
      enqueueApproval: async (input: Record<string, unknown>) => {
        approvalInput = input;
        return 'approval-invite-10';
      },
    });

    await executeMobileCommand(
      command('calendar.create', {
        ...basePayload,
        attendees: [{ email: 'ari@example.com' }, { email: 'sam@example.com' }],
      }),
      user,
      deps,
    );

    expect(approvalInput?.detail).toBe('2 attendees will be notified.');
  });
});

describe('task commands', () => {
  test('task.create maps mobile fields onto the audited card tool', async () => {
    const { calls, deps } = recordingDependencies({ cardId: 'card-9', operationId: 'op-card-9' });

    const result = await executeMobileCommand(
      command('task.create', {
        boardID: 'board-1',
        column: 'Today',
        title: 'Ship mobile tests',
        description: 'Add coverage',
        priority: 'high',
        dueAt: '2026-07-22T12:00:00.000Z',
      }),
      user,
      deps,
    );

    expect(calls).toEqual([
      {
        name: 'tasks_create_card',
        args: {
          boardId: 'board-1',
          column: 'Today',
          title: 'Ship mobile tests',
          description: 'Add coverage',
          priority: 'high',
          dueIso: '2026-07-22T12:00:00.000Z',
          source: { kind: 'manual' },
        },
      },
    ]);
    expect(result).toMatchObject({
      status: 'applied',
      operationID: 'op-card-9',
      syncDomain: 'tasks',
      entityKind: 'task',
      entityID: 'card-9',
      syncPayload: { cardID: 'card-9', title: 'Ship mobile tests' },
    });
  });

  test('task.create falls back to the idempotency key when the tool returns no card id', async () => {
    const { deps } = recordingDependencies({ ok: true });

    const result = await executeMobileCommand(
      command('task.create', { title: 'Untracked' }, 'task-key-1'),
      user,
      deps,
    );

    expect(result.entityID).toBe('task-key-1');
    expect(result.syncPayload).toEqual({ cardID: 'task-key-1', title: 'Untracked' });
  });

  test('task.setCompleted round-trips the completion state', async () => {
    const { calls, deps } = recordingDependencies({ operationId: 'op-complete' });

    const result = await executeMobileCommand(
      command('task.setCompleted', { cardID: 'card-2', completed: false }),
      user,
      deps,
    );

    expect(calls).toEqual([{ name: 'tasks_update_card', args: { cardId: 'card-2', completed: false } }]);
    expect(result).toMatchObject({
      entityID: 'card-2',
      operationID: 'op-complete',
      syncPayload: { cardID: 'card-2', completed: false },
    });
  });
});

describe('work capture command', () => {
  test('delegates to captureWork and surfaces split results', async () => {
    const captures: Array<Record<string, unknown>> = [];
    const deps = dependencies({
      capture: async (input: Record<string, unknown>) => {
        captures.push(input);
        return { captureId: 'capture-7', status: 'split' as const, workIds: ['work-7', 'work-8'] };
      },
    });

    const result = await executeMobileCommand(
      command('work.capture', {
        rawText: 'renew passport and file taxes',
        transcript: 'renew passport and file taxes',
        source: 'voice',
        areaID: 'area-1',
      }),
      user,
      deps,
    );

    expect(captures).toEqual([
      {
        rawText: 'renew passport and file taxes',
        transcript: 'renew passport and file taxes',
        source: 'voice',
        areaId: 'area-1',
      },
    ]);
    expect(result).toEqual({
      status: 'applied',
      syncDomain: 'work',
      entityKind: 'work',
      entityID: 'work-7',
      syncPayload: { captureID: 'capture-7', workIDs: ['work-7', 'work-8'], fallback: false },
    });
  });

  test('a fallback capture keeps the capture id as identity and reports the fallback', async () => {
    const deps = dependencies({
      capture: async () => ({
        captureId: 'capture-8',
        status: 'split' as const,
        workIds: [],
        fallback: true,
      }),
    });

    const result = await executeMobileCommand(
      command('work.capture', { rawText: 'note', source: 'text' }),
      user,
      deps,
    );

    expect(result.entityID).toBe('capture-8');
    expect(result.syncPayload).toMatchObject({ fallback: true, workIDs: [] });
  });
});

describe('approval commands', () => {
  test('approve prefers the nested execution operation id and undo window', async () => {
    const { calls, deps } = recordingDependencies({
      result: { operationId: 'op-nested' },
      approval: { undoExpiresAt: 2_400 },
    });

    const result = await executeMobileCommand(
      command('approval.approve', { approvalID: 'approval-3', editedArguments: { title: 'Edited' } }),
      user,
      deps,
    );

    expect(calls).toEqual([
      {
        name: 'albatross_approve_action',
        args: { approvalId: 'approval-3', editedArgs: { title: 'Edited' } },
      },
    ]);
    expect(result).toEqual({
      status: 'applied',
      operationID: 'op-nested',
      undoExpiresAt: 2_400,
      syncDomain: 'activity',
      entityKind: 'approval',
      entityID: 'approval-3',
      syncPayload: { approvalID: 'approval-3', status: 'approved' },
    });
  });

  test('approve falls back to a top-level operation id and tolerates junk metadata', async () => {
    const { deps } = recordingDependencies({ operationId: 'op-top', approval: { undoExpiresAt: 'soon' } });

    const result = await executeMobileCommand(
      command('approval.approve', { approvalID: 'approval-4' }),
      user,
      deps,
    );

    expect(result.operationID).toBe('op-top');
    expect(result.undoExpiresAt).toBeUndefined();

    const junk = recordingDependencies({ result: { operationId: 42 } });
    const junkResult = await executeMobileCommand(
      command('approval.approve', { approvalID: 'approval-5' }),
      user,
      junk.deps,
    );
    expect(junkResult.operationID).toBeUndefined();
  });

  test('reject records the rejection with its reason', async () => {
    const { calls, deps } = recordingDependencies({ ok: true });

    const result = await executeMobileCommand(
      command('approval.reject', { approvalID: 'approval-6', reason: 'Wrong time.' }),
      user,
      deps,
    );

    expect(calls).toEqual([
      { name: 'albatross_reject_action', args: { approvalId: 'approval-6', reason: 'Wrong time.' } },
    ]);
    expect(result).toMatchObject({
      status: 'applied',
      entityID: 'approval-6',
      syncPayload: { approvalID: 'approval-6', status: 'rejected' },
    });
  });
});
