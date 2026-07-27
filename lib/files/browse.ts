import { getCloudFileAccess, markCloudFileConnectionAccess } from './connections';
import {
  type CloudFilePage,
  escapeGoogleDriveQuery,
  normalizeGoogleDrivePage,
  normalizeOneDrivePage,
} from './providers';

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

function googleDriveEndpoint(input: { folderId?: string; query?: string; cursor?: string }) {
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
  if (input.cursor) url.searchParams.set('pageToken', input.cursor);
  return url.toString();
}

export async function browseCloudFiles(input: {
  userId: string;
  connectionId: string;
  folderId?: string;
  query?: string;
  cursor?: string;
}): Promise<CloudFilePage> {
  const access = await getCloudFileAccess(input);
  if (!access) throw new Error('File connection not found.');
  const { connection, accessToken } = access;
  const endpoint =
    connection.provider === 'google_drive' ? googleDriveEndpoint(input) : oneDriveEndpoint(input);
  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? 'File access expired. Reconnect this account.'
          : 'The file provider could not load this folder.',
      );
    }
    const page =
      connection.provider === 'google_drive'
        ? normalizeGoogleDrivePage(payload, connection.connectionId)
        : normalizeOneDrivePage(payload, connection.connectionId);
    await markCloudFileConnectionAccess(input.userId, connection.connectionId).catch(() => undefined);
    return page;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The file provider is unavailable.';
    await markCloudFileConnectionAccess(input.userId, connection.connectionId, message).catch(
      () => undefined,
    );
    throw error;
  }
}
