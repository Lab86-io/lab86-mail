import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { GoogleDocumentEditor, type GoogleEditorSource } from '../components/files/DocumentEditor';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function openWithOffice(mimeType: GoogleEditorSource['mimeType']) {
  const requests: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    requests.push(`${init?.method || 'GET'} ${String(url)}`);
    return new Promise<Response>(() => undefined);
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <QueryClientProvider client={client}>
        <GoogleDocumentEditor
          officeEnabled
          source={{ connectionId: 'drive', fileId: 'file-1', mimeType }}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );
  });
  await act(async () => tree.unmount());
  client.clear();
  return requests;
}

describe('the Files editor switch with Office on', () => {
  test('a Google Doc opens in the Albatross editor', async () => {
    const requests = await openWithOffice('application/vnd.google-apps.document');
    expect(requests.some((request) => request.startsWith('GET /api/files/google/editor?'))).toBe(true);
    expect(requests.some((request) => request.includes('/api/files/google/office'))).toBe(false);
  });

  test('a Google Sheet keeps the Office working copy', async () => {
    const requests = await openWithOffice('application/vnd.google-apps.spreadsheet');
    expect(requests).toContain('POST /api/files/google/office');
  });
});
