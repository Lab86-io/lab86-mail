export type BriefServiceId =
  | 'gmail'
  | 'outlook'
  | 'icloud'
  | 'mail'
  | 'github'
  | 'bitbucket'
  | 'jira'
  | 'slack'
  | 'calendar'
  | 'tasks';

export interface BriefService {
  id: BriefServiceId;
  label: string;
  logoSvg: string;
}

const ICON_CLASS = 'footer-logo';

const SERVICES: Record<BriefServiceId, BriefService> = {
  gmail: {
    id: 'gmail',
    label: 'Gmail',
    logoSvg: `<svg class="${ICON_CLASS}" viewBox="0 0 24 24" role="img" aria-label="Gmail"><path fill="#EA4335" d="M3.4 5.1h17.2v13.8H3.4z"/><path fill="#fff" d="M5.1 7.3v9.8h13.8V7.3L12 12.4 5.1 7.3Z"/><path fill="#FBBC04" d="M3.4 5.1 12 11.5l8.6-6.4v2.6L12 14.1 3.4 7.7V5.1Z"/><path fill="#34A853" d="M3.4 7.7v11.2h3.1V10L3.4 7.7Z"/><path fill="#4285F4" d="M20.6 7.7v11.2h-3.1V10l3.1-2.3Z"/></svg>`,
  },
  outlook: {
    id: 'outlook',
    label: 'Outlook',
    logoSvg: `<svg class="${ICON_CLASS}" viewBox="0 0 24 24" role="img" aria-label="Outlook"><path fill="#0078D4" d="M2 5.2 11 3v18l-9-2.2V5.2Z"/><path fill="#50A7F9" d="M11 5h10v14H11z"/><path fill="#fff" d="M13 8h6v1.6h-6V8Zm0 3.2h6v1.6h-6v-1.6Zm0 3.2h4.4V16H13v-1.6Z"/><path fill="#fff" d="M6.55 8.4c1.65 0 2.8 1.32 2.8 3.1s-1.15 3.1-2.8 3.1-2.8-1.32-2.8-3.1 1.15-3.1 2.8-3.1Zm0 1.3c-.76 0-1.27.72-1.27 1.8s.51 1.8 1.27 1.8 1.27-.72 1.27-1.8-.51-1.8-1.27-1.8Z"/></svg>`,
  },
  icloud: {
    id: 'icloud',
    label: 'iCloud',
    logoSvg: `<svg class="${ICON_CLASS}" viewBox="0 0 24 24" role="img" aria-label="iCloud"><path fill="currentColor" d="M17.05 12.96c-.03-2.62 2.14-3.88 2.24-3.94-1.22-1.79-3.12-2.03-3.8-2.06-1.61-.16-3.15.95-3.97.95-.82 0-2.09-.93-3.44-.9-1.77.03-3.4 1.03-4.31 2.61-1.84 3.19-.47 7.9 1.32 10.49.88 1.27 1.92 2.69 3.29 2.64 1.32-.05 1.82-.85 3.42-.85 1.6 0 2.05.85 3.44.82 1.42-.02 2.32-1.29 3.19-2.56 1-1.46 1.41-2.88 1.43-2.95-.03-.01-2.75-1.05-2.78-4.18l-.03-.07ZM14.44 5.26c.73-.88 1.22-2.11 1.08-3.33-1.05.04-2.32.7-3.07 1.58-.67.78-1.26 2.02-1.1 3.21 1.17.09 2.36-.59 3.09-1.46Z"/></svg>`,
  },
  mail: {
    id: 'mail',
    label: 'Mail',
    logoSvg: `<svg class="${ICON_CLASS}" viewBox="0 0 24 24" role="img" aria-label="Mail"><path fill="none" stroke="currentColor" stroke-width="2" d="M4 6h16v12H4z"/><path fill="none" stroke="currentColor" stroke-width="2" d="m4 7 8 6 8-6"/></svg>`,
  },
  github: {
    id: 'github',
    label: 'GitHub',
    logoSvg: `<svg class="${ICON_CLASS}" viewBox="0 0 24 24" role="img" aria-label="GitHub"><path fill="currentColor" d="M12 .5a12 12 0 0 0-3.8 23.38c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.74.08-.74 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.48.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.92 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.47 11.47 0 0 1 6.02 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.6-2.81 5.61-5.48 5.91.43.37.82 1.1.82 2.22v3.31c0 .32.21.7.83.58A12 12 0 0 0 12 .5Z"/></svg>`,
  },
  bitbucket: {
    id: 'bitbucket',
    label: 'Bitbucket',
    logoSvg: `<svg class="${ICON_CLASS}" viewBox="0 0 24 24" role="img" aria-label="Bitbucket"><path fill="#2684FF" d="M2.26 3.1a.72.72 0 0 0-.71.83l2.97 18.04c.08.5.51.87 1.02.87h14.25c.38 0 .7-.27.76-.65l2.97-18.25a.72.72 0 0 0-.71-.84H2.26Zm12.74 13.1H9.1L7.5 9.74h8.58L15 16.2Z"/><path fill="#0052CC" d="M22.22 9.74h-6.14L15 16.2H9.1l-6.96 8.26c.19.17.44.27.7.27h14.25c.38 0 .7-.27.76-.65l4.37-14.34Z" opacity=".55"/></svg>`,
  },
  jira: {
    id: 'jira',
    label: 'Jira',
    logoSvg: `<svg class="${ICON_CLASS}" viewBox="0 0 24 24" role="img" aria-label="Jira"><path fill="#2684FF" d="M11.88 2.43 2.34 11.97a1.64 1.64 0 0 0 0 2.32l6.55 6.55 3.02-3.02-5.38-5.38 5.35-5.35 5.38 5.38 3.02-3.02-6.08-6.08a1.64 1.64 0 0 0-2.32 0Z"/><path fill="#0052CC" d="m11.91 7.09 5.35 5.38-5.35 5.35 3.02 3.02 6.55-6.55a1.64 1.64 0 0 0 0-2.32l-6.55-6.55-3.02 3.02Z"/></svg>`,
  },
  slack: {
    id: 'slack',
    label: 'Slack',
    logoSvg: `<svg class="${ICON_CLASS}" viewBox="0 0 24 24" role="img" aria-label="Slack"><path fill="#36C5F0" d="M8.45 2a2.05 2.05 0 0 0 0 4.1h2.05V4.05A2.05 2.05 0 0 0 8.45 2Zm0 5.47H2.98a2.05 2.05 0 0 0 0 4.1h5.47a2.05 2.05 0 0 0 0-4.1Z"/><path fill="#2EB67D" d="M22 9.52a2.05 2.05 0 0 0-4.1 0v2.05h2.05A2.05 2.05 0 0 0 22 9.52Zm-5.47 0V4.05a2.05 2.05 0 0 0-4.1 0v5.47a2.05 2.05 0 0 0 4.1 0Z"/><path fill="#ECB22E" d="M14.48 22a2.05 2.05 0 0 0 0-4.1h-2.05v2.05A2.05 2.05 0 0 0 14.48 22Zm0-5.47h5.47a2.05 2.05 0 0 0 0-4.1h-5.47a2.05 2.05 0 0 0 0 4.1Z"/><path fill="#E01E5A" d="M2 14.48a2.05 2.05 0 0 0 4.1 0v-2.05H4.05A2.05 2.05 0 0 0 2 14.48Zm5.47 0v5.47a2.05 2.05 0 0 0 4.1 0v-5.47a2.05 2.05 0 0 0-4.1 0Z"/></svg>`,
  },
  calendar: {
    id: 'calendar',
    label: 'Calendar',
    logoSvg: `<svg class="${ICON_CLASS}" viewBox="0 0 24 24" role="img" aria-label="Calendar"><path fill="none" stroke="currentColor" stroke-width="2" d="M4 5h16v15H4zM4 9h16M8 3v4m8-4v4"/></svg>`,
  },
  tasks: {
    id: 'tasks',
    label: 'Tasks',
    logoSvg: `<svg class="${ICON_CLASS}" viewBox="0 0 24 24" role="img" aria-label="Tasks"><path fill="none" stroke="currentColor" stroke-width="2" d="m5 12 4 4L19 6M5 20h14"/></svg>`,
  },
};

const ALIASES: Record<string, BriefServiceId> = {
  google: 'gmail',
  gmail: 'gmail',
  microsoft: 'outlook',
  outlook: 'outlook',
  icloud: 'icloud',
  apple: 'icloud',
  imap: 'mail',
  mail: 'mail',
  github: 'github',
  bitbucket: 'bitbucket',
  jira: 'jira',
  atlassian: 'jira',
  atlassianjira: 'jira',
  slack: 'slack',
  calendar: 'calendar',
  tasks: 'tasks',
};

export function briefServiceFromProvider(provider: string): BriefServiceId {
  return normalizeBriefServiceId(provider) || 'mail';
}

export function normalizeBriefServiceId(value: string | null | undefined): BriefServiceId | null {
  const key = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return ALIASES[key] || null;
}

export function briefServicesFromIds(values: Array<string | null | undefined>): BriefService[] {
  const seen = new Set<BriefServiceId>();
  const services: BriefService[] = [];
  for (const value of values) {
    const id = normalizeBriefServiceId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    services.push(SERVICES[id]);
  }
  return services;
}

export function briefServiceDefinition(id: string): BriefService | null {
  const normalized = normalizeBriefServiceId(id);
  return normalized ? SERVICES[normalized] : null;
}
