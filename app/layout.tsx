import { ClerkProvider } from '@clerk/nextjs';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { CSSProperties } from 'react';
import { Toaster } from 'sonner';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { ThemeProvider } from '@/components/shell/ThemeProvider';
import { isStagingRuntime } from '@/lib/hosted/controls';
import { isClerkConfigured } from '@/lib/hosted/env';
import { GROTESK_FONT_FAMILY } from '@/lib/theme/font-families';
import './globals.css';

// The display serifs ship with the app (app/fonts, SIL Open Font License), so a
// build never depends on reaching Google Fonts. Two production builds failed
// on that fetch on 2026-09-26.

// Warm editorial display serif — used for the Daily Report masthead, datelines,
// and section heads. Body text stays Geist; this is scoped to display/headings.
const fraunces = localFont({
  src: [
    { path: './fonts/fraunces-latin-wght-normal.woff2', weight: '100 900', style: 'normal' },
    { path: './fonts/fraunces-latin-wght-italic.woff2', weight: '100 900', style: 'italic' },
  ],
  variable: '--font-fraunces',
  display: 'swap',
});

// Friendly hand-drawn-ish serif — the "News" UI font option in the theme
// panel (rounded terminals, newspaper warmth).
const averia = localFont({
  src: [
    { path: './fonts/averia-serif-libre-latin-300-normal.woff2', weight: '300', style: 'normal' },
    { path: './fonts/averia-serif-libre-latin-300-italic.woff2', weight: '300', style: 'italic' },
    { path: './fonts/averia-serif-libre-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/averia-serif-libre-latin-400-italic.woff2', weight: '400', style: 'italic' },
    { path: './fonts/averia-serif-libre-latin-700-normal.woff2', weight: '700', style: 'normal' },
    { path: './fonts/averia-serif-libre-latin-700-italic.woff2', weight: '700', style: 'italic' },
  ],
  variable: '--font-averia',
  display: 'swap',
});

// High-contrast literary display serif — elegant, airy headlines ("Editorial+").
const instrument = localFont({
  src: [
    { path: './fonts/instrument-serif-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/instrument-serif-latin-400-italic.woff2', weight: '400', style: 'italic' },
  ],
  variable: '--font-instrument',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Albatross',
  description: 'Mail, calendar, and files across connected accounts, with a daily brief',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-touch-icon.png',
  },
};

// Default workspace-frame colors before hydration. BrowserThemeColor then
// follows the resolved app theme and the user's live palette, not just OS mode.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#d2e0d6' },
    { media: '(prefers-color-scheme: dark)', color: '#19211c' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const clerkEnabled = isClerkConfigured();
  const clerkProxyUrl =
    clerkEnabled && process.env.NEXT_PUBLIC_CLERK_PROXY_URL && isStagingRuntime() ? '/__clerk' : undefined;
  const content = (
    <>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <QueryProvider clerkEnabled={clerkEnabled}>
          {children}
          <Toaster position="bottom-center" theme="system" closeButton richColors />
        </QueryProvider>
      </ThemeProvider>
    </>
  );

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} ${fraunces.variable} ${averia.variable} ${instrument.variable}`}
      style={{ '--font-hanken': GROTESK_FONT_FAMILY } as CSSProperties}
    >
      <body>
        {clerkEnabled ? (
          <ClerkProvider
            {...(clerkProxyUrl ? { proxyUrl: clerkProxyUrl } : {})}
            appearance={{
              variables: {
                colorBackground: 'var(--color-bg-elevated)',
                colorText: 'var(--color-text)',
                colorPrimary: 'var(--color-accent)',
              },
              elements: {
                avatarBox: 'bg-[var(--color-avatar-bg)]',
                userButtonAvatarBox: 'bg-[var(--color-avatar-bg)]',
                userButtonTrigger:
                  'rounded-md focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]',
              },
            }}
          >
            {content}
          </ClerkProvider>
        ) : (
          content
        )}
      </body>
    </html>
  );
}
