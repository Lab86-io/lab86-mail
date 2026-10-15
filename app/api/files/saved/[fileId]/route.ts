import { createSavedFileGet } from '@/lib/files/saved-file-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// One saved file of the signed-in user (lib/files/saved-file-route.ts).
const get = createSavedFileGet();

export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  return get(req, (await params).fileId);
}
