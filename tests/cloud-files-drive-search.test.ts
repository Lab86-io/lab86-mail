import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cloudFileBrowseErrorResponse } from '../app/api/files/browse/route';
import {
  __setCloudFileBrowseDepsForTest,
  browseCloudFiles,
  CloudFileProviderError,
  googleDriveEndpoint,
  googleFailure,
} from '../lib/files/browse';

// Repro of the 2026-09-30 demo bug: Files, Google Drive folder "Albatross
// review", search "marigold-quasar" gave "Files could not refresh" and the log
// said `status: 403, reason: 'forbidden'`. The search sent `orderBy` with a
// `fullText` query. Drive refuses that sort with a 403 `forbidden`.

const FIELDS =
  'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,thumbnailLink,owners(displayName))';

function driveUrl(params: Record<string, string>) {
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

const SEARCH_URL = driveUrl({
  q: "trashed = false and (name contains 'marigold-quasar' or fullText contains 'marigold-quasar')",
  fields: FIELDS,
  pageSize: '100',
  supportsAllDrives: 'true',
  includeItemsFromAllDrives: 'true',
});

function installDrive(answer: (url: string) => Response = () => Response.json({ files: [] })) {
  const requests: string[] = [];
  const accessed = mock(async (..._args: unknown[]) => undefined);
  __setCloudFileBrowseDepsForTest({
    getCloudFileAccess: (async () => ({
      connection: {
        connectionId: 'google_drive_61b2330',
        provider: 'google_drive',
        status: 'connected',
        scopes: [],
      },
      accessToken: 'drive-token',
    })) as any,
    markCloudFileConnectionAccess: accessed as any,
    fetch: (async (url: string | URL | Request) => {
      requests.push(String(url));
      return answer(String(url));
    }) as any,
  });
  return { requests, accessed };
}

afterEach(() => __setCloudFileBrowseDepsForTest());

describe('Google Drive search request', () => {
  test('a search from the Drive root sends the exact URL: text query, no sort order', async () => {
    const { requests } = installDrive();
    await browseCloudFiles({
      userId: 'user-1',
      connectionId: 'google_drive_61b2330',
      query: 'marigold-quasar',
    });
    expect(requests).toEqual([SEARCH_URL]);
    expect(new URL(requests[0]).searchParams.has('orderBy')).toBe(false);
  });

  test('a search from an open folder sends the same URL and no folder lookup', async () => {
    const { requests } = installDrive();
    const page = await browseCloudFiles({
      userId: 'user-1',
      connectionId: 'google_drive_61b2330',
      folderId: 'folder-albatross-review',
      query: '  marigold-quasar ',
    });
    expect(requests).toEqual([SEARCH_URL]);
    expect(page.items).toEqual([]);
  });

  test('a folder page without a query keeps the folder clause and the sort order', () => {
    expect(googleDriveEndpoint({ folderId: 'folder-albatross-review', pageSize: 50 })).toBe(
      driveUrl({
        q: "trashed = false and 'folder-albatross-review' in parents",
        fields: FIELDS,
        pageSize: '50',
        orderBy: 'folder,name_natural',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      }),
    );
    expect(googleDriveEndpoint({ folderId: 'shared', driveId: 'drive-1', cursor: 'next' })).toBe(
      driveUrl({
        q: "trashed = false and 'shared' in parents",
        fields: FIELDS,
        pageSize: '100',
        orderBy: 'folder,name_natural',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        corpora: 'drive',
        driveId: 'drive-1',
        pageToken: 'next',
      }),
    );
  });

  test('a search page with a cursor keeps the relevance order', () => {
    const url = new URL(googleDriveEndpoint({ query: 'plan', cursor: 'page-2' }));
    expect(url.searchParams.get('pageToken')).toBe('page-2');
    expect(url.searchParams.has('orderBy')).toBe(false);
  });
});

describe('Google Drive error mapping', () => {
  const failure = (status: number, reason?: string, message = '') =>
    googleFailure(
      new Response(null, { status }),
      reason || message ? { error: { message, errors: reason ? [{ reason }] : [] } } : {},
    );

  test('the sort refusal is a request error, not a reconnect and not a retry', async () => {
    const sortRefusal =
      'Sorting is not supported for queries with fullText terms. Results are always in descending relevance order.';
    const { accessed } = installDrive(() =>
      Response.json(
        {
          error: { code: 403, message: sortRefusal, errors: [{ reason: 'forbidden', message: sortRefusal }] },
        },
        { status: 403 },
      ),
    );
    const error = await browseCloudFiles({
      userId: 'user-1',
      connectionId: 'google_drive_61b2330',
      query: 'marigold-quasar',
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(CloudFileProviderError);
    expect(error).toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
      providerStatus: 403,
      providerReason: 'forbidden',
    });
    expect(error.message).toContain('Sorting is not supported');
    expect((accessed.mock.calls[0] as unknown[])[3]).toEqual({ reconnect: false });

    const response = cloudFileBrowseErrorResponse(error);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
      reconnect: false,
      retryable: false,
    });
  });

  test('each Google status and reason maps to one Files error', () => {
    expect(failure(401, 'authError')).toMatchObject({ status: 409, code: 'RECONNECT_REQUIRED' });
    expect(failure(403, 'insufficientPermissions')).toMatchObject({
      status: 409,
      code: 'RECONNECT_REQUIRED',
    });
    expect(failure(403, 'appNotAuthorizedToFile')).toMatchObject({ status: 409, code: 'RECONNECT_REQUIRED' });
    for (const reason of [
      'userRateLimitExceeded',
      'rateLimitExceeded',
      'dailyLimitExceeded',
      'sharingRateLimitExceeded',
    ])
      expect(failure(403, reason)).toMatchObject({ status: 429, code: 'RATE_LIMITED', providerStatus: 403 });
    expect(failure(429)).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(failure(403, 'forbidden', 'Nope')).toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
      message: 'Google Drive refused this request: Nope',
    });
    expect(failure(403)).toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
      message: 'Google Drive refused this request.',
    });
    expect(failure(400, 'invalidParameter', 'Bad q')).toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
    expect(failure(404, 'notFound')).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(failure(500, 'backendError')).toMatchObject({ status: 503, code: 'UNAVAILABLE' });
    expect(failure(418)).toMatchObject({ status: 502, code: 'UNAVAILABLE' });
  });
});
