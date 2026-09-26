import { describe, expect, mock, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { composeWeeklyReviewDocument } from '../lib/brief/weekly-document';
import { composeBudgetBriefDocument } from '../lib/mail/brief-budget-document';
import {
  briefEmailHtml,
  briefEmailLink,
  briefEmailSections,
  briefEmailSubject,
  briefEmailText,
  deliverBriefEmail,
} from '../lib/mail/brief-email';
import { runBriefJob } from '../lib/mail/brief-jobs';
import { parseBriefDocument } from '../lib/shared/brief-document';
import type { DailyReport } from '../lib/shared/types';
import { migrateDailyReport } from '../lib/store/daily-reports';

const NOW = Date.parse('2026-09-28T11:00:00Z');
const TZ = 'America/New_York';

function edition(extra: Partial<DailyReport> = {}): DailyReport {
  const report = {
    _id: 'r<1>',
    kind: 'morning',
    generatedAt: NOW,
    accounts: [],
    title: 'Brief',
    narrative: 'Two replies wait on you.',
    sections: {
      answer: [
        {
          account: 'a1',
          threadId: 't1',
          subject: 'Deck <draft> & notes',
          people: ['Maya'],
          sender: 'Maya',
          whyItMatters: 'She asked for notes.',
          unread: true,
        },
      ],
    },
    stats: {},
    ...extra,
  } as unknown as DailyReport;
  report.document = composeBudgetBriefDocument({
    report,
    prose: { lede: 'Two replies wait on you.', weekAhead: 'Thursday is the review.', lines: {} },
    timezone: TZ,
  });
  return report;
}

describe('the brief email', () => {
  test('turns the edition into sections, with a summary for what email cannot draw', () => {
    const report = edition();
    expect(briefEmailSections(report.document!)).toEqual([
      { title: null, text: 'Two replies wait on you.', items: [] },
      {
        title: 'Answer',
        text: null,
        items: [{ label: 'Deck <draft> & notes', meta: 'Maya', line: null }],
      },
      { title: 'Week ahead', text: 'Thursday is the review.', items: [] },
    ]);
    const tool = parseBriefDocument({
      version: 2,
      title: 'x',
      summary: 'x',
      generatedAt: NOW,
      regions: [
        {
          id: 'chart',
          summary: 'A chart of the week.',
          tree: { kind: 'metric', label: 'Replies', value: '3', emphasis: 'standard', tone: 'neutral' },
        },
      ],
    });
    expect(briefEmailSections(tool)).toEqual([{ title: null, text: 'A chart of the week.', items: [] }]);
  });

  test('escapes the content and links every item to the edition', () => {
    const report = edition();
    const link = briefEmailLink(report._id, 'https://mail.example.com/');
    expect(link).toBe('https://mail.example.com/brief?id=r%3C1%3E');
    const html = briefEmailHtml({ report, document: report.document!, link, timezone: TZ });
    expect(html).toContain('Deck &lt;draft&gt; &amp; notes');
    expect(html).not.toContain('<draft>');
    expect(html).toContain('href="https://mail.example.com/brief?id=r%3C1%3E"');
    expect(html).toContain('The Monday Brief');
    expect(html).toContain('Open in Albatross');
    expect(html).not.toMatch(/\bAI\b/);
    expect(briefEmailSubject(report, TZ)).toBe('Your brief for Monday, September 28');
    expect(briefEmailSubject({ ...report, kind: 'weekly' }, TZ)).toBe(
      'Your weekly review, Monday, September 28',
    );
    const text = briefEmailText(report.document!, link);
    expect(text).toContain('Answer\n- Deck <draft> & notes\n  Maya');
    expect(text.endsWith(`Open in Albatross: ${link}`)).toBe(true);
    const weekly = { ...report, kind: 'weekly' as const };
    const review = composeWeeklyReviewDocument({ generatedAt: NOW, sections: report.sections }, TZ);
    expect(briefEmailHtml({ report: weekly, document: review, link })).toContain('The Weekly Review');
  });
});

describe('sending the brief by email', () => {
  function deps(overrides: Record<string, unknown> = {}) {
    const sent: any[] = [];
    const saved: DailyReport[] = [];
    return {
      sent,
      saved,
      deps: {
        configured: () => true,
        preferences: async () => ({ emailEnabled: true }),
        primaryEmail: async () => 'me@example.com',
        fetch: async (url: string, init: RequestInit) => {
          sent.push({ url, body: JSON.parse(String(init.body)) });
          return new Response(JSON.stringify({ id: 'email-1' }));
        },
        save: async (report: DailyReport) => {
          saved.push(report);
          return report;
        },
        publicUrl: () => 'https://mail.example.com',
        ...overrides,
      } as any,
    };
  }

  test('sends a scheduled edition once to the primary address', async () => {
    const report = edition();
    const { sent, saved, deps: injected } = deps();
    expect(await deliverBriefEmail('u1', report, TZ, injected)).toEqual({ sent: true, id: 'email-1' });
    expect(sent[0].url).toBe('https://api.resend.com/emails');
    expect(sent[0].body).toMatchObject({
      to: ['me@example.com'],
      subject: 'Your brief for Monday, September 28',
    });
    expect(sent[0].body.text).toContain('Open in Albatross');
    expect(saved[0].emailedAt).toBeGreaterThan(0);
    expect(await deliverBriefEmail('u1', saved[0], TZ, injected)).toEqual({
      sent: false,
      reason: 'already_sent',
    });
    expect(sent).toHaveLength(1);
  });

  test('stays quiet when the edition, the setting, the server, or the address says so', async () => {
    const report = edition();
    expect(await deliverBriefEmail('u1', { ...report, kind: 'manual' }, TZ, deps().deps)).toEqual({
      sent: false,
      reason: 'edition',
    });
    expect(await deliverBriefEmail('u1', report, TZ, deps({ configured: () => false }).deps)).toEqual({
      sent: false,
      reason: 'unconfigured',
    });
    expect(await deliverBriefEmail('u1', { ...report, document: undefined }, TZ, deps().deps)).toEqual({
      sent: false,
      reason: 'no_document',
    });
    expect(
      await deliverBriefEmail(
        'u1',
        report,
        TZ,
        deps({ preferences: async () => ({ emailEnabled: false }) }).deps,
      ),
    ).toEqual({ sent: false, reason: 'off' });
    expect(await deliverBriefEmail('u1', report, TZ, deps({ primaryEmail: async () => '' }).deps)).toEqual({
      sent: false,
      reason: 'no_address',
    });
  });

  test('a failed send throws and marks nothing', async () => {
    const { saved, deps: injected } = deps({
      fetch: async () => new Response(JSON.stringify({ message: 'Domain not verified' }), { status: 422 }),
    });
    await expect(deliverBriefEmail('u1', edition(), TZ, injected)).rejects.toThrow('Domain not verified');
    expect(saved).toHaveLength(0);
    const bare = deps({ fetch: async () => new Response('nope', { status: 500 }) });
    await expect(deliverBriefEmail('u1', edition(), TZ, bare.deps)).rejects.toThrow('Resend failed (500)');
  });

  test('the edition keeps when it was emailed', () => {
    const migrated = migrateDailyReport({ ...edition(), emailedAt: 5 } as any);
    expect(migrated.emailedAt).toBe(5);
  });

  test('the brief job emails after it announces, and a failed email never fails the job', async () => {
    const calls: Array<{ name: string; args: any }> = [];
    const email = mock(async () => {
      throw new Error('resend down');
    });
    const report = { ...edition(), editorial: { mode: 'generated' } };
    const jobDeps = {
      mutation: (async (fn: any, args: any) => {
        const name = getFunctionName(fn);
        calls.push({ name, args });
        if (name === 'briefJobs:claim')
          return {
            kind: 'daily',
            edition: 'morning',
            reportId: 'r<1>',
            createdAt: NOW,
            attempts: 1,
            timezone: TZ,
          };
        return true;
      }) as any,
      query: (async () => null) as any,
      telemetry: mock(async () => {}),
      daily: mock(async () => report),
      weekly: mock(async () => report),
      area: mock(async () => ({})),
      narrative: mock(async () => ({})),
      readDaily: mock(async () => null),
      notify: mock(async () => {}),
      email,
      noAccess: mock(async () => false),
      now: () => 100,
    };
    await runBriefJob('owner', 'job', jobDeps as any);
    expect(email).toHaveBeenCalledTimes(1);
    expect(email.mock.calls[0]).toEqual(['owner', report, TZ] as any);
    expect(calls.at(-1)?.args.error).toBeUndefined();
  });
});
