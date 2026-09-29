import { after, type NextRequest, NextResponse } from 'next/server';
import { drainMailAttachmentQueue } from '@/lib/attachments/mail-files';
import { isInternalCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const defaultDependencies = {
  isInternalCronRequest,
  drainMailAttachmentQueue,
  defer: (task: () => Promise<unknown>) => after(task),
};

// Called by the Convex mail attachment cron (convex/mailAttachments.ts tick)
// once for each user with due queued files. The downloads outlive the
// response, so the route answers at once.
export function createMailAttachmentsPost(overrides: Partial<typeof defaultDependencies> = {}) {
  const deps = { ...defaultDependencies, ...overrides };
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req))
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    const body = await req.json().catch(() => null);
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    if (!userId || userId.length > 240)
      return NextResponse.json({ ok: false, error: 'A userId is required.' }, { status: 400 });
    deps.defer(() =>
      deps.drainMailAttachmentQueue(userId).catch((error) => {
        console.error('[cron/mail-attachments] drain failed', userId, error);
      }),
    );
    return NextResponse.json({ ok: true, started: true }, { status: 202 });
  };
}

export const POST = createMailAttachmentsPost();
