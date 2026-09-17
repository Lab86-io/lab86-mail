// This capability bypasses staging's browser Basic challenge only. Clerk still
// authenticates every protected request. It never contains a Clerk credential.
export const NATIVE_BROWSER_COOKIE = 'lab86_native_browser';
export const NATIVE_BROWSER_TTL_SECONDS = 60 * 60;

const encoder = new TextEncoder();

async function key(secret: string) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function createNativeBrowserAccess(origin: string, secret: string, now = Date.now()) {
  if (!secret) throw new Error('Native browser access is not configured.');
  const expiresAt = Math.floor(now / 1000) + NATIVE_BROWSER_TTL_SECONDS;
  const payload = `${expiresAt}.${crypto.randomUUID()}`;
  const signature = await crypto.subtle.sign(
    'HMAC',
    await key(secret),
    encoder.encode(`native-browser-v1:${origin}:${payload}`),
  );
  const hex = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { value: `${payload}.${hex}`, expiresAt };
}

export async function verifyNativeBrowserAccess(
  value: string | undefined,
  origin: string,
  secret: string | undefined,
  now = Date.now(),
) {
  if (!secret || !value || value.length > 160) return false;
  const match = /^(\d{10})\.([a-f0-9-]{36})\.([a-f0-9]{64})$/u.exec(value);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  const seconds = Math.floor(now / 1000);
  if (expiresAt <= seconds || expiresAt > seconds + NATIVE_BROWSER_TTL_SECONDS) return false;
  const signature = Uint8Array.from(match[3].match(/../gu)!, (byte) => Number.parseInt(byte, 16));
  return crypto.subtle.verify(
    'HMAC',
    await key(secret),
    signature,
    encoder.encode(`native-browser-v1:${origin}:${match[1]}.${match[2]}`),
  );
}
