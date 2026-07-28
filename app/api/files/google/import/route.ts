import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { GOOGLE_NATIVE_MIME, importGoogleNativeFile } from '@/lib/documents/google-import';
import type { AlbatrossDocumentRecord } from '@/lib/documents/model';
import {
  createAndLinkGoogleDocument,
  findDocumentByGoogleFile,
  linkGoogleDocument,
  updateDocument,
} from '@/lib/documents/service';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const inputSchema = z.object({
  connectionId: z.string().min(1).max(500),
  fileId: z.string().min(1).max(500),
  mimeType: z.enum([
    'application/vnd.google-apps.document',
    'application/vnd.google-apps.spreadsheet',
    'application/vnd.google-apps.presentation',
  ]),
  webUrl: z.string().url().max(2_000).optional(),
  mode: z.enum(['open', 'refresh']).default('open'),
});

export async function POST(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'google-file-import',
      limit: 30,
      windowMs: 60_000,
    });
    const input = inputSchema.parse(await req.json().catch(() => ({})));
    const existing = await findDocumentByGoogleFile({
      userId: user.userId,
      connectionId: input.connectionId,
      fileId: input.fileId,
    });
    if (existing && input.mode === 'open') {
      return NextResponse.json({ ok: true, document: existing, existing: true });
    }
    const imported = await importGoogleNativeFile({
      userId: user.userId,
      connectionId: input.connectionId,
      fileId: input.fileId,
      mimeType: input.mimeType,
    });
    const sourceRefs = [
      {
        kind: 'google_drive',
        id: input.fileId,
        label: imported.title,
        url: imported.webUrl || input.webUrl,
      },
    ];
    let document: AlbatrossDocumentRecord;
    let linked: Awaited<ReturnType<typeof linkGoogleDocument>>;
    if (existing) {
      const refreshed = await updateDocument({
        userId: user.userId,
        documentId: existing.documentId,
        expectedRevision: existing.currentRevision,
        title: imported.title,
        model: imported.model,
        sourceRefs: uniqueSourceRefs([...sourceRefs, ...existing.sourceRefs]),
        reason: 'google_refresh',
        actor: 'system',
      });
      if (!refreshed.ok) {
        return NextResponse.json(
          { ok: false, error: 'The Albatross file changed while Google was being imported.' },
          { status: 409 },
        );
      }
      document = refreshed.document;
      linked = await linkGoogleDocument({
        userId: user.userId,
        documentId: document.documentId,
        connectionId: input.connectionId,
        fileId: input.fileId,
        mimeType: input.mimeType,
        webUrl: imported.webUrl || input.webUrl,
        providerVersion: imported.providerVersion,
        syncedRevision: document.currentRevision,
      });
    } else {
      const created = await createAndLinkGoogleDocument({
        userId: user.userId,
        kind: imported.kind,
        title: imported.title,
        model: imported.model,
        sourceRefs,
        reason: 'google_import',
        connectionId: input.connectionId,
        fileId: input.fileId,
        mimeType: input.mimeType,
        webUrl: imported.webUrl || input.webUrl,
        providerVersion: imported.providerVersion,
      });
      document = created.document;
      linked = created.linked;
    }
    if (!linked.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: 'This Google file is already linked to another Albatross file.',
          documentId: linked.documentId,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      document: {
        ...document,
        google: {
          connectionId: input.connectionId,
          fileId: input.fileId,
          mimeType: input.mimeType,
          webUrl: imported.webUrl || input.webUrl,
          providerVersion: imported.providerVersion,
          syncedRevision: document.currentRevision,
          lastSyncedAt: Date.now(),
        },
      },
      existing: Boolean(existing),
      refreshed: Boolean(existing),
      kind: GOOGLE_NATIVE_MIME[input.mimeType],
    });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitJson(error);
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { ok: false, error: error.issues[0]?.message || 'Invalid Google file.' },
        { status: 400 },
      );
    }
    console.error('[google-file-import]', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Google file import failed.' },
      { status: 502 },
    );
  }
}

function uniqueSourceRefs<T extends { kind: string; id: string }>(refs: T[]) {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
