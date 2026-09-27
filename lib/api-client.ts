'use client';

export type CallToolOptions = {
  /**
   * Return a result that reports `ok: false` instead of throwing. Only for
   * callers that read the failure fields themselves (for example a calendar
   * result that asks the user to choose between events).
   */
  acceptFailedResult?: boolean;
};

/**
 * Type-light RPC client over `/api/tools/[name]`. Used by client components
 * via TanStack Query. The same registry that the AI agent and Codex see.
 *
 * A tool can succeed at the transport level and still report `ok: false` in
 * its result (a provider rejected the change, a partial delete, a revision
 * conflict). That is a failure, so this throws unless the caller opts out
 * with `acceptFailedResult`.
 */
export async function callTool<T = any>(
  name: string,
  args: any = {},
  headers: HeadersInit = {},
  signal?: AbortSignal,
  options: CallToolOptions = {},
): Promise<T> {
  // Tools that parse naive date/times (e.g. calendar_create_event) need the
  // user's timezone. The agent passes it explicitly, but direct UI calls didn't
  // carry one, so created events landed in the wrong zone. Send the browser tz.
  let timezone: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timezone = undefined;
  }
  const res = await fetch(`/api/tools/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(timezone ? { 'x-user-timezone': timezone } : {}),
      ...headers,
    },
    body: JSON.stringify(args),
    ...(signal ? { signal } : {}),
  });
  let data: any = null;
  let raw = '';
  try {
    raw = await res.text();
    data = raw ? JSON.parse(raw) : null;
  } catch {}
  if (!res.ok || data?.ok === false) {
    // Prefer the API's structured, intentional error; never splice the raw
    // response body (HTML error pages, stack traces) into a client-facing error.
    throw new Error(data?.error || `${name} failed (${res.status})`);
  }
  if (data === null) {
    // 2xx with an unreadable/non-JSON body: keep the captured preview since it's
    // the only failure context available for this direct-call debugging path.
    const preview = raw.replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(
      preview
        ? `${name} failed: unreadable server response: ${preview}`
        : `${name} failed: empty or unreadable server response`,
    );
  }
  const result = data.result;
  if (!options.acceptFailedResult && isFailedResult(result)) {
    throw new Error(failedResultMessage(name, result));
  }
  return result as T;
}

function isFailedResult(result: unknown): result is Record<string, unknown> {
  return Boolean(result) && typeof result === 'object' && (result as { ok?: unknown }).ok === false;
}

/** A readable message from the failure fields a tool result can carry. */
export function failedResultMessage(name: string, result: Record<string, unknown>): string {
  for (const key of ['error', 'message', 'summary', 'reason'] as const) {
    const value = result[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  if (result.needsDisambiguation) return 'More than one item matches. Open it and try again.';
  if (Array.isArray(result.errors) && result.errors.length) {
    const first = result.errors[0];
    const detail =
      typeof first === 'string'
        ? first
        : first && typeof first === 'object' && typeof (first as any).error === 'string'
          ? (first as any).error
          : '';
    if (detail) return detail;
  }
  return `${name} did not complete`;
}

export async function health(): Promise<any> {
  const r = await fetch('/api/healthz', { cache: 'no-store' });
  return r.json();
}

export async function listTools(): Promise<any> {
  const r = await fetch('/api/tools', { cache: 'no-store' });
  return r.json();
}

/** Search list endpoints use an envelope distinct from the tool RPC. */
export async function readSearchSource<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const data = await response.json().catch(() => null);
  signal.throwIfAborted();
  if (!response.ok || data === null || data?.ok === false) {
    throw new Error(typeof data?.error === 'string' ? data.error : 'Could not search this source.');
  }
  return data as T;
}
