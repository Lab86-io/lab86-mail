import { NextRequest, NextResponse } from 'next/server';
import { api, convexMutation } from '@/lib/hosted/convex';
import { hostedPublicUrl, nylasRedirectUri } from '@/lib/hosted/env';
import { requireNylas } from '@/lib/nylas/client';
import { encryptSecret } from '@/lib/security/crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const error = url.searchParams.get('error') || '';
  if (error) return redirectWithStatus('/', 'nylas_error', error);
  if (!code || !state) return redirectWithStatus('/', 'nylas_error', 'missing code or state');

  const stored = await convexMutation<any>(api.accounts.consumeOAuthState, { state });
  if (!stored) return redirectWithStatus('/', 'nylas_error', 'invalid or expired state');

  try {
    const token = await requireNylas().auth.exchangeCodeForToken({
      clientId: process.env.NYLAS_CLIENT_ID || '',
      clientSecret: process.env.NYLAS_CLIENT_SECRET || undefined,
      redirectUri: nylasRedirectUri(),
      code,
    });
    const provider = normalizeProvider(token.provider || stored.provider);
    const scopes = String(token.scope || '')
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
    await convexMutation(api.accounts.upsertConnectedAccount, {
      userId: stored.userId,
      email: token.email,
      provider,
      grantId: token.grantId,
      accessTokenEncrypted: token.accessToken ? encryptSecret(token.accessToken) : undefined,
      refreshTokenEncrypted: token.refreshToken ? encryptSecret(token.refreshToken) : undefined,
      expiresAt: token.expiresIn ? Date.now() + token.expiresIn * 1000 : undefined,
      scopes,
    });
    return redirectWithStatus(stored.redirectTo || '/', 'nylas_connected', token.email);
  } catch (err: any) {
    return redirectWithStatus(stored.redirectTo || '/', 'nylas_error', err?.message || 'connect failed');
  }
}

function normalizeProvider(provider: string) {
  if (provider === 'google' || provider === 'microsoft' || provider === 'icloud') return provider;
  return 'imap';
}

function redirectWithStatus(path: string, key: string, value: string) {
  const target = new URL(path.startsWith('/') ? path : '/', hostedPublicUrl());
  target.searchParams.set(key, value);
  return NextResponse.redirect(target);
}
