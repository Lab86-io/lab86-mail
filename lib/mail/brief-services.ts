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

const GMAIL_2026_LOGO = `<svg class="${ICON_CLASS}" viewBox="0 0 800 636.36322" role="img" aria-label="Gmail"><title>Gmail</title><path fill="url(#gmail-footer-gradient-a)" d="M627.27193 81.819216h172.72682V581.8179c0 30.12265-24.42266 54.54532-54.54531 54.54532h-90.90885a27.272655 27.272655 0 0 1-27.27266-27.27266z"/><path fill="#fc413d" d="M172.72768 81.819216H.00085692711V581.8179c0 30.12265 24.42266207289 54.54532 54.54531007289 54.54532h90.908853a27.272655 27.272655 0 0 0 27.27266-27.27266z"/><path fill="url(#gmail-footer-gradient-b)" d="M141.93685 20.255746C105.42331-10.435083 50.946177-5.7169131 20.255349 30.796627-10.435479 67.305622-5.7173098 121.78275 30.79623 152.47813l345.80818 290.6765a36.36354 36.36354 0 0 0 46.79533 0L769.20792 152.47358C805.71691 121.78275 810.43508 67.305622 779.74426 30.792081 749.05343-5.7169131 694.5763-10.435083 658.0673 20.255746L399.9998 237.18245z"/><defs><linearGradient id="gmail-footer-gradient-a" x1="713.6374" x2="713.6374" y1="81.819216" y2="636.36322" gradientUnits="userSpaceOnUse"><stop stop-color="#60d673"/><stop offset=".17" stop-color="#42c868"/><stop offset=".39" stop-color="#0ebc5f"/><stop offset=".62" stop-color="#00a9bb"/><stop offset=".86" stop-color="#3c90ff"/><stop offset="1" stop-color="#3186ff"/></linearGradient><linearGradient id="gmail-footer-gradient-b" x1="0" x2="799.9998" y1="91.501434" y2="91.501434" gradientUnits="userSpaceOnUse"><stop offset=".08" stop-color="#ff63a0"/><stop offset=".3" stop-color="#fc413d"/><stop offset=".65" stop-color="#fc413d"/><stop offset=".72" stop-color="#fc5c30"/><stop offset=".86" stop-color="#feb10c"/><stop offset=".91" stop-color="#fec700"/><stop offset=".96" stop-color="#ffdb0f"/></linearGradient></defs></svg>`;

const MICROSOFT_LOGO = `<svg class="${ICON_CLASS}" viewBox="0 0 24 24" role="img" aria-label="Outlook"><title>Outlook</title><path fill="#F25022" d="M1 1h10.5v10.5H1z"/><path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z"/><path fill="#00A4EF" d="M1 12.5h10.5V23H1z"/><path fill="#FFB900" d="M12.5 12.5H23V23H12.5z"/></svg>`;

const SERVICES: Record<BriefServiceId, BriefService> = {
  gmail: {
    id: 'gmail',
    label: 'Gmail',
    logoSvg: GMAIL_2026_LOGO,
  },
  outlook: {
    id: 'outlook',
    label: 'Outlook',
    logoSvg: MICROSOFT_LOGO,
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
