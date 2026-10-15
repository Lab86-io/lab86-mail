// Web tools. Albatross reaches the web only through Browserbase (owner
// decision D2, docs/albatross-goal-runs.md G5): every call goes through
// lib/web/, which owns the one Browserbase client.

import { z } from 'zod';
import { saveWebFile, WebFileError } from '../web/file-pull';
import { readPage, searchWeb } from '../web/read';
import { RESEARCH_LIMITS, runWebResearch } from '../web/research';
import { defineTool } from './registry';

export const browserbaseSearch = defineTool({
  name: 'browserbase_search',
  description:
    'Web search through Browserbase. Returns titles, addresses (url), and dates when known. It gives no page text and no snippets: read a page with browserbase_fetch, or use web_research, before you state a fact from it.',
  category: 'web',
  mutating: false,
  input: z.object({ query: z.string(), limit: z.number().int().min(1).max(25).default(10) }),
  output: z.object({ results: z.array(z.any()) }),
  async handler({ query, limit }) {
    return { results: await searchWeb(query, limit) };
  },
});

export const browserbaseFetch = defineTool({
  name: 'browserbase_fetch',
  description:
    'Read one web page or file through Browserbase. Returns the page as markdown text. For a PDF, Word, Excel, or PowerPoint file it returns the text of the file. Max 80,000 characters (truncated: true when cut). It runs no JavaScript.',
  category: 'web',
  mutating: false,
  input: z.object({ url: z.string().url() }),
  output: z.object({
    content: z.string(),
    contentType: z.string().optional(),
    url: z.string().optional(),
    status: z.number().optional(),
    truncated: z.boolean().optional(),
  }),
  async handler({ url }, ctx) {
    return readPage(url, ctx.abortSignal ? { signal: ctx.abortSignal } : {});
  },
});

export const webResearch = defineTool({
  name: 'web_research',
  description: `Research a question on the web through Browserbase. Runs your searches in parallel, reads the best pages in parallel, and returns numbered sources, each with a short passage, plus a failed list. Use the passages as evidence and cite sources by number. Limits: ${RESEARCH_LIMITS.maxQueries} searches, ${RESEARCH_LIMITS.maxPages} pages read (at most ${RESEARCH_LIMITS.maxBrowserPages} in a browser), about ${RESEARCH_LIMITS.totalMs / 1_000} seconds. Pages on sites the user signed in to are read with the saved sign-in, read only.`,
  category: 'web',
  mutating: false,
  input: z.object({
    question: z.string().min(3).max(300).describe('The question to answer, in one sentence.'),
    queries: z
      .array(z.string().min(2).max(200))
      .min(1)
      .max(RESEARCH_LIMITS.maxQueries)
      .describe('1 to 6 different search queries for the question.'),
    sites: z
      .array(z.string().min(3).max(200))
      .max(RESEARCH_LIMITS.maxSites)
      .optional()
      .describe(
        'Sites to read first, for example ["irs.gov"]: the issuer, the official source, or a site where the user has an account.',
      ),
  }),
  output: z.object({
    ok: z.boolean(),
    sources: z.array(
      z.object({
        n: z.number(),
        title: z.string(),
        url: z.string(),
        passage: z.string(),
        signedIn: z.boolean().optional(),
      }),
    ),
    failed: z.array(z.string()),
  }),
  async handler(args, ctx) {
    return runWebResearch({
      question: args.question,
      queries: args.queries,
      sites: args.sites,
      userId: ctx.userId ?? null,
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    });
  },
});

export const webFileSave = defineTool({
  name: 'web_file_save',
  description:
    "Save a file from the web in the user's Files: PDF, Word (DOCX), Excel (XLSX), PowerPoint (PPTX), CSV, PNG, or JPEG, max 25 MB. Get the file from the issuer's own site: irs.gov for IRS forms (for example https://www.irs.gov/pub/irs-pdf/fw9.pdf), the state agency for state forms, the company for its own forms. Do not use copies on other sites. Returns fileId, title, size, contentType, sourceUrl, and sha256, not the contents; read a PDF with browserbase_fetch.",
  category: 'web',
  mutating: true,
  risk: 'write_self',
  input: z.object({
    url: z.string().min(1).max(2_000).describe('The direct address of the file.'),
    name: z
      .string()
      .max(120)
      .optional()
      .describe('The file name to show in Files, for example "Form W-9.pdf".'),
  }),
  output: z.object({
    ok: z.boolean(),
    fileId: z.string(),
    title: z.string(),
    openPath: z.string(),
    size: z.number(),
    contentType: z.string(),
    sourceUrl: z.string().optional(),
    sha256: z.string(),
  }),
  async handler(args, ctx) {
    const userId = ctx.userId;
    if (!userId) throw new Error('Sign in required to save a file.');
    try {
      const saved = await saveWebFile({
        userId,
        url: args.url,
        name: args.name,
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      });
      return {
        ok: true,
        fileId: saved.fileId,
        title: saved.title,
        openPath: saved.openPath,
        size: saved.size,
        contentType: saved.contentType,
        ...(saved.sourceUrl ? { sourceUrl: saved.sourceUrl } : {}),
        sha256: saved.sha256,
      };
    } catch (error) {
      if (error instanceof WebFileError) throw new Error(error.message);
      throw error;
    }
  },
});
