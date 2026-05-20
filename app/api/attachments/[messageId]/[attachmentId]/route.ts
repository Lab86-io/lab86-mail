import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { runGog } from '@/lib/gog/pool';
import { sanitizeFilename } from '@/lib/shared/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Streams a single Gmail attachment. gog downloads it to a temp dir (it has no
// stdout/base64 mode for binaries), which we then read back and hand to the
// browser with the right content-type + a download disposition.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ messageId: string; attachmentId: string }> },
) {
  const { messageId, attachmentId } = await params;
  const url = new URL(req.url);
  const account = url.searchParams.get('account') || '';
  const filename = sanitizeFilename(url.searchParams.get('name') || 'attachment');
  const mime = url.searchParams.get('mime') || 'application/octet-stream';

  if (!account || !messageId || !attachmentId) {
    return new Response('account, messageId and attachmentId are required', { status: 400 });
  }

  const dir = await fs.mkdtemp(path.join(tmpdir(), 'mailos-att-'));
  try {
    await runGog(
      [
        '--account',
        account,
        'gmail',
        'attachment',
        messageId,
        attachmentId,
        '--out',
        dir,
        '--name',
        filename,
        '--no-input',
      ],
      { timeoutMs: 120_000 },
    );

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(path.join(dir, filename));
    } catch {
      // gog may have chosen a slightly different on-disk name; fall back to
      // whatever single file landed in the temp dir.
      const written = await fs.readdir(dir);
      if (!written.length) throw new Error('attachment was not written');
      bytes = await fs.readFile(path.join(dir, written[0]));
    }

    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': mime,
        'content-disposition': `attachment; filename="${filename.replaceAll('"', '')}"`,
        'content-length': String(bytes.byteLength),
        'cache-control': 'private, no-store',
      },
    });
  } catch (err: any) {
    return new Response(`attachment fetch failed: ${err?.message || 'error'}`, { status: 502 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
