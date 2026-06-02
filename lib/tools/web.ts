import { z } from 'zod';
import { spawn } from 'node:child_process';
import { defineTool } from './registry';

const BROWSERBASE_SEARCH =
  process.env.LAB86_MAIL_BROWSERBASE_SEARCH ||
  process.env.MAIL_OS_BROWSERBASE_SEARCH ||
  '/home/jjalangtry/.local/bin/browserbase-search';
const BROWSERBASE_FETCH =
  process.env.LAB86_MAIL_BROWSERBASE_FETCH ||
  process.env.MAIL_OS_BROWSERBASE_FETCH ||
  '/home/jjalangtry/.local/bin/browserbase-fetch';

function runCli(bin: string, args: string[], timeoutMs = 45_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: process.env, timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || stdout.trim() || `${bin} exited ${code}`));
    });
  });
}

export const browserbaseSearch = defineTool({
  name: 'browserbase_search',
  description: 'Web search via Browserbase (returns titles, URLs, and snippets).',
  category: 'web',
  mutating: false,
  input: z.object({ query: z.string(), limit: z.number().int().min(1).max(20).default(10) }),
  output: z.object({ results: z.array(z.any()) }),
  async handler({ query, limit }) {
    const out = await runCli(BROWSERBASE_SEARCH, [query]).catch(() => '');
    try {
      const parsed = JSON.parse(out);
      return { results: (parsed.results || []).slice(0, limit) };
    } catch {
      return { results: [] };
    }
  },
});

export const browserbaseFetch = defineTool({
  name: 'browserbase_fetch',
  description: 'Fetch and return the markdown of a web page via Browserbase.',
  category: 'web',
  mutating: false,
  input: z.object({ url: z.string().url() }),
  output: z.object({ content: z.string() }),
  async handler({ url }) {
    const out = await runCli(BROWSERBASE_FETCH, ['--redirects', url]).catch(() => '');
    try {
      const parsed = JSON.parse(out);
      return { content: parsed.content || parsed.markdown || parsed.text || '' };
    } catch {
      return { content: out };
    }
  },
});
