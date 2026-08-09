import { describe, expect, test } from 'bun:test';
import {
  emailDeclaresOwnBackground,
  emailNeedsIsolatedFrame,
  sanitizeEmailFrameHtml,
  sanitizeEmailHtml,
  sanitizeOutgoingHtml,
} from '../lib/sanitize';

// The frame chooser decides whether mail renders in the isolated iframe (its
// own CSS survives, EmailFrame scales it to the pane) or adapts inline. These
// pin the decision so a chooser change cannot silently reroute mail.

describe('emailDeclaresOwnBackground', () => {
  test('sees bgcolor table mail', () => {
    expect(emailDeclaresOwnBackground('<table bgcolor="#ffffff"><tr><td>x</td></tr></table>')).toBe(true);
  });
  test('sees inline background colors and images', () => {
    expect(emailDeclaresOwnBackground('<div style="background-color: #f6f6f6">x</div>')).toBe(true);
    expect(emailDeclaresOwnBackground('<div style="background: url(banner.png)">x</div>')).toBe(true);
  });
  test('ignores non-color background values', () => {
    expect(emailDeclaresOwnBackground('<div style="background: transparent">x</div>')).toBe(false);
    expect(emailDeclaresOwnBackground('<div style="background-color: inherit">x</div>')).toBe(false);
  });
  test('a bare reply declares nothing', () => {
    expect(emailDeclaresOwnBackground('<p>Sounds good, see you then.</p>')).toBe(false);
  });
});

describe('emailNeedsIsolatedFrame', () => {
  test('full documents and table layouts take the frame', () => {
    expect(emailNeedsIsolatedFrame('<!doctype html><html><body>x</body></html>')).toBe(true);
    expect(emailNeedsIsolatedFrame('<table><tr><td>x</td></tr></table>')).toBe(true);
    expect(emailNeedsIsolatedFrame('<style>.a{color:red}</style><p>x</p>')).toBe(true);
  });
  test('outlook conditionals and mail-css markers take the frame', () => {
    expect(emailNeedsIsolatedFrame('<!--[if mso]><p>x</p><![endif]-->')).toBe(true);
    expect(emailNeedsIsolatedFrame('<div>@media (max-width: 600px) { .a {} }</div>')).toBe(true);
    expect(emailNeedsIsolatedFrame('<p style="mso-line-height-rule:exactly">x</p>')).toBe(true);
  });
  test('simple fragments stay inline', () => {
    expect(emailNeedsIsolatedFrame('<p>Thanks! <a href="https://example.test">Link</a></p>')).toBe(false);
    expect(emailNeedsIsolatedFrame('Plain words only')).toBe(false);
  });
});

describe('sanitizers without a window', () => {
  test('return empty on the server so SSR and client cannot diverge', () => {
    expect(sanitizeEmailHtml('<p>x</p>')).toBe('');
    expect(sanitizeEmailFrameHtml('<p>x</p>')).toBe('');
    expect(sanitizeOutgoingHtml('<p>x</p>')).toBe('');
  });
});
