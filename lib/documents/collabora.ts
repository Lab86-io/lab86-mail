import { api, convexMutation } from '@/lib/hosted/convex';
import { OfficeError, signOfficeToken, verifyOfficeToken } from './office-security';
import { getOfficeFile, getOfficeSession, type OfficeFile, requireOffice } from './office-service';

export async function startCollaboraSession(userId: string, document: OfficeFile) {
  const config = requireOffice();
  const response = await fetch(`${config.server}/hosting/discovery`, {
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) throw new OfficeError('The document server is unavailable. Try again shortly.', 503);
  const discovery = await response.text();
  const action = [...discovery.matchAll(/<action\s+([^>]+)>/g)]
    .map((match) =>
      Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((attr) => [attr[1], attr[2]])),
    )
    .find((item) => item.ext === document.extension && item.name === 'edit');
  if (!action?.urlsrc) throw new OfficeError('The document server cannot edit this file type.', 503);
  const target = new URL(
    action.urlsrc
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replace(/<[^>]+>/g, ''),
  );
  if (target.origin !== config.server)
    throw new OfficeError('The document server returned an unexpected editor address.', 503);
  const sessionId = crypto.randomUUID();
  const session = await convexMutation<{ ok: boolean; expiresAt?: number }>(
    (api as any).officeDocuments.startSession,
    {
      userId,
      documentId: document.documentId,
      sessionId,
      key: sessionId,
      expectedRevision: document.currentRevision,
    },
  );
  if (!session.ok || !session.expiresAt)
    throw new OfficeError('The working copy changed. Open it again.', 409);
  const token = signOfficeToken(
    {
      purpose: 'wopi',
      userId,
      documentId: document.documentId,
      sessionId,
      exp: Math.floor(session.expiresAt / 1000),
    },
    config.secret,
  );
  target.searchParams.set(
    'WOPISrc',
    `${config.app}/api/office/wopi/${encodeURIComponent(document.documentId)}`,
  );
  target.searchParams.set('lang', 'en-US');
  return {
    provider: 'collabora' as const,
    documentId: document.documentId,
    serverUrl: config.server,
    editorUrl: target.toString(),
    accessToken: token,
    accessTokenTtl: session.expiresAt,
  };
}

export async function wopiContext(request: Request, documentId: string) {
  const config = requireOffice(true);
  const token =
    new URL(request.url).searchParams.get('access_token') ||
    request.headers.get('authorization')?.replace(/^Bearer /i, '') ||
    '';
  const capability = verifyOfficeToken(token, config.secret);
  if (
    typeof capability.exp !== 'number' ||
    !Number.isFinite(capability.exp) ||
    capability.purpose !== 'wopi' ||
    capability.documentId !== documentId ||
    typeof capability.userId !== 'string' ||
    typeof capability.sessionId !== 'string'
  )
    throw new OfficeError('Invalid document access token.', 401);
  const session = await getOfficeSession(capability.userId, documentId, capability.sessionId);
  if (!session) throw new OfficeError('The editor session expired. Reopen the working copy.', 401);
  const file = await getOfficeFile(capability.userId, documentId);
  if (!file?.version?.url) throw new OfficeError('Working copy not found.', 404);
  return { config, file, session, userId: capability.userId, sessionId: capability.sessionId };
}
