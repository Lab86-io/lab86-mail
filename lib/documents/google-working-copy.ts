import { z } from 'zod';
import { getCloudFileAccess } from '@/lib/files/connections';
import { decryptSecret, encryptSecret } from '@/lib/security/crypto';
import { googleErrorReasons, isGoogleAppAccessDenied } from './google-access';
import {
  GOOGLE_DOC_MIME,
  GOOGLE_DOC_OFFICE_OPEN_REFUSED,
  GOOGLE_DOC_OFFICE_SAVE_REFUSED,
} from './google-write-policy';
import {
  OFFICE_MIME,
  OfficeError,
  type OfficeExtension,
  readOfficeResponse,
  validateOfficeArchive,
} from './office-security';

const nativeTypes: Record<string, OfficeExtension> = {
  'application/vnd.google-apps.document': 'docx',
  'application/vnd.google-apps.spreadsheet': 'xlsx',
  'application/vnd.google-apps.presentation': 'pptx',
};
const sessionSchema = z.object({
  userId: z.string(),
  connectionId: z.string(),
  fileId: z.string(),
  mimeType: z.string(),
  etag: z.string().min(1),
  version: z.string().min(1),
  expiresAt: z.number(),
});
const defaults = {
  getCloudFileAccess,
  encryptSecret,
  decryptSecret,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
};
let deps = defaults;
export function __setGoogleWorkingCopyDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
}
async function access(userId: string, connectionId: string) {
  const result = await deps.getCloudFileAccess({ userId, connectionId });
  if (!result || result.connection.provider !== 'google_drive')
    throw new OfficeError('Google Drive connection not found.', 404);
  return result.accessToken;
}
/**
 * Shown when Google refuses to replace a file that the user can edit. The
 * Drive API replaces a file only with the full `drive` scope, or with
 * `drive.file` for a file that Albatross made; Albatross does not ask for
 * `drive` (docs/google-verification/scopes.md).
 */
export const GOOGLE_WORKING_COPY_NOT_APP_FILE =
  'Google did not save your edits: Albatross has no write access to this file in Google Drive. Your edited copy is still in Albatross. Download it to keep your changes.';

/** The error reasons of a failed Google answer, for example `appNotAuthorizedToFile`. */
async function responseErrorReasons(response: Response) {
  const payload = await response
    .clone()
    .json()
    .catch(() => null);
  return googleErrorReasons(payload);
}

/**
 * One Drive call with the user's token. It maps a failed answer to an
 * OfficeError; `options.forbidden` replaces the message of an app-access 403.
 */
async function request(
  token: string,
  url: string,
  init: RequestInit = {},
  options: { forbidden?: string } = {},
) {
  const response = await deps.fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
    cache: 'no-store',
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 412 || response.status === 409)
    throw new OfficeError(
      'The original changed in Google. Download its latest version before saving your edits.',
      409,
    );
  // Only an app-access reason gets the caller's message. A rate limit, a
  // quota, or a 403 with no reason keeps the error below.
  if (
    response.status === 403 &&
    options.forbidden &&
    isGoogleAppAccessDenied(403, await responseErrorReasons(response))
  ) {
    throw new OfficeError(options.forbidden, 403);
  }
  if (response.status === 401 || response.status === 403)
    throw new OfficeError(
      'Google write access is missing. Reconnect Google Drive or check sharing permissions.',
      403,
    );
  if (!response.ok)
    throw new OfficeError(
      'Google could not complete this file operation. Your edited copy is still available to retry.',
      502,
    );
  return response;
}
// Drive v2 exposes an explicit etag for conditional media updates. A version
// comparison alone would leave a race between the check and content replacement.
async function metadata(token: string, fileId: string) {
  const response = await request(
    token,
    `https://www.googleapis.com/drive/v2/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,title,mimeType,etag,version,editable`,
  );
  const data = await response.json();
  if (!data.etag || data.version == null)
    throw new OfficeError('Google did not provide a version for this file. Try opening it again.', 409);
  if (data.editable === false) throw new OfficeError('You only have view access to this Google file.', 403);
  if (!nativeTypes[data.mimeType]) throw new OfficeError('Choose a Google Doc, Sheet, or Slides file.');
  return { ...data, version: String(data.version) };
}
export async function downloadGoogleWorkingCopy(input: {
  userId: string;
  connectionId: string;
  fileId: string;
}) {
  const token = await access(input.userId, input.connectionId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await metadata(token, input.fileId);
    // A Google Doc gets no Office working copy: the Albatross editor saves it
    // with the `documents` scope (lib/documents/google-write-policy.ts).
    if (before.mimeType === GOOGLE_DOC_MIME) throw new OfficeError(GOOGLE_DOC_OFFICE_OPEN_REFUSED, 409);
    const extension = nativeTypes[before.mimeType];
    const response = await request(
      token,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(input.fileId)}/export?mimeType=${encodeURIComponent(OFFICE_MIME[extension])}`,
    );
    const bytes = await readOfficeResponse(response);
    validateOfficeArchive(bytes, extension);
    const after = await metadata(token, input.fileId);
    if (before.etag !== after.etag || before.version !== after.version) continue;
    return {
      bytes,
      extension,
      title: String(before.title || 'Untitled'),
      session: deps.encryptSecret(
        JSON.stringify({
          ...input,
          mimeType: before.mimeType,
          etag: before.etag,
          version: before.version,
          expiresAt: Date.now() + 7 * 86400_000,
        }),
      ),
    };
  }
  throw new OfficeError('The file is still changing in Google. Try opening it again shortly.', 409);
}
const SESSION_TTL_MS = 7 * 86400_000;

/** True when a stored working-copy session is past its expiry. */
export function googleWorkingCopyExpired(session: string): boolean {
  try {
    return sessionSchema.parse(JSON.parse(deps.decryptSecret(session))).expiresAt < Date.now();
  } catch {
    return false;
  }
}

/**
 * Extends an expired session when the Google original is still the version
 * the copy came from (OFF-2). A changed original keeps the conflict error, so
 * a renewal can never hide an edit made in Google.
 */
export async function renewGoogleWorkingCopy(input: { userId: string; session: string }) {
  let session: z.infer<typeof sessionSchema>;
  try {
    session = sessionSchema.parse(JSON.parse(deps.decryptSecret(input.session)));
  } catch {
    throw new OfficeError('Download a working copy before saving changes.', 400);
  }
  if (session.userId !== input.userId)
    throw new OfficeError('This working copy belongs to another user.', 403);
  const token = await access(input.userId, session.connectionId);
  const current = await metadata(token, session.fileId);
  if (
    current.etag !== session.etag ||
    current.version !== session.version ||
    current.mimeType !== session.mimeType
  )
    throw new OfficeError(
      'The original changed in Google. Download its latest version before saving your edits.',
      409,
    );
  return deps.encryptSecret(JSON.stringify({ ...session, expiresAt: Date.now() + SESSION_TTL_MS }));
}

export async function saveGoogleWorkingCopy(input: {
  userId: string;
  session: string;
  bytes: Uint8Array;
  extension: OfficeExtension;
}) {
  let session: z.infer<typeof sessionSchema>;
  try {
    session = sessionSchema.parse(JSON.parse(deps.decryptSecret(input.session)));
  } catch {
    throw new OfficeError('Download a working copy before saving changes.', 400);
  }
  if (session.userId !== input.userId)
    throw new OfficeError('This working copy belongs to another user.', 403);
  // The Drive upload below replaces a Doc that Albatross did not make only
  // with the full `drive` scope. A Doc saves from the Albatross editor.
  if (session.mimeType === GOOGLE_DOC_MIME) throw new OfficeError(GOOGLE_DOC_OFFICE_SAVE_REFUSED, 409);
  if (session.expiresAt < Date.now())
    throw new OfficeError('This working copy has expired. Download the latest original.', 409);
  if (nativeTypes[session.mimeType] !== input.extension)
    throw new OfficeError('Choose an edited file of the same type as the downloaded copy.');
  validateOfficeArchive(input.bytes, input.extension);
  const token = await access(input.userId, session.connectionId);
  const current = await metadata(token, session.fileId);
  if (
    current.etag !== session.etag ||
    current.version !== session.version ||
    current.mimeType !== session.mimeType
  )
    throw new OfficeError(
      'The original changed in Google. Download its latest version before saving your edits.',
      409,
    );
  const boundary = `albatross_${crypto.randomUUID().replaceAll('-', '')}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ mimeType: session.mimeType })}\r\n--${boundary}\r\nContent-Type: ${OFFICE_MIME[input.extension]}\r\n\r\n`,
    ),
    Buffer.from(input.bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await request(
    token,
    `https://www.googleapis.com/upload/drive/v2/files/${encodeURIComponent(session.fileId)}?uploadType=multipart&convert=true&supportsAllDrives=true&fields=id,version,etag,alternateLink`,
    {
      method: 'PUT',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, 'If-Match': session.etag },
      body,
    },
    // The metadata said that the user can edit the file, so an app-access
    // 403 here means that the app has no access to the file.
    { forbidden: GOOGLE_WORKING_COPY_NOT_APP_FILE },
  );
  const saved = await response.json();
  if (!saved.etag || saved.version == null)
    throw new OfficeError(
      'Google saved the file but did not return its new version. Reopen it before editing again.',
      502,
    );
  return {
    fileId: session.fileId,
    providerVersion: String(saved.version),
    webUrl: saved.alternateLink,
    session: deps.encryptSecret(
      JSON.stringify({
        ...session,
        etag: saved.etag,
        version: String(saved.version),
        expiresAt: Date.now() + 7 * 86400_000,
      }),
    ),
  };
}
