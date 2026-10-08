'use client';

// The signed-in user's Passwords and IDs, without values, for the settings
// tab, the chat card, and the thread (docs/albatross-secure-store.md). One
// react-query key, so a save in one place updates the others. The API calls
// here never return a value: the server sends labels, sites, hints, and facts.
//
// A call that can need the identity check (a new site, an allow answer)
// returns Clerk's 403 body instead of throwing, so `useReverification` can
// open its modal and retry the same call.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type {
  SecureAllowAnswer,
  SecureDetailsResponse,
  SecureItemCreate,
  SecureItemUpdate,
  SecureItemView,
  SecureUseView,
} from '@/lib/secure/contract';

export const SECURE_DETAILS_QUERY_KEY = ['secure-details'] as const;

/** The response of a user the feature is off for: every secure surface hides. */
export const SECURE_DETAILS_OFF: SecureDetailsResponse = { ok: true, enabled: false, items: [] };

export class SecureApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly field?: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'SecureApiError';
  }
}

/** Clerk's reverification body: `useReverification` opens its modal when a fetcher returns it. */
export interface IdentityCheckBody {
  clerk_error: { type: 'forbidden'; reason: 'reverification-error'; metadata?: unknown };
  code?: string;
}

export function isIdentityCheckBody(data: unknown): data is IdentityCheckBody {
  const body = data as { clerk_error?: { type?: string; reason?: string } } | null | undefined;
  return body?.clerk_error?.type === 'forbidden' && body.clerk_error.reason === 'reverification-error';
}

/** True when the user closed Clerk's modal: the wrapped call rejects with this code. */
export function isIdentityCheckCancelled(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'reverification_cancelled';
}

const JSON_HEADERS = { 'content-type': 'application/json' };

async function readBody(response: Response): Promise<any> {
  return response.json().catch(() => null);
}

function failure(response: Response, data: any, fallback: string): SecureApiError {
  return new SecureApiError(
    typeof data?.error === 'string' && data.error ? data.error : fallback,
    response.status,
    typeof data?.code === 'string' ? data.code : undefined,
    typeof data?.field === 'string' ? data.field : undefined,
    typeof data?.reason === 'string' ? data.reason : undefined,
  );
}

export async function fetchSecureDetails(): Promise<SecureDetailsResponse> {
  const response = await fetch('/api/secure-details', { cache: 'no-store' });
  const data = await readBody(response);
  // Off for this user (no flag, no key): the section hides; nothing is wrong.
  if ((response.status === 404 || response.status === 503) && data?.code === 'off') return SECURE_DETAILS_OFF;
  if (!response.ok || !data?.ok) throw failure(response, data, 'Could not load Passwords and IDs.');
  return {
    ok: true,
    enabled: Boolean(data.enabled),
    items: Array.isArray(data.items) ? (data.items as SecureItemView[]) : [],
  };
}

export function useSecureDetails(enabled = true) {
  return useQuery({
    queryKey: SECURE_DETAILS_QUERY_KEY,
    queryFn: fetchSecureDetails,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** Refresh the list after a save, a delete, an allow, or a site change anywhere. */
export function useInvalidateSecureDetails() {
  const qc = useQueryClient();
  return useCallback(() => void qc.invalidateQueries({ queryKey: SECURE_DETAILS_QUERY_KEY }), [qc]);
}

export async function createSecureItem(body: SecureItemCreate): Promise<SecureItemView> {
  const response = await fetch('/api/secure-details', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  const data = await readBody(response);
  if (!response.ok || !data?.ok || !data.item) throw failure(response, data, 'Could not save this.');
  return data.item as SecureItemView;
}

/**
 * Change the label, the sites, or a value. A new site needs the identity
 * check: the 403 body comes back as is for `useReverification`.
 */
export async function updateSecureItem(
  itemId: string,
  body: SecureItemUpdate,
): Promise<{ item: SecureItemView } | IdentityCheckBody> {
  const response = await fetch(`/api/secure-details/${encodeURIComponent(itemId)}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  const data = await readBody(response);
  if (response.status === 403 && isIdentityCheckBody(data)) return data;
  if (!response.ok || !data?.ok || !data.item) throw failure(response, data, 'Could not save this.');
  return { item: data.item as SecureItemView };
}

export async function deleteSecureItem(itemId: string): Promise<void> {
  const response = await fetch(`/api/secure-details/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
  const data = await readBody(response);
  if (!response.ok || !data?.ok) throw failure(response, data, 'Could not delete this.');
}

export async function fetchSecureUses(itemId: string): Promise<SecureUseView[]> {
  const response = await fetch(`/api/secure-details/${encodeURIComponent(itemId)}/uses`, {
    cache: 'no-store',
  });
  const data = await readBody(response);
  if (!response.ok || !data?.ok) throw failure(response, data, 'Could not load the uses.');
  return Array.isArray(data.uses) ? (data.uses as SecureUseView[]) : [];
}

/**
 * Answer an allow_secure handoff. "Allow once" and "Always on this site" need
 * the identity check: the 403 body comes back as is for `useReverification`.
 * A 409 means another device answered first; the caller refreshes the run.
 */
export async function answerSecureAllow(
  body: SecureAllowAnswer,
): Promise<{ runId: string } | IdentityCheckBody> {
  const response = await fetch('/api/secure-details/allow', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  const data = await readBody(response);
  if (response.status === 403 && isIdentityCheckBody(data)) return data;
  if (!response.ok || !data?.ok) throw failure(response, data, 'Could not send your answer.');
  return { runId: String(data.runId ?? '') };
}
