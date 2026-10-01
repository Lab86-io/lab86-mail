import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { sanitizeEmailFrameHtml, sanitizeEmailHtml, sanitizeOutgoingHtml } from '../lib/sanitize';

const g = globalThis as { window?: unknown };
const previousWindow = g.window;

test('the wrappers return nothing on the server', () => {
  expect(sanitizeEmailHtml('<p>Hi</p>')).toBe('');
  expect(sanitizeEmailFrameHtml('<p>Hi</p>')).toBe('');
  expect(sanitizeOutgoingHtml('<p>Hi</p>')).toBe('');
});

describe('in the browser', () => {
  beforeAll(() => {
    g.window = new JSDOM('').window;
  });

  afterAll(() => {
    g.window = previousWindow;
  });

  test('outgoing html keeps formatting but drops scripts, handlers, and styles', () => {
    const html = sanitizeOutgoingHtml(
      '<p style="color:red" onclick="x()">Hi <strong>there</strong></p><script>alert(1)</script><pre><code>a</code></pre><a href="javascript:x">bad</a><a href="https://example.test">ok</a>',
    );
    expect(html).toContain('<strong>there</strong>');
    expect(html).toContain('<pre><code>a</code></pre>');
    expect(html).toContain('href="https://example.test"');
    expect(html).not.toMatch(/<script|onclick|style=|javascript:/i);
  });

  test('frame html keeps style blocks and removes active content', () => {
    const html = sanitizeEmailFrameHtml(
      '<html><head><style>.a{color:#123}</style><meta http-equiv="refresh" content="0"></head><body><p class="a" onload="x()">Hi</p><iframe src="https://evil.test"></iframe><img src="data:image/png;base64,AAAA"></body></html>',
    );
    expect(html).toContain('.a{color:#123}');
    expect(html).toContain('<p class="a">Hi</p>');
    expect(html).toContain('data:image/png;base64,AAAA');
    expect(html).not.toMatch(/<iframe|<meta|onload/i);
  });

  test('inline read html uses the cached contained sanitizer', () => {
    const html = sanitizeEmailHtml('<div style="position:fixed; color:#333">Hi</div><form><input></form>');
    expect(html).toContain('color:#333');
    expect(html).not.toMatch(/position|<form|<input/i);
    expect(sanitizeEmailHtml('<p>Again</p>')).toBe('<p>Again</p>');
  });
});
