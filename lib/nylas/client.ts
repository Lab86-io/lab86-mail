import Nylas from 'nylas';
import { isNylasConfigured } from '@/lib/hosted/env';

let client: Nylas | null = null;

export function requireNylas() {
  if (!isNylasConfigured()) {
    throw new Error('Nylas is not configured. Set NYLAS_API_KEY and NYLAS_CLIENT_ID.');
  }
  if (!client) {
    client = new Nylas({
      apiKey: process.env.NYLAS_API_KEY || '',
      apiUri: process.env.NYLAS_API_URI || 'https://api.us.nylas.com',
      timeout: Number(process.env.NYLAS_TIMEOUT_SECONDS || 45),
    });
  }
  return client;
}
