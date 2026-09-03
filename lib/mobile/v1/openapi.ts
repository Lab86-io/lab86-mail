import { z } from 'zod';
import { MobileCommandVariantSchemas, MobileContractV1, MobileSyncChangeVariantSchemas } from './contract';

function schemaFor(schema: z.ZodType) {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    reused: 'inline',
    cycles: 'throw',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

const jsonContent = (schema: string) => ({
  'application/json': { schema: { $ref: `#/components/schemas/${schema}` } },
});

const errorResponses = {
  '400': { description: 'Invalid request', content: jsonContent('MobileErrorEnvelope') },
  '401': { description: 'Authentication required', content: jsonContent('MobileErrorEnvelope') },
  '409': { description: 'Command conflict', content: jsonContent('MobileErrorEnvelope') },
  '429': { description: 'Rate limited', content: jsonContent('MobileErrorEnvelope') },
  '500': { description: 'Server failure', content: jsonContent('MobileErrorEnvelope') },
};

export function mobileOpenAPIV1() {
  const components = Object.fromEntries(
    Object.entries(MobileContractV1.schemas).map(([name, schema]) => [name, schemaFor(schema)]),
  );
  components.MobileCommand = {
    oneOf: Object.keys(MobileCommandVariantSchemas).map((name) => ({
      $ref: `#/components/schemas/${name}`,
    })),
    discriminator: {
      propertyName: 'kind',
      mapping: {
        'mail.archive': '#/components/schemas/MailArchiveCommand',
        'mail.trash': '#/components/schemas/MailTrashCommand',
        'mail.markRead': '#/components/schemas/MailMarkReadCommand',
        'mail.markUnread': '#/components/schemas/MailMarkUnreadCommand',
        'mail.star': '#/components/schemas/MailStarCommand',
        'mail.unstar': '#/components/schemas/MailUnstarCommand',
        'mail.addLabel': '#/components/schemas/MailAddLabelCommand',
        'mail.removeLabel': '#/components/schemas/MailRemoveLabelCommand',
        'mail.snooze': '#/components/schemas/MailSnoozeCommand',
        'mail.unsnooze': '#/components/schemas/MailUnsnoozeCommand',
        'mail.mute': '#/components/schemas/MailMuteCommand',
        'mail.restore': '#/components/schemas/MailRestoreCommand',
        'mail.send': '#/components/schemas/MailSendCommand',
        'mail.saveDraft': '#/components/schemas/MailSaveDraftCommand',
        'mail.deleteDraft': '#/components/schemas/MailDeleteDraftCommand',
        'calendar.create': '#/components/schemas/CalendarCreateCommand',
        'task.create': '#/components/schemas/TaskCreateCommand',
        'task.setCompleted': '#/components/schemas/TaskSetCompletedCommand',
        'work.capture': '#/components/schemas/WorkCaptureCommand',
        'work.setHorizon': '#/components/schemas/WorkSetHorizonCommand',
        'approval.approve': '#/components/schemas/ApprovalApproveCommand',
        'approval.reject': '#/components/schemas/ApprovalRejectCommand',
      },
    },
  };
  components.SyncChange = {
    oneOf: Object.keys(MobileSyncChangeVariantSchemas).map((name) => ({
      $ref: `#/components/schemas/${name}`,
    })),
    discriminator: {
      propertyName: 'entityKind',
      mapping: {
        thread: '#/components/schemas/MailThreadSyncChange',
        message: '#/components/schemas/MailMessageSyncChange',
        draft: '#/components/schemas/MailDraftSyncChange',
        event: '#/components/schemas/CalendarEventSyncChange',
        task: '#/components/schemas/TaskSyncChange',
        work: '#/components/schemas/WorkSyncChange',
        workHorizon: '#/components/schemas/WorkHorizonSyncChange',
        approval: '#/components/schemas/ApprovalSyncChange',
        operation: '#/components/schemas/OperationSyncChange',
      },
    },
  };
  components.SyncEnvelope = {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'deletedIDs', 'cursor', 'serverRevision', 'hasMore'],
    properties: {
      items: { type: 'array', items: { $ref: '#/components/schemas/SyncChange' } },
      deletedIDs: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 240 } },
      cursor: { type: 'string' },
      serverRevision: { type: 'integer', minimum: 0 },
      hasMore: { type: 'boolean' },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Albatross Mobile API',
      version: '1.0.0',
      description:
        'Versioned query and command boundary shared by Albatross iOS and the web domain services.',
    },
    servers: [{ url: '/' }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/mobile/v1/bootstrap': {
        get: {
          operationId: 'getMobileBootstrap',
          responses: {
            '200': { description: 'Initial authenticated state', content: jsonContent('MobileBootstrap') },
            ...errorResponses,
          },
        },
      },
      '/api/mobile/v1/sync': {
        get: {
          operationId: 'getMobileSync',
          parameters: [
            {
              name: 'domain',
              in: 'query',
              required: true,
              schema: schemaFor(
                z.enum(['accounts', 'mail', 'calendar', 'tasks', 'today', 'work', 'assistant', 'activity']),
              ),
            },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 500 },
            },
          ],
          responses: {
            '200': { description: 'One domain change page', content: jsonContent('SyncEnvelope') },
            ...errorResponses,
          },
        },
      },
      '/api/mobile/v1/mail/threads': {
        get: {
          operationId: 'getMobileMailThreads',
          parameters: [
            { name: 'accountID', in: 'query', required: false, schema: { type: 'string' } },
            {
              name: 'category',
              in: 'query',
              required: false,
              schema: { type: 'string', minLength: 1, maxLength: 240 },
            },
            {
              name: 'cursor',
              in: 'query',
              required: false,
              description: 'Opaque page cursor from a previous response (a decimal epoch-ms watermark).',
              schema: { type: 'string', pattern: '^\\d+$' },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100 },
            },
          ],
          responses: {
            '200': { description: 'One page of thread summaries', content: jsonContent('MailThreadPage') },
            ...errorResponses,
          },
        },
      },
      '/api/mobile/v1/mail/threads/{threadID}': {
        get: {
          operationId: 'getMobileMailThread',
          parameters: [
            { name: 'threadID', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'accountID', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'A full thread with ordered messages',
              content: jsonContent('MailThreadDetail'),
            },
            ...errorResponses,
          },
        },
      },
      '/api/mobile/v1/commands': {
        post: {
          operationId: 'postMobileCommand',
          requestBody: { required: true, content: jsonContent('MobileCommand') },
          responses: {
            '200': { description: 'Durable command receipt', content: jsonContent('CommandReceipt') },
            ...errorResponses,
          },
        },
      },
      '/api/mobile/v1/commands/{id}': {
        get: {
          operationId: 'getMobileCommand',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Current durable command receipt', content: jsonContent('CommandReceipt') },
            ...errorResponses,
          },
        },
      },
      '/api/mobile/v1/commands/{id}/undo': {
        post: {
          operationId: 'undoMobileCommand',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Receipt after undo completes', content: jsonContent('CommandReceipt') },
            ...errorResponses,
          },
        },
      },
    },
    components: {
      schemas: components,
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'Clerk session token' },
      },
    },
  } as const;
}
