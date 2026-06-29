import { Mail, Plug } from 'lucide-react';
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

export function GitHubLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label="GitHub"
      className={cn('size-4 fill-current text-[#181717] dark:text-white', className)}
    >
      <title>GitHub</title>
      <path d="M12 .5a12 12 0 0 0-3.8 23.38c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.74.08-.74 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.48.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.92 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.47 11.47 0 0 1 6.02 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.6-2.81 5.61-5.48 5.91.43.37.82 1.1.82 2.22v3.31c0 .32.21.7.83.58A12 12 0 0 0 12 .5Z" />
    </svg>
  );
}

export function BitbucketLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Bitbucket" className={cn('size-4', className)}>
      <title>Bitbucket</title>
      <path
        fill="#2684FF"
        d="M2.26 3.1a.72.72 0 0 0-.71.83l2.97 18.04c.08.5.51.87 1.02.87h14.25c.38 0 .7-.27.76-.65l2.97-18.25a.72.72 0 0 0-.71-.84H2.26Zm12.74 13.1H9.1L7.5 9.74h8.58L15 16.2Z"
      />
      <path
        fill="#0052CC"
        d="M22.22 9.74h-6.14L15 16.2H9.1l-6.96 8.26c.19.17.44.27.7.27h14.25c.38 0 .7-.27.76-.65l4.37-14.34Z"
        opacity="0.55"
      />
    </svg>
  );
}

export function JiraLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Jira" className={cn('size-4', className)}>
      <title>Jira</title>
      <path
        fill="#2684FF"
        d="M11.88 2.43 2.34 11.97a1.64 1.64 0 0 0 0 2.32l6.55 6.55 3.02-3.02-5.38-5.38 5.35-5.35 5.38 5.38 3.02-3.02-6.08-6.08a1.64 1.64 0 0 0-2.32 0Z"
      />
      <path
        fill="#0052CC"
        d="m11.91 7.09 5.35 5.38-5.35 5.35 3.02 3.02 6.55-6.55a1.64 1.64 0 0 0 0-2.32l-6.55-6.55-3.02 3.02Z"
      />
    </svg>
  );
}

export function SlackLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Slack" className={cn('size-4', className)}>
      <title>Slack</title>
      <path
        fill="#36C5F0"
        d="M8.45 2a2.05 2.05 0 0 0 0 4.1h2.05V4.05A2.05 2.05 0 0 0 8.45 2Zm0 5.47H2.98a2.05 2.05 0 0 0 0 4.1h5.47a2.05 2.05 0 0 0 0-4.1Z"
      />
      <path
        fill="#2EB67D"
        d="M22 9.52a2.05 2.05 0 0 0-4.1 0v2.05h2.05A2.05 2.05 0 0 0 22 9.52Zm-5.47 0V4.05a2.05 2.05 0 0 0-4.1 0v5.47a2.05 2.05 0 0 0 4.1 0Z"
      />
      <path
        fill="#ECB22E"
        d="M14.48 22a2.05 2.05 0 0 0 0-4.1h-2.05v2.05A2.05 2.05 0 0 0 14.48 22Zm0-5.47h5.47a2.05 2.05 0 0 0 0-4.1h-5.47a2.05 2.05 0 0 0 0 4.1Z"
      />
      <path
        fill="#E01E5A"
        d="M2 14.48a2.05 2.05 0 0 0 4.1 0v-2.05H4.05A2.05 2.05 0 0 0 2 14.48Zm5.47 0v5.47a2.05 2.05 0 0 0 4.1 0v-5.47a2.05 2.05 0 0 0-4.1 0Z"
      />
    </svg>
  );
}

export function ConnectionLogo({ server, className }: { server: string; className?: string }) {
  if (server === 'github') return <GitHubLogo className={className} />;
  if (server === 'bitbucket') return <BitbucketLogo className={className} />;
  if (server === 'jira') return <JiraLogo className={className} />;
  if (server === 'slack') return <SlackLogo className={className} />;
  return <Plug aria-hidden className={cn('size-4', className)} />;
}

export function ProviderLogo({ provider, className }: { provider: string; className?: string }) {
  if (provider === 'google') return <GoogleLogo className={className} />;
  if (provider === 'microsoft') return <MicrosoftLogo className={className} />;
  if (provider === 'icloud') return <AppleLogo className={className} />;
  if (provider === 'github' || provider === 'bitbucket' || provider === 'jira' || provider === 'slack') {
    return <ConnectionLogo server={provider} className={className} />;
  }
  return <Mail aria-hidden className={cn('size-4', className)} />;
}

export function providerDisplayName(provider: string) {
  if (provider === 'google') return 'Gmail';
  if (provider === 'microsoft') return 'Outlook';
  if (provider === 'icloud') return 'iCloud';
  if (provider === 'imap') return 'IMAP';
  if (provider === 'github') return 'GitHub';
  if (provider === 'bitbucket') return 'Bitbucket';
  if (provider === 'jira') return 'Jira';
  if (provider === 'slack') return 'Slack';
  return provider;
}
