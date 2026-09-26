import { clerkClient } from '@clerk/nextjs/server';
import { loadBriefPreferences } from '../brief/preferences';
import { hostedPublicUrl } from '../hosted/env';
import { transactionalEmailConfigured } from '../notifications/delivery';
import type { BriefDocumentV2, BriefNode } from '../shared/brief-document';
import { dailyBriefDatelineAt } from '../shared/brief-edition';
import type { DailyReport } from '../shared/types';
import { saveDailyReport } from '../store/daily-reports';

// The Brief by email (FEATURES item 6). When the user turns it on and the
// server has transactional email (Resend), each scheduled edition (the
// morning edition and the weekly review) also goes to the user's primary
// address. Every item links back to the edition in the app.

export const BRIEF_EMAIL_EDITIONS = new Set(['morning', 'weekly']);
const ITEM_LIMIT = 8;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface BriefEmailSection {
  title: string | null;
  text: string | null;
  items: Array<{ label: string; meta: string | null; line: string | null }>;
}

const REGION_TITLES: Record<string, string> = {
  yesterday: 'Since yesterday',
  since: 'What Albatross did',
  answer: 'Answer',
  today: 'Today',
  know: 'Know',
  waiting: 'Waiting on',
  tasks: 'Tasks this week',
  connected: 'Connected tools',
  'week-ahead': 'Week ahead',
  areas: 'Areas',
  done: 'Done this week',
  open: 'Still open',
  'next-week': 'Next week',
};

function textOf(node: BriefNode): string | null {
  if (node.kind === 'text') return node.text;
  if (node.kind === 'hero' || node.kind === 'stack') {
    const parts = node.children.map(textOf).filter((part): part is string => Boolean(part));
    return parts.length ? parts.join('\n\n') : null;
  }
  return null;
}

/**
 * The edition as plain sections: the lede, each list with its rows, each
 * paragraph. A region the email cannot draw (an interactive component) is
 * its one-line summary.
 */
export function briefEmailSections(document: BriefDocumentV2): BriefEmailSection[] {
  const sections: BriefEmailSection[] = [];
  for (const region of document.regions) {
    const tree = region.tree;
    const title = REGION_TITLES[region.id] ?? null;
    if (tree.kind === 'entity_list') {
      const items = tree.items.slice(0, ITEM_LIMIT).map((item) => ({
        label: item.ref.label || 'Untitled',
        meta: item.framing.sender || null,
        line: item.framing.reason || null,
      }));
      if (items.length) sections.push({ title: tree.title || title, text: null, items });
      continue;
    }
    const text = textOf(tree) || region.summary || null;
    if (text) sections.push({ title: region.id === 'lede' ? null : title, text, items: [] });
  }
  return sections;
}

export function briefEmailLink(reportId: string, base = hostedPublicUrl()) {
  return `${base.replace(/\/$/, '')}/brief?id=${encodeURIComponent(reportId)}`;
}

export function briefEmailSubject(
  report: Pick<DailyReport, 'kind' | 'generatedAt'>,
  timezone?: string | null,
) {
  const date = dailyBriefDatelineAt(report.generatedAt, timezone);
  return report.kind === 'weekly' ? `Your weekly review, ${date}` : `Your brief for ${date}`;
}

export function briefEmailHtml(input: {
  report: Pick<DailyReport, '_id' | 'kind' | 'generatedAt'>;
  document: BriefDocumentV2;
  link: string;
  timezone?: string | null;
}) {
  const link = escapeHtml(input.link);
  const heading = escapeHtml(
    input.report.kind === 'weekly'
      ? 'The Weekly Review'
      : `The ${new Intl.DateTimeFormat('en-US', {
          timeZone: input.document.timezone || 'UTC',
          weekday: 'long',
        }).format(new Date(input.report.generatedAt))} Brief`,
  );
  const dateline = escapeHtml(
    dailyBriefDatelineAt(input.report.generatedAt, input.timezone ?? input.document.timezone),
  );
  const body = briefEmailSections(input.document)
    .map((section) => {
      const title = section.title
        ? `<h2 style="font-size:13px;font-weight:600;color:#6b6b6b;margin:28px 0 8px">${escapeHtml(section.title)}</h2>`
        : '';
      const text = section.text
        ? section.text
            .split(/\n{2,}/)
            .map(
              (paragraph) =>
                `<p style="font-size:${section.title ? 15 : 19}px;line-height:1.55;margin:0 0 12px;color:#1a1a1a${section.title ? '' : ';font-family:Georgia,serif'}">${escapeHtml(paragraph)}</p>`,
            )
            .join('')
        : '';
      const items = section.items.length
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${section.items
            .map(
              (item) =>
                `<tr><td style="padding:10px 0;border-top:1px solid #ececec"><a href="${link}" style="color:#1a1a1a;text-decoration:none;font-size:15px;font-weight:600">${escapeHtml(item.label)}</a>${
                  item.meta
                    ? `<div style="font-size:12px;color:#6b6b6b;margin-top:2px">${escapeHtml(item.meta)}</div>`
                    : ''
                }${
                  item.line
                    ? `<div style="font-size:14px;color:#454545;line-height:1.5;margin-top:4px">${escapeHtml(item.line)}</div>`
                    : ''
                }</td></tr>`,
            )
            .join('')}</table>`
        : '';
      return `${title}${text}${items}`;
    })
    .join('');
  return `<!doctype html><html><body style="margin:0;background:#faf8f5"><div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:32px 20px;color:#1a1a1a"><p style="font-size:12px;color:#6b6b6b;margin:0">${dateline}</p><h1 style="font-family:Georgia,serif;font-size:30px;line-height:1.12;margin:8px 0 20px">${heading}</h1>${body}<p style="margin:32px 0 12px"><a href="${link}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:11px 16px;border-radius:999px;font-size:14px">Open in Albatross</a></p><p style="font-size:12px;color:#777">You get this because Brief by email is on. Turn it off in Settings, Daily Brief.</p></div></body></html>`;
}

export function briefEmailText(document: BriefDocumentV2, link: string) {
  return [
    ...briefEmailSections(document).map((section) =>
      [
        section.title,
        section.text,
        ...section.items.map((item) =>
          [`- ${item.label}`, item.meta ? `  ${item.meta}` : null, item.line ? `  ${item.line}` : null]
            .filter(Boolean)
            .join('\n'),
        ),
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    `Open in Albatross: ${link}`,
  ].join('\n\n');
}

async function clerkPrimaryEmail(userId: string) {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  return (
    user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId)?.emailAddress ||
    user.emailAddresses[0]?.emailAddress ||
    ''
  );
}

const defaults = {
  configured: () => transactionalEmailConfigured(),
  preferences: (userId: string) => loadBriefPreferences(userId),
  primaryEmail: clerkPrimaryEmail,
  fetch: (input: string, init: RequestInit) => fetch(input, init),
  save: (report: DailyReport) => saveDailyReport(report),
  publicUrl: () => hostedPublicUrl(),
};

export type BriefEmailResult =
  | { sent: true; id: string }
  | {
      sent: false;
      reason: 'edition' | 'off' | 'unconfigured' | 'no_document' | 'already_sent' | 'no_address';
    };

/**
 * Sends one edition by email when the user turned it on. Records `emailedAt`
 * on the edition, so a job that runs again never sends it twice. Throws on a
 * send failure; the caller logs it and the edition stays published.
 */
export async function deliverBriefEmail(
  userId: string,
  report: DailyReport,
  timezone?: string,
  deps = defaults,
): Promise<BriefEmailResult> {
  if (!BRIEF_EMAIL_EDITIONS.has(report.kind)) return { sent: false, reason: 'edition' };
  if (report.emailedAt) return { sent: false, reason: 'already_sent' };
  if (!deps.configured()) return { sent: false, reason: 'unconfigured' };
  if (!report.document) return { sent: false, reason: 'no_document' };
  const preferences = await deps.preferences(userId);
  if (!preferences.emailEnabled) return { sent: false, reason: 'off' };
  const to = await deps.primaryEmail(userId);
  if (!to) return { sent: false, reason: 'no_address' };
  const link = briefEmailLink(report._id, deps.publicUrl());
  const response = await deps.fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY || ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.LAB86_NOTIFICATION_FROM || '',
      to: [to],
      subject: briefEmailSubject(report, timezone),
      html: briefEmailHtml({ report, document: report.document, link, timezone }),
      text: briefEmailText(report.document, link),
    }),
  });
  const payload = await response.json().catch(() => ({}) as Record<string, unknown>);
  if (!response.ok)
    throw new Error(String((payload as any)?.message || `Resend failed (${response.status})`));
  await deps.save({ ...report, emailedAt: Date.now() });
  return { sent: true, id: String((payload as any)?.id || '') };
}
