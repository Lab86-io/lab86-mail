import { generateText } from 'ai';
import { z } from 'zod';
import { fastModel, hasAi, primaryModel } from '../ai/client';
import { normalizeGogMessage } from '../gog/normalize';
import { runGogJson } from '../gog/pool';
import { classifyThreadWithContext, SMART_CATEGORY_IDS } from '../mail/smart-categories';
import type { SmartCategory, SmartCategoryId, SmartLabelDefinition, SmartRule } from '../shared/types';
import { recallSender } from '../store/memories';
import { getThreadMessages, upsertMessage as upsertMessageRecord } from '../store/messages';
import { listSmartLabels } from '../store/smart-labels';
import { listSmartRules } from '../store/smart-rules';
import { getThread as getThreadRecord, setThreadSummary, setThreadTriage, upsertThread } from '../store/threads';
import { defineTool } from './registry';

async function loadThread(account: string, threadId: string) {
  const cached = await getThreadMessages(account, threadId);
  if (cached.length) return cached.sort((a, b) => (Number(a.date) || 0) - (Number(b.date) || 0));

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
    const threadObj = raw?.thread || raw?.result || raw?.data || raw;
    const arr: any[] = threadObj?.messages || [];
    const messages = arr
      .map((m) => normalizeGogMessage(m, account))
      .filter((m) => m._id)
      .sort((a, b) => (Number(a.date) || 0) - (Number(b.date) || 0));
    for (const m of messages) await upsertMessageRecord(m).catch(() => undefined);
    const newest = messages[messages.length - 1];
    if (newest) {
      await upsertThread(account, {
        _id: threadId,
        subject: newest.subject || messages[0]?.subject || '(no subject)',
        fromAddress: newest.from,
        lastDate: newest.date,
        snippet: newest.snippet || newest.textBody?.slice(0, 240) || '',
        labels: newest.labels || [],
        unread: messages.some((m) => m.labels?.includes('UNREAD')),
      }).catch(() => undefined);
    }
    return messages;
  } catch {
    const cached = await getThreadMessages(account, threadId);
    return cached.sort((a, b) => (Number(a.date) || 0) - (Number(b.date) || 0));
  }
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
  async handler({ account, threadId }) {
    const cachedThread = await getThreadRecord(account, threadId).catch(() => null);
    if (cachedThread?.summary && cachedThread.summaryAt && Date.now() - cachedThread.summaryAt < 6 * 60 * 60_000) {
      return { summary: cachedThread.summary, model: 'cached' };
    }
    const messages = await loadThread(account, threadId);
    if (!messages.length) return { summary: '(empty thread)', model: 'none' };
    if (!hasAi()) {
      const senders = [...new Set(messages.map((m) => m.from))].slice(0, 3).join(', ');
      const summary = `${messages[0].subject} — ${messages.length} message(s) with ${senders}.`;
      await setThreadSummary(account, threadId, summary).catch(() => undefined);
      return { summary, model: 'local' };
    }
    const prompt = [
      'Summarize this email thread for Jakob as a tight TL;DR.',
      'Output: one plain sentence (max ~25 words) capturing the gist. Then, ONLY if the thread genuinely warrants it, up to 3 short bullets (each "- ", max ~12 words) for the key facts, asks, or deadlines.',
      'No headings, no preamble, no sign-off. Omit the bullets entirely for simple threads.',
      '',
      'Thread:',
      concatThread(messages),
    ].join('\n');
    try {
      const { text } = await generateText({
        model: fastModel(),
        system:
          "You are lab86-mail, Jakob's local email assistant. Be concrete. Never claim an action was performed; you can only reason.",
        prompt,
      });
      const summary = text.trim();
      await setThreadSummary(account, threadId, summary).catch(() => undefined);
      return { summary, model: 'fast' };
    } catch (err: any) {
      // Cloud model failed — most often insufficient_quota / rate limit / network.
      // Fall back to a deterministic local summary so the UI never gets stuck.
      const senders = [...new Set(messages.map((m) => m.from))].slice(0, 3).join(', ');
      const last = messages[messages.length - 1];
      const summary = `${last.subject} — ${messages.length} message(s) with ${senders}; latest from ${last.from}.\n\n(AI summary unavailable: ${err?.message || 'model error'}.)`;
      await setThreadSummary(account, threadId, summary).catch(() => undefined);
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
  async handler({ account, threadId }) {
    const messages = await loadThread(account, threadId);
    if (!messages.length)
      return { priority: 3 as const, action: 'archive', reason: 'empty thread', model: 'none' };
    if (!hasAi()) {
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
    const { text } = await generateText({
      model: fastModel(),
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
  async handler({ account, threadId, instructions, tone }) {
    const messages = await loadThread(account, threadId);
    if (!messages.length) return { draft: '', model: 'none' };
    const last = messages[messages.length - 1];
    const memory = await recallSender(last.from);
    if (!hasAi()) {
      const sender = String(last.from).replace(/<.*?>/g, '').trim().split(/\s+/)[0] || 'there';
      return {
        draft: `Hi ${sender},\n\nThanks for reaching out. ${instructions || 'I will take a look.'}\n\nBest,\nJakob`,
        model: 'local',
      };
    }
    const prompt = [
      `Draft a reply for Jakob to the last message in this thread.`,
      tone ? `Tone: ${tone}.` : '',
      instructions ? `Jakob's instruction: ${instructions}` : '',
      memory ? `Memory about ${memory.email}: ${memory.notes}` : '',
      "Return only the body text — no greeting/signature scaffolding unless the situation needs it. Match Jakob's style: concise, warm, lower-case openers ok.",
      '',
      'Thread:',
      concatThread(messages),
    ]
      .filter(Boolean)
      .join('\n');
    const { text } = await generateText({
      model: primaryModel(),
      system: "You are lab86-mail drafting on Jakob's behalf. Never claim the message was sent.",
      prompt,
    });
    return { draft: text.trim(), model: 'primary' };
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
    if (!hasAi()) {
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
    const { text } = await generateText({
      model: fastModel(),
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
}

const CLASSIFY_SYSTEM =
  'You classify email threads for Jakob. Output only JSON lines. Categories: main, needs_reply, waiting, codes, orders, finance_admin, noise, review. Main is personal human conversations only, except unread urgent codes/security/account-access/payment/delivery/refund problems. A Gmail CATEGORY_PERSONAL or IMPORTANT label means a real person — never classify those as noise. CATEGORY_PROMOTIONS, CATEGORY_UPDATES, and CATEGORY_SOCIAL are automated. LinkedIn, publishers, rewards programs, newsletters, bulk/list mail, and marketplace promos are noise.';

const CLASSIFY_INSTRUCTIONS = [
  'For each input line, return exactly one JSON object:',
  '{"id":"...","primary":"main|needs_reply|waiting|codes|orders|finance_admin|noise|review","secondary":["..."],"confidence":0.0-1.0,"reason":"short display reason","needsAttention":true|false,"suggestedAction":"reply|read|archive|label|snooze|wait|none","isHumanLike":true|false,"isAutomated":true|false,"allowNoReplyInMain":true|false,"signals":["short"]}',
  'No prose. One JSON object per line.',
].join('\n');

function classifyLine(thread: ClassifyInputThread, idx: number) {
  return `${idx + 1}. id=${thread.id} from=${thread.fromAddress || thread.from || ''} unread=${thread.unread ? 'yes' : 'no'} labels=${(thread.labels || []).join(',')} subject=${(thread.subject || '').slice(0, 120)} snippet=${(thread.snippet || '').slice(0, 240)}`;
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
  context: { rules: SmartRule[]; customLabels: SmartLabelDefinition[]; force?: boolean },
): Promise<Array<{ id: string; model: string } & SmartCategory>> {
  if (!threads.length) return [];
  const { rules, customLabels, force } = context;
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
      },
      { rules, customLabels },
    ),
  }));

  const uncertain = local.filter(
    ({ verdict }) => force || verdict.primary === 'review' || verdict.confidence < 0.68,
  );
  const aiById = new Map<string, SmartCategory>();
  if (hasAi() && uncertain.length) {
    for (let i = 0; i < uncertain.length; i += 40) {
      const chunk = uncertain.slice(i, i + 40);
      try {
        const { text } = await generateText({
          model: fastModel(),
          system: CLASSIFY_SYSTEM,
          prompt: [CLASSIFY_INSTRUCTIONS, '', chunk.map(({ thread }, idx) => classifyLine(thread, idx)).join('\n')].join('\n'),
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
    return { id: thread.id, ...merged, model: ai ? 'fast' : verdict.model || 'deterministic' };
  });
}

export const classifyThreads = defineTool({
  name: 'classify_threads',
  description:
    'Classify visible threads into smart MailOS categories: main, needs_reply, waiting, codes, orders, finance_admin, noise, or review.',
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
    return { verdicts, model: usedAi ? 'fast' : hasAi() ? 'deterministic' : 'local' };
  },
});

export const extractActionItems = defineTool({
  name: 'extract_action_items',
  description: 'Pull action items out of a thread as a checklist.',
  category: 'ai',
  mutating: false,
  input: z.object({ account: z.string(), threadId: z.string() }),
  output: z.object({ items: z.array(z.string()), model: z.string() }),
  async handler({ account, threadId }) {
    const messages = await loadThread(account, threadId);
    if (!hasAi() || !messages.length) {
      return { items: [], model: hasAi() ? 'fast' : 'local' };
    }
    const { text } = await generateText({
      model: fastModel(),
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
  async handler({ account, threadId, language }) {
    const messages = await loadThread(account, threadId);
    if (!hasAi() || !messages.length) return { translation: '', model: 'none' };
    const last = messages[messages.length - 1];
    const { text } = await generateText({
      model: fastModel(),
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
    if (!hasAi()) return { verdict: 'ok' as const, notes: [] as string[], model: 'local' };
    const { text } = await generateText({
      model: fastModel(),
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
    'Translate a natural-language description into a Gmail query string (e.g. "from board members last quarter" → from:(...) newer_than:90d).',
  category: 'ai',
  mutating: false,
  input: z.object({ description: z.string() }),
  output: z.object({ query: z.string(), model: z.string() }),
  async handler({ description }) {
    if (!hasAi()) return { query: description, model: 'local' };
    const { text } = await generateText({
      model: fastModel(),
      system:
        'You translate natural language into Gmail search syntax. Output only the query, no prose, no quotes. Use operators like from:, to:, subject:, newer_than:Nd, older_than:Nd, is:unread, has:attachment, in:inbox.',
      prompt: description,
    });
    return { query: text.trim().replace(/^"|"$/g, ''), model: 'fast' };
  },
});

function normalizeAiVerdict(parsed: any) {
  const primary = SMART_CATEGORY_IDS.includes(parsed.primary as SmartCategoryId) ? parsed.primary : 'review';
  const secondary = Array.isArray(parsed.secondary)
    ? parsed.secondary.filter((id: string) => SMART_CATEGORY_IDS.includes(id as SmartCategoryId)).slice(0, 3)
    : [];
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
