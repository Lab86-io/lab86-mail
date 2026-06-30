import { ClerkProvider } from '@clerk/nextjs';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata, Viewport } from 'next';
import { Averia_Serif_Libre, Fraunces, Hanken_Grotesk, Instrument_Serif } from 'next/font/google';
import { Toaster } from 'sonner';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { ThemeProvider } from '@/components/shell/ThemeProvider';
import { isStagingRuntime } from '@/lib/hosted/controls';
import { isClerkConfigured } from '@/lib/hosted/env';
import './globals.css';

// Warm editorial display serif — used for the Daily Report masthead, datelines,
// and section heads. Body text stays Geist; this is scoped to display/headings.
const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-fraunces',
  display: 'swap',
});

// Friendly hand-drawn-ish serif — the "News" UI font option in the theme
// panel (rounded terminals, newspaper warmth).
const averia = Averia_Serif_Libre({
  subsets: ['latin'],
  weight: ['300', '400', '700'],
  style: ['normal', 'italic'],
  variable: '--font-averia',
  display: 'swap',
});

// High-contrast literary display serif — elegant, airy headlines ("Editorial+").
const instrument = Instrument_Serif({
  subsets: ['latin'],
  weight: ['400'],
  style: ['normal', 'italic'],
  variable: '--font-instrument',
  display: 'swap',
});

// Warm modern grotesque — a friendlier sans option than Geist for the display
// layer (and the brief body).
const hanken = Hanken_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-hanken',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Lab86 Mail',
  description: 'AI-native mail across connected accounts',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-touch-icon.png',
  },
};

// Static values (matching --color-bg in globals.css) — CSS variables don't
// resolve in the theme-color meta tag, which is parsed before any stylesheet.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f8fb' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
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
      className={`${GeistSans.variable} ${GeistMono.variable} ${fraunces.variable} ${averia.variable} ${instrument.variable} ${hanken.variable}`}
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
                avatarBox: 'bg-[var(--color-avatar-bg)] shadow-[var(--shadow-control)]',
                userButtonAvatarBox: 'bg-[var(--color-avatar-bg)] shadow-[var(--shadow-control)]',
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
