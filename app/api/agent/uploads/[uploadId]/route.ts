import { readChatUpload } from '@/lib/ai/chat-upload-content';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { sanitizeFilename } from '@/lib/shared/files';
export const runtime = 'nodejs';
export async function GET(_request: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  try {
    const user = await requireCurrentUser();
    const { uploadId } = await params;
    const { file, bytes } = await readChatUpload(user.userId, uploadId);
    const image = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.contentType);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': file.contentType || 'application/octet-stream',
        'Content-Disposition': `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(sanitizeFilename(file.name))}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof AuthRequiredError ? 'Authentication required' : 'Attachment unavailable' },
      { status: error instanceof AuthRequiredError ? 401 : 404 },
    );
  }
}
