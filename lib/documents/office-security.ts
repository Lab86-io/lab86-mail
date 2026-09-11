import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const OFFICE_MAX_BYTES = 25 * 1024 * 1024;
export type OfficeExtension = 'docx' | 'xlsx' | 'pptx';
export const OFFICE_MIME: Record<OfficeExtension, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export class OfficeError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function officeConfiguration(env: NodeJS.ProcessEnv = process.env, existingSession = false) {
  const provider = (env.OFFICE_EDITOR_PROVIDER ?? 'onlyoffice').trim().toLowerCase();
  if (provider !== 'collabora' && provider !== 'onlyoffice')
    throw new OfficeError('OFFICE_EDITOR_PROVIDER must be collabora or onlyoffice.', 503);
  if (
    !existingSession &&
    (env.OFFICE_EDITOR_ENABLED !== 'true' ||
      (provider === 'onlyoffice' && env.OFFICE_LICENSE_ACCEPTED !== 'true'))
  )
    return null;
  const secret = env.OFFICE_JWT_SECRET || '';
  if (secret.length < 32 || !env.OFFICE_DOCUMENT_SERVER_URL || !env.OFFICE_APP_ORIGIN) return null;
  const server = configuredOrigin(env.OFFICE_DOCUMENT_SERVER_URL, env.NODE_ENV);
  const app = configuredOrigin(env.OFFICE_APP_ORIGIN, env.NODE_ENV);
  return { server, app, secret, provider };
}

function configuredOrigin(value: string, mode: string | undefined) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(mode !== 'production' && loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new OfficeError(
      'Office endpoints must be HTTPS origins (loopback HTTP is allowed only in development).',
      503,
    );
  return url.origin;
}

export function officeExtension(name: string): OfficeExtension {
  const extension = name.split('.').at(-1)?.toLowerCase();
  if (extension !== 'docx' && extension !== 'xlsx' && extension !== 'pptx')
    throw new OfficeError(
      'Choose a DOCX, XLSX, or PPTX file. Macro-enabled and legacy Office files are not supported.',
    );
  return extension;
}

// Inspect bounded ZIP directory metadata without inflating untrusted content.
// We preserve the original archive bytes, never normalize through the simple editor model.
export function validateOfficeArchive(bytes: Uint8Array, extension: OfficeExtension) {
  if (!bytes.byteLength || bytes.byteLength > OFFICE_MAX_BYTES)
    throw new OfficeError('Office files must be between 1 byte and 25 MB.', 413);
  const data = Buffer.from(bytes);
  let end = -1;
  for (let index = data.length - 22; index >= Math.max(0, data.length - 65557); index--) {
    if (data.readUInt32LE(index) === 0x06054b50) {
      end = index;
      break;
    }
  }
  if (end < 0 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6))
    throw new OfficeError('This is not a supported Office archive.');
  const count = data.readUInt16LE(end + 10);
  let cursor = data.readUInt32LE(end + 16);
  const names = new Set<string>();
  let expanded = 0;
  if (count > 10000 || !count) throw new OfficeError('Office archive is too complex.');
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50)
      throw new OfficeError('Office archive directory is invalid.');
    if (data.readUInt16LE(cursor + 8) & 1) throw new OfficeError('Encrypted files cannot be edited here.');
    expanded += data.readUInt32LE(cursor + 24);
    const length = data.readUInt16LE(cursor + 28);
    const next = cursor + 46 + length + data.readUInt16LE(cursor + 30) + data.readUInt16LE(cursor + 32);
    if (next > end || expanded > 250 * 1024 * 1024)
      throw new OfficeError('Office archive expands beyond the supported limit.');
    const name = data.subarray(cursor + 46, cursor + 46 + length).toString('utf8');
    if (
      name.startsWith('/') ||
      name.includes('..') ||
      name.includes('\\') ||
      /vbaproject|activex/iu.test(name)
    )
      throw new OfficeError('Unsafe or macro-enabled Office content is not supported.');
    names.add(name);
    cursor = next;
  }
  const required =
    extension === 'docx'
      ? 'word/document.xml'
      : extension === 'xlsx'
        ? 'xl/workbook.xml'
        : 'ppt/presentation.xml';
  if (!names.has('[Content_Types].xml') || !names.has(required))
    throw new OfficeError('The file content does not match its Office extension.');
  return createHash('sha256').update(data).digest('hex');
}

export function signOfficeToken(payload: Record<string, unknown>, secret: string) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const content = `${header}.${body}`;
  return `${content}.${createHmac('sha256', secret).update(content).digest('base64url')}`;
}

export function verifyOfficeToken(token: string, secret: string, now = Date.now()) {
  if (token.length > 100_000) throw new OfficeError('Invalid Office token.', 401);
  const parts = token.split('.');
  if (parts.length !== 3) throw new OfficeError('Invalid Office token.', 401);
  const digest = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const supplied = Buffer.from(parts[2], 'base64url');
  if (digest.length !== supplied.length || !timingSafeEqual(digest, supplied))
    throw new OfficeError('Invalid Office signature.', 401);
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch {
    throw new OfficeError('Invalid Office token.', 401);
  }
  if (header?.alg !== 'HS256' || !payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new OfficeError('Invalid Office token.', 401);
  if (payload.exp !== undefined && (typeof payload.exp !== 'number' || payload.exp * 1000 <= now))
    throw new OfficeError('Office session expired. Reopen the file.', 401);
  return payload;
}

export function validateOfficeDownloadUrl(value: string, server: string) {
  const url = new URL(value);
  if (url.origin !== server || url.username || url.password || url.hash)
    throw new OfficeError('Office save URL is not from the configured document server.', 403);
  return url.toString();
}

export async function readOfficeResponse(response: Response) {
  if (!response.ok || !response.body)
    throw new OfficeError('The document server could not supply the saved file.', 502);
  if (Number(response.headers.get('content-length')) > OFFICE_MAX_BYTES) {
    await response.body.cancel();
    throw new OfficeError('Office file exceeds 25 MB.', 413);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > OFFICE_MAX_BYTES) throw new OfficeError('Office file exceeds 25 MB.', 413);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks, total);
}

/** Bound request bodies before multipart/JSON parsing, including chunked requests. */
export async function readOfficeRequest(request: Request, maxBytes: number) {
  if (Number(request.headers.get('content-length')) > maxBytes) {
    await request.body?.cancel();
    throw new OfficeError('Office request is too large.', 413);
  }
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new OfficeError('Office request is too large.', 413);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks, total);
}
