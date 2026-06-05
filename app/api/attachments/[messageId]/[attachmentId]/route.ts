import type { NextRequest } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { downloadNylasAttachment } from '@/lib/nylas/provider';
import { sanitizeFilename } from '@/lib/shared/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ messageId: string; attachmentId: string }> },
) {
  const { messageId, attachmentId } = await params;
  const url = new URL(req.url);
  const account = url.searchParams.get('account') || '';
  const filename = sanitizeFilename(url.searchParams.get('name') || 'attachment');
  const mime = url.searchParams.get('mime') || 'application/octet-stream';
  const disposition = url.searchParams.get('preview') === '1' ? 'inline' : 'attachment';

  if (!account || !messageId || !attachmentId) {
    return new Response('account, messageId and attachmentId are required', { status: 400 });
  }

  try {
    const user = await requireCurrentUser();
    const stream = await downloadNylasAttachment({
      userId: user.userId,
      account,
      messageId,
      attachmentId,
    });
    if (!stream)
      return new Response('attachment fetch failed: Nylas account is not connected', { status: 404 });

    return new Response(stream, {
      headers: {
        'content-type': mime,
        'content-disposition': `${disposition}; filename="${filename.replaceAll('"', '')}"`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (err: any) {
    return new Response(`attachment fetch failed: ${err?.message || 'error'}`, { status: 502 });
  }
}
