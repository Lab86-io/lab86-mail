// Client-side sender logo resolution for the inbox list.
//
// The old path trusted whatever image URL the server handed back, which let
// provider "default globe" placeholders (Google s2 serves a 16px globe, DDG a
// 48px one) render as if they were brand logos. This module probes an ordered
// candidate chain with real <img> loads, accepts a URL only when the decoded
// bitmap is large enough to be a genuine logo at 2x row size, and memoizes the
// per-domain verdict in memory + localStorage so a domain always resolves the
// same way — session to session, without re-probing on scroll re-renders.
//
// Endpoint facts (verified 2026-07-05):
// - logo.clearbit.com no longer resolves (Clearbit Logo API sunset) — omitted.
// - google.com/s2/favicons?sz=128 returns HTTP 404 with a 16x16 globe body for
//   unknown domains, and can return small upscale-prone originals otherwise.
// - icons.duckduckgo.com/ip3 returns HTTP 404 with a 48x48 placeholder body
//   for unknown domains; real favicons often carry 64/128px frames.
// - /api/logos/<domain> is our server proxy (logo.dev / Brandfetch when
//   tokens exist, then public sources) and 404s cleanly on a miss.

/** Minimum decoded size for any accepted logo — 2x the 28px row avatar. */
export const MIN_LOGO_NATURAL_SIZE = 56;
/**
 * Google s2 is the most globe/upscale-prone source, so as the last resort it
 * must return close to the 128px we ask for before we trust it to be crisp.
 */
export const MIN_GOOGLE_S2_NATURAL_SIZE = 96;
/** Bump the version to invalidate every stored verdict at once. */
export const LOGO_CACHE_KEY_PREFIX = 'lab86-logo-v1:';
/** Stored verdict meaning "no real logo exists — use the initials avatar". */
export const INITIALS_VERDICT = 'initials';

const PERSONAL_DOMAINS = new Set([
  'aol.com',
  'fastmail.com',
  'gmail.com',
  'hey.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'mac.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'pm.me',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
  'ymail.com',
]);

const RESERVED_DOMAINS = new Set(['example.com', 'example.net', 'example.org']);

// Infrastructure domains that should borrow the parent brand's logo.
const LOGO_DOMAIN_ALIASES: Record<string, string> = {
  'microsoftonline.com': 'microsoft.com',
  'office.com': 'microsoft.com',
  'office365.com': 'microsoft.com',
  'onmicrosoft.com': 'microsoft.com',
  'windows.net': 'microsoft.com',
  'googleusercontent.com': 'google.com',
  'googlemail.com': 'google.com',
  'amazonses.com': 'amazon.com',
};

// Common second-level public suffixes, enough to guess a brand apex for the
// direct favicon fallbacks. A wrong guess is harmless: the candidate simply
// fails to load and the chain falls through to initials.
const TWO_PART_SUFFIXES = new Set([
  'ac.uk',
  'co.in',
  'co.jp',
  'co.kr',
  'co.nz',
  'co.uk',
  'co.za',
  'com.ar',
  'com.au',
  'com.br',
  'com.hk',
  'com.mx',
  'com.sg',
  'com.tr',
  'com.tw',
  'gov.uk',
  'ne.jp',
  'net.au',
  'or.jp',
  'org.au',
  'org.uk',
]);

/**
 * The domain a sender's company logo should be keyed on, or '' when the
 * address can't have one (personal mailboxes, reserved/test domains).
 */
export function senderLogoDomain(email: string | null | undefined): string {
  const raw = String(email || '')
    .trim()
    .toLowerCase();
  const domainPart = (raw.includes('@') ? raw.split('@')[1] : raw).replace(/\.$/, '');
  if (!domainPart?.includes('.') || /[^a-z0-9.-]/.test(domainPart)) return '';
  const aliased =
    LOGO_DOMAIN_ALIASES[domainPart] ||
    Object.entries(LOGO_DOMAIN_ALIASES).find(([suffix]) => domainPart.endsWith(`.${suffix}`))?.[1] ||
    domainPart;
  const apex = apexDomain(aliased);
  if (PERSONAL_DOMAINS.has(apex) || RESERVED_DOMAINS.has(apex)) return '';
  if (aliased === 'localhost' || aliased.endsWith('.local')) return '';
  if (aliased.endsWith('.test') || aliased.endsWith('.invalid') || aliased.endsWith('.localhost')) return '';
  return aliased;
}

/** Best-effort registrable domain (news.stripe.com → stripe.com). */
export function apexDomain(domain: string): string {
  const labels = domain.split('.').filter(Boolean);
  if (labels.length <= 2) return domain;
  const lastTwo = labels.slice(-2).join('.');
  const take = TWO_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/**
 * Ordered logo sources for a domain. Every entry either yields a real image
 * (validated by isAcceptableLogo) or fails, so the chain can never end on a
 * placeholder — the terminal state is always our designed initials avatar.
 */
export function candidateLogoUrls(domain: string): string[] {
  if (!domain) return [];
  const apex = apexDomain(domain);
  const urls = [
    // Server proxy first: it can use logo.dev/Brandfetch tokens and 404s on a miss.
    `/api/logos/${encodeURIComponent(domain)}`,
    // DDG serves multi-frame favicons (often 64/128px); 404s carry a 48px
    // placeholder body that the size gate rejects.
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(apex)}.ico`,
    // Google s2 404s with a 16px globe body for unknown domains and may hand
    // back tiny originals — both rejected by the stricter s2 size gate.
    `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(apex)}`,
  ];
  return [...new Set(urls)];
}

/**
 * Accept a probed image only when it can render crisply at 2x row size and is
 * roughly logo-shaped. Rejects the Google 16px globe, the DDG 48px
 * placeholder, tiny upscaled favicons, and banner-shaped wordmarks.
 */
export function isAcceptableLogo({
  width,
  height,
  url,
}: {
  width: number;
  height: number;
  url: string;
}): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  const minSize = url.includes('google.com/s2/favicons') ? MIN_GOOGLE_S2_NATURAL_SIZE : MIN_LOGO_NATURAL_SIZE;
  if (width < minSize || height < minSize) return false;
  const ratio = width / height;
  if (ratio > 2.5 || ratio < 0.4) return false;
  return true;
}

export interface VerdictStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): VerdictStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage access can throw in privacy modes; verdicts just stay in memory.
    return null;
  }
}

export function verdictStorageKey(domain: string): string {
  return `${LOGO_CACHE_KEY_PREFIX}${domain}`;
}

/** Winning URL, INITIALS_VERDICT, or null when nothing is stored. */
export function readStoredVerdict(domain: string, storage: VerdictStorage | null = defaultStorage()) {
  if (!domain || !storage) return null;
  try {
    const value = storage.getItem(verdictStorageKey(domain));
    return value || null;
  } catch {
    return null;
  }
}

export function writeStoredVerdict(
  domain: string,
  verdict: string,
  storage: VerdictStorage | null = defaultStorage(),
) {
  if (!domain || !storage) return;
  try {
    storage.setItem(verdictStorageKey(domain), verdict);
  } catch {
    // Quota/privacy failures are fine — the in-memory verdict still holds.
  }
}

export type ProbeImage = (url: string) => Promise<{ width: number; height: number } | null>;

const PROBE_TIMEOUT_MS = 8_000;

/**
 * Load a URL through an off-screen Image so naturalWidth/naturalHeight can be
 * inspected before anything renders. Cross-origin dimensions are readable
 * without CORS, and the browser cache makes the later <img> render free.
 */
export function probeImageElement(url: string): Promise<{ width: number; height: number } | null> {
  if (typeof Image === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const finish = (value: { width: number; height: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    img.onload = () => finish({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => finish(null);
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    img.src = url;
  });
}

// Module-level memo so scroll re-renders resolve synchronously and a domain is
// probed at most once per session, no matter how many rows share it.
const verdicts = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();

export function resetSenderLogoCacheForTest() {
  verdicts.clear();
  inFlight.clear();
}

/**
 * Synchronous lookup: the winning URL, null for a settled initials verdict,
 * or undefined when the domain hasn't been resolved yet this session.
 */
export function peekSenderLogo(
  domain: string,
  storage: VerdictStorage | null = defaultStorage(),
): string | null | undefined {
  if (!domain) return null;
  const cached = verdicts.get(domain);
  if (cached !== undefined) return cached === INITIALS_VERDICT ? null : cached;
  const stored = readStoredVerdict(domain, storage);
  if (stored) {
    verdicts.set(domain, stored);
    return stored === INITIALS_VERDICT ? null : stored;
  }
  return undefined;
}

/**
 * Resolve the logo URL for a domain (null means "use initials"). Concurrent
 * callers for the same domain share one probe run. A definitive miss (some
 * source loaded but nothing acceptable) is persisted; a fully failed run
 * (offline, every probe errored) is only remembered for this session so a
 * transient outage can't permanently downgrade a real logo to initials.
 */
export function resolveSenderLogo(
  domain: string,
  options: { probe?: ProbeImage; storage?: VerdictStorage | null } = {},
): Promise<string | null> {
  if (!domain) return Promise.resolve(null);
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const peeked = peekSenderLogo(domain, storage);
  if (peeked !== undefined) return Promise.resolve(peeked);
  const pending = inFlight.get(domain);
  if (pending) return pending;

  const probe = options.probe || probeImageElement;
  const run = (async () => {
    let sawDecodedImage = false;
    for (const url of candidateLogoUrls(domain)) {
      const decoded = await probe(url).catch(() => null);
      if (!decoded) continue;
      sawDecodedImage = true;
      if (isAcceptableLogo({ width: decoded.width, height: decoded.height, url })) {
        verdicts.set(domain, url);
        writeStoredVerdict(domain, url, storage);
        return url;
      }
    }
    verdicts.set(domain, INITIALS_VERDICT);
    if (sawDecodedImage) writeStoredVerdict(domain, INITIALS_VERDICT, storage);
    return null;
  })().finally(() => {
    inFlight.delete(domain);
  });
  inFlight.set(domain, run);
  return run;
}
