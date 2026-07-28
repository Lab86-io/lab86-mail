import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { DocumentGenerationError, generateDocumentProposal } from '@/lib/documents/ai';
import { GoogleDocumentConflictError, updateGoogleNativeFile } from '@/lib/documents/google';
import {
  GOOGLE_NATIVE_MIME,
  GOOGLE_NATIVE_MIME_TYPES,
  importGoogleNativeFile,
} from '@/lib/documents/google-import';
import { type AlbatrossDocumentRecord, parseDocumentModel } from '@/lib/documents/model';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const identitySchema = z.object({
  connectionId: z.string().min(1).max(500),
  fileId: z.string().min(1).max(500),
  mimeType: z.enum(GOOGLE_NATIVE_MIME_TYPES),
});

const patchSchema = identitySchema.extend({
  title: z.string().min(1).max(500),
  model: z.unknown(),
  expectedProviderVersion: z.string().max(100).optional(),
});

const aiSchema = identitySchema.extend({
  title: z.string().min(1).max(500),
  model: z.unknown(),
  instruction: z.string().min(1).max(20_000),
  sourceContext: z.string().max(40_000).optional(),
});

function errorResponse(error: unknown) {
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
  if (error instanceof GoogleDocumentConflictError) {
    return NextResponse.json(
      {
        ok: false,
        code: 'PROVIDER_VERSION_CONFLICT',
        error: 'This file changed in Google Drive. Reload it before saving your edits.',
      },
      { status: 409 },
    );
  }
  if (error instanceof DocumentGenerationError) {
    console.error('[google-file-editor-ai] invalid model', error);
    return NextResponse.json(
      { ok: false, error: 'Albatross returned an invalid edit. Try again.' },
      { status: 502 },
    );
  }
  console.error('[google-file-editor]', error);
  return NextResponse.json(
    { ok: false, error: error instanceof Error ? error.message : 'Google file operation failed.' },
    { status: 502 },
  );
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'google-file-editor-open',
      limit: 60,
      windowMs: 60_000,
    });
    const input = identitySchema.parse({
      connectionId: req.nextUrl.searchParams.get('connectionId'),
      fileId: req.nextUrl.searchParams.get('fileId'),
      mimeType: req.nextUrl.searchParams.get('mimeType'),
    });
    const imported = await importGoogleNativeFile({ userId: user.userId, ...input });
    return NextResponse.json({
      ok: true,
      file: {
        ...input,
        source: 'google_drive',
        kind: imported.kind,
        title: imported.title,
        model: imported.model,
        webUrl: imported.webUrl,
        providerVersion: imported.providerVersion,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'google-file-editor-save',
      limit: 120,
      windowMs: 60_000,
    });
    const input = patchSchema.parse(await req.json().catch(() => ({})));
    const kind = GOOGLE_NATIVE_MIME[input.mimeType];
    const updated = await updateGoogleNativeFile({
      userId: user.userId,
      connectionId: input.connectionId,
      fileId: input.fileId,
      kind,
      title: input.title,
      model: input.model,
      expectedProviderVersion: input.expectedProviderVersion,
    });
    return NextResponse.json({
      ok: true,
      file: {
        ...input,
        source: 'google_drive',
        kind,
        ...updated,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'google-file-editor-ai',
      limit: 20,
      windowMs: 60_000,
    });
    const input = aiSchema.parse(await req.json().catch(() => ({})));
    const kind = GOOGLE_NATIVE_MIME[input.mimeType];
    const model = parseDocumentModel(input.model, kind);
    const current: AlbatrossDocumentRecord = {
      documentId: `google:${input.fileId}`,
      kind,
      title: input.title,
      model,
      currentRevision: 1,
      sourceRefs: [{ kind: 'google_drive', id: input.fileId, label: input.title }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const proposal = await generateDocumentProposal({
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      kind,
      instruction: input.instruction,
      current,
      sourceContext: input.sourceContext,
    });
    return NextResponse.json({
      ok: true,
      suggestion: {
        suggestionId: crypto.randomUUID(),
        title: proposal.title,
        description: proposal.summary,
        proposedModel: proposal.model,
        sourceRefs: current.sourceRefs,
        status: 'proposed',
        createdAt: Date.now(),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
