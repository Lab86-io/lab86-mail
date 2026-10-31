import { z } from 'zod';
import { MobileCommandVariantSchemas, MobileContractV1 } from './contract';

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

const notFoundResponse = {
  description: 'Unknown item, or a user outside the Needs you rollout',
  content: jsonContent('MobileErrorEnvelope'),
};

const obligationIdParameter = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1, maxLength: 240 },
} as const;

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
        'mail.snooze': '#/components/schemas/MailSnoozeCommand',
        'mail.unsnooze': '#/components/schemas/MailUnsnoozeCommand',
        'mail.restore': '#/components/schemas/MailRestoreCommand',
        'calendar.create': '#/components/schemas/CalendarCreateCommand',
        'task.setCompleted': '#/components/schemas/TaskSetCompletedCommand',
        'work.setHorizon': '#/components/schemas/WorkSetHorizonCommand',
        'work.listAdd': '#/components/schemas/WorkListAddCommand',
        'work.listToggle': '#/components/schemas/WorkListToggleCommand',
        'work.listRemove': '#/components/schemas/WorkListRemoveCommand',
        'work.metricLog': '#/components/schemas/WorkMetricLogCommand',
        'work.milestoneToggle': '#/components/schemas/WorkMilestoneToggleCommand',
        'work.setShape': '#/components/schemas/WorkSetShapeCommand',
      },
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
      '/api/mobile/v1/assistant/route': {
        post: {
          operationId: 'postAssistantRoute',
          requestBody: { required: true, content: jsonContent('AssistantRouteRequest') },
          responses: {
            '200': {
              description: 'Ask or hold, with confidence',
              content: jsonContent('AssistantRouteVerdict'),
            },
            ...errorResponses,
          },
        },
      },
      '/api/mobile/v1/contacts/recipients': {
        get: {
          operationId: 'getMobileRecipientSuggestions',
          parameters: [
            {
              name: 'q',
              in: 'query',
              required: false,
              description: 'What the user typed. Empty means the top people for a focused field.',
              schema: { type: 'string', maxLength: 200 },
            },
            {
              name: 'fromAccountID',
              in: 'query',
              required: false,
              description: 'The selected From mailbox. People seen on it rank higher.',
              schema: { type: 'string', maxLength: 240 },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 10 },
            },
            {
              name: 'exclude',
              in: 'query',
              required: false,
              description: 'Addresses already in the field; repeat the parameter or separate with commas.',
              schema: { type: 'array', items: { type: 'string' }, maxItems: 50 },
              style: 'form',
              explode: true,
            },
          ],
          responses: {
            '200': {
              description: 'Ranked recipients, best first',
              content: jsonContent('RecipientSuggestionPage'),
            },
            ...errorResponses,
          },
        },
      },
      '/api/mobile/v1/contacts/status': {
        get: {
          operationId: 'getMobileContactStatus',
          responses: {
            '200': {
              description: 'Contact sync state and reconnect need for each mailbox',
              content: jsonContent('ContactStatusPage'),
            },
            ...errorResponses,
          },
        },
      },
      '/api/mobile/v1/contacts/resync': {
        post: {
          operationId: 'postMobileContactResync',
          requestBody: { required: true, content: jsonContent('ContactResyncRequest') },
          responses: {
            '200': {
              description: 'Whether a contact pass started',
              content: jsonContent('ContactResyncReceipt'),
            },
            '404': { description: 'Unknown mailbox', content: jsonContent('MobileErrorEnvelope') },
            ...errorResponses,
          },
        },
      },
      '/api/mobile/v1/accounts/{accountID}/send-as': {
        get: {
          operationId: 'getMobileSendAs',
          description:
            'The addresses the mailbox can send from. Put a usable address in the fromAddress field of POST /api/compose.',
          parameters: [
            {
              name: 'accountID',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1, maxLength: 240 },
            },
            {
              name: 'messageID',
              in: 'query',
              required: false,
              description: 'The message a reply or a forward answers. It sets defaultAddress.',
              schema: { type: 'string', minLength: 1, maxLength: 240 },
            },
            {
              name: 'threadID',
              in: 'query',
              required: false,
              description:
                'The thread of a reply. Without messageID, its newest message sets defaultAddress.',
              schema: { type: 'string', minLength: 1, maxLength: 240 },
            },
          ],
          responses: {
            '200': {
              description: 'The send-as addresses and the address to select first',
              content: jsonContent('MobileSendAsPage'),
            },
            '404': { description: 'Unknown mailbox', content: jsonContent('MobileErrorEnvelope') },
            ...errorResponses,
          },
        },
      },
      '/api/mobile/v1/needs-you': {
        get: {
          operationId: 'getMobileNeedsYou',
          description:
            'The Needs you items: open, snoozed, and closed today. enabled is false for a user outside the rollout; the app then hides the screen.',
          responses: {
            '200': { description: 'The Needs you snapshot', content: jsonContent('NeedsYouSnapshot') },
            ...errorResponses,
          },
        },
      },
      '/api/mobile/v1/needs-you/{id}': {
        post: {
          operationId: 'postMobileNeedsYouAction',
          description:
            'Done, Later (until), Not mine, Undo (inside undoUntil), or an RSVP answer (response) for one item.',
          parameters: [obligationIdParameter],
          requestBody: { required: true, content: jsonContent('ObligationActionRequest') },
          responses: {
            '200': {
              description: 'The item after the action',
              content: jsonContent('ObligationActionResponse'),
            },
            '404': notFoundResponse,
            ...errorResponses,
          },
        },
      },
      '/api/mobile/v1/needs-you/{id}/draft': {
        post: {
          operationId: 'postMobileNeedsYouDraft',
          description:
            'The prepared reply of a mail reply item. The server keeps it for the current message.',
          parameters: [obligationIdParameter],
          responses: {
            '200': { description: 'The prepared reply', content: jsonContent('ObligationDraftResponse') },
            '404': notFoundResponse,
            ...errorResponses,
          },
        },
      },
      '/api/mobile/v1/needs-you/{id}/reply': {
        post: {
          operationId: 'postMobileNeedsYouReply',
          description:
            'Sends the reply in the thread with the undo-send delay and closes the item as sent_reply.',
          parameters: [obligationIdParameter],
          requestBody: { required: true, content: jsonContent('ObligationReplyRequest') },
          responses: {
            '200': { description: 'The closed item', content: jsonContent('ObligationReplyResponse') },
            '404': notFoundResponse,
            ...errorResponses,
          },
        },
      },
      '/api/mobile/v1/needs-you/{id}/albatross': {
        post: {
          operationId: 'postMobileNeedsYouAlbatross',
          description:
            'Start in Albatross: the item goes into its Albatross and reaches a run, or a new Albatross starts from it.',
          parameters: [obligationIdParameter],
          responses: {
            '200': {
              description: 'The Albatross of the item',
              content: jsonContent('ObligationAlbatrossResponse'),
            },
            '404': notFoundResponse,
            ...errorResponses,
          },
        },
      },
      '/api/mobile/v1/today/summary': {
        get: {
          operationId: 'getMobileTodaySummary',
          responses: {
            '200': {
              description: 'Lead line, next move, next meeting, and edition time, for widgets',
              content: jsonContent('TodaySummary'),
            },
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
