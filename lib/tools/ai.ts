import { z } from 'zod';
import { describeProvider } from '../ai/client';
import { contextFirstName } from '../ai/context';
import { generateTextForCurrentUser, hasAiForCurrentUser } from '../ai/gateway';
import { api, convexQuery } from '../hosted/convex';
import { isConvexConfigured } from '../hosted/env';
import { applyNaturalLanguageAccountHint } from '../mail/search/account-scope';
import { parseMailSearchQuery } from '../mail/search/parser';
import { classifyThreadWithContext, SMART_CATEGORY_IDS } from '../mail/smart-categories';
import { getNylasThread } from '../nylas/provider';
import type { SmartCategory, SmartCategoryId, SmartLabelDefinition, SmartRule } from '../shared/types';
import { requireStoreUserId } from '../store/kv';
import { recallSender } from '../store/memories';
import { getThreadMessages, upsertMessage as upsertMessageRecord } from '../store/messages';
import { listSmartLabels } from '../store/smart-labels';
import { listSmartRules } from '../store/smart-rules';
import {
  getThread as getThreadRecord,
  setThreadSummary,
  setThreadTriage,
  upsertThread,
} from '../store/threads';
import { defineTool } from './registry';

async function loadThread(account: string, threadId: string, userId?: string | null) {
  const cached = await getThreadMessages(account, threadId);
  if (cached.length) return cached.sort((a, b) => (Number(a.date) || 0) - (Number(b.date) || 0));

  const thread = await getNylasThread({ userId, account, threadId }).catch(() => null);
  const messages = (thread?.messages || [])
    .filter((message) => message._id)
    .sort((a, b) => (Number(a.date) || 0) - (Number(b.date) || 0));
  for (const message of messages) await upsertMessageRecord(message).catch(() => undefined);
  const newest = messages[messages.length - 1];
  if (newest) {
    await upsertThread(account, {
      _id: threadId,
      subject: newest.subject || messages[0]?.subject || '(no subject)',
      fromAddress: newest.from,
      lastDate: newest.date,
      snippet: newest.snippet || newest.textBody?.slice(0, 240) || '',
      labels: newest.labels || [],
      unread: messages.some((message) => message.labels?.includes('UNREAD')),
    }).catch(() => undefined);
  }
  return messages;
}

function concatThread(messages: any[], maxChars = 24_000): string {
  return messages
    .map(
      (m, i) =>
        `--- Message ${i + 1}/${messages.length} ---\nFrom: ${m.from}\nTo: ${m.to}\nDate: ${new Date(m.date).toISOString()}\nSubject: ${m.subject}\n\n${(m.textBody || m.snippet || '').slice(0, 4000)}`,
    )
    .join('\n\n')
    .slice(0, maxChars);
}

export const summarizeThread = defineTool({
  name: 'summarize_thread',
  description: 'Generate a structured rolling summary of a thread and cache it.',
  category: 'ai',
  mutating: false,
  input: z.object({ account: z.string(), threadId: z.string() }),
  output: z.object({ summary: z.string(), model: z.string() }),
  async handler({ account, threadId }, ctx) {
    const cachedThread = await getThreadRecord(account, threadId).catch(() => null);
    if (
      cachedThread?.summary &&
      cachedThread.summaryAt &&
      Date.now() - cachedThread.summaryAt < 6 * 60 * 60_000
    ) {
      // Surface the real model that produced the cached summary, not 'cached'.
      return { summary: cachedThread.summary, model: cachedThread.summaryModel || 'cached' };
    }
    const messages = await loadThread(account, threadId, ctx.userId);
    if (!messages.length) return { summary: '(empty thread)', model: 'none' };
    if (!(await hasAiForCurrentUser())) {
      const senders = [...new Set(messages.map((m) => m.from))].slice(0, 3).join(', ');
      const summary = `${messages[0].subject} — ${messages.length} message(s) with ${senders}.`;
      await setThreadSummary(account, threadId, summary, 'local').catch(() => undefined);
      return { summary, model: 'local' };
    }
    const prompt = [
      'Summarize this email thread for the user as a tight TL;DR.',
      'Output: one plain sentence (max ~25 words) capturing the gist. Then, ONLY if the thread genuinely warrants it, up to 3 short bullets (each "- ", max ~12 words) for the key facts, asks, or deadlines.',
      'No headings, no preamble, no sign-off. Omit the bullets entirely for simple threads.',
      '',
      'Thread:',
      concatThread(messages),
    ].join('\n');
    try {
      const result = await generateTextForCurrentUser({
        feature: 'summarize_thread',
        // Summaries are bulk single-shot work: nano tier (always the cheap
        // model, ignores the user's fast-model override).
        speed: 'nano',
        // Minimal reasoning: nano is a reasoning model, and with a tight output
        // cap its hidden reasoning tokens can consume the entire budget and
        // return EMPTY visible text. A TL;DR needs no chain-of-thought — force
        // the fastest, cheapest single-pass behavior.
        providerOptions: { openai: { reasoningEffort: 'minimal' } },
        system:
          "You are lab86-mail, the user's email assistant. Be concrete. Never claim an action was performed; you can only reason.",
        prompt,
      });
      const summary = result.text.trim();
      // An empty completion is a silent failure (e.g. reasoning ate the budget,
      // or the provider returned no text). Treat it as an error so the local
      // fallback below fires instead of caching a blank card.
      if (!summary) throw new Error('model returned an empty summary');
      // The provider's response carries the concrete model id it served.
      const model = (result as any)?.response?.modelId || describeProvider().fast || 'ai';
      await setThreadSummary(account, threadId, summary, model).catch(() => undefined);
      return { summary, model };
    } catch (err: any) {
      // Cloud model failed — most often insufficient_quota / rate limit / network.
      // Fall back to a deterministic local summary so the UI never gets stuck.
      const senders = [...new Set(messages.map((m) => m.from))].slice(0, 3).join(', ');
      const last = messages[messages.length - 1];
      const summary = `${last.subject} — ${messages.length} message(s) with ${senders}; latest from ${last.from}.\n\n(AI summary unavailable: ${err?.message || 'model error'}.)`;
      await setThreadSummary(account, threadId, summary, 'local-fallback').catch(() => undefined);
      return { summary, model: 'local-fallback' };
    }
  },
});

export const triageThread = defineTool({
  name: 'triage_thread',
  description:
    'Classify a thread by priority (1=urgent, 2=normal, 3=low), suggest an action, and store the verdict.',
  category: 'ai',
  mutating: false,
  input: z.object({ account: z.string(), threadId: z.string() }),
  output: z.object({
    priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    action: z.string(),
    reason: z.string(),
    model: z.string(),
  }),
  async handler({ account, threadId }, ctx) {
    const messages = await loadThread(account, threadId, ctx.userId);
    if (!messages.length)
      return { priority: 3 as const, action: 'archive', reason: 'empty thread', model: 'none' };
    if (!(await hasAiForCurrentUser())) {
      const triage = {
        priority: (messages[messages.length - 1].labels.includes('UNREAD') ? 2 : 3) as 1 | 2 | 3,
        action: 'read',
        reason: 'heuristic (no AI configured)',
        at: Date.now(),
      };
      await setThreadTriage(account, threadId, triage).catch(() => undefined);
      return { priority: triage.priority, action: triage.action, reason: triage.reason, model: 'local' };
    }
    const prompt = [
      'Triage this email thread.',
      'Output a single JSON object: { "priority": 1|2|3, "action": "reply"|"read"|"archive"|"delegate"|"wait", "reason": "<short>" }.',
      'Priority 1 = needs reply today. 2 = needs attention this week. 3 = informational / low.',
      'No prose around the JSON.',
      '',
      'Thread:',
      concatThread(messages),
    ].join('\n');
    const { text } = await generateTextForCurrentUser({
      feature: 'triage_thread',
      speed: 'fast',
      system: 'You are lab86-mail triaging email. Output only valid JSON.',
      prompt,
    });
    let parsed: any = {};
    try {
      const match = text.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : {};
    } catch {}
    const priority = (
      parsed.priority === 1 || parsed.priority === 2 || parsed.priority === 3 ? parsed.priority : 2
    ) as 1 | 2 | 3;
    const action = String(parsed.action || 'read');
    const reason = String(parsed.reason || '').slice(0, 240);
    await setThreadTriage(account, threadId, { priority, action, reason, at: Date.now() }).catch(
      () => undefined,
    );
    return { priority, action, reason, model: 'fast' };
  },
});

export const draftReply = defineTool({
  name: 'draft_reply',
  description: 'Draft a polished reply to the latest message in a thread, factoring in any sender memory.',
  category: 'ai',
  mutating: false,
  input: z.object({
    account: z.string(),
    threadId: z.string(),
    instructions: z.string().optional(),
    tone: z.enum(['neutral', 'warm', 'direct', 'apologetic', 'enthusiastic']).optional(),
  }),
  output: z.object({ draft: z.string(), model: z.string() }),
  async handler({ account, threadId, instructions, tone }, ctx) {
    const messages = await loadThread(account, threadId, ctx.userId);
    if (!messages.length) return { draft: '', model: 'none' };
    const last = messages[messages.length - 1];
    const memory = await recallSender(last.from);
    if (!(await hasAiForCurrentUser())) {
      const sender = String(last.from).replace(/<.*?>/g, '').trim().split(/\s+/)[0] || 'there';
      const firstName = contextFirstName();
      const signoff = firstName ? `\n\nBest,\n${firstName}` : '';
      return {
        draft: `Hi ${sender},\n\nThanks for reaching out. ${instructions || 'I will take a look.'}${signoff}`,
        model: 'local',
      };
    }
    const prompt = [
      `Draft a reply for the user to the last message in this thread.`,
      tone ? `Tone: ${tone}.` : '',
      instructions ? `The user's instruction: ${instructions}` : '',
      memory ? `Memory about ${memory.email}: ${memory.notes}` : '',
      "Return only the body text — no greeting/signature scaffolding unless the situation needs it. Match the user's style: concise, warm, lower-case openers ok.",
      '',
      'Thread:',
      concatThread(messages),
    ]
      .filter(Boolean)
      .join('\n');
    const { text } = await generateTextForCurrentUser({
      feature: 'draft_reply',
      speed: 'fast',
      system: "You are lab86-mail drafting on the user's behalf. Never claim the message was sent.",
      prompt,
    });
    return { draft: text.trim(), model: 'fast' };
  },
});

export const bulkTriage = defineTool({
  name: 'bulk_triage',
  description: 'Triage many threads in a single AI call. Returns verdicts keyed by thread id.',
  category: 'ai',
  mutating: false,
  input: z.object({
    items: z
      .array(
        z.object({
          id: z.string(),
          from: z.string().optional(),
          subject: z.string().optional(),
          snippet: z.string().optional(),
        }),
      )
      .max(40),
  }),
  output: z.object({
    verdicts: z.array(
      z.object({
        id: z.string(),
        priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        action: z.string(),
        reason: z.string(),
      }),
    ),
    model: z.string(),
  }),
  async handler({ items }) {
    if (!items.length) return { verdicts: [], model: 'none' };
    if (!(await hasAiForCurrentUser())) {
      return {
        verdicts: items.map((it) => ({
          id: it.id,
          priority: 2 as const,
          action: 'read',
          reason: 'no AI configured',
        })),
        model: 'local',
      };
    }
    const lines = items
      .map(
        (it, i) =>
          `${i + 1}. id=${it.id} from=${it.from || ''} subject=${(it.subject || '').slice(0, 100)} snippet=${(it.snippet || '').slice(0, 160)}`,
      )
      .join('\n');
    const prompt = [
      'Triage these threads. For each line, return exactly one JSON object on its own line in the form:',
      '{ "id": "<id>", "priority": 1|2|3, "action": "reply"|"read"|"archive"|"delegate"|"wait", "reason": "<short>" }',
      'No prose. One JSON object per input line.',
      '',
      lines,
    ].join('\n');
    const { text } = await generateTextForCurrentUser({
      feature: 'bulk_triage',
      speed: 'fast',
      system: 'You are lab86-mail triaging email in bulk. Output only JSON objects, one per line.',
      prompt,
    });
    const verdicts: any[] = [];
    for (const line of text.split('\n')) {
      const match = line.match(/\{[^}]*\}/);
      if (!match) continue;
      try {
        const obj = JSON.parse(match[0]);
        if (obj.id)
          verdicts.push({
            id: String(obj.id),
            priority: (obj.priority === 1 || obj.priority === 3 ? obj.priority : 2) as 1 | 2 | 3,
            action: String(obj.action || 'read'),
            reason: String(obj.reason || ''),
          });
      } catch {}
    }
    // Fill in missing ids with defaults so the UI never has gaps.
    for (const it of items) {
      if (!verdicts.find((v) => v.id === it.id)) {
        verdicts.push({ id: it.id, priority: 2 as const, action: 'read', reason: 'no verdict returned' });
      }
    }
    return { verdicts, model: 'fast' };
  },
});

const SmartCategorySchema = z.enum(SMART_CATEGORY_IDS);
const SuggestedActionSchema = z.enum(['reply', 'read', 'archive', 'label', 'snooze', 'wait', 'none']);

export interface ClassifyInputThread {
  id: string;
  account?: string;
  from?: string;
  fromAddress?: string;
  subject?: string;
  snippet?: string;
  labels?: string[];
  unread?: boolean;
  date?: string | number;
  bodyText?: string;
}

const CLASSIFY_SYSTEM =
  'You classify email threads for the user. Output only JSON lines. Categories: main, needs_reply, codes, orders, finance_admin, noise, review. Main is personal human conversations only, except unread urgent codes/security/account-access/payment/delivery/refund problems. A Gmail CATEGORY_PERSONAL or IMPORTANT label means a real person — never classify those as noise. CATEGORY_PROMOTIONS, CATEGORY_UPDATES, and CATEGORY_SOCIAL are automated. LinkedIn, publishers, rewards programs, newsletters, bulk/list mail, and marketplace promos are noise. When a body excerpt is provided, ground the verdict in what the message actually says — boilerplate footers (unsubscribe links, "sign in" prompts, order-history links) signal automation, not codes or orders.';

const CLASSIFY_INSTRUCTIONS = [
  'For each input line, return exactly one JSON object:',
  '{"id":"...","primary":"main|needs_reply|codes|orders|finance_admin|noise|review","secondary":["..."],"confidence":0.0-1.0,"reason":"short display reason","needsAttention":true|false,"suggestedAction":"reply|read|archive|label|snooze|wait|none","isHumanLike":true|false,"isAutomated":true|false,"allowNoReplyInMain":true|false,"signals":["short"]}',
  'No prose. One JSON object per line.',
].join('\n');

function classifyLine(thread: ClassifyInputThread, idx: number) {
  const body = String(thread.bodyText || '')
    .replace(/\s+/g, ' ')
    .slice(0, 600);
  return `${idx + 1}. id=${thread.id} from=${thread.fromAddress || thread.from || ''} unread=${thread.unread ? 'yes' : 'no'} labels=${(thread.labels || []).join(',')} subject=${(thread.subject || '').slice(0, 120)} snippet=${(thread.snippet || '').slice(0, 240)}${body ? ` body=${body}` : ''}`;
}

// Pull latest-message body excerpts from the Convex corpus for threads that
// arrived without one (the KV thread cache stores only snippets). Best-effort:
// classification still works header-only when the corpus has no row yet.
async function hydrateBodyExcerpts(threads: ClassifyInputThread[]) {
  if (!isConvexConfigured()) return;
  let userId: string;
  try {
    userId = requireStoreUserId();
  } catch {
    return;
  }
  const missing = threads.filter((thread) => !thread.bodyText && thread.account && thread.id);
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    try {
      const excerpts = await convexQuery<Record<string, string>>((api as any).mailCorpus.threadBodyExcerpts, {
        userId,
        items: chunk.map((thread) => ({
          accountId: thread.account as string,
          providerThreadId: thread.id,
        })),
      });
      for (const thread of chunk) {
        const body = excerpts[`${thread.account}:${thread.id}`];
        if (body) thread.bodyText = body;
      }
    } catch {
      return;
    }
  }
}

/**
 * Local-first batched smart classification. Every thread is classified
 * deterministically; only the ones the deterministic pass is unsure about
 * (review or confidence < 0.68, or `force`) are sent to the fast model, in
 * chunks of 40. Gmail CATEGORY_x and IMPORTANT labels flow through both the
 * deterministic classifier and the model prompt. Shared by the
 * `classify_threads` tool and the daily report's Tier-1 breadth pass.
 */
export async function classifyThreadsBatched(
  threads: ClassifyInputThread[],
  context: {
    rules: SmartRule[];
    customLabels: SmartLabelDefinition[];
    force?: boolean;
    speed?: 'fast' | 'nano';
  },
): Promise<Array<{ id: string; model: string } & SmartCategory>> {
  if (!threads.length) return [];
  const { rules, customLabels, force, speed = 'fast' } = context;
  await hydrateBodyExcerpts(threads);
  const local = threads.map((thread) => ({
    thread,
    verdict: classifyThreadWithContext(
      {
        _id: thread.id,
        account: thread.account || '',
        fromAddress: thread.fromAddress || thread.from || '',
        subject: thread.subject || '',
        snippet: thread.snippet || '',
        labels: thread.labels || [],
        unread: thread.unread ?? false,
        lastDate: Number(thread.date || 0),
        bodyText: thread.bodyText,
      },
      { rules, customLabels },
    ),
  }));

  const uncertain = local.filter(
    ({ verdict }) => force || verdict.primary === 'review' || verdict.confidence < 0.68,
  );
  const aiById = new Map<string, SmartCategory>();
  if (uncertain.length && (await hasAiForCurrentUser())) {
    for (let i = 0; i < uncertain.length; i += 40) {
      const chunk = uncertain.slice(i, i + 40);
      try {
        const { text } = await generateTextForCurrentUser({
          feature: 'classify_threads',
          speed,
          system: CLASSIFY_SYSTEM,
          prompt: [
            CLASSIFY_INSTRUCTIONS,
            '',
            chunk.map(({ thread }, idx) => classifyLine(thread, idx)).join('\n'),
          ].join('\n'),
        });
        for (const line of text.split('\n')) {
          const match = line.match(/\{[\s\S]*\}/);
          if (!match) continue;
          try {
            const parsed = JSON.parse(match[0]);
            if (parsed?.id) aiById.set(String(parsed.id), normalizeAiVerdict(parsed) as SmartCategory);
          } catch {}
        }
      } catch {}
    }
  }

  return local.map(({ thread, verdict }) => {
    const ai = aiById.get(thread.id);
    const merged = (ai || verdict) as SmartCategory;
    return { id: thread.id, ...merged, model: ai ? speed : verdict.model || 'deterministic' };
  });
}

export const classifyThreads = defineTool({
  name: 'classify_threads',
  description:
    'Classify visible threads into smart MailOS categories: main, needs_reply, codes, orders, finance_admin, noise, or review.',
  category: 'ai',
  mutating: false,
  input: z.object({
    account: z.string().optional(),
    force: z.boolean().optional(),
    threads: z
      .array(
        z.object({
          id: z.string(),
          account: z.string().optional(),
          from: z.string().optional(),
          fromAddress: z.string().optional(),
          subject: z.string().optional(),
          snippet: z.string().optional(),
          labels: z.array(z.string()).optional(),
          unread: z.boolean().optional(),
          date: z.union([z.string(), z.number()]).optional(),
        }),
      )
      .max(40),
  }),
  output: z.object({
    verdicts: z.array(
      z.object({
        id: z.string(),
        primary: SmartCategorySchema,
        secondary: z.array(SmartCategorySchema),
        confidence: z.number(),
        reason: z.string(),
        needsAttention: z.boolean(),
        suggestedAction: SuggestedActionSchema,
        isHumanLike: z.boolean(),
        isAutomated: z.boolean(),
        allowNoReplyInMain: z.boolean(),
        customLabels: z.array(z.string()).optional(),
        bulkSignals: z.array(z.string()).optional(),
        ruleHits: z.array(z.string()).optional(),
        signals: z.array(z.string()),
        model: z.string(),
      }),
    ),
    model: z.string(),
  }),
  async handler({ threads, force }) {
    if (!threads.length) return { verdicts: [], model: 'none' };
    const [rules, customLabels] = await Promise.all([listSmartRules(), listSmartLabels()]);
    const verdicts = await classifyThreadsBatched(threads, { rules, customLabels, force });
    const usedAi = verdicts.some((v) => v.model === 'fast');
    const aiAvailable = usedAi || (await hasAiForCurrentUser());
    return { verdicts, model: usedAi ? 'fast' : aiAvailable ? 'deterministic' : 'local' };
  },
});

export const extractActionItems = defineTool({
  name: 'extract_action_items',
  description: 'Pull action items out of a thread as a checklist.',
  category: 'ai',
  mutating: false,
  input: z.object({ account: z.string(), threadId: z.string() }),
  output: z.object({ items: z.array(z.string()), model: z.string() }),
  async handler({ account, threadId }, ctx) {
    const messages = await loadThread(account, threadId, ctx.userId);
    const aiAvailable = await hasAiForCurrentUser();
    if (!aiAvailable || !messages.length) {
      return { items: [], model: aiAvailable ? 'fast' : 'local' };
    }
    const { text } = await generateTextForCurrentUser({
      feature: 'extract_action_items',
      speed: 'fast',
      system: 'You are lab86-mail. Extract concrete action items as a plain bullet list. No prose.',
      prompt: [
        'Extract action items as a bullet list. One per line, prefixed with "- ".',
        '',
        concatThread(messages),
      ].join('\n'),
    });
    const items = text
      .split('\n')
      .map((l) => l.replace(/^[-•*]\s*/, '').trim())
      .filter(Boolean);
    return { items, model: 'fast' };
  },
});

export const translateThread = defineTool({
  name: 'translate_thread',
  description: 'Translate the latest message of a thread into a target language.',
  category: 'ai',
  mutating: false,
  input: z.object({
    account: z.string(),
    threadId: z.string(),
    language: z.string().describe('e.g. "english", "japanese", "spanish"'),
  }),
  output: z.object({ translation: z.string(), model: z.string() }),
  async handler({ account, threadId, language }, ctx) {
    const messages = await loadThread(account, threadId, ctx.userId);
    if (!(await hasAiForCurrentUser()) || !messages.length) return { translation: '', model: 'none' };
    const last = messages[messages.length - 1];
    const { text } = await generateTextForCurrentUser({
      feature: 'translate_thread',
      speed: 'fast',
      system: 'Translate naturally. Return only the translation.',
      prompt: `Translate to ${language}:\n\n${last.textBody || last.snippet}`,
    });
    return { translation: text.trim(), model: 'fast' };
  },
});

export const preSendCritique = defineTool({
  name: 'pre_send_critique',
  description:
    'Critique a draft before send — flag tone risk, missing context, unkept promises (e.g. "you said you\'d attach…"), name typos.',
  category: 'ai',
  mutating: false,
  input: z.object({ draftBody: z.string(), threadContext: z.string().optional() }),
  output: z.object({
    verdict: z.enum(['ok', 'review']),
    notes: z.array(z.string()),
    model: z.string(),
  }),
  async handler({ draftBody, threadContext }) {
    if (!(await hasAiForCurrentUser()))
      return { verdict: 'ok' as const, notes: [] as string[], model: 'local' };
    const { text } = await generateTextForCurrentUser({
      feature: 'pre_send_critique',
      speed: 'fast',
      system:
        'You are a strict email editor. Return only a JSON object: {"verdict":"ok"|"review","notes":["...","..."]}. Notes are warnings, max 3.',
      prompt: `Critique this draft for tone, completeness, promises, and respect.\nThread context (may be empty):\n${threadContext || '(none)'}\n\nDraft:\n${draftBody}`,
    });
    let parsed: any = {};
    try {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    } catch {}
    const verdict: 'ok' | 'review' = parsed.verdict === 'review' ? 'review' : 'ok';
    const notes: string[] = Array.isArray(parsed.notes) ? parsed.notes.slice(0, 3).map(String) : [];
    return { verdict, notes, model: 'fast' };
  },
});

export const nlSearch = defineTool({
  name: 'nl_search',
  description:
    'Translate a natural-language description into structured mail search intent and a temporary query string.',
  category: 'ai',
  mutating: false,
  input: z.object({ description: z.string() }),
  output: z.object({ query: z.string(), ast: z.any(), model: z.string() }),
  async handler({ description }) {
    if (!(await hasAiForCurrentUser()))
      return { query: description, ast: parseMailSearchQuery(description), model: 'local' };
    const { text } = await generateTextForCurrentUser({
      feature: 'nl_search',
      speed: 'fast',
      system:
        'You translate natural language into a compact mail search query. Output only the query, no prose, no quotes. Prefer provider-neutral operators the app compiler understands: account:, from:, to:, subject:, newer_than:Nd, older_than:Nd, is:unread, is:starred, has:attachment, in:inbox. Use account: for phrases like "my Gmail account", "my Outlook account", "from my email account", or "mailbox"; use from: only for sender addresses.',
      prompt: description,
    });
    const query = applyNaturalLanguageAccountHint(description, text.trim().replace(/^"|"$/g, ''));
    return { query, ast: parseMailSearchQuery(query), model: 'fast' };
  },
});

export const nlTask = defineTool({
  name: 'nl_task',
  description:
    'Parse a natural-language to-do into structured task fields (title, due date, priority, labels, notes).',
  category: 'ai',
  mutating: false,
  // `now` is the caller's current time as an ISO string WITH offset, so relative
  // dates ("tomorrow", "next Tuesday", "June 24") resolve in the user's timezone.
  input: z.object({ text: z.string(), now: z.string().optional() }),
  output: z.object({
    title: z.string(),
    dueAt: z.number().nullable(),
    priority: z.enum(['low', 'medium', 'high']).nullable(),
    labels: z.array(z.string()),
    description: z.string().nullable(),
    model: z.string(),
  }),
  async handler({ text, now }) {
    const raw = text.trim();
    if (!raw)
      return { title: '', dueAt: null, priority: null, labels: [], description: null, model: 'local' };
    if (!(await hasAiForCurrentUser()))
      return { title: raw, dueAt: null, priority: null, labels: [], description: null, model: 'local' };

    const reference = now && !Number.isNaN(Date.parse(now)) ? now : new Date().toISOString();
    const { text: out } = await generateTextForCurrentUser({
      feature: 'nl_task',
      speed: 'fast',
      system: `You convert a natural-language to-do into JSON. The user's current local date/time is ${reference}. Resolve relative dates ("today", "tonight", "tomorrow", "next Tuesday", "June 24", "in 3 days") against it. Output ONLY a JSON object (no prose, no markdown fences) with exactly these keys:
- "title": string — a concise imperative task title with date/priority/label noise stripped.
- "due": string|null — ISO 8601 datetime using the SAME UTC offset as the reference time, or null when no date is implied. If a date is given without a time, use 09:00 local (or 23:59 for "tonight"/"by end of day").
- "priority": "low"|"medium"|"high"|null — only when clearly implied ("urgent"/"asap" => high).
- "labels": string[] — short tags the user wrote with # or that are clearly implied; otherwise [].
- "description": string|null — extra detail beyond the title, otherwise null.`,
      prompt: raw,
    });

    return { ...parseNlTaskResult(out, raw), model: 'fast' };
  },
});

// Pull structured task fields out of the model's JSON reply. Pure + exported so
// the parsing (the part that can go wrong) is unit-tested without a live model.
export function parseNlTaskResult(
  out: string,
  fallbackTitle: string,
): {
  title: string;
  dueAt: number | null;
  priority: 'low' | 'medium' | 'high' | null;
  labels: string[];
  description: string | null;
} {
  let parsed: any = {};
  try {
    const m = (out || '').match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : {};
  } catch {}

  const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : fallbackTitle;
  let dueAt: number | null = null;
  if (typeof parsed.due === 'string' && parsed.due.trim()) {
    const t = Date.parse(parsed.due);
    if (!Number.isNaN(t)) dueAt = t;
  }
  const priority = ['low', 'medium', 'high'].includes(parsed.priority) ? parsed.priority : null;
  const labels = Array.isArray(parsed.labels)
    ? parsed.labels
        .map((l: any) => String(l).trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];
  const description =
    typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim() : null;
  return { title, dueAt, priority, labels, description };
}

function normalizeAiVerdict(parsed: any) {
  const rawSecondary: SmartCategoryId[] = Array.isArray(parsed.secondary)
    ? parsed.secondary.filter((id: string) => SMART_CATEGORY_IDS.includes(id as SmartCategoryId)).slice(0, 3)
    : [];
  const rawPrimary = SMART_CATEGORY_IDS.includes(parsed.primary as SmartCategoryId)
    ? (parsed.primary as SmartCategoryId)
    : 'review';
  // needs_reply exists only as a secondary tag of Main in this system (the
  // category query derives it from the unread-Main window). A model that
  // returns it as the primary would otherwise be invisible everywhere; fold
  // it into Main + secondary so it lands in both Main and Needs Reply.
  const primary = rawPrimary === 'needs_reply' ? 'main' : rawPrimary;
  const secondary =
    rawPrimary === 'needs_reply' && !rawSecondary.includes('needs_reply')
      ? (['needs_reply', ...rawSecondary].slice(0, 3) as SmartCategoryId[])
      : rawSecondary;
  const action = ['reply', 'read', 'archive', 'label', 'snooze', 'wait', 'none'].includes(
    parsed.suggestedAction,
  )
    ? parsed.suggestedAction
    : 'read';
  return {
    primary,
    secondary,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
    reason: String(parsed.reason || 'AI classification').slice(0, 220),
    needsAttention: Boolean(parsed.needsAttention),
    suggestedAction: action,
    isHumanLike: Boolean(parsed.isHumanLike),
    isAutomated: Boolean(parsed.isAutomated),
    allowNoReplyInMain: Boolean(parsed.allowNoReplyInMain),
    signals: Array.isArray(parsed.signals) ? parsed.signals.map(String).slice(0, 5) : [],
    classifiedAt: Date.now(),
    model: 'fast',
  };
}
