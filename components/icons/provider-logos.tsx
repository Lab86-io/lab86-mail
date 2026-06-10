import { Mail } from 'lucide-react';
import { cn } from '@/lib/utils';

// Official brand marks, inlined as SVG paths so they render crisply at any
// size with no network fetch. Sources: Google identity guidelines "G",
// Microsoft logo (four squares), Apple mark.

export function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Google" className={cn('size-4', className)}>
      <title>Google</title>
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.11A12 12 0 0 0 12 24Z"
      />
      <path fill="#FBBC05" d="M5.28 14.28a7.2 7.2 0 0 1 0-4.56V6.61H1.27a12 12 0 0 0 0 10.78l4.01-3.11Z" />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.27 6.61l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77Z"
      />
    </svg>
  );
}

export function MicrosoftLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Microsoft" className={cn('size-4', className)}>
      <title>Microsoft</title>
      <path fill="#F25022" d="M1 1h10.5v10.5H1z" />
      <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
      <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" />
      <path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
    </svg>
  );
}

export function AppleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Apple" className={cn('size-4 fill-current', className)}>
      <title>Apple</title>
      <path d="M17.05 12.96c-.03-2.62 2.14-3.88 2.24-3.94-1.22-1.79-3.12-2.03-3.8-2.06-1.61-.16-3.15.95-3.97.95-.82 0-2.09-.93-3.44-.9-1.77.03-3.4 1.03-4.31 2.61-1.84 3.19-.47 7.9 1.32 10.49.88 1.27 1.92 2.69 3.29 2.64 1.32-.05 1.82-.85 3.42-.85 1.6 0 2.05.85 3.44.82 1.42-.02 2.32-1.29 3.19-2.56 1-1.46 1.41-2.88 1.43-2.95-.03-.01-2.75-1.05-2.78-4.18l-.03-.07ZM14.44 5.26c.73-.88 1.22-2.11 1.08-3.33-1.05.04-2.32.7-3.07 1.58-.67.78-1.26 2.02-1.1 3.21 1.17.09 2.36-.59 3.09-1.46Z" />
    </svg>
  );
}

export function ProviderLogo({ provider, className }: { provider: string; className?: string }) {
  if (provider === 'google') return <GoogleLogo className={className} />;
  if (provider === 'microsoft') return <MicrosoftLogo className={className} />;
  if (provider === 'icloud') return <AppleLogo className={className} />;
  return <Mail aria-hidden className={cn('size-4', className)} />;
}

export function providerDisplayName(provider: string) {
  if (provider === 'google') return 'Gmail';
  if (provider === 'microsoft') return 'Outlook';
  if (provider === 'icloud') return 'iCloud';
  if (provider === 'imap') return 'IMAP';
  return provider;
}
