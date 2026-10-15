import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Egress scan (docs/albatross-goal-runs.md G5, owner decision D2): Albatross
// reaches the web only through Browserbase. A URL that a model gives, or that
// comes from mail or page content, never goes to a plain server fetch.
//
// The scan finds every network call in lib/ and app/: fetch( and its test
// seams (fetcher, fetchImpl, fetchFn, `(x ?? fetch)(`). Each call must be:
// - a same-origin path ('/api/...'), or
// - a literal (or a file constant) https address on a first-party host below, or
// - a reviewed site in REVIEWED_SITES, which says where its address comes from.
// A new call fails here until a person adds it to the list with a reason.

const ROOT = path.join(import.meta.dir, '..');

/** First-party API hosts (a host matches itself and its subdomains). */
const FIRST_PARTY_HOSTS = [
  // Browserbase: the one web layer. Only lib/web/browserbase-client.ts names it.
  'api.browserbase.com',
  // Google: Gmail, Calendar, People, Drive, Docs, OAuth, push, and RISC.
  'googleapis.com',
  'accounts.google.com',
  // Nylas mail and calendar.
  'nylas.com',
  // The model gateway and the model providers.
  'openrouter.ai',
  'api.openai.com',
  'api.anthropic.com',
  'api.together.ai',
  // Connected work accounts.
  'atlassian.com',
  'atlassian.net',
  'slack.com',
  'api.github.com',
  'bitbucket.org',
  'graph.microsoft.com',
  'login.microsoftonline.com',
  // Sign-in, mail delivery, Apple services, billing.
  'clerk.com',
  'api.resend.com',
  'apple.com',
  'stripe.com',
  // Convex storage and functions.
  'convex.cloud',
  'convex.site',
  // Railway private network.
  'railway.internal',
] as const;

type Review = { kind: 'own' | 'convex' | 'first_party' | 'browserbase' | 'exception'; why: string };

/** `file :: first argument` for calls whose address is not a literal. */
const REVIEWED_SITES: Record<string, Review> = {
  // --- The Browserbase layer ---
  'lib/web/browserbase-client.ts :: `${BROWSERBASE_API_BASE}${input.path}`': {
    kind: 'browserbase',
    why: 'The one Browserbase REST client. A model URL goes in the JSON body to Browserbase, never to our fetch.',
  },
  "lib/web/read.ts :: { url: url.toString(), format: 'markdown' }": {
    kind: 'browserbase',
    why: 'deps.fetch is browserbaseFetch (Browserbase Fetch API).',
  },
  "lib/web/read.ts :: { url: url.toString(), format: 'raw' }": {
    kind: 'browserbase',
    why: 'deps.fetch is browserbaseFetch (Browserbase Fetch API).',
  },
  'lib/web/session.ts :: target': {
    kind: 'browserbase',
    why: 'Runs inside page.evaluate, in the Browserbase browser, not on our server.',
  },
  // --- Goal runs: saved files, draft attachments, and PDF export ---
  'lib/documents/office-pdf.ts :: endpoint': {
    kind: 'first_party',
    why: 'The document server convert-to endpoint (OFFICE_CONVERT_URL or OFFICE_DOCUMENT_SERVER_URL); bytes go to our own Collabora.',
  },
  'lib/documents/office-pdf.ts :: file.version.url': {
    kind: 'convex',
    why: 'A Convex storage URL for the saved revision of the user Word file.',
  },
  'lib/files/saved-files.ts :: row.url': {
    kind: 'convex',
    why: 'A Convex storage URL from the agentUploads row (ctx.storage.getUrl).',
  },
  'lib/files/saved-file-route.ts :: row.url': {
    kind: 'convex',
    why: 'A Convex storage URL from the agentUploads row; the route streams the user own saved file.',
  },
  'lib/files/draft-attachments.ts :: url': {
    kind: 'convex',
    why: 'A Convex storage URL of an office file revision; draft attachments never fetch a URL from a request.',
  },
  // --- Own origin (browser code that calls our /api routes) ---
  'lib/api-client.ts :: url': { kind: 'own', why: 'Browser code; the caller passes /api/narrative.' },
  'lib/files/library-client.ts :: url': {
    kind: 'own',
    why: 'Browser code; /api/files/library and /api/files/browse.',
  },
  'lib/albatross/work-view.ts :: url': {
    kind: 'own',
    why: 'Browser code; postJson gets /api/albatross/* paths.',
  },
  'app/settings/page.tsx :: url': {
    kind: 'own',
    why: 'Browser code; fetchJson/postJson/patchJson get /api paths.',
  },
  'lib/shell/proof-dismissals.ts :: ENDPOINT': {
    kind: 'own',
    why: "const '/api/albatross/proof-matches/dismissals'.",
  },
  'lib/documents/odoo-spreadsheet-engine.ts :: SPREADSHEET_TEMPLATES_URL': {
    kind: 'own',
    why: 'Browser code; a /vendor/o-spreadsheet path on our origin.',
  },
  'lib/documents/odoo-spreadsheet-engine.ts :: file.imageSrc': {
    kind: 'own',
    why: 'Browser code; the image store writes only data: URIs.',
  },
  'lib/documents/spreadsheet-image-store.ts :: path': {
    kind: 'own',
    why: 'Only a data:image base64 URI passes its check.',
  },
  // --- Convex storage ---
  'app/api/agent/uploads/route.ts :: uploadUrl': { kind: 'convex', why: 'agentUploads.generateUploadUrl.' },
  'app/api/cron/mail-outbox/route.ts :: claimed.url': {
    kind: 'convex',
    why: 'mailOutbox.claim storage URL.',
  },
  'app/api/documents/[documentId]/export/route.ts :: source.url': {
    kind: 'convex',
    why: 'documents.getImportSource storage URL.',
  },
  'app/api/documents/[documentId]/original/route.ts :: source.url': {
    kind: 'convex',
    why: 'documents.getImportSource storage URL.',
  },
  'app/api/documents/import/route.ts :: uploadUrl': {
    kind: 'convex',
    why: 'An import upload URL from Convex.',
  },
  'app/api/office/[documentId]/content/route.ts :: file.version.url': {
    kind: 'convex',
    why: 'officeDocuments storage URL.',
  },
  'app/api/office/wopi/[documentId]/contents/route.ts :: file.version!.url!': {
    kind: 'convex',
    why: 'officeDocuments storage URL.',
  },
  'lib/ai/chat-upload-content.ts :: file.url': { kind: 'convex', why: 'agentUploads.getUpload storage URL.' },
  'lib/attachments/fetch-store.ts :: uploadUrl': {
    kind: 'convex',
    why: 'boards.generateAttachmentUploadUrl.',
  },
  'lib/attachments/mail-files.ts :: uploadUrl': { kind: 'convex', why: 'mailAttachments.uploadUrl.' },
  'lib/attachments/mail-files.ts :: url': {
    kind: 'convex',
    why: 'mailAttachments.getStoredFile storage URL.',
  },
  'lib/documents/deck-asset-store.ts :: uploadUrl': { kind: 'convex', why: 'documentAssets upload URL.' },
  'lib/documents/deck-assets.ts :: url': {
    kind: 'convex',
    why: 'The host must be the Convex host; redirect: error.',
  },
  'lib/documents/deck-upload-assets.ts :: url': {
    kind: 'convex',
    why: 'agentUploads.getUpload storage URL.',
  },
  'lib/documents/google-office.ts :: file.version.url': {
    kind: 'convex',
    why: 'officeDocuments storage URL.',
  },
  'lib/documents/office-service.ts :: uploadUrl': { kind: 'convex', why: 'office.uploadUrl.' },
  'lib/documents/word-service.ts :: file.version.url': {
    kind: 'convex',
    why: 'officeDocuments storage URL.',
  },
  'lib/files/saved-files.ts :: uploadUrl': { kind: 'convex', why: 'agentUploads.generateUploadUrl.' },
  'lib/google/scheduled.ts :: uploadUrl': { kind: 'convex', why: 'mailOutbox.uploadUrl.' },
  'lib/send/outbox.ts :: url': { kind: 'convex', why: 'mailOutbox.uploadUrl.' },
  'lib/hosted/convex.ts :: input': {
    kind: 'convex',
    why: 'The ConvexHttpClient fetch, with a signal added.',
  },
  // --- First-party APIs with a built address ---
  'lib/ai/generation-cost.ts :: input': {
    kind: 'first_party',
    why: 'The OpenRouter SDK fetch wrapper (openrouter.ai).',
  },
  'lib/ai/openrouter-policy.ts :: input': {
    kind: 'first_party',
    why: 'The OpenRouter SDK fetch wrapper (openrouter.ai).',
  },
  'lib/classifier/client.ts :: model.endpoint': {
    kind: 'first_party',
    why: 'Catalog endpoints: openrouter.ai, api.together.ai.',
  },
  'lib/content/cloud-sync.ts :: url': {
    kind: 'first_party',
    why: 'Drive and Graph literals; deltaLink checked by safeDeltaUrl.',
  },
  'lib/documents/collabora.ts :: `${config.server}/hosting/discovery`': {
    kind: 'first_party',
    why: 'The document server from OFFICE_DOCUMENT_SERVER_URL.',
  },
  'app/api/office/[documentId]/callback/route.ts :: url': {
    kind: 'first_party',
    why: 'Signed callback; the origin must be the configured document server.',
  },
  'lib/documents/google-import.ts :: endpoint': { kind: 'first_party', why: 'googleapis.com literals.' },
  'lib/documents/google-working-copy.ts :: url': { kind: 'first_party', why: 'googleapis.com literals.' },
  'lib/documents/google.ts :: endpoint': { kind: 'first_party', why: 'googleapis.com constants.' },
  'lib/files/connections.ts :: input': {
    kind: 'first_party',
    why: 'Google and Microsoft token and file endpoints.',
  },
  'lib/google/http.ts :: url': { kind: 'first_party', why: 'Gmail, Calendar, and People API constants.' },
  'lib/google/oauth.ts :: url': {
    kind: 'first_party',
    why: 'oauth2.googleapis.com token and revoke endpoints.',
  },
  'lib/google/push/google-api.ts :: url': { kind: 'first_party', why: 'The Drive API constant.' },
  'lib/google/risc.ts :: url': { kind: 'first_party', why: 'Google RISC configuration and its jwks_uri.' },
  'lib/mcp/atlassian.ts :: input.url': {
    kind: 'first_party',
    why: 'api.atlassian.com, from the server definition.',
  },
  'lib/mcp/bitbucket.ts :: apiUrl(baseUrl, pathOrUrl, params)': {
    kind: 'first_party',
    why: 'api.bitbucket.org, and the page.next link of its answer.',
  },
  'lib/mcp/github.ts :: target': { kind: 'first_party', why: 'api.github.com endpoints.' },
  'lib/mcp/provider-oauth.ts :: endpoint.tokenUrl': {
    kind: 'first_party',
    why: 'Atlassian, Bitbucket, and Slack token URLs.',
  },
  'lib/mcp/slack.ts :: url.toString()': { kind: 'first_party', why: 'slack.com/api.' },
  'lib/nylas/grant-cleanup.ts :: `${base}/v3/grants/${encodeURIComponent(id)}`': {
    kind: 'first_party',
    why: 'NYLAS_API_URI or api.us.nylas.com.',
  },
  'lib/weather/weatherkit.ts :: url': { kind: 'first_party', why: 'weatherkit.apple.com.' },
  // --- Exceptions: outside hosts without Browserbase (see the notes doc) ---
  'lib/secure/fetch.ts :: url.toString()': {
    kind: 'exception',
    why: 'secure_fetch with LAB86_SECURE_FETCH_BROWSERBASE off (the default): https, a public host the user saved the key for, no redirects. On: a Browserbase session.',
  },
  'lib/mail/unsubscribe.ts :: target': {
    kind: 'exception',
    why: 'RFC 8058 one-click unsubscribe the user starts: the List-Unsubscribe https address, a public host, no redirects.',
  },
  'lib/documents/deck-art.ts :: url': {
    kind: 'exception',
    why: 'Fixed museum search APIs (Met, Cleveland, Art Institute, SMK) for deck art, behind DECK_ART_LIVE.',
  },
  'lib/documents/deck-art.ts :: candidate.imageUrl': {
    kind: 'exception',
    why: 'A museum image on ARTWORK_IMAGE_HOSTS for deck art.',
  },
  'app/api/logos/[domain]/route.ts :: url': {
    kind: 'exception',
    why: 'Sender logo image proxy: fixed logo services (logo.dev, Brandfetch, DuckDuckGo, Google favicons).',
  },
  'lib/weather/open-meteo.ts :: url': {
    kind: 'exception',
    why: 'Fixed Open-Meteo weather hosts for the Brief.',
  },
};

/** The exceptions, by file. A new one is a visible change to this list and to the notes. */
const EXPECTED_EXCEPTIONS = [
  'app/api/logos/[domain]/route.ts',
  'lib/documents/deck-art.ts',
  'lib/mail/unsubscribe.ts',
  'lib/secure/fetch.ts',
  'lib/weather/open-meteo.ts',
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const file = path.join(dir, entry);
    if (statSync(file).isDirectory()) sourceFiles(file, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry) && !/\.(test|spec)\.|\.d\.ts$/.test(entry)) out.push(file);
  }
  return out;
}

const CALL =
  /(?<![\w$])(?:globalThis\.|window\.|self\.)?(?:fetch|fetcher|fetchImpl|fetchFn)\s*\(|\.(?:fetch|fetcher|fetchImpl|fetchFn)\s*\(|(?<![\w$])(?:globalThis\.)?fetch\)\s*\(/g;

/** The first argument of the call whose "(" is at `open`. */
export function firstArgument(source: string, open: number): string {
  let depth = 0;
  let quote = '';
  let index = open + 1;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if (char === ',' && depth === 0) break;
  }
  return source
    .slice(open + 1, index)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The default of a fetch seam that only forwards, for example
 * `fetch: (...args) => fetch(...args)` or `fetcher: FetchLike = (input, init) => fetch(input, init)`.
 * The seam's own call sites (deps.fetch(...)) are checked like any call.
 */
function isForwarder(line: string): boolean {
  const match = line.match(
    /\b(?:fetch|fetcher|fetchImpl|fetchFn)\??\s*(?::\s*[\w$<>.]+\s*)?[:=]\s*\(*\s*\(\s*(?:\.\.\.)?([\w$]+)[^()]*(?:\([^()]*\)[^()]*)*\)\s*(?::\s*[^=]+?)?=>\s*(?:globalThis\.)?fetch\(\s*(?:\.\.\.)?([\w$]+)/,
  );
  return Boolean(match && match[1] === match[2]);
}

function hostAllowed(host: string) {
  return FIRST_PARTY_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** The address of a literal or of a file constant, or null when the address is built at run time. */
function literalAddress(argument: string, source: string, depth = 0): string | null {
  const constant = argument.match(/^`\$\{([A-Z0-9_]+)\}|^([A-Z][A-Z0-9_]+)$/);
  const name = constant?.[1] || constant?.[2];
  if (name) {
    if (depth > 3) return null;
    const declared = source.match(new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*((['"\`])[^'"\`]*)`));
    return declared ? literalAddress(declared[1], source, depth + 1) : null;
  }
  const literal = argument.match(/^(['"`])([^'"`]*)/);
  return literal ? literal[2] : null;
}

interface Site {
  file: string;
  line: number;
  argument: string;
  verdict: 'own' | 'first_party' | 'reviewed' | 'forwarder' | 'unknown';
  detail?: string;
}

function scan(): Site[] {
  const sites: Site[] = [];
  for (const absolute of [...sourceFiles(path.join(ROOT, 'lib')), ...sourceFiles(path.join(ROOT, 'app'))]) {
    const file = path.relative(ROOT, absolute);
    const source = readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(CALL)) {
      const start = source.lastIndexOf('\n', match.index) + 1;
      const end = source.indexOf('\n', match.index);
      const line = source.slice(start, end === -1 ? undefined : end);
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      const argument = firstArgument(source, (match.index ?? 0) + match[0].length - 1);
      const site: Site = {
        file,
        line: source.slice(0, match.index).split('\n').length,
        argument,
        verdict: 'unknown',
      };
      const address = literalAddress(argument, source);
      if (REVIEWED_SITES[`${file} :: ${argument}`]) site.verdict = 'reviewed';
      else if (isForwarder(line)) site.verdict = 'forwarder';
      else if (address?.startsWith('/') && !address.startsWith('//')) site.verdict = 'own';
      else if (address && /^https:\/\//.test(address)) {
        const host = new URL(address.replace(/\$\{.*$/, '')).hostname;
        site.verdict = hostAllowed(host) ? 'first_party' : 'unknown';
        site.detail = host;
      }
      sites.push(site);
    }
  }
  return sites;
}

describe('egress: Albatross reaches the web only through Browserbase', () => {
  const sites = scan();

  test('the scan finds the known call sites', () => {
    expect(sites.length).toBeGreaterThan(80);
    expect(sites.some((site) => site.file === 'lib/web/browserbase-client.ts')).toBe(true);
  });

  test('every network call is same-origin, first-party, or reviewed', () => {
    const unknown = sites
      .filter((site) => site.verdict === 'unknown')
      .map(
        (site) => `${site.file}:${site.line} :: ${site.argument}${site.detail ? ` (${site.detail})` : ''}`,
      );
    expect(unknown).toEqual([]);
  });

  test('every reviewed site still exists, and the exceptions are the known ones', () => {
    const found = new Set(sites.map((site) => `${site.file} :: ${site.argument}`));
    expect(Object.keys(REVIEWED_SITES).filter((key) => !found.has(key))).toEqual([]);
    const exceptions = [
      ...new Set(
        Object.entries(REVIEWED_SITES)
          .filter(([, review]) => review.kind === 'exception')
          .map(([key]) => key.split(' :: ')[0]),
      ),
    ].sort();
    expect(exceptions).toEqual(EXPECTED_EXCEPTIONS);
  });

  test('the old direct paths are gone: file pulls, the reverse geocode, Browserbase copies', () => {
    const at = (file: string) => sites.filter((site) => site.file === file && site.verdict !== 'forwarder');
    // fetchWebFile goes through lib/web/file-pull.ts: only the Convex upload is left.
    expect(at('lib/attachments/fetch-store.ts').map((site) => site.argument)).toEqual(['uploadUrl']);
    // The Nominatim reverse geocode goes through Browserbase Fetch.
    expect(at('lib/albatross/intent-plan.ts')).toEqual([]);
    for (const file of [
      'lib/tools/web.ts',
      'lib/albatross/browser-session.ts',
      'lib/documents/deck-render.ts',
    ])
      expect(at(file)).toEqual([]);
  });

  test('only the client names Browserbase hosts or reads its key', () => {
    const offenders: string[] = [];
    for (const absolute of [...sourceFiles(path.join(ROOT, 'lib')), ...sourceFiles(path.join(ROOT, 'app'))]) {
      const file = path.relative(ROOT, absolute);
      if (file === 'lib/web/browserbase-client.ts') continue;
      const source = readFileSync(absolute, 'utf8');
      if (/api\.browserbase\.com|connect\.browserbase\.com|BROWSERBASE_API_KEY|BB_API_KEY/.test(source))
        offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test('no other network library, and never a Playwright request from our server', () => {
    // Reviewed uses of a network library, by file.
    const libraryAllowed: Record<string, string> = {
      'lib/notifications/apns.ts':
        'APNs over HTTP/2 to api.push.apple.com and api.sandbox.push.apple.com (Apple).',
    };
    const offenders: string[] = [];
    const forbidden = [
      /from ['"](?:node:)?(?:http|https|http2)['"]/,
      /require\(['"](?:node:)?(?:http|https|http2)['"]\)/,
      /from ['"](?:axios|got|undici|node-fetch|ky|superagent|request)['"]/,
      /new XMLHttpRequest\(/,
      // context.request / page.request run from our server with the browser's cookies.
      /\b(?:context|page|browserContext)\.request\b/,
      /\.request\.(?:get|post|put|patch|delete|head|fetch)\s*\(/,
      /\broute\.fetch\s*\(/,
    ];
    for (const absolute of [...sourceFiles(path.join(ROOT, 'lib')), ...sourceFiles(path.join(ROOT, 'app'))]) {
      const file = path.relative(ROOT, absolute);
      if (libraryAllowed[file]) continue;
      const lines = readFileSync(absolute, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        for (const pattern of forbidden) if (pattern.test(line)) offenders.push(`${file}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('the scanner helpers read arguments, forwarders, and constants', () => {
    // Source text with a template literal in it, built so no string holds "${".
    const template = ['`', '$', '{A_URL}/y`'].join('');
    const source = `const A_URL = 'https://api.github.com/x';\nfetch(${template}, { a: (1, 2) })`;
    expect(firstArgument(source, source.indexOf('fetch(') + 5)).toBe(template);
    expect(literalAddress(template, source)).toBe('https://api.github.com/x');
    expect(literalAddress('A_URL', source)).toBe('https://api.github.com/x');
    expect(literalAddress('url', source)).toBeNull();
    expect(isForwarder('  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),')).toBe(true);
    expect(isForwarder('  fetch: (url: string, init: RequestInit) => fetch(url, init),')).toBe(true);
    expect(isForwarder('  fetcher: FetchLike = (input, init) => fetch(input, init),')).toBe(true);
    expect(
      isForwarder('  fetch: ((input: string, init?: RequestInit) => fetch(input, init)) as FetchLike,'),
    ).toBe(true);
    // A helper that takes any address is not a seam default.
    expect(isForwarder('  get: (url: string) => fetch(url),')).toBe(false);
    expect(isForwarder('const pull = (url: string) => fetch(url);')).toBe(false);
    expect(isForwarder('  fetch: (url: string) => fetch(modelUrl),')).toBe(false);
    expect(hostAllowed('gmail.googleapis.com')).toBe(true);
    expect(hostAllowed('evilgoogleapis.com')).toBe(false);
  });
});
