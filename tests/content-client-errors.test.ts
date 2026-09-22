import { expect, test } from 'bun:test';
import { contentRequest } from '../components/settings/ContentSettings';
import { settingsRequest } from '../components/settings/JevSection';

test('settings loaders give useful errors for non-JSON outages and preserve structured server errors', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response('Unavailable', { status: 503 })) as typeof fetch;
    await expect(contentRequest()).rejects.toThrow('Content could not load.');
    await expect(settingsRequest()).rejects.toThrow('Jev settings could not load.');
    globalThis.fetch = (async () =>
      Response.json({ error: 'Reload to resolve this conflict.' }, { status: 409 })) as typeof fetch;
    await expect(contentRequest()).rejects.toThrow('Reload to resolve this conflict.');
    await expect(settingsRequest()).rejects.toThrow('Reload to resolve this conflict.');
  } finally {
    globalThis.fetch = original;
  }
});
