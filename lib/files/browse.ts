import { fetchCloudFileProvider, getCloudFileAccess, markCloudFileConnectionAccess } from './connections';
import {
  type CloudFilePage,
  escapeGoogleDriveQuery,
  normalizeGoogleDrivePage,
  normalizeOneDrivePage,
} from './providers';

const defaultDependencies = {
  getCloudFileAccess,
  markCloudFileConnectionAccess,
  fetch,
};

let dependencies = defaultDependencies;

export function __setCloudFileBrowseDepsForTest(overrides: Partial<typeof defaultDependencies> = {}) {
  dependencies = { ...defaultDependencies, ...overrides };
}

export class CloudFileProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'INVALID_REQUEST' | 'RECONNECT_REQUIRED' | 'NOT_FOUND' | 'RATE_LIMITED' | 'UNAVAILABLE',
    readonly providerStatus?: number,
    readonly providerReason?: string,
  ) {
    super(message);
    this.name = 'CloudFileProviderError';
  }
}

function boundedQuery(value: string | undefined) {
  return String(value || '')
    .trim()
    .slice(0, 200);
}

function oneDriveEndpoint(input: { folderId?: string; query?: string; cursor?: string }) {
  if (input.cursor) {
    const cursor = new URL(input.cursor);
    if (cursor.origin !== 'https://graph.microsoft.com') {
      throw new Error('Invalid OneDrive page cursor.');
    }
    return cursor.toString();
  }
  const query = boundedQuery(input.query);
  if (query) {
    const escaped = query.replaceAll("'", "''");
    return `https://graph.microsoft.com/v1.0/me/drive/root/search(q='${encodeURIComponent(escaped)}')?$top=100&$expand=thumbnails`;
  }
  if (input.folderId) {
    return `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(input.folderId)}/children?$top=100&$expand=thumbnails`;
  }
  return 'https://graph.microsoft.com/v1.0/me/drive/root/children?$top=100&$expand=thumbnails';
}

function googleDriveEndpoint(input: {
  folderId?: string;
  query?: string;
  cursor?: string;
  driveId?: string;
}) {
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  const folderId = input.folderId || 'root';
  const query = boundedQuery(input.query);
  const clauses = ['trashed = false'];
  if (query) {
    clauses.push(`name contains '${escapeGoogleDriveQuery(query)}'`);
  } else {
    clauses.push(`'${escapeGoogleDriveQuery(folderId)}' in parents`);
  }
  url.searchParams.set('q', clauses.join(' and '));
  url.searchParams.set(
    'fields',
    'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,thumbnailLink,owners(displayName))',
  );
  url.searchParams.set('pageSize', '100');
  url.searchParams.set('orderBy', 'folder,name_natural');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  if (input.driveId) {
    url.searchParams.set('corpora', 'drive');
    url.searchParams.set('driveId', input.driveId);
  }
  if (input.cursor) url.searchParams.set('pageToken', input.cursor);
  return url.toString();
}

function googleFailure(response: Response, payload: any) {
  const reason = String(payload?.error?.errors?.[0]?.reason || '').slice(0, 100) || undefined;
  const detail = String(payload?.error?.message || '').trim();
  if (response.status === 401) {
    return new CloudFileProviderError(
      'Google Drive access expired. Reconnect this account.',
      409,
      'RECONNECT_REQUIRED',
      response.status,
      reason,
    );
  }
  if (response.status === 404) {
    return new CloudFileProviderError(
      'This Google Drive folder no longer exists or is no longer shared with you.',
      404,
      'NOT_FOUND',
      response.status,
      reason,
    );
  }
  if (response.status === 429) {
    return new CloudFileProviderError(
      'Google Drive is temporarily rate limited. Try again shortly.',
      429,
      'RATE_LIMITED',
      response.status,
      reason,
    );
  }
  if (response.status === 400) {
    return new CloudFileProviderError(
      detail ? `Google Drive could not open this folder: ${detail}` : 'Google Drive rejected this folder.',
      400,
      'INVALID_REQUEST',
      response.status,
      reason,
    );
  }
  if (response.status === 403 && /auth|credential|permission|scope/iu.test(`${reason || ''} ${detail}`)) {
    return new CloudFileProviderError(
      'Google Drive permission is missing or expired. Reconnect this account.',
      409,
      'RECONNECT_REQUIRED',
      response.status,
      reason,
    );
  }
  return new CloudFileProviderError(
    detail
      ? `Google Drive could not load this folder: ${detail}`
      : 'Google Drive could not load this folder.',
    response.status >= 500 ? 503 : 502,
    'UNAVAILABLE',
    response.status,
    reason,
  );
}

function oneDriveFailure(response: Response, payload: any) {
  const detail = String(payload?.error?.message || '').trim();
  if (response.status === 401 || response.status === 403) {
    return new CloudFileProviderError(
      'File access expired. Reconnect this OneDrive account.',
      409,
      'RECONNECT_REQUIRED',
      response.status,
    );
  }
  if (response.status === 404) {
    return new CloudFileProviderError(
      'This OneDrive folder no longer exists or is no longer shared with you.',
      404,
      'NOT_FOUND',
      response.status,
    );
  }
  if (response.status === 429) {
    return new CloudFileProviderError(
      'OneDrive is temporarily rate limited. Try again shortly.',
      429,
      'RATE_LIMITED',
      response.status,
    );
  }
  return new CloudFileProviderError(
    detail ? `OneDrive could not load this folder: ${detail}` : 'OneDrive could not load this folder.',
    response.status >= 500 ? 503 : 502,
    'UNAVAILABLE',
    response.status,
  );
}

async function resolveGoogleFolder(
  accessToken: string,
  folderId: string | undefined,
): Promise<{ folderId?: string; driveId?: string }> {
  if (!folderId || folderId === 'root') return { folderId };
  const response = await fetchCloudFileProvider(
    dependencies.fetch,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?supportsAllDrives=true&fields=id,mimeType,driveId,shortcutDetails(targetId,targetMimeType)`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw googleFailure(response, payload);
  if (
    payload?.mimeType === 'application/vnd.google-apps.shortcut' &&
    payload?.shortcutDetails?.targetMimeType === 'application/vnd.google-apps.folder'
  ) {
    return {
      folderId: String(payload.shortcutDetails.targetId || folderId),
      driveId: typeof payload.driveId === 'string' ? payload.driveId : undefined,
    };
  }
  if (payload?.mimeType !== 'application/vnd.google-apps.folder') {
    throw new CloudFileProviderError(
      'This Google Drive item is not a folder.',
      400,
      'INVALID_REQUEST',
      400,
      'notAFolder',
    );
  }
  return {
    folderId: String(payload.id || folderId),
    driveId: typeof payload.driveId === 'string' ? payload.driveId : undefined,
  };
}

export async function browseCloudFiles(input: {
  userId: string;
  connectionId: string;
  folderId?: string;
  query?: string;
  cursor?: string;
}): Promise<CloudFilePage> {
  const access = await dependencies.getCloudFileAccess(input);
  if (!access) throw new Error('File connection not found.');
  const { connection, accessToken } = access;
  try {
    const googleFolder =
      connection.provider === 'google_drive' && !boundedQuery(input.query)
        ? await resolveGoogleFolder(accessToken, input.folderId)
        : undefined;
    const endpoint =
      connection.provider === 'google_drive'
        ? googleDriveEndpoint({ ...input, ...googleFolder })
        : oneDriveEndpoint(input);
    const response = await fetchCloudFileProvider(dependencies.fetch, endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw connection.provider === 'google_drive'
        ? googleFailure(response, payload)
        : oneDriveFailure(response, payload);
    }
    const page =
      connection.provider === 'google_drive'
        ? normalizeGoogleDrivePage(payload, connection.connectionId)
        : normalizeOneDrivePage(payload, connection.connectionId);
    await dependencies
      .markCloudFileConnectionAccess(input.userId, connection.connectionId)
      .catch(() => undefined);
    return page;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The file provider is unavailable.';
    const typed = error instanceof CloudFileProviderError ? error : null;
    console.warn('[cloud-files-browse]', {
      provider: connection.provider,
      connection: connection.connectionId.slice(0, 20),
      status: typed?.providerStatus,
      reason: typed?.providerReason,
    });
    await dependencies
      .markCloudFileConnectionAccess(input.userId, connection.connectionId, message)
      .catch(() => undefined);
    throw error;
  }
}
