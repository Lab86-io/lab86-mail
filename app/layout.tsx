import { ClerkProvider, Show, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata, Viewport } from 'next';
import { Fraunces } from 'next/font/google';
import { Toaster } from 'sonner';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { ThemeProvider } from '@/components/shell/ThemeProvider';
import { isPublicSignupDisabled, isStagingRuntime } from '@/lib/hosted/controls';
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

export const viewport: Viewport = {
  themeColor: 'var(--color-bg)',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const clerkProxyUrl =
    process.env.NEXT_PUBLIC_CLERK_PROXY_URL && isStagingRuntime() ? '/__clerk' : undefined;
  const content = (
    <>
      {process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? <ClerkNav /> : null}
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <QueryProvider>
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
      className={`${GeistSans.variable} ${GeistMono.variable} ${fraunces.variable}`}
    >
      <body>
        {process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? (
          <ClerkProvider {...(clerkProxyUrl ? { proxyUrl: clerkProxyUrl } : {})}>{content}</ClerkProvider>
        ) : (
          content
        )}
      </body>
    </html>
  );
}

function ClerkNav() {
  const signupDisabled = isPublicSignupDisabled();
  return (
    <div className="fixed top-3 right-3 z-50 flex items-center gap-2">
      <Show when="signed-out">
        <SignInButton mode="modal">
          <button
            type="button"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1 text-[12px] text-[var(--color-text)] shadow-sm"
          >
            Sign in
          </button>
        </SignInButton>
        {signupDisabled ? null : (
          <SignUpButton mode="modal">
            <button
              type="button"
              className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[12px] text-[var(--color-accent-foreground)] shadow-sm"
            >
              Sign up
            </button>
          </SignUpButton>
        )}
      </Show>
      <Show when="signed-in">
        <UserButton />
      </Show>
    </div>
  );
}
