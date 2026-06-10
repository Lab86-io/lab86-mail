import Nylas from 'nylas';
import { isNylasConfigured } from '@/lib/hosted/env';

let client: Nylas | null = null;

export function requireNylas() {
  if (!isNylasConfigured()) {
    throw new Error('Nylas is not configured. Set NYLAS_API_KEY and NYLAS_CLIENT_ID.');
  }
  if (!client) {
    const timeoutSeconds = Number(process.env.NYLAS_TIMEOUT_SECONDS || 45);
    client = new Nylas({
      // isNylasConfigured() above guarantees the key is present.
      apiKey: process.env.NYLAS_API_KEY!,
      apiUri: process.env.NYLAS_API_URI || 'https://api.us.nylas.com',
      timeout: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 45,
    });
  }
  return client;
}
