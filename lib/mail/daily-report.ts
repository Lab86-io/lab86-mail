import { randomUUID } from 'node:crypto';
import { generateText } from 'ai';
import { describeProvider, fastModel, hasAi } from '../ai/client';
import { normalizeGogMessage, normalizeGogSearchItem } from '../gog/normalize';
import { runGogJson } from '../gog/pool';
import { classifyThreadWithContext } from '../mail/smart-categories';
import { emailFromHeader, shortFrom } from '../shared/format';
import type { DailyReport, DailyReportItem, Message, Thread, ThreadInsight } from '../shared/types';
import { saveDailyReport } from '../store/daily-reports';
import { getThreadMessages, upsertMessage as upsertMessageRecord } from '../store/messages';
import { listSmartLabels } from '../store/smart-labels';
import { listSmartRules } from '../store/smart-rules';
import { insightId, upsertThreadInsight } from '../store/thread-insights';
import { getThread, upsertThread } from '../store/threads';
import { listTrackedThreads, upsertTrackedThread } from '../store/tracked-threads';

const ACCOUNT_LIST = (
  process.env.LAB86_MAIL_ACCOUNTS ||
  process.env.MAIL_OS_ACCOUNTS ||
  'jjalangtry@gmail.com,jakob@lab86.io'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const RECENT_QUERIES = [
  'in:inbox newer_than:14d -in:trash -in:spam',
  'is:unread newer_than:30d -in:trash -in:spam',
  'is:starred newer_than:180d -in:trash -in:spam',
  'in:sent newer_than:14d -in:trash -in:spam',
];

export async function generateDailyReport(input: {
  kind: DailyReport['kind'];
  accounts?: string[];
  now?: number;
  maxRecentPerAccount?: number;
  includeCalendar?: boolean;
}) {
  const now = input.now || Date.now();
  const accounts = input.accounts?.length ? input.accounts : await authedAccounts();
  const errors: string[] = [];
  const [rules, customLabels, tracked] = await Promise.all([
    listSmartRules(),
    listSmartLabels(),
    listTrackedThreads({ limit: 500 }),
  ]);
  const trackedByKey = new Map(tracked.map((item) => [`${item.account}:${item.threadId}`, item]));
  const candidates = new Map<string, Thread>();

  for (const account of accounts) {
    for (const query of RECENT_QUERIES) {
      try {
        for (const thread of await searchAccountThreads(account, query, input.maxRecentPerAccount || 18)) {
          candidates.set(`${thread.account}:${thread._id}`, thread);
        }
      } catch (err: any) {
        errors.push(`${account}: ${err?.message || 'search failed'}`);
      }
    }
  }

  for (const item of tracked) {
    if (item.status === 'resolved' || item.status === 'dismissed') continue;
    if (accounts.length && !accounts.includes(item.account)) continue;
    const existing = await getThread(item.account, item.threadId);
    if (existing) candidates.set(`${existing.account}:${existing._id}`, existing);
  }

  const calendarContext = input.includeCalendar !== false ? await loadCalendarContext(accounts, now) : [];
  const sorted = [...candidates.values()].sort((a, b) => Number(b.lastDate || 0) - Number(a.lastDate || 0));
  const bounded = sorted.slice(0, 120);
  const insights: ThreadInsight[] = [];

  for (const thread of bounded) {
    const trackedItem = trackedByKey.get(`${thread.account}:${thread._id}`);
    const messages = await loadThreadMessages(thread.account, thread._id);
    const smart = classifyThreadWithContext(thread, { rules, customLabels });
    const insight = await buildThreadInsight(thread, messages, smart, Boolean(trackedItem), now);
    insights.push(insight);
    await upsertThread(thread.account, { ...thread, smartCategory: smart }).catch(() => undefined);
    await upsertThreadInsight(insight).catch(() => undefined);
    if (insight.suggestedTrack && !trackedItem) {
      await upsertTrackedThread({
        account: thread.account,
        threadId: thread._id,
        subject: thread.subject,
        participants: insight.people,
        status: insight.waitingOnSomeone
          ? 'waiting'
          : insight.commitments.some((c) => c.dueAt)
            ? 'due_soon'
            : 'open',
        reason: insight.reason,
        openLoops: insight.openLoops,
        nextAction: insight.needsReply ? 'Reply' : insight.waitingOnSomeone ? 'Wait for response' : 'Review',
        dueAt: insight.commitments.find((c) => c.dueAt)?.dueAt || null,
        importance: insight.needsReply || insight.commitments.length ? 1 : 2,
        source: 'report',
      }).catch(() => undefined);
    }
  }

  const refreshedTracked = await listTrackedThreads({ limit: 500 });
  const report = await composeReport({
    kind: input.kind,
    now,
    accounts,
    insights,
    tracked: refreshedTracked.filter((item) => accounts.includes(item.account)),
    calendarContext,
    errors,
  });
  await saveDailyReport(report);
  return report;
}

async function authedAccounts() {
  try {
    const raw = await runGogJson<any>(['auth', 'list', '--json', '--no-input'], { timeoutMs: 15_000 });
    const discovered = (raw?.accounts || []).map((a: any) => a.email).filter(Boolean);
    return [...new Set([...ACCOUNT_LIST, ...discovered])];
  } catch {
    return ACCOUNT_LIST;
  }
}

async function searchAccountThreads(account: string, query: string, max: number) {
  const raw = await runGogJson<any>([
    '--account',
    account,
    '--json',
    'gmail',
    'search',
    '--max',
    String(max),
    '--no-input',
    '--',
    query,
  ]);
  const threads = coerceList(raw)
    .map((item) => normalizeGogSearchItem(item, account))
    .filter((item) => item._id);
  for (const thread of threads) await upsertThread(account, thread).catch(() => undefined);
  return threads as Thread[];
}

async function loadThreadMessages(account: string, threadId: string) {
  const cached = await getThreadMessages(account, threadId);
  if (cached.length) return cached.sort((a, b) => Number(a.date || 0) - Number(b.date || 0));
  try {
    const raw = await runGogJson<any>([
      '--account',
      account,
      '--json',
      'gmail',
      'thread',
      'get',
      threadId,
      '--full',
      '--no-input',
    ]);
    const arr: any[] = (raw?.thread || raw?.result || raw?.data || raw)?.messages || [];
    const messages = arr
      .map((m) => normalizeGogMessage(m, account))
      .filter((m) => m._id)
      .sort((a, b) => Number(a.date || 0) - Number(b.date || 0));
    for (const message of messages) await upsertMessageRecord(message).catch(() => undefined);
    return messages;
  } catch {
    return cached;
  }
}

async function buildThreadInsight(
  thread: Thread,
  messages: Message[],
  smart: Thread['smartCategory'],
  tracked: boolean,
  now: number,
): Promise<ThreadInsight> {
  const text = threadText(thread, messages, 8000);
  const people = extractPeople(thread, messages);
  const commitments = extractCommitments(text, now);
  const needsReply =
    Boolean(smart?.isHumanLike && smart.secondary.includes('needs_reply')) ||
    /\b(reply|respond|let me know|can you|could you|please send|waiting for your|need your)\b/i.test(text);
  const waitingOnSomeone =
    /\b(i'?ll call|i will call|we will call|i'?ll send|will follow up|waiting on|circle back)\b/i.test(text);
  const openLoops = [
    ...commitments.map((item) => item.text),
    ...(needsReply ? ['Potential reply needed'] : []),
    ...(waitingOnSomeone ? ['Waiting on someone else'] : []),
  ].slice(0, 4);

  if (hasAi() && (tracked || needsReply || waitingOnSomeone || commitments.length || smart?.needsAttention)) {
    try {
      const { text: aiText } = await generateText({
        model: fastModel(),
        system:
          'Analyze this email thread for Jakob. Return only JSON: {"summary":"...","openLoops":["..."],"needsReply":true|false,"waitingOnSomeone":true|false,"reason":"...","nextAction":"..."}',
        prompt: text,
      });
      const parsed = parseJson(aiText);
      if (parsed) {
        return {
          _id: insightId(thread.account, thread._id),
          account: thread.account,
          threadId: thread._id,
          subject: thread.subject,
          summary: String(parsed.summary || thread.snippet || thread.subject).slice(0, 500),
          people,
          commitments,
          openLoops: Array.isArray(parsed.openLoops)
            ? parsed.openLoops.map(String).filter(Boolean).slice(0, 5)
            : openLoops,
          needsReply: Boolean(parsed.needsReply),
          waitingOnSomeone: Boolean(parsed.waitingOnSomeone),
          suggestedTrack:
            tracked ||
            Boolean(parsed.needsReply) ||
            Boolean(parsed.waitingOnSomeone) ||
            commitments.some((item) => item.dueAt && item.dueAt >= now),
          suggestedCategory: smart?.primary || 'review',
          reason: String(parsed.reason || parsed.nextAction || smart?.reason || 'Important thread').slice(
            0,
            280,
          ),
          generatedAt: now,
          model: describeProvider().fast || 'fast',
        };
      }
    } catch {}
  }

  return {
    _id: insightId(thread.account, thread._id),
    account: thread.account,
    threadId: thread._id,
    subject: thread.subject,
    summary: thread.snippet || thread.subject,
    people,
    commitments,
    openLoops,
    needsReply,
    waitingOnSomeone,
    suggestedTrack:
      tracked ||
      needsReply ||
      waitingOnSomeone ||
      commitments.some((item) => item.dueAt && item.dueAt >= now),
    suggestedCategory: smart?.primary || 'review',
    reason: smart?.reason || 'Recent or tracked thread',
    generatedAt: now,
    model: 'local',
  };
}

async function composeReport(input: {
  kind: DailyReport['kind'];
  now: number;
  accounts: string[];
  insights: ThreadInsight[];
  tracked: Awaited<ReturnType<typeof listTrackedThreads>>;
  calendarContext: string[];
  errors: string[];
}) {
  const trackedKeys = new Map(input.tracked.map((item) => [`${item.account}:${item.threadId}`, item]));
  const toItem = (insight: ThreadInsight): DailyReportItem => {
    const tracked = trackedKeys.get(`${insight.account}:${insight.threadId}`);
    return {
      account: insight.account,
      threadId: insight.threadId,
      subject: insight.subject,
      people: insight.people,
      whyItMatters: insight.reason || insight.summary,
      nextAction: insight.needsReply
        ? 'Reply'
        : insight.waitingOnSomeone
          ? 'Wait / follow up'
          : tracked?.nextAction,
      dueAt: insight.commitments.find((item) => item.dueAt)?.dueAt || tracked?.dueAt || null,
      unread: false,
      trackedThreadId: tracked?._id,
    };
  };

  const dueSoon = input.insights
    .filter((item) =>
      item.commitments.some((c) => c.dueAt && c.dueAt >= input.now && c.dueAt < input.now + 7 * 86400_000),
    )
    .slice(0, 8)
    .map(toItem);
  const needsReply = input.insights
    .filter((item) => item.needsReply)
    .slice(0, 10)
    .map(toItem);
  const waiting = input.insights
    .filter((item) => item.waitingOnSomeone)
    .slice(0, 8)
    .map(toItem);
  const trackedItems = input.tracked
    .filter((item) => item.status !== 'resolved' && item.status !== 'dismissed')
    .slice(0, 10)
    .map((item) => ({
      account: item.account,
      threadId: item.threadId,
      subject: item.subject,
      people: item.participants,
      whyItMatters: item.reason,
      nextAction: item.nextAction,
      dueAt: item.dueAt,
      unread: false,
      trackedThreadId: item._id,
    }));
  const urgent = [...dueSoon, ...needsReply].slice(0, 6);
  const notable = input.insights
    .filter((item) => !item.needsReply && !item.waitingOnSomeone && !item.commitments.length)
    .slice(0, 6)
    .map(toItem);
  let narrative = localNarrative(input.kind, urgent, needsReply, waiting, trackedItems);
  let model = 'local';

  if (hasAi()) {
    try {
      const { text } = await generateText({
        model: fastModel(),
        system:
          'Write Jakob a concise Daily Report from his email. Be concrete and narrative, not generic. Mention important open loops, timing, interviews, offers, calls, and replies. Return only the prose narrative, 2-4 short paragraphs.',
        prompt: [
          `Kind: ${input.kind}`,
          `Now: ${new Date(input.now).toString()}`,
          `Calendar context: ${input.calendarContext.join(' | ') || 'none'}`,
          `Needs reply: ${needsReply.map((i) => `${i.people.join(', ')}: ${i.subject} (${i.whyItMatters})`).join('\n')}`,
          `Waiting: ${waiting.map((i) => `${i.people.join(', ')}: ${i.subject} (${i.whyItMatters})`).join('\n')}`,
          `Due soon: ${dueSoon.map((i) => `${i.people.join(', ')}: ${i.subject} due ${i.dueAt ? new Date(i.dueAt).toString() : ''}`).join('\n')}`,
          `Tracked: ${trackedItems.map((i) => `${i.people.join(', ')}: ${i.subject} (${i.whyItMatters})`).join('\n')}`,
        ].join('\n\n'),
      });
      narrative = text.trim() || narrative;
      model = describeProvider().fast || 'fast';
    } catch {}
  }

  return {
    _id: randomUUID(),
    kind: input.kind,
    generatedAt: input.now,
    accounts: input.accounts,
    title: `${input.kind === 'evening' ? 'Evening' : input.kind === 'morning' ? 'Morning' : 'Manual'} Daily Report`,
    narrative,
    sections: {
      urgent,
      needsReply,
      waiting,
      dueSoon,
      tracked: trackedItems,
      notable,
      noiseSummary:
        'Subscribed, publication, platform, and promo mail stayed out of the report unless it looked actionable.',
    },
    stats: {
      scannedThreads: input.insights.length,
      trackedThreads: trackedItems.length,
      needsReply: needsReply.length,
      dueSoon: dueSoon.length,
      unread: 0,
    },
    model,
    errors: input.errors,
  } satisfies DailyReport;
}

function localNarrative(
  kind: DailyReport['kind'],
  urgent: DailyReportItem[],
  needsReply: DailyReportItem[],
  waiting: DailyReportItem[],
  tracked: DailyReportItem[],
) {
  const parts = [
    `${kind === 'evening' ? 'This evening' : 'Today'}, your mail has ${urgent.length} urgent thread${urgent.length === 1 ? '' : 's'}, ${needsReply.length} conversation${needsReply.length === 1 ? '' : 's'} that may need a reply, and ${waiting.length} waiting loop${waiting.length === 1 ? '' : 's'}.`,
  ];
  if (tracked.length) {
    parts.push(
      `The tracked conversations remain the backbone: ${tracked
        .slice(0, 3)
        .map((item) => item.people[0] || item.subject)
        .join(', ')}.`,
    );
  }
  if (urgent[0]) parts.push(`Start with ${urgent[0].subject}: ${urgent[0].whyItMatters}`);
  return parts.join('\n\n');
}

async function loadCalendarContext(accounts: string[], now: number) {
  const fromIso = new Date(now).toISOString();
  const toIso = new Date(now + 7 * 86400_000).toISOString();
  const out: string[] = [];
  for (const account of accounts.slice(0, 3)) {
    const raw = await runGogJson<any>([
      '--account',
      account,
      '--json',
      'calendar',
      'freebusy',
      '--from',
      fromIso,
      '--to',
      toIso,
      '--no-input',
    ]).catch(() => null);
    if (raw?.busy || raw?.calendars)
      out.push(`${account}: ${JSON.stringify(raw.busy || raw.calendars).slice(0, 600)}`);
  }
  return out;
}

function threadText(thread: Thread, messages: Message[], maxChars: number) {
  const msgText = messages
    .slice(-8)
    .map(
      (m, index) =>
        `Message ${index + 1}\nFrom: ${m.from}\nTo: ${m.to}\nDate: ${new Date(Number(m.date || 0)).toString()}\nSubject: ${m.subject}\n\n${m.textBody || m.snippet || ''}`,
    )
    .join('\n\n');
  return [`Thread: ${thread.subject}`, `From: ${thread.fromAddress}`, `Snippet: ${thread.snippet}`, msgText]
    .join('\n\n')
    .slice(0, maxChars);
}

function extractPeople(thread: Thread, messages: Message[]) {
  const values = [
    thread.fromAddress,
    ...messages.flatMap((message) => [message.from, message.to, message.cc]),
  ];
  const names = new Set<string>();
  for (const value of values) {
    for (const part of String(value || '').split(',')) {
      const email = emailFromHeader(part);
      if (email && /jjalangtry|jakob@lab86/i.test(email)) continue;
      const label = shortFrom(part);
      if (label) names.add(label);
    }
  }
  return [...names].slice(0, 5);
}

function extractCommitments(text: string, now: number) {
  const commitments: ThreadInsight['commitments'] = [];
  const lines = text
    .split(/\n+/)
    .filter((line) =>
      /\b(call|interview|offer|deadline|due|sign|send|meet|meeting|tuesday|monday|wednesday|thursday|friday|tomorrow|today)\b/i.test(
        line,
      ),
    );
  for (const line of lines.slice(0, 8)) {
    commitments.push({
      text: line.trim().slice(0, 220),
      dueAt: inferDueAt(line, now),
      confidence: 0.58,
    });
  }
  return commitments;
}

function inferDueAt(text: string, now: number) {
  const lower = text.toLowerCase();
  const timeMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  const base = new Date(now);
  if (lower.includes('tomorrow')) base.setDate(base.getDate() + 1);
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const weekday = weekdays.findIndex((day) => lower.includes(day));
  if (weekday >= 0) {
    const diff = (weekday - base.getDay() + 7) % 7 || 7;
    base.setDate(base.getDate() + diff);
  }
  if (timeMatch) {
    let hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2] || 0);
    const ampm = timeMatch[3];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    base.setHours(hour, minute, 0, 0);
    return base.getTime();
  }
  if (weekday >= 0 || lower.includes('tomorrow') || lower.includes('today')) {
    base.setHours(17, 0, 0, 0);
    return base.getTime();
  }
  return null;
}

function coerceList(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.messages)) return raw.messages;
  if (Array.isArray(raw?.threads)) return raw.threads;
  if (Array.isArray(raw?.results)) return raw.results;
  if (Array.isArray(raw?.items)) return raw.items;
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw?.result)) return raw.result;
  return [];
}

function parseJson(text: string) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}
