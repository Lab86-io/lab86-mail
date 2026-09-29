import { after, type NextRequest } from 'next/server';
import { openMailAttachment } from '@/lib/attachments/mail-files';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { serverErrorMessage } from '@/lib/security/error-answer';
import { sanitizeFilename } from '@/lib/shared/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Types that a browser shows without script execution. Everything else
 * (HTML, SVG, XML, JavaScript, unknown types) goes out as a download so a
 * sender cannot run script on the app origin with the user's session.
 */
const INLINE_SAFE_EXACT = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/heic',
  'image/heif',
  'application/pdf',
  'text/plain',
]);

export function normalizeAttachmentMime(raw: string | null | undefined): string {
  const base = String(raw || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base)
    ? base
    : 'application/octet-stream';
}

export function isInlineSafeMime(mime: string): boolean {
  if (INLINE_SAFE_EXACT.has(mime)) return true;
  return mime.startsWith('audio/') || mime.startsWith('video/');
}

export function attachmentResponseHeaders(input: {
  mime: string | null | undefined;
  filename: string;
  preview: boolean;
}): Record<string, string> {
  const mime = normalizeAttachmentMime(input.mime);
  const inline = input.preview && isInlineSafeMime(mime);
  // A download keeps its declared type; the attachment disposition, nosniff,
  // and the sandbox stop any browser from rendering it on the app origin.
  const contentType = inline && mime === 'text/plain' ? 'text/plain; charset=utf-8' : mime;
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${input.filename.replaceAll('"', '')}"`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  };
  // Chromium refuses to start its PDF viewer in a sandboxed document, so an
  // inline PDF is the one case without the sandbox. The viewer runs apart
  // from the app origin, and every other response keeps the sandbox.
  if (!(inline && mime === 'application/pdf')) {
    headers['content-security-policy'] =
      "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";
  }
  return headers;
}

const defaultDependencies = {
  requireCurrentUser,
  openMailAttachment,
  // The stored copy of a provider file is written after the response.
  defer: (task: () => Promise<unknown>) => after(task),
};

export function createAttachmentGet(overrides: Partial<typeof defaultDependencies> = {}) {
  const deps = { ...defaultDependencies, ...overrides };
  return async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ messageId: string; attachmentId: string }> },
  ) {
    const { messageId, attachmentId } = await params;
    const url = new URL(req.url);
    const account = url.searchParams.get('account') || '';
    const name = url.searchParams.get('name');
    const mime = url.searchParams.get('mime');

    if (!account || !messageId || !attachmentId) {
      return new Response('account, messageId and attachmentId are required', { status: 400 });
    }

    try {
      const user = await deps.requireCurrentUser();
      // Our encrypted storage first; else the provider, and the file is stored.
      const file = await deps.openMailAttachment(
        { userId: user.userId, account, messageId, attachmentId },
        {
          fill: 'always',
          hint: { filename: name ? sanitizeFilename(name) : undefined, mimeType: mime || undefined },
          defer: deps.defer,
        },
      );
      if (!file)
        return new Response('attachment fetch failed: Nylas account is not connected', { status: 404 });

      return new Response(file.stream, {
        headers: attachmentResponseHeaders({
          mime: mime || file.mimeType,
          filename: sanitizeFilename(name || file.filename || 'attachment'),
          preview: url.searchParams.get('preview') === '1',
        }),
      });
    } catch (err: any) {
      return new Response(serverErrorMessage('[attachments] fetch failed', err, 'attachment fetch failed'), {
        status: 502,
      });
    }
  };
}

export const GET = createAttachmentGet();
