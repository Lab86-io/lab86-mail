import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { exportDocument } from '../lib/documents/export';
import {
  __setGoogleOfficeDepsForTest,
  openGoogleOfficeFile,
  saveGoogleOfficeFile,
} from '../lib/documents/google-office';
import { createDefaultDocumentModel } from '../lib/documents/model';

const input = { userId: 'owner', connectionId: 'connection', fileId: 'google-file' };
const token = (version: string, extra = {}) =>
  JSON.stringify({ ...input, version, etag: `etag-${version}`, ...extra });
let bytes: Uint8Array;
beforeAll(async () => {
  bytes = new Uint8Array(
    (
      await exportDocument({
        documentId: 'fixture',
        title: 'Fixture',
        kind: 'doc',
        model: createDefaultDocumentModel('doc'),
        currentRevision: 1,
        sourceRefs: [],
        createdAt: 1,
        updatedAt: 1,
      })
    ).bytes,
  );
});
afterEach(() => __setGoogleOfficeDepsForTest());
const file = (overrides: any = {}) =>
  ({
    documentId: 'stable-copy',
    extension: 'docx',
    currentRevision: 2,
    google: {
      connectionId: input.connectionId,
      fileId: input.fileId,
      session: token('1'),
      syncedRevision: 1,
    },
    lastWopiSave: { id: 'receipt', revision: 2 },
    version: { url: 'https://storage.test/private' },
    ...overrides,
  }) as any;
function setup(overrides: Parameters<typeof __setGoogleOfficeDepsForTest>[0] = {}) {
  __setGoogleOfficeDepsForTest({
    decryptSecret: (s) => s,
    downloadGoogleWorkingCopy: async () => ({
      bytes,
      extension: 'docx',
      title: 'Fixture',
      session: token('1'),
    }),
    getOfficeFile: async () => file(),
    convexQuery: (async () => null) as any,
    convexMutation: (async () => ({ ok: true })) as any,
    storeOfficeBytes: async () => 'uploaded',
    createOfficeFile: (async () => ({})) as any,
    fetch: async () => new Response(new Uint8Array(bytes)),
    saveGoogleWorkingCopy: async () => ({
      session: token('2'),
      fileId: input.fileId,
      webUrl: 'https://docs.google.com/document/d/google-file/edit',
    }),
    ...overrides,
  });
}
describe('Google Office working-copy identity and concurrency', () => {
  test('identity excludes revision and remains separated by owner and connection', async () => {
    const created: any[] = [];
    let providerVersion = '1';
    setup({
      getOfficeFile: async () => null,
      downloadGoogleWorkingCopy: async () => ({
        bytes,
        extension: 'docx',
        title: 'Fixture',
        session: token(providerVersion),
      }),
      createOfficeFile: (async (args: any) => {
        created.push(args);
        return args;
      }) as any,
    });
    const first = await openGoogleOfficeFile(input);
    providerVersion = '2';
    expect((await openGoogleOfficeFile(input)).documentId).toBe(first.documentId);
    expect((await openGoogleOfficeFile({ ...input, userId: 'other' })).documentId).not.toBe(first.documentId);
    expect((await openGoogleOfficeFile({ ...input, connectionId: 'other' })).documentId).not.toBe(
      first.documentId,
    );
    expect(created[0]).not.toHaveProperty('connectionId');
    expect(created[1].google.session).toBe(token('2'));
  });
  test('an older etag-derived identity is reused instead of multiplying copies', async () => {
    let reads = 0;
    setup({
      getOfficeFile: async () => (++reads === 1 ? null : file({ documentId: 'legacy-copy' })),
      convexQuery: (async () => ({ documentId: 'legacy-copy' })) as any,
    });
    expect(await openGoogleOfficeFile(input)).toEqual({ documentId: 'legacy-copy', created: false });
  });
  test('opening the same provider revision retains unsynced local changes', async () => {
    let args: any;
    setup({
      convexMutation: (async (_fn: any, value: any) => {
        args = value;
        return { ok: true };
      }) as any,
    });
    expect((await openGoogleOfficeFile(input)).created).toBe(false);
    expect(args).toMatchObject({ expectedSession: token('1'), syncedRevision: 1 });
    setup({ convexMutation: (async () => ({ ok: false })) as any });
    await expect(openGoogleOfficeFile(input)).rejects.toThrow('changed while opening');
  });
  test('Google changes cannot overwrite dirty or actively edited local content', async () => {
    const downloadGoogleWorkingCopy = async () => ({
      bytes,
      extension: 'docx' as const,
      title: 'Fixture',
      session: token('2'),
    });
    setup({ downloadGoogleWorkingCopy });
    await expect(openGoogleOfficeFile(input)).rejects.toThrow('edits are preserved');
    setup({
      downloadGoogleWorkingCopy,
      getOfficeFile: async () =>
        file({ currentRevision: 1, wopiLock: { value: 'lock', expiresAt: Date.now() + 10000 } }),
    });
    await expect(openGoogleOfficeFile(input)).rejects.toThrow('edits are preserved');
  });
  test('a clean copy imports changed Google content with atomic version/session checks', async () => {
    let args: any;
    const overrides = {
      downloadGoogleWorkingCopy: async () => ({
        bytes,
        extension: 'docx' as const,
        title: 'Fixture',
        session: token('2'),
      }),
      getOfficeFile: async () => file({ currentRevision: 1 }),
      convexMutation: (async (_fn: any, value: any) => {
        args = value;
        return { ok: true };
      }) as any,
    };
    setup(overrides);
    expect((await openGoogleOfficeFile(input)).documentId).toBe('stable-copy');
    expect(args).toMatchObject({
      expectedRevision: 1,
      expectedSession: token('1'),
      session: token('2'),
      storageId: 'uploaded',
    });
    setup({ ...overrides, convexMutation: (async () => ({ ok: false })) as any });
    await expect(openGoogleOfficeFile(input)).rejects.toThrow('changed while importing');
  });
  test('save requires a matching durable receipt and preserves the original identity', async () => {
    setup();
    await expect(saveGoogleOfficeFile('owner', 'stable-copy', '')).rejects.toThrow('Save the editor');
    await expect(saveGoogleOfficeFile('owner', 'stable-copy', 'wrong')).rejects.toThrow('still saving');
    expect(await saveGoogleOfficeFile('owner', 'stable-copy', 'receipt')).toMatchObject({
      ok: true,
      revision: 2,
    });
    setup({ getOfficeFile: async () => null });
    await expect(saveGoogleOfficeFile('owner', 'stable-copy', 'receipt')).rejects.toThrow('not found');
    setup({ getOfficeFile: async () => file({ currentRevision: 1 }) });
    expect(await saveGoogleOfficeFile('owner', 'stable-copy', 'receipt')).toEqual({ ok: true, revision: 1 });
  });
  test('a competing token refresh preserves the successful Google write token and reports conflict', async () => {
    let reads = 0;
    const writes: any[] = [];
    const concurrentToken = token('1', { refreshed: true });
    setup({
      getOfficeFile: async () =>
        reads++ === 0
          ? file()
          : file({ currentRevision: 3, google: { ...file().google, session: concurrentToken } }),
      convexMutation: (async (_fn: any, args: any) => {
        writes.push(args);
        return { ok: writes.length > 1 };
      }) as any,
    });
    await expect(saveGoogleOfficeFile('owner', 'stable-copy', 'receipt')).rejects.toThrow(
      'Google saved this revision',
    );
    expect(writes[1]).toMatchObject({
      expectedSession: concurrentToken,
      session: token('2'),
      syncedRevision: 2,
    });
  });
  test.each([
    '3',
    'invalid',
  ])('reconciliation never replaces newer or unrecognized provider version %s', async (providerVersion) => {
    let reads = 0;
    const writes: any[] = [];
    setup({
      getOfficeFile: async () =>
        reads++ === 0 ? file() : file({ google: { ...file().google, session: token(providerVersion) } }),
      convexMutation: (async (_fn: any, args: any) => {
        writes.push(args);
        return { ok: writes.length > 1 };
      }) as any,
    });
    await expect(saveGoogleOfficeFile('owner', 'stable-copy', 'receipt')).rejects.toThrow('Google saved');
    if (providerVersion === 'invalid') expect(writes).toHaveLength(1);
    else
      expect(writes[1]).toMatchObject({
        session: token('3'),
        expectedSession: token('3'),
        providerVersion: '3',
        syncedRevision: 1,
      });
  });
  test('reconciliation is conditional, bounded, and stops for removed or unrelated copies', async () => {
    let writes = 0;
    setup({
      convexMutation: (async () => {
        writes++;
        return { ok: false };
      }) as any,
    });
    await expect(saveGoogleOfficeFile('owner', 'stable-copy', 'receipt')).rejects.toThrow('Google saved');
    expect(writes).toBe(4);
    for (const current of [
      null,
      file({ google: { ...file().google, session: token('1', { fileId: 'other-file' }) } }),
    ]) {
      let reads = 0;
      setup({
        getOfficeFile: async () => (reads++ === 0 ? file() : current),
        convexMutation: (async () => ({ ok: false })) as any,
      });
      await expect(saveGoogleOfficeFile('owner', 'stable-copy', 'receipt')).rejects.toThrow('Google saved');
    }
  });
});

test('a durable pending save is reconciled on the next open or save without repeating the Google write', async () => {
  const pending = file({
    google: { ...file().google, pendingSave: { session: token('2'), providerVersion: '2', revision: 2 } },
  });
  const recovered = file({ google: { ...file().google, session: token('2'), syncedRevision: 2 } });
  for (const action of ['open', 'save']) {
    let current = pending;
    setup({
      getOfficeFile: async () => current,
      convexMutation: (async () => {
        current = recovered;
        return { ok: true };
      }) as any,
      downloadGoogleWorkingCopy: async () => ({
        bytes,
        extension: 'docx',
        title: 'Fixture',
        session: token('2'),
      }),
      saveGoogleWorkingCopy: async () => {
        throw new Error('must not repeat completed provider write');
      },
    });
    if (action === 'open') expect((await openGoogleOfficeFile(input)).documentId).toBe('stable-copy');
    else
      expect(await saveGoogleOfficeFile('owner', 'stable-copy', 'receipt')).toEqual({
        ok: true,
        revision: 2,
      });
  }
  setup({ getOfficeFile: async () => pending, convexMutation: (async () => ({ ok: false })) as any });
  await expect(saveGoogleOfficeFile('owner', 'stable-copy', 'receipt')).rejects.toThrow(
    'saved revision is preserved',
  );
});
