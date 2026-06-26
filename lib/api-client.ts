'use client';

/**
 * Type-light RPC client over `/api/tools/[name]`. Used by client components
 * via TanStack Query. The same registry that the AI agent and Codex see.
 */
export async function callTool<T = any>(name: string, args: any = {}, headers: HeadersInit = {}): Promise<T> {
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
  });
  let data: any = null;
  let raw = '';
  try {
    raw = await res.text();
    data = raw ? JSON.parse(raw) : null;
  } catch {}
  if (!res.ok || data?.ok === false) {
    const preview = raw.replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(data?.error || `${name} failed (${res.status})${preview ? `: ${preview}` : ''}`);
  }
  if (data === null) {
    throw new Error(`${name} failed: empty or unreadable server response`);
  }
  return data.result as T;
}

export async function health(): Promise<any> {
  const r = await fetch('/api/healthz', { cache: 'no-store' });
  return r.json();
}

export async function listTools(): Promise<any> {
  const r = await fetch('/api/tools', { cache: 'no-store' });
  return r.json();
}
