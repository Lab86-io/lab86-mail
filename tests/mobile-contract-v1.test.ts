import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJSON, mobileCommandPayloadHash } from '../lib/mobile/v1/canonical';
import { capabilitiesForProvider } from '../lib/mobile/v1/capabilities';
import { executeMobileCommand, mobileCommandDomain } from '../lib/mobile/v1/command-executor';
import {
  CommandReceiptSchema,
  MobileBootstrapSchema,
  MobileCommandSchema,
  SyncEnvelopeSchema,
} from '../lib/mobile/v1/contract';
import { mobileOpenAPIV1 } from '../lib/mobile/v1/openapi';
import { commandReceiptFromRow } from '../lib/mobile/v1/receipt';

const user = {
  userId: 'user_mobile_contract',
  email: 'owner@example.com',
  name: 'Owner',
  source: 'clerk' as const,
};

const createdAt = '2026-07-17T12:00:00.000Z';

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    invoke: async () => ({ ok: true }),
    enqueueApproval: async () => 'approval-1',
    capture: async () => ({ captureId: 'capture-1', status: 'split' as const, workIds: ['work-1'] }),
    ...overrides,
  } as any;
}

describe('MobileContractV1 schemas', () => {
  test('accepts typed primary-loop commands and rejects payload drift', () => {
    const command = MobileCommandSchema.parse({
      idempotencyKey: 'command-1',
      kind: 'task.setCompleted',
      payload: { cardID: 'card-1', completed: true },
      baseRevision: 4,
      clientCreatedAt: createdAt,
    });

    expect(command.kind).toBe('task.setCompleted');
    expect(mobileCommandDomain(command)).toBe('tasks');
    expect(() =>
      MobileCommandSchema.parse({
        ...command,
        payload: { cardID: 'card-1', completed: true, dynamicToolName: 'tasks_update_card' },
      }),
    ).toThrow();
  });

  test('golden bootstrap and sync payloads decode without JSONValue-style guessing', () => {
    const bootstrap = MobileBootstrapSchema.parse(
      JSON.parse(
        readFileSync(
          path.join(
            import.meta.dir,
            '../apps/ios/Packages/MobileAPI/Tests/MobileAPITests/Fixtures/bootstrap-v1.json',
          ),
          'utf8',
        ),
      ),
    );
    const sync = SyncEnvelopeSchema.parse(
      JSON.parse(
        readFileSync(
          path.join(
            import.meta.dir,
            '../apps/ios/Packages/MobileAPI/Tests/MobileAPITests/Fixtures/sync-v1.json',
          ),
          'utf8',
        ),
      ),
    );

    expect(bootstrap.accounts[0].sync.itemsSynced).toBe(42);
    expect(sync.items[0]).toMatchObject({
      domain: 'tasks',
      entityKind: 'task',
      payload: { cardID: 'card-1', completed: true },
    });
    expect(() =>
      SyncEnvelopeSchema.parse({
        ...sync,
        items: [{ ...sync.items[0], payload: { completed: true, dynamic: 'not typed' } }],
      }),
    ).toThrow();
  });

  test('shared golden receipt decodes through the public Zod contract', () => {
    const receipt = CommandReceiptSchema.parse(
      JSON.parse(
        readFileSync(
          path.join(
            import.meta.dir,
            '../apps/ios/Packages/MobileAPI/Tests/MobileAPITests/Fixtures/command-receipt-v1.json',
          ),
          'utf8',
        ),
      ),
    );

    expect(receipt.status).toBe('failed');
    expect(receipt.recoverableError?.retryable).toBe(true);
  });

  test('provider capability differences are explicit instead of broken controls', () => {
    expect(capabilitiesForProvider('google').calendar).toBe(true);
    expect(capabilitiesForProvider('microsoft').labels).toBe(false);
    expect(capabilitiesForProvider('imap')).toMatchObject({
      mail: true,
      calendar: false,
      folders: true,
      labels: false,
    });
    expect(capabilitiesForProvider('imap').unsupportedReason).toContain('calendar');
  });
});

describe('MobileContractV1 command policy', () => {
  test('private calendar holds execute through the shared calendar tool', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const command = MobileCommandSchema.parse({
      idempotencyKey: 'calendar-private-1',
      kind: 'calendar.create',
      payload: {
        accountID: 'account-1',
        title: 'Focus block',
        startAt: '2026-07-18T13:00:00.000Z',
        endAt: '2026-07-18T14:00:00.000Z',
        allDay: false,
        attendees: [],
        busy: true,
      },
      clientCreatedAt: createdAt,
    });
    const result = await executeMobileCommand(
      command,
      user,
      dependencies({
        invoke: async (name: string, args: Record<string, unknown>) => {
          calls.push({ name, args });
          return { eventId: 'event-1', operationId: 'operation-1' };
        },
      }),
    );

    expect(calls).toEqual([
      {
        name: 'calendar_create_event',
        args: expect.objectContaining({ account: 'account-1', attendees: [] }),
      },
    ]);
    expect(result).toMatchObject({ status: 'applied', entityID: 'event-1', operationID: 'operation-1' });
  });

  test('calendar invitations become durable desktop approvals before provider writes', async () => {
    let invoked = false;
    let approvalInput: Record<string, unknown> | undefined;
    const command = MobileCommandSchema.parse({
      idempotencyKey: 'calendar-invite-1',
      kind: 'calendar.create',
      payload: {
        accountID: 'account-1',
        title: 'Project review',
        startAt: '2026-07-18T13:00:00.000Z',
        endAt: '2026-07-18T14:00:00.000Z',
        allDay: false,
        attendees: [{ email: 'ari@example.com' }],
        busy: true,
      },
      clientCreatedAt: createdAt,
    });
    const result = await executeMobileCommand(
      command,
      user,
      dependencies({
        invoke: async () => {
          invoked = true;
          return {};
        },
        enqueueApproval: async (input: Record<string, unknown>) => {
          approvalInput = input;
          return 'approval-invite-1';
        },
      }),
    );

    expect(invoked).toBe(false);
    expect(approvalInput).toMatchObject({
      userId: user.userId,
      kind: 'calendar_invite',
      toolName: 'calendar_create_event',
    });
    expect(result).toMatchObject({
      status: 'needsApproval',
      approvalID: 'approval-invite-1',
      entityKind: 'approval',
    });
  });

  test('task completion uses the existing audited domain service', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const command = MobileCommandSchema.parse({
      idempotencyKey: 'task-complete-1',
      kind: 'task.setCompleted',
      payload: { cardID: 'card-1', completed: true },
      clientCreatedAt: createdAt,
    });
    const result = await executeMobileCommand(
      command,
      user,
      dependencies({
        invoke: async (name: string, args: Record<string, unknown>) => {
          calls.push({ name, args });
          return { operationId: 'operation-task-1' };
        },
      }),
    );

    expect(calls).toEqual([{ name: 'tasks_update_card', args: { cardId: 'card-1', completed: true } }]);
    expect(result.operationID).toBe('operation-task-1');
  });
});

describe('MobileContractV1 OpenAPI and receipts', () => {
  test('canonical command hashing is stable across object key order', () => {
    const left = { kind: 'task.setCompleted', payload: { completed: true, cardID: 'card-1' } };
    const right = { payload: { cardID: 'card-1', completed: true }, kind: 'task.setCompleted' };

    expect(canonicalJSON(left)).toBe(canonicalJSON(right));
    expect(mobileCommandPayloadHash(left)).toBe(mobileCommandPayloadHash(right));
  });

  test('generates the checked-in OpenAPI 3.1 document from the Zod contract', () => {
    const document = mobileOpenAPIV1();
    const checkedIn = JSON.parse(
      readFileSync(path.join(import.meta.dir, '../docs/mobile/openapi/mobile-v1.json'), 'utf8'),
    );

    expect(document.openapi).toBe('3.1.0');
    expect(document.paths['/api/mobile/v1/commands'].post.operationId).toBe('postMobileCommand');
    expect(document.components.schemas.MobileCommand).toBeDefined();
    expect(document.components.schemas.MobileCommand.discriminator.propertyName).toBe('kind');
    expect(document.components.schemas.MobileCommand.oneOf).toContainEqual({
      $ref: '#/components/schemas/TaskSetCompletedCommand',
    });
    expect(document.components.schemas.SyncChange.discriminator.propertyName).toBe('entityKind');
    expect(document.components.schemas.SyncEnvelope.properties.items.items).toEqual({
      $ref: '#/components/schemas/SyncChange',
    });
    expect(checkedIn).toEqual(document);
  });

  test('maps durable Convex rows to the public receipt without leaking payloads', () => {
    const receipt = commandReceiptFromRow({
      _id: 'command-1',
      status: 'failed',
      payload: { private: 'must not escape' },
      errorCode: 'PROVIDER_UNAVAILABLE',
      errorMessage: 'The provider is temporarily unavailable.',
      errorRetryable: true,
    });

    expect(CommandReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(receipt).not.toHaveProperty('payload');
    expect(receipt.recoverableError?.retryable).toBe(true);
  });

  test('schema and routes retain idempotency, sync revisions, and tombstones', () => {
    const schema = readFileSync(path.join(import.meta.dir, '../convex/schema.ts'), 'utf8');
    const mobile = readFileSync(path.join(import.meta.dir, '../convex/mobile.ts'), 'utf8');
    const route = readFileSync(path.join(import.meta.dir, '../app/api/mobile/v1/commands/route.ts'), 'utf8');
    const accounts = readFileSync(path.join(import.meta.dir, '../convex/accounts.ts'), 'utf8');

    expect(schema).toContain('mobileCommands: defineTable');
    expect(schema).toContain('mobileSyncTombstones: defineTable');
    expect(schema).toContain(".index('by_user_idempotency'");
    expect(mobile).toContain('recordDeletion');
    expect(mobile).toContain('if (command.undoneAt) return command;');
    expect(route).toContain('claimCommand');
    expect(accounts).toContain("'mobileCommands'");
    expect(accounts).toContain("'mobileSyncChanges'");
    expect(accounts).toContain("'mobileSyncTombstones'");
    expect(accounts).toContain("'mobileSyncHeads'");
  });
});
