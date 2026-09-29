import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { exportDocument } from '../lib/documents/export';
import {
  __setGoogleDocumentDepsForTest,
  GoogleWriteError,
  updateGoogleNativeFile,
} from '../lib/documents/google';
import { googleErrorReasons, isGoogleAppAccessDenied } from '../lib/documents/google-access';
import {
  __setGoogleWorkingCopyDepsForTest,
  GOOGLE_WORKING_COPY_NOT_APP_FILE,
  saveGoogleWorkingCopy,
} from '../lib/documents/google-working-copy';
import { createDefaultDocumentModel } from '../lib/documents/model';

// Drive scope trim (docs/google-verification/scopes.md): Albatross asks for
// drive.readonly, drive.file, and documents, not the full drive scope. Google
// refuses a Drive write to a file that Albatross did not make, so the two
// Drive writes on such files fail soft.

const access = (async () => ({
  connection: { provider: 'google_drive', connectionId: 'drive' },
  accessToken: 'fixture-token',
})) as any;

const doc = {
  revisionId: 'revision',
  body: {
    content: [
      { startIndex: 1, endIndex: 8, paragraph: { elements: [{ textRun: { content: 'Source\n' } }] } },
    ],
  },
};

function googleError(status: number, reason: string) {
  return Response.json({ error: { code: status, errors: [{ reason }], message: reason } }, { status });
}

function installDocs(options: { name?: string; rename: () => Response }) {
  const calls: Array<{ url: string; method: string }> = [];
  __setGoogleDocumentDepsForTest({
    getCloudFileAccess: access,
    fetch: (async (url: unknown, init?: RequestInit) => {
      const endpoint = String(url);
      const method = init?.method || 'GET';
      calls.push({ url: endpoint, method });
      if (endpoint.includes('/drive/v3/files/') && method === 'PATCH') return options.rename();
      if (endpoint.includes('/drive/v3/files/')) {
        return Response.json({
          name: options.name,
          webViewLink: 'https://docs.google.com/d/doc',
          version: '9',
        });
      }
      if (endpoint.includes('docs.googleapis.com') && method === 'POST') return Response.json({});
      return Response.json(doc);
    }) as any,
  });
  return calls;
}

function save(title: string) {
  return updateGoogleNativeFile({
    userId: 'owner',
    connectionId: 'drive',
    fileId: 'doc',
    kind: 'doc',
    title,
    model: createDefaultDocumentModel('doc', 'Source'),
    expectedProviderVersion: '9',
  });
}

afterEach(() => {
  __setGoogleDocumentDepsForTest();
  __setGoogleWorkingCopyDepsForTest();
});

describe('Doc write-back rename', () => {
  test('a 403 on the rename keeps the saved content and the Google name', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const calls = installDocs({
        name: 'Budget from Google',
        rename: () => googleError(403, 'appNotAuthorizedToFile'),
      });
      const saved = await save('My new name');
      expect(saved).toMatchObject({ title: 'Budget from Google', renameSkipped: true, providerVersion: '9' });
      expect(calls.some((call) => call.url.includes(':batchUpdate'))).toBe(true);
      expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('rename skipped');
    } finally {
      warn.mockRestore();
    }
  });

  test('a skipped rename with no known Google name returns the asked title', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      installDocs({ rename: () => googleError(403, 'appNotAuthorizedToFile') });
      expect(await save('Asked title')).toMatchObject({ title: 'Asked title', renameSkipped: true });
    } finally {
      warn.mockRestore();
    }
  });

  test('an equal name sends no rename, and a good rename reports no skip', async () => {
    const same = installDocs({ name: 'Memo', rename: () => Response.json({ id: 'doc' }) });
    const kept = await save('Memo');
    expect(kept.title).toBe('Memo');
    expect(kept).not.toHaveProperty('renameSkipped');
    expect(same.some((call) => call.method === 'PATCH')).toBe(false);

    const other = installDocs({ name: 'Memo', rename: () => Response.json({ id: 'doc' }) });
    const renamed = await save('Memo, second draft');
    expect(renamed.title).toBe('Memo, second draft');
    expect(renamed).not.toHaveProperty('renameSkipped');
    expect(other.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  test('other rename failures still fail the save', async () => {
    installDocs({ name: 'Memo', rename: () => googleError(500, 'backendError') });
    const failure = await save('Renamed').catch((error) => error);
    expect(failure).toBeInstanceOf(GoogleWriteError);
    expect(failure.status).toBe(500);

    installDocs({ name: 'Memo', rename: () => googleError(401, 'authError') });
    await expect(save('Renamed')).rejects.toThrow('Reconnect Google Drive');
  });

  test('only appNotAuthorizedToFile skips the rename; a limit, a quota, a missing scope, or no reason fails as before', async () => {
    for (const rename of [
      () => googleError(403, 'userRateLimitExceeded'),
      () => googleError(403, 'storageQuotaExceeded'),
      () => googleError(403, 'insufficientFilePermissions'),
      // The user did not allow write access at consent: a reconnect fixes it.
      () => googleError(403, 'insufficientPermissions'),
      () =>
        Response.json(
          { error: { code: 403, details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } },
          { status: 403 },
        ),
      () => new Response('', { status: 403 }),
    ]) {
      installDocs({ name: 'Memo', rename });
      const failure = await save('Renamed').catch((error) => error);
      expect(failure).toBeInstanceOf(GoogleWriteError);
      expect(failure.status).toBe(403);
      expect(failure.message).toContain('Reconnect Google Drive');
    }
  });
});

describe('Office working-copy save', () => {
  let bytes: Uint8Array;
  beforeAll(async () => {
    const exported = await exportDocument({
      documentId: 'fixture',
      title: 'Report',
      kind: 'doc',
      model: createDefaultDocumentModel('doc'),
      currentRevision: 1,
      sourceRefs: [],
      createdAt: 1,
      updatedAt: 1,
    });
    bytes = new Uint8Array(exported.bytes);
  });
  const session = JSON.stringify({
    userId: 'owner',
    connectionId: 'drive',
    fileId: 'original',
    mimeType: 'application/vnd.google-apps.document',
    etag: 'etag1',
    version: '1',
    expiresAt: Date.now() + 60_000,
  });

  function installWorkingCopy(upload: () => Response) {
    __setGoogleWorkingCopyDepsForTest({
      getCloudFileAccess: access,
      encryptSecret: (value) => value,
      decryptSecret: (value) => value,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        if (init?.method === 'PUT') return upload();
        return Response.json({
          id: 'original',
          title: 'Report',
          mimeType: 'application/vnd.google-apps.document',
          etag: 'etag1',
          version: '1',
          editable: true,
        });
      }) as any,
    });
  }

  const saveCopy = () => saveGoogleWorkingCopy({ userId: 'owner', session, bytes, extension: 'docx' });

  test('a file that Albatross did not make gets a clear error, not a raw 403', async () => {
    installWorkingCopy(() => googleError(403, 'appNotAuthorizedToFile'));
    const failure = await saveCopy().catch((error) => error);
    expect(failure.message).toBe(GOOGLE_WORKING_COPY_NOT_APP_FILE);
    expect(failure.status).toBe(403);
    expect(GOOGLE_WORKING_COPY_NOT_APP_FILE).toContain('Albatross has no write access to this file');
  });

  test('a rate limit, a quota, a user permission, a missing scope, or no reason keeps the old 403 error', async () => {
    for (const upload of [
      () => googleError(403, 'userRateLimitExceeded'),
      () => googleError(403, 'storageQuotaExceeded'),
      () => googleError(403, 'insufficientFilePermissions'),
      () => googleError(403, 'insufficientPermissions'),
      () => new Response('forbidden', { status: 403 }),
    ]) {
      installWorkingCopy(upload);
      const failure = await saveCopy().catch((error) => error);
      expect(failure.message).not.toBe(GOOGLE_WORKING_COPY_NOT_APP_FILE);
      expect(failure.message).toContain('Google write access is missing');
      expect(failure.status).toBe(403);
    }
  });

  test('an expired sign-in keeps its own error', async () => {
    installWorkingCopy(() => googleError(401, 'authError'));
    await expect(saveCopy()).rejects.toThrow('Reconnect Google Drive');
  });

  test('a file that Albatross made saves as before', async () => {
    installWorkingCopy(() => Response.json({ id: 'original', version: '2', etag: 'etag2' }));
    const saved = await saveCopy();
    expect(saved.providerVersion).toBe('2');
  });

  test('a changed original, a Google failure, and a save with no version keep their errors', async () => {
    installWorkingCopy(() => new Response('', { status: 412 }));
    const conflict = await saveCopy().catch((error) => error);
    expect(conflict.status).toBe(409);
    expect(conflict.message).toContain('The original changed in Google');

    installWorkingCopy(() => googleError(500, 'backendError'));
    const failed = await saveCopy().catch((error) => error);
    expect(failed.status).toBe(502);
    expect(failed.message).toContain('Your edited copy is still available to retry');

    installWorkingCopy(() => Response.json({ id: 'original' }));
    const unversioned = await saveCopy().catch((error) => error);
    expect(unversioned.status).toBe(502);
    expect(unversioned.message).toContain('did not return its new version');
  });
});

describe('Google 403 reasons', () => {
  test('reads the reasons of errors[] and details[], and ignores bodies with none', () => {
    expect(
      googleErrorReasons({
        error: { errors: [{ reason: 'appNotAuthorizedToFile' }, {}], details: [{ reason: 'X' }, null] },
      }),
    ).toEqual(['appNotAuthorizedToFile', 'X']);
    expect(googleErrorReasons(null)).toEqual([]);
    expect(googleErrorReasons('not json')).toEqual([]);
    expect(googleErrorReasons({ error: { errors: 'bad' } })).toEqual([]);
  });

  test('only appNotAuthorizedToFile on a 403 counts', () => {
    expect(isGoogleAppAccessDenied(403, ['appNotAuthorizedToFile'])).toBe(true);
    expect(isGoogleAppAccessDenied(403, ['userRateLimitExceeded', 'appNotAuthorizedToFile'])).toBe(true);
    expect(isGoogleAppAccessDenied(403, ['insufficientPermissions'])).toBe(false);
    expect(isGoogleAppAccessDenied(403, ['ACCESS_TOKEN_SCOPE_INSUFFICIENT'])).toBe(false);
    expect(isGoogleAppAccessDenied(403, ['storageQuotaExceeded'])).toBe(false);
    expect(isGoogleAppAccessDenied(403, [])).toBe(false);
    expect(isGoogleAppAccessDenied(401, ['appNotAuthorizedToFile'])).toBe(false);
  });
});
