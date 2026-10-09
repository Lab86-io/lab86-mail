import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { AUTH_PRODUCT_LINE, AuthScreen } from '../components/auth/AuthScreen';
import { isPublicRoute } from '../proxy';

const ROOT = path.join(import.meta.dir, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

function renderAuthScreen() {
  return new JSDOM(
    renderToStaticMarkup(
      <AuthScreen>
        <div data-clerk-form="true" />
      </AuthScreen>,
    ),
  ).window.document;
}

describe('sign-in and sign-up screens (Google OAuth home page checks)', () => {
  test('the screen names the app, says what it does, and links Privacy and Terms', () => {
    const doc = renderAuthScreen();
    const text = doc.body.textContent || '';
    expect(text).toContain('Albatross');
    expect(text).toContain(AUTH_PRODUCT_LINE);
    expect(AUTH_PRODUCT_LINE).toContain('email and calendar app from Lab86');
    expect(AUTH_PRODUCT_LINE).not.toMatch(/\bAI\b/);

    const footer = doc.querySelector('footer');
    expect(footer).not.toBeNull();
    const links = [...(footer?.querySelectorAll('a') ?? [])].map((link) => ({
      href: link.getAttribute('href'),
      label: link.textContent,
    }));
    expect(links).toEqual([
      { href: '/privacy', label: 'Privacy' },
      { href: '/terms', label: 'Terms' },
    ]);
    // The Clerk form renders inside the screen, beside the introduction.
    expect(doc.querySelector('[data-clerk-form]')).not.toBeNull();
  });

  test('the sign-in and sign-up pages render the Clerk form inside the shared screen', () => {
    for (const [file, widget] of [
      ['app/sign-in/[[...sign-in]]/page.tsx', 'SignIn'],
      ['app/sign-up/[[...sign-up]]/page.tsx', 'SignUp'],
    ] as const) {
      const source = read(file).replace(/\s+/g, ' ');
      expect(source).toContain("import { AuthScreen } from '@/components/auth/AuthScreen'");
      expect(source).toMatch(new RegExp(`<AuthScreen> <${widget}[^>]*/> </AuthScreen>`));
    }
  });

  test('the legal pages and the sign-in pages stay public', () => {
    for (const pathname of ['/privacy', '/terms', '/sign-in', '/sign-up', '/support', '/pricing']) {
      expect(isPublicRoute(new NextRequest(`https://mail.lab86.io${pathname}`)), pathname).toBe(true);
    }
  });
});

describe('privacy policy service providers', () => {
  const privacy = read('app/privacy/page.tsx').replace(/\s+/g, ' ');

  test('names each service that receives user data or the user IP address', () => {
    for (const provider of [
      'Railway',
      'Convex',
      'Nylas',
      'Clerk',
      'Stripe',
      'Resend',
      'OpenRouter',
      'Browserbase',
      'Apple Push Notification service',
      'Browser push services',
      'DuckDuckGo and Google site icons',
      'Open-Meteo',
      'OpenStreetMap Nominatim',
      'Google Maps',
      'Google Fonts',
      'museum collections',
      'DiceBear',
      'GitHub, Bitbucket, Atlassian (Jira and Confluence),',
      'Slack, or Granola',
      'These connections only read.',
    ]) {
      expect(privacy, provider).toContain(provider);
    }
  });

  test('keeps the Limited Use statement and limits Google data transfers', () => {
    expect(privacy).toContain('Google API Services User Data Policy');
    expect(privacy).toContain('including the Limited Use requirements');
    expect(privacy).toContain('We transfer Google user data to the service providers');
  });
});
