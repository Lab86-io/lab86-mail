import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import {
  consumeOAuthCompletion,
  hashOAuthCompletionToken,
  OAUTH_COMPLETION_TTL_MS,
  saveOAuthCompletion,
} from '../lib/security/oauth-completions';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/oauthCompletions.ts': () => import('../convex/oauthCompletions'),
};

const SECRET = 'oauth-completion-secret';
const START = new Date('2026-09-01T00:00:00Z').getTime();
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

beforeEach(() => setSystemTime(new Date(START)));
afterEach(() => setSystemTime());

function save(t: ReturnType<typeof convexTest>, overrides: Record<string, unknown> = {}) {
  return t.mutation(api.oauthCompletions.save, {
    internalSecret: SECRET,
    userId: 'user_1',
    kind: 'mail',
    tokenHash: 'hash_1',
    payloadEncrypted: 'enc:payload',
    expiresAt: START + OAUTH_COMPLETION_TTL_MS,
    ...overrides,
  } as any);
}

function consume(t: ReturnType<typeof convexTest>, overrides: Record<string, unknown> = {}) {
  return t.mutation(api.oauthCompletions.consume, {
    internalSecret: SECRET,
    userId: 'user_1',
    kind: 'mail',
    tokenHash: 'hash_1',
    ...overrides,
  } as any);
}

describe('oauthCompletions (Convex)', () => {
  test('returns the payload once, to the user and flow that own it', async () => {
    const t = convexTest(schema, modules);
    await save(t);

    expect(await consume(t, { userId: 'attacker' })).toBeNull();
    expect(await consume(t, { kind: 'mcp' })).toBeNull();
    // A wrong caller does not burn the owner's completion.
    expect(await consume(t)).toEqual({ payloadEncrypted: 'enc:payload' });
    expect(await consume(t)).toBeNull();
  });

  test('drops an expired completion when it is redeemed', async () => {
    const t = convexTest(schema, modules);
    await save(t);
    setSystemTime(new Date(START + OAUTH_COMPLETION_TTL_MS + 1));

    expect(await consume(t)).toBeNull();
    expect(await t.run((ctx) => ctx.db.query('oauthCompletions').collect())).toHaveLength(0);
  });

  test('replaces a row with the same token hash', async () => {
    const t = convexTest(schema, modules);
    await save(t);
    await save(t, { payloadEncrypted: 'enc:second' });

    const rows = await t.run((ctx) => ctx.db.query('oauthCompletions').collect());
    expect(rows.map((row) => row.payloadEncrypted)).toEqual(['enc:second']);
  });

  test('refuses callers without the internal secret', async () => {
    const t = convexTest(schema, modules);
    await expect(save(t, { internalSecret: 'wrong' })).rejects.toThrow();
    await expect(consume(t, { internalSecret: undefined })).rejects.toThrow();
  });

  test('the sweep deletes expired rows and keeps live rows', async () => {
    const t = convexTest(schema, modules);
    await save(t, { tokenHash: 'old', expiresAt: START + 1_000 });
    await save(t, { tokenHash: 'live', expiresAt: START + 3_600_000 });
    setSystemTime(new Date(START + 60_000));

    expect(await t.mutation(internal.oauthCompletions.sweepExpired, {})).toEqual({ deleted: 1 });
    const rows = await t.run((ctx) => ctx.db.query('oauthCompletions').collect());
    expect(rows.map((row) => row.tokenHash)).toEqual(['live']);
  });

  test('a full sweep batch schedules the next page', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert('oauthCompletions', {
          userId: 'user_1',
          kind: 'mcp',
          tokenHash: `hash_${index}`,
          payloadEncrypted: 'x',
          expiresAt: START,
          createdAt: START,
        });
      }
    });
    setSystemTime(new Date(START + 1_000));

    expect(await t.mutation(internal.oauthCompletions.sweepExpired, {})).toEqual({ deleted: 100 });
    const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(scheduled.some((job) => job.name.includes('sweepExpired'))).toBe(true);
  });
});

describe('oauth completion helpers', () => {
  function fakeDependencies() {
    const calls: Array<{ fn: unknown; args: Record<string, any> }> = [];
    const rows = new Map<string, string>();
    return {
      calls,
      deps: {
        convexMutation: (async (fn: unknown, args: Record<string, any>) => {
          calls.push({ fn, args });
          if ('payloadEncrypted' in args) {
            rows.set(args.tokenHash, args.payloadEncrypted);
            return { ok: true };
          }
          const payloadEncrypted = rows.get(args.tokenHash);
          rows.delete(args.tokenHash);
          return payloadEncrypted ? { payloadEncrypted } : null;
        }) as any,
        encryptSecret: (value: string) => `enc:${value}`,
        decryptSecret: (value: string) => value.replace(/^enc:/, ''),
        now: () => START,
        randomToken: () => 'token_value_1',
      },
    };
  }

  test('stores a hash and an encrypted payload, never the token or the code', async () => {
    const { calls, deps } = fakeDependencies();

    const token = await saveOAuthCompletion(
      { userId: 'user_1', kind: 'mail', payload: { code: 'code_1', provider: 'google' } },
      deps,
    );

    expect(token).toBe('token_value_1');
    expect(calls[0].args).toEqual({
      userId: 'user_1',
      kind: 'mail',
      tokenHash: hashOAuthCompletionToken('token_value_1'),
      payloadEncrypted: 'enc:{"code":"code_1","provider":"google"}',
      expiresAt: START + OAUTH_COMPLETION_TTL_MS,
    });
    expect(JSON.stringify(calls[0].args)).not.toContain('token_value_1');
  });

  test('redeems the payload with the hash of the token once', async () => {
    const { calls, deps } = fakeDependencies();
    const token = await saveOAuthCompletion({ userId: 'user_1', kind: 'mcp', payload: { code: 'c' } }, deps);

    expect(
      await consumeOAuthCompletion<{ code: string }>(
        { userId: 'user_1', kind: 'mcp', completionToken: token },
        deps,
      ),
    ).toEqual({
      code: 'c',
    });
    expect(calls[1].args).toEqual({
      userId: 'user_1',
      kind: 'mcp',
      tokenHash: hashOAuthCompletionToken(token),
    });
    expect(
      await consumeOAuthCompletion({ userId: 'user_1', kind: 'mcp', completionToken: token }, deps),
    ).toBeNull();
  });

  test('the hash is a stable SHA-256 hex digest', () => {
    expect(hashOAuthCompletionToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
