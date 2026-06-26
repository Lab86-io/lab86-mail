import { describe, expect, test } from 'bun:test';
import { emailDeclaresOwnBackground, emailNeedsIsolatedFrame } from '../lib/sanitize';

describe('emailDeclaresOwnBackground', () => {
  test('detects bgcolor attributes and inline background colors', () => {
    expect(emailDeclaresOwnBackground('<table bgcolor="#ffffff"><tr><td>Hi</td></tr></table>')).toBe(true);
    expect(emailDeclaresOwnBackground('<div style="background-color:#111111">Hi</div>')).toBe(true);
    expect(emailDeclaresOwnBackground('<div style="background: transparent">Hi</div>')).toBe(false);
    expect(emailDeclaresOwnBackground('<p>Plain reply</p>')).toBe(false);
  });
});

describe('emailNeedsIsolatedFrame', () => {
  test('requires iframe rendering for branded HTML mail', () => {
    expect(emailNeedsIsolatedFrame('<html><body><table><tr><td>Newsletter</td></tr></table></body></html>')).toBe(
      true,
    );
    expect(emailNeedsIsolatedFrame('<!--[if mso]>outlook markup<![endif]-->')).toBe(true);
    expect(emailNeedsIsolatedFrame('<p>Thanks for the update.</p>')).toBe(false);
  });
});
