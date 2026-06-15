import { z } from 'zod';
import { defineTool } from './registry';

const BROWSERBASE_API_BASE = 'https://api.browserbase.com/v1';
const BROWSERBASE_TIMEOUT_MS = 45_000;

function browserbaseApiKey() {
  return (
    process.env.BROWSERBASE_API_KEY || process.env.LAB86_BROWSERBASE_API_KEY || process.env.BB_API_KEY || ''
  );
}

async function postBrowserbase<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const apiKey = browserbaseApiKey();
  if (!apiKey) throw new Error('BROWSERBASE_API_KEY is not configured.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BROWSERBASE_TIMEOUT_MS);
  try {
    const response = await fetch(`${BROWSERBASE_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bb-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Browserbase ${path} failed (${response.status}): ${text.slice(0, 240)}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Browserbase ${path} timed out after ${BROWSERBASE_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export const browserbaseSearch = defineTool({
  name: 'browserbase_search',
  description: 'Web search via Browserbase Search. Returns titles, URLs, snippets, authors, and dates.',
  category: 'web',
  mutating: false,
  input: z.object({ query: z.string(), limit: z.number().int().min(1).max(25).default(10) }),
  output: z.object({ results: z.array(z.any()) }),
  async handler({ query, limit }) {
    const json = await postBrowserbase<{ results?: any[]; data?: any[] }>('/search', {
      query,
      numResults: limit,
    });
    const results = Array.isArray(json.results) ? json.results : Array.isArray(json.data) ? json.data : [];
    return { results: results.slice(0, limit) };
  },
});

export const browserbaseFetch = defineTool({
  name: 'browserbase_fetch',
  description: 'Fetch and return markdown page content via Browserbase Fetch.',
  category: 'web',
  mutating: false,
  input: z.object({ url: z.string().url() }),
  output: z.object({ content: z.string() }),
  async handler({ url }) {
    const json = await postBrowserbase<any>('/fetch', {
      url,
      allowRedirects: true,
      format: 'markdown',
    });
    return {
      content: String(json?.content || json?.markdown || json?.text || json?.data?.content || ''),
    };
  },
});
