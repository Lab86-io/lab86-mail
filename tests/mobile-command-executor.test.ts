import { describe, expect, test } from 'bun:test';
import { executeMobileCommand, mobileCommandDomain } from '../lib/mobile/v1/command-executor';
import { type MobileCommand, MobileCommandSchema } from '../lib/mobile/v1/contract';
import { MobileNotFoundError } from '../lib/mobile/v1/http';

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
    expect(mobileCommandDomain(command('task.setCompleted', { cardID: 'c', completed: true }))).toBe('tasks');
    expect(mobileCommandDomain(command('work.setShape', { workID: 'w', shape: 'list' }))).toBe('work');
  });

  test('commands native never sends are not part of the contract', () => {
    for (const kind of [
      'mail.addLabel',
      'mail.removeLabel',
      'mail.mute',
      'mail.send',
      'mail.saveDraft',
      'mail.deleteDraft',
      'calendar.resync',
      'task.create',
      'work.capture',
      'work.captureFromChat',
      'approval.approve',
      'approval.reject',
    ])
      expect(() => command(kind, {})).toThrow();
    expect(() => mobileCommandDomain({ kind: 'approval.approve' } as unknown as MobileCommand)).toThrow(
      /Unsupported mobile command domain: approval/,
    );
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
      command('mail.markUnread', { accountID: 'account-1', threadID: 'thread-1', messageID: 'message-1' }),
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
      command('mail.star', { accountID: 'account-1', threadID: 'thread-2', messageID: 'message-2' }),
      user,
      star.deps,
    );
    expect(star.calls).toEqual([{ name: 'star', args: { account: 'account-1', messageId: 'message-2' } }]);
    expect(starred.syncPayload).toEqual({ accountID: 'account-1', starred: true });

    const unstar = recordingDependencies();
    const unstarred = await executeMobileCommand(
      command('mail.unstar', { accountID: 'account-1', threadID: 'thread-2', messageID: 'message-2' }),
      user,
      unstar.deps,
    );
    expect(unstar.calls[0].name).toBe('unstar');
    expect(unstarred.syncPayload).toEqual({ accountID: 'account-1', starred: false });
  });

  test('a thread-only star or unread change acts on the newest message of the thread', async () => {
    for (const [kind, tool] of [
      ['mail.star', 'star'],
      ['mail.unstar', 'unstar'],
      ['mail.markUnread', 'mark_unread'],
    ] as const) {
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
      const deps = dependencies({
        invoke: async (name: string, args: Record<string, unknown>) => {
          calls.push({ name, args });
          if (name !== 'get_thread') return { ok: true };
          // The tool order is not trusted: the newest date wins.
          return {
            messages: [
              { _id: 'message-new', date: 3_000 },
              { _id: 'message-old', date: 1_000 },
              { id: 'message-mid', date: 2_000 },
              { date: 4_000 },
            ],
          };
        },
      });

      const result = await executeMobileCommand(
        command(kind, { accountID: 'account-1', threadID: 'thread-9' }),
        user,
        deps,
      );

      expect(calls).toEqual([
        { name: 'get_thread', args: { account: 'account-1', threadId: 'thread-9' } },
        { name: tool, args: { account: 'account-1', messageId: 'message-new' } },
      ]);
      expect(result).toMatchObject({ entityKind: 'message', entityID: 'message-new' });
    }
  });

  test('a thread-only change on a thread without messages fails as not found, not as a retry', async () => {
    const deps = dependencies({ invoke: async () => ({ messages: [{ date: 1 }] }) });

    await expect(
      executeMobileCommand(
        command('mail.star', { accountID: 'account-1', threadID: 'thread-0' }),
        user,
        deps,
      ),
    ).rejects.toBeInstanceOf(MobileNotFoundError);

    const empty = dependencies({ invoke: async () => ({}) });
    await expect(
      executeMobileCommand(
        command('mail.unstar', { accountID: 'account-1', threadID: 'thread-0' }),
        user,
        empty,
      ),
    ).rejects.toThrow('This conversation has no message to change.');
  });

  test('message targets need their thread', () => {
    expect(() => command('mail.star', { accountID: 'account-1', messageID: 'message-1' })).toThrow();
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

  test('snooze and unsnooze need no message: the tool acts on the whole thread', async () => {
    const { calls, deps } = recordingDependencies();
    const untilAt = '2026-08-21T09:00:00.000Z';

    await executeMobileCommand(
      command('mail.snooze', { accountID: 'account-1', threadID: 'thread-7', untilAt }),
      user,
      deps,
    );
    await executeMobileCommand(
      command('mail.unsnooze', { accountID: 'account-1', threadID: 'thread-7' }),
      user,
      deps,
    );

    expect(calls).toEqual([
      {
        name: 'snooze_thread',
        args: {
          account: 'account-1',
          messageId: undefined,
          threadId: 'thread-7',
          untilTs: Date.parse(untilAt),
        },
      },
      { name: 'unsnooze_thread', args: { account: 'account-1', messageId: undefined, threadId: 'thread-7' } },
    ]);
  });

  test('unsnooze clears the snooze with the explicit snoozeCleared flag', async () => {
    const { calls, deps } = recordingDependencies();

    const result = await executeMobileCommand(
      command('mail.unsnooze', { accountID: 'account-1', threadID: 'thread-4', messageID: 'message-4' }),
      user,
      deps,
    );

    expect(calls).toEqual([
      {
        name: 'unsnooze_thread',
        args: { account: 'account-1', messageId: 'message-4', threadId: 'thread-4' },
      },
    ]);
    expect(result.syncPayload).toEqual({ accountID: 'account-1', snoozeCleared: true });
  });

  test('restore routes through restore_from_trash and clears archived and trashed', async () => {
    const restore = recordingDependencies();
    const restored = await executeMobileCommand(
      command('mail.restore', { accountID: 'account-1', threadID: 'thread-6' }),
      user,
      restore.deps,
    );
    expect(restore.calls).toEqual([
      { name: 'restore_from_trash', args: { account: 'account-1', threadId: 'thread-6' } },
    ]);
    expect(restored.syncPayload).toEqual({ accountID: 'account-1', archived: false, trashed: false });
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

describe('work horizon command', () => {
  test('work.setHorizon converts ISO dates to epoch ms and reports the stored horizon', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const deps = dependencies({
      setWorkHorizon: async (input: Record<string, unknown>) => {
        calls.push(input);
        return { horizon: { ...(input.horizon as object), wokeAt: undefined }, dormant: true };
      },
    });

    const result = await executeMobileCommand(
      command('work.setHorizon', {
        workID: 'work-9',
        horizon: { kind: 'later', notBeforeAt: '2026-11-01T00:00:00.000Z', label: 'not before November' },
      }),
      user,
      deps,
    );

    expect(calls).toEqual([
      {
        userId: user.userId,
        workId: 'work-9',
        horizon: {
          kind: 'later',
          notBefore: Date.parse('2026-11-01T00:00:00.000Z'),
          label: 'not before November',
        },
      },
    ]);
    expect(result).toEqual({
      status: 'applied',
      syncDomain: 'work',
      entityKind: 'workHorizon',
      entityID: 'work-9',
      syncPayload: {
        workID: 'work-9',
        horizon: {
          kind: 'later',
          notBefore: Date.parse('2026-11-01T00:00:00.000Z'),
          label: 'not before November',
        },
      },
    });
    expect(mobileCommandDomain(command('work.setHorizon', { workID: 'w', horizonCleared: true }))).toBe(
      'work',
    );
  });

  test('work.setHorizon with horizonCleared puts the Work back on now', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const deps = dependencies({
      setWorkHorizon: async (input: Record<string, unknown>) => {
        calls.push(input);
        return { horizon: null, dormant: false };
      },
    });
    const result = await executeMobileCommand(
      command('work.setHorizon', { workID: 'work-9', horizonCleared: true }),
      user,
      deps,
    );
    expect(calls).toEqual([{ userId: user.userId, workId: 'work-9', horizon: null }]);
    expect(result.syncPayload).toEqual({ workID: 'work-9', horizonCleared: true });
  });

  test('work.setHorizon needs exactly one of horizon and horizonCleared', () => {
    expect(() => command('work.setHorizon', { workID: 'w' })).toThrow();
    expect(() =>
      command('work.setHorizon', { workID: 'w', horizon: { kind: 'someday' }, horizonCleared: true }),
    ).toThrow();
    expect(() =>
      command('work.setHorizon', { workID: 'w', horizon: { kind: 'later', notBeforeAt: 'soon' } }),
    ).toThrow();
    expect(command('work.setHorizon', { workID: 'w', horizon: { kind: 'someday' } }).payload).toEqual({
      workID: 'w',
      horizon: { kind: 'someday' },
    });
  });
});
