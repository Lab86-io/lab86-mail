import { NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { sanitizeFilename } from '@/lib/shared/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 5;
const STORAGE_UPLOAD_TIMEOUT_MS = 45_000;
const agentUploadsApi = (api as any).agentUploads;

function errorResponse(err: any) {
  if (err instanceof RateLimitError) return rateLimitJson(err);
  if (err instanceof AuthRequiredError) {
    return NextResponse.json({ ok: false, error: err.message || 'Authentication required' }, { status: 401 });
  }
  console.error('[agent-uploads] Upload failed:', err);
  return NextResponse.json({ ok: false, error: 'Upload failed' }, { status: 500 });
}

async function uploadToStorage(uploadUrl: string, file: File, contentType: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STORAGE_UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: file,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Storage upload failed (${response.status}).`);
    return (await response.json()) as { storageId: string };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error('Storage upload timed out. Try again with a smaller file.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: `Invalid form: ${err?.message || err}` }, { status: 400 });
  }

  const files = form.getAll('files').filter((value): value is File => value instanceof File);
  if (!files.length) return NextResponse.json({ ok: false, error: 'files required' }, { status: 400 });
  if (files.length > MAX_FILES) {
    return NextResponse.json(
      { ok: false, error: `Upload at most ${MAX_FILES} files at once.` },
      { status: 400 },
    );
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_TOTAL_BYTES) {
    return NextResponse.json(
      { ok: false, error: `Files exceed ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB total.` },
      { status: 413 },
    );
  }

  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'agent-uploads',
      limit: 30,
      windowMs: 60_000,
    });

    const uploads = [];
    for (const file of files) {
      const name = sanitizeFilename(file.name || 'attachment');
      const contentType = file.type || 'application/octet-stream';
      const uploadUrl = await convexMutation<string>(agentUploadsApi.generateUploadUrl, {
        userId: user.userId,
      });
      const { storageId } = await uploadToStorage(uploadUrl, file, contentType);
      const uploadId = await convexMutation<string>(agentUploadsApi.registerUpload, {
        userId: user.userId,
        storageId,
        name,
        contentType,
        size: file.size,
      });
      uploads.push({ uploadId, name, contentType, size: file.size });
    }

    return NextResponse.json({ ok: true, uploads });
  } catch (err: any) {
    return errorResponse(err);
  }
}
