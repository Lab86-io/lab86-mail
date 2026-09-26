import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { convexTest } from 'convex-test';
import JSZip from 'jszip';
import { createAccountExportGet } from '../app/api/account/export/route';
import { api } from '../convex/_generated/api';
import {
  CASCADE_SPECIAL_TABLES,
  EXPORT_SKIPPED_TABLES,
  EXPORT_TABLES,
  USER_BULK_TABLES,
  USER_INLINE_TABLES,
} from '../convex/accounts';
import schema from '../convex/schema';
import { AuthRequiredError } from '../lib/auth/current-user';
import {
  buildDataExport,
  type DataExportDependencies,
  exportFileName,
  readExportPage,
  toWebStream,
} from '../lib/hosted/data-export';
import { exportPageSize, REDACTED, redactExportRow } from '../lib/hosted/export-redaction';
import { RateLimitError } from '../lib/rate-limit';

async function collect(stream: NodeJS.ReadableStream): Promise<ArrayBuffer> {
  return new Response(toWebStream(stream)).arrayBuffer();
}

describe('what the export leaves out', () => {
  test('secrets are removed at any depth, and derived data and mail bodies are dropped', () => {
    expect(
      redactExportRow('mcpCredentials', {
        accessTokenEncrypted: 'x',
        masked: 'sk-…1234',
        nested: { encryptedKey: 'y', internalSecret: 'z', totalTokens: 12, list: [{ token: 't' }] },
        embedding: [0.1],
        searchText: 'x',
      }),
    ).toEqual({
      accessTokenEncrypted: REDACTED,
      masked: 'sk-…1234',
      nested: {
        encryptedKey: REDACTED,
        internalSecret: REDACTED,
        totalTokens: 12,
        list: [{ token: REDACTED }],
      },
    });
    expect(redactExportRow('mailOneTimeCodes', { code: '123456', issuer: 'Bank' })).toEqual({
      code: REDACTED,
      issuer: 'Bank',
    });
    expect(redactExportRow('mailCorpusMessages', { subject: 'Hi', textBody: 'x', htmlBody: 'y' })).toEqual({
      subject: 'Hi',
    });
    // The same field name is not a secret elsewhere.
    expect(redactExportRow('briefJobs', { state: 'done' })).toEqual({ state: 'done' });
    expect(redactExportRow('nylasOAuthStates', { state: 's' })).toEqual({ state: REDACTED });
    expect(exportPageSize('documentModels')).toBe(2);
    expect(exportPageSize('userDocs')).toBe(10);
    expect(exportPageSize('albatrossIntents')).toBe(50);
    expect(exportPageSize('mailCorpusMessages')).toBe(100);
  });

  test('the export follows the deletion cascade, and every skip has a reason', () => {
    const cascade = new Set<string>([
      ...USER_INLINE_TABLES,
      ...USER_BULK_TABLES,
      ...Object.keys(CASCADE_SPECIAL_TABLES),
    ]);
    const missing = [...cascade].filter(
      (table) => !EXPORT_TABLES.includes(table) && !(table in EXPORT_SKIPPED_TABLES),
    );
    expect(missing).toEqual([]);
    for (const [table, reason] of Object.entries(EXPORT_SKIPPED_TABLES)) {
      expect(cascade.has(table)).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
    for (const table of ['users', 'boards', 'boardColumns', 'cards', 'albatrossIntents', 'userDocs', 'areas'])
      expect(EXPORT_TABLES).toContain(table);
    expect(new Set(EXPORT_TABLES).size).toBe(EXPORT_TABLES.length);
  });
});

describe('Convex export pages', () => {
  const SECRET = 'export-secret';
  const USER = 'export_user';
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
  });
  const harness = () =>
    convexTest(schema, {
      '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
      '../convex/accounts.ts': () => import('../convex/accounts'),
    });

  test('each table pages by user, with secrets removed', async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (const userId of [USER, 'someone_else'])
        await ctx.db.insert('aiProviderKeys', {
          userId,
          provider: 'openai',
          encryptedKey: 'secret-bytes',
          fingerprint: 'f',
          masked: 'sk-…9',
          createdAt: 1,
          updatedAt: 1,
        });
      for (let i = 0; i < 3; i++)
        await ctx.db.insert('userDocs', {
          userId: USER,
          kind: 'pref',
          key: `k${i}`,
          doc: { value: String(i) },
          createdAt: 1,
          updatedAt: 1,
        });
      await ctx.db.insert('users', {
        clerkUserId: USER,
        email: 'u@example.test',
        name: 'U',
        createdAt: 1,
        updatedAt: 1,
      });
      const boardId = await ctx.db.insert('boards', {
        ownerUserId: USER,
        title: 'Home',
        createdAt: 1,
        updatedAt: 1,
      } as any);
      await ctx.db.insert('boardColumns', { boardId, name: 'Now', order: 0, createdAt: 1, updatedAt: 1 });
    });
    const page = (table: string, cursor: string | null = null, numItems = 100) =>
      t.query(api.accounts.exportUserTablePage, {
        internalSecret: SECRET,
        userId: USER,
        table,
        cursor,
        numItems,
      });

    const keys = await page('aiProviderKeys');
    expect(keys.page).toHaveLength(1);
    expect(keys.page[0]).toMatchObject({ encryptedKey: REDACTED, masked: 'sk-…9', userId: USER });

    const first = await page('userDocs', null, 2);
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    const rest = await page('userDocs', first.continueCursor, 2);
    expect(rest.page).toHaveLength(1);

    expect((await page('users')).page).toEqual([expect.objectContaining({ email: 'u@example.test' })]);
    expect((await page('boards')).page).toEqual([expect.objectContaining({ title: 'Home' })]);
    expect((await page('boardColumns')).page).toEqual([expect.objectContaining({ name: 'Now' })]);
    expect(await t.query(api.accounts.exportTableList, { internalSecret: SECRET })).toEqual([
      ...EXPORT_TABLES,
    ]);
    await expect(page('rateLimits')).rejects.toThrow('not part of the export');
    await expect(
      t.query(api.accounts.exportUserTablePage, {
        internalSecret: 'wrong',
        userId: USER,
        table: 'users',
        cursor: null,
        numItems: 1,
      }),
    ).rejects.toThrow();
  });
});

function fakeExport(pages: Record<string, unknown[][]>): DataExportDependencies {
  return {
    tables: async () => Object.keys(pages),
    page: async ({ table, cursor }) => {
      const index = cursor ? Number(cursor) : 0;
      const all = pages[table];
      return {
        page: all[index] ?? [],
        isDone: index >= all.length - 1,
        continueCursor: String(index + 1),
      };
    },
    now: () => new Date('2026-09-26T12:00:00Z'),
  };
}

describe('the ZIP', () => {
  test('it holds a README, one JSON file per table, and a summary with row counts', async () => {
    const built = await buildDataExport(
      'u',
      fakeExport({ areas: [[{ name: 'Home' }], [{ name: 'Work' }]], cards: [[]] }),
    );
    expect(built.fileName).toBe('albatross-export-2026-09-26.zip');
    const zip = await JSZip.loadAsync(await collect(built.stream));
    expect(Object.keys(zip.files).sort()).toEqual(
      ['README.txt', 'data/', 'data/areas.json', 'data/cards.json', 'summary.json'].sort(),
    );
    expect(JSON.parse(await zip.file('data/areas.json')!.async('string'))).toEqual([
      { name: 'Home' },
      { name: 'Work' },
    ]);
    expect(JSON.parse(await zip.file('data/cards.json')!.async('string'))).toEqual([]);
    const summary = JSON.parse(await zip.file('summary.json')!.async('string'));
    expect(summary.files).toEqual([
      { file: 'data/areas.json', rows: 2 },
      { file: 'data/cards.json', rows: 0 },
    ]);
    const readme = await zip.file('README.txt')!.async('string');
    expect(readme).toContain('Albatross data export');
    expect(readme).toContain(REDACTED);
    expect(readme).not.toMatch(/\bAI\b/);
    expect(exportFileName(new Date('2031-01-02T00:00:00Z'))).toBe('albatross-export-2031-01-02.zip');
  });

  test('a page that is too large is read again at half the size', async () => {
    const sizes: number[] = [];
    const page = mock(async (input: { numItems: number }) => {
      sizes.push(input.numItems);
      if (input.numItems > 25) throw new Error('Too many bytes read');
      return { page: [1], isDone: true, continueCursor: '' };
    });
    await readExportPage({ page }, { userId: 'u', table: 'x', cursor: null, numItems: 100 });
    expect(sizes).toEqual([100, 50, 25]);
    const always = mock(async () => {
      throw new Error('down');
    });
    await expect(
      readExportPage({ page: always }, { userId: 'u', table: 'x', cursor: null, numItems: 2 }),
    ).rejects.toThrow('down');
    expect(always).toHaveBeenCalledTimes(2);
  });

  test('the web stream carries text and byte chunks, and ends on an error', async () => {
    const { PassThrough } = await import('node:stream');
    const source = new PassThrough();
    const read = new Response(toWebStream(source)).text();
    source.write(Buffer.from('ab'));
    source.emit('data', 'cd');
    source.end();
    expect(await read).toBe('abcd');
    const failing = new PassThrough();
    const reading = new Response(toWebStream(failing)).text();
    failing.emit('error', new Error('page failed'));
    await expect(reading).rejects.toThrow('page failed');
  });
});

describe('the export route', () => {
  const user = { userId: 'u', email: 'u@example.test', name: 'U', source: 'clerk' as const };

  test('it streams a ZIP with a download name', async () => {
    const get = createAccountExportGet({
      requireCurrentUser: async () => user,
      enforceUserRateLimit: async () => undefined as any,
      buildDataExport: (userId) => buildDataExport(userId, fakeExport({ areas: [[{ name: 'Home' }]] })),
    });
    const response = await get();
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="albatross-export-2026-09-26.zip"',
    );
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    expect(zip.file('summary.json')).toBeTruthy();
  });

  test('it asks for sign-in, limits repeats, and reports a failure', async () => {
    const signedOut = createAccountExportGet({
      requireCurrentUser: async () => {
        throw new AuthRequiredError();
      },
    });
    expect((await signedOut()).status).toBe(401);
    const limited = createAccountExportGet({
      requireCurrentUser: async () => user,
      enforceUserRateLimit: async () => {
        throw new RateLimitError('Too many exports.', 60_000, 5);
      },
    });
    expect((await limited()).status).toBe(429);
    const error = console.error;
    console.error = () => undefined;
    try {
      const broken = createAccountExportGet({
        requireCurrentUser: async () => user,
        enforceUserRateLimit: async () => undefined as any,
        buildDataExport: async () => {
          throw new Error('convex down');
        },
      });
      expect((await broken()).status).toBe(500);
    } finally {
      console.error = error;
    }
  });
});
