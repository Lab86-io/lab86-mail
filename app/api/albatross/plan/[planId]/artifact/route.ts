import type { NextRequest } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* Serves a plan's HTML brief as a standalone page. Task cards link here so the
 * plan travels with the work it created. Auth-gated to the plan's owner; the
 * strict CSP treats the AI-composed document as untrusted content. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ planId: string }> }) {
  const { planId } = await ctx.params;
  try {
    const user = await requireCurrentUser();
    const artifact = await convexQuery<{
      artifactHtml: string | null;
      artifactTitle: string | null;
    }>((api as any).albatrossIntents.getPlanArtifact, { userId: user.userId, planId });
    if (!artifact.artifactHtml) {
      return new Response('This plan has no brief yet.', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      });
    }
    return new Response(artifact.artifactHtml, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'private, no-store',
        // Fonts + the maps embed match what the artifact prompt permits. Scripts
        // stay blocked: this page serves AI-authored HTML on the app's own
        // origin (in-app the same document runs sandboxed with an opaque origin,
        // where its theme-listener script is safe to run).
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src data:; frame-src https://www.google.com",
      },
    });
  } catch (err: any) {
    if (err instanceof AuthRequiredError) {
      return new Response('Sign in to view this plan.', { status: 401 });
    }
    const message = err?.message || '';
    if (/not found/i.test(message)) return new Response('Plan not found.', { status: 404 });
    console.error('[albatross-artifact-route]', message || err);
    return new Response('Failed to load plan brief.', { status: 500 });
  }
}
