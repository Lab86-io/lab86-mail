import { describe, expect, spyOn, test } from 'bun:test';
import { createSendAsGet } from '../app/api/mail/send-as/route';
import { createMobileSendAsGet } from '../app/api/mobile/v1/accounts/[accountID]/send-as/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { mailboxIdentity } from '../lib/mail/send-as';
import {
  ComposeFromErrorCodeSchema,
  ComposeFromFieldsSchema,
  MobileContractV1,
  MobileSendAsPageSchema,
} from '../lib/mobile/v1/contract';
import { mobileOpenAPIV1 } from '../lib/mobile/v1/openapi';
import type { NylasAccountRow } from '../lib/nylas/provider';
import type { SendAsErrorCode, SendAsPage } from '../lib/shared/send-as';

const user = { userId: 'user_send_as', email: 'ann@gmail.com', name: 'Ann', source: 'clerk' as const };
const NOW = new Date('2026-10-01T12:00:00.000Z');

const row = (overrides: Partial<NylasAccountRow> = {}): NylasAccountRow => ({
  userId: user.userId,
  accountId: 'acct-1',
  email: 'ann@gmail.com',
  provider: 'google',
  status: 'connected',
  displayName: 'Ann Lee',
  grantId: 'google:11111111-1111-1111-1111-111111111111',
  scopes: [],
  ...overrides,
});

const page = (overrides: Partial<SendAsPage> = {}): SendAsPage => ({
  accountId: 'acct-1',
  aliasesSupported: true,
  partial: false,
  identities: [
    mailboxIdentity(row()),
    {
      email: 'ann@work.example',
      displayName: 'Ann at Work',
      isPrimary: false,
      isDefault: false,
      verificationStatus: 'accepted',
      replyTo: 'team@work.example',
      hasProviderSignature: true,
      usable: true,
    },
    {
      email: 'side@club.example',
      isPrimary: false,
      isDefault: false,
      verificationStatus: 'pending',
      hasProviderSignature: false,
      usable: false,
    },
  ],
  defaultAddress: 'ann@work.example',
  ...overrides,
});

const params = (accountID: string) => ({ params: Promise.resolve({ accountID }) });

describe('GET /api/mobile/v1/accounts/{accountID}/send-as', () => {
  function handler(overrides: Record<string, unknown> = {}) {
    const calls: any[] = [];
    const get = createMobileSendAsGet({
      requireCurrentUser: async () => user,
      listAccounts: async () => [row(), row({ accountId: 'acct-off', status: 'error' })],
      loadSendAsPage: async (input: unknown) => {
        calls.push(input);
        return page();
      },
      now: () => NOW,
      ...overrides,
    } as any);
    return { get, calls };
  }

  test('returns the typed page for a reply, with the anchor ids passed on', async () => {
    const { get, calls } = handler();
    const response = await get(
      new Request('http://localhost/api/mobile/v1/accounts/acct-1/send-as?messageID=m1&threadID=t1', {
        headers: { 'x-request-id': 'req-1' },
      }),
      params('acct-1'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('req-1');
    const body = await response.json();
    expect(MobileSendAsPageSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({
      version: 1,
      accountID: 'acct-1',
      aliasesSupported: true,
      partial: false,
      defaultAddress: 'ann@work.example',
      serverTime: NOW.toISOString(),
    });
    expect(body.identities).toHaveLength(3);
    expect(calls).toEqual([{ userId: user.userId, account: row(), messageId: 'm1', threadId: 't1' }]);
  });

  test('a new message names no anchor', async () => {
    const { get, calls } = handler();
    await get(
      new Request('http://localhost/api/mobile/v1/accounts/acct-1/send-as?messageID='),
      params('acct-1'),
    );
    expect(calls[0]).toMatchObject({ messageId: undefined, threadId: undefined });
  });

  test('errors: unknown mailbox 404, disconnected 409, long id 400, signed out 401, failure 500', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { get } = handler();
      const url = 'http://localhost/api/mobile/v1/accounts/x/send-as';
      const codeOf = async (response: Response) => [response.status, (await response.json()).error.code];
      expect(await codeOf(await get(new Request(url), params('acct-9')))).toEqual([404, 'NOT_FOUND']);
      expect(await codeOf(await get(new Request(url), params('acct-off')))).toEqual([409, 'CONFLICT']);
      expect(
        await codeOf(await get(new Request(`${url}?messageID=${'m'.repeat(241)}`), params('acct-1'))),
      ).toEqual([400, 'INVALID_REQUEST']);
      const signedOut = handler({
        requireCurrentUser: async () => {
          throw new AuthRequiredError('Sign in required.');
        },
      });
      expect(await codeOf(await signedOut.get(new Request(url), params('acct-1')))).toEqual([
        401,
        'AUTH_REQUIRED',
      ]);
      const failing = handler({
        loadSendAsPage: async () => {
          throw new Error('boom');
        },
      });
      expect(await codeOf(await failing.get(new Request(url), params('acct-1')))).toEqual([
        500,
        'SERVER_ERROR',
      ]);
    } finally {
      error.mockRestore();
    }
  });
});

describe('GET /api/mail/send-as (web composer)', () => {
  function handler(overrides: Record<string, unknown> = {}) {
    const calls: any[] = [];
    const get = createSendAsGet({
      requireCurrentUser: async () => user,
      getAccount: async (_userId: string, account: string) => (account === 'acct-1' ? row() : null),
      loadSendAsPage: async (input: any) => {
        calls.push(input);
        return page();
      },
      ...overrides,
    } as any);
    return { get, calls };
  }

  test('returns the page with ok, and passes the anchor', async () => {
    const { get, calls } = handler();
    const response = await get(new Request('http://localhost/api/mail/send-as?account=acct-1&messageId=m1'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ...page() });
    expect(calls[0]).toMatchObject({ userId: user.userId, messageId: 'm1', threadId: undefined });
  });

  test('a missing account is 400, an unknown one 404, signed out 401, and a failure a fixed 500', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { get } = handler();
      expect((await get(new Request('http://localhost/api/mail/send-as'))).status).toBe(400);
      expect((await get(new Request('http://localhost/api/mail/send-as?account=nope'))).status).toBe(404);
      const signedOut = handler({
        requireCurrentUser: async () => {
          throw new AuthRequiredError('Sign in required.');
        },
      });
      expect(
        (await signedOut.get(new Request('http://localhost/api/mail/send-as?account=acct-1'))).status,
      ).toBe(401);
      const failing = handler({
        loadSendAsPage: async () => {
          throw new Error('Gmail said something private');
        },
      });
      const failed = await failing.get(new Request('http://localhost/api/mail/send-as?account=acct-1'));
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ ok: false, error: 'The From addresses are not available.' });
    } finally {
      error.mockRestore();
    }
  });
});

describe('send-as mobile contract', () => {
  test('the page is strict and needs at least one identity', () => {
    const valid = {
      version: 1 as const,
      accountID: 'acct-1',
      aliasesSupported: false,
      partial: false,
      identities: [mailboxIdentity({ email: 'ann@outlook.example' })],
      defaultAddress: 'ann@outlook.example',
      serverTime: NOW.toISOString(),
    };
    expect(MobileSendAsPageSchema.parse(valid)).toEqual(valid);
    expect(() => MobileSendAsPageSchema.parse({ ...valid, identities: [] })).toThrow();
    expect(() => MobileSendAsPageSchema.parse({ ...valid, extra: true })).toThrow();
    expect(() =>
      MobileSendAsPageSchema.parse({
        ...valid,
        identities: [{ ...valid.identities[0], verificationStatus: 'verificationStatusUnspecified' }],
      }),
    ).toThrow();
  });

  test('the compose From field takes a bare address only, and the codes match the server codes', () => {
    expect(ComposeFromFieldsSchema.parse({ account: 'acct-1', fromAddress: ' ann@work.example ' })).toEqual({
      account: 'acct-1',
      fromAddress: 'ann@work.example',
    });
    expect(ComposeFromFieldsSchema.parse({ account: 'acct-1' })).toEqual({ account: 'acct-1' });
    expect(() =>
      ComposeFromFieldsSchema.parse({ account: 'acct-1', fromAddress: 'Ann <a@b.example>' }),
    ).toThrow();
    const codes: SendAsErrorCode[] = ['from_unknown', 'from_unverified', 'from_unsupported'];
    expect(ComposeFromErrorCodeSchema.options).toEqual(codes);
  });

  test('the OpenAPI document publishes the endpoint and the schemas', () => {
    const document = mobileOpenAPIV1();
    const operation = document.paths['/api/mobile/v1/accounts/{accountID}/send-as'].get;
    expect(operation.operationId).toBe('getMobileSendAs');
    expect(operation.parameters.map((parameter) => [parameter.name, parameter.in])).toEqual([
      ['accountID', 'path'],
      ['messageID', 'query'],
      ['threadID', 'query'],
    ]);
    expect(operation.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/MobileSendAsPage',
    );
    for (const name of [
      'MobileSendAsPage',
      'MobileSendAsIdentity',
      'ComposeFromFields',
      'ComposeFromErrorCode',
    ]) {
      expect(MobileContractV1.schemas).toHaveProperty(name);
      expect(document.components.schemas).toHaveProperty(name);
    }
  });
});
