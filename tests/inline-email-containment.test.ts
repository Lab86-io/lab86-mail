import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { containInlineStyle, createInlineEmailSanitizer } from '../lib/sanitize';

const sanitize = createInlineEmailSanitizer(createDOMPurify(new JSDOM('').window as any));

test('a position:fixed overlay cannot leave the message box', () => {
  const html = sanitize(
    '<div style="position:fixed; inset:0; z-index:99999; color:#333">Your session expired</div>',
  );
  expect(html).not.toMatch(/position|z-index|inset/i);
  expect(html).toContain('color:#333');
  expect(html).toContain('Your session expired');
});

test('fake sign-in forms are removed from inline mail', () => {
  const html = sanitize(
    '<form action="https://evil.test"><label>Password</label><input type="password" name="p"><button>Sign in</button></form><p>Hi</p>',
  );
  expect(html).not.toMatch(/<form|<input|<button|<label/i);
  expect(html).toContain('<p>Hi</p>');
});

test('ordinary inline styles and links survive', () => {
  const html = sanitize('<p style="font-weight:600">Bold</p><a href="https://example.test">Link</a>');
  expect(html).toContain('font-weight:600');
  expect(html).toContain('href="https://example.test"');
  expect(sanitize('<p style="position:absolute">x</p>')).toBe('<p>x</p>');
});

test('style filtering drops escape hatches and unsafe values', () => {
  expect(containInlineStyle('top: -9999px; left:0; transform: scale(9); margin: 4px')).toBe('margin: 4px');
  expect(containInlineStyle('width: expression(alert(1)); color: red')).toBe('color: red');
  expect(containInlineStyle('background-image: url(javascript:x)')).toBe('');
  expect(containInlineStyle('background-image: url(https://cdn.test/a.png)')).toBe(
    'background-image: url(https://cdn.test/a.png)',
  );
  expect(containInlineStyle(';;broken; color: blue')).toBe('color: blue');
});

test('the inline mail container contains paint as a second layer', () => {
  const css = readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8');
  const rule = css.slice(css.indexOf('  .email-body {'), css.indexOf('}', css.indexOf('  .email-body {')));
  expect(rule).toContain('contain: paint;');
  expect(rule).toContain('position: relative;');
});
