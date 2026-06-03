import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata, Viewport } from 'next';
import { Fraunces } from 'next/font/google';
import { Toaster } from 'sonner';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { ThemeProvider } from '@/components/shell/ThemeProvider';
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

export const metadata: Metadata = {
  title: 'lab86-mail',
  description: 'AI-native Lab86 mail client for Jakob',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-touch-icon.png',
  },
};

export const viewport: Viewport = {
  themeColor: 'var(--color-bg)',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} ${fraunces.variable}`}
    >
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <QueryProvider>
            {children}
            <Toaster position="bottom-center" theme="system" closeButton richColors />
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
