import { z } from 'zod';
import { describeProvider } from '../ai/client';
import { contextFirstName } from '../ai/context';
import { generateTextForCurrentUser, hasAiForCurrentUser } from '../ai/gateway';
import {
  MAIL_UNDO,
  mailOperationReason,
  pluralThreads,
  recordMailOperation,
  type TriageChange,
} from '../mail/mail-operations';
import { applyNaturalLanguageAccountHint } from '../mail/search/account-scope';
import { parseMailSearchQuery } from '../mail/search/parser';
import { recallSender } from '../store/memories';
import { resolveThreadMessages } from '../store/messages';
import {
  getThread as getThreadRecord,
  setThreadSummary,
  setThreadTriage,
  upsertThread,
} from '../store/threads';
import { defineTool } from './registry';

const SUMMARY_PROMPT_INSTRUCTIONS = [
  'Summarize this multi-message email thread for the user as a reliable working-memory note.',
  'Output format: one compact sentence with the current state, then up to 3 short "- " bullets only when useful.',
  'Prioritize: what changed most recently, who owes what, explicit asks, decisions, deadlines, blockers, and follow-up risk.',
  'Do not repeat the subject unless needed. Do not include a heading, greeting, sign-off, or generic advice.',
  'Never invent facts. If timing, ownership, or outcome is unclear, say so plainly.',
].join('\n');

// The full thread from the corpus, then the provider (KV-1). A partial cache
// never stands in for the full thread.
async function loadThread(account: string, threadId: string, userId?: string | null) {
  const messages = await resolveThreadMessages(account, threadId, { userId });
  const newest = messages[messages.length - 1];
  // The KV thread row only carries the summary and triage overlay; it must
  // exist before setThreadSummary or setThreadTriage can patch it.
  if (newest && !(await getThreadRecord(account, threadId).catch(() => null))) {
    await upsertThread(account, {
      _id: threadId,
      subject: newest.subject || messages[0]?.subject || '(no subject)',
      fromAddress: newest.from,
      lastDate: newest.date,
      snippet: newest.snippet || newest.textBody?.slice(0, 240) || '',
      labels: newest.labels || [],
      unread: messages.some((message) => Boolean(message.unread) || message.labels?.includes('UNREAD')),
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
    const messages = await loadThread(account, threadId, ctx.userId);
    if (!messages.length) return { summary: '(empty thread)', model: 'none' };
    if (messages.length <= 1) return { summary: '', model: 'none' };

    const cachedThread = await getThreadRecord(account, threadId).catch(() => null);
    if (
      cachedThread?.summary &&
      cachedThread.summaryAt &&
      Date.now() - cachedThread.summaryAt < 6 * 60 * 60_000
    ) {
      // Surface the real model that produced the cached summary, not 'cached'.
      return { summary: cachedThread.summary, model: cachedThread.summaryModel || 'cached' };
    }
    if (!(await hasAiForCurrentUser())) {
      const senders = [...new Set(messages.map((m) => m.from))].slice(0, 3).join(', ');
      const last = messages[messages.length - 1];
      const summary = `${last.subject} — ${messages.length} messages with ${senders}; latest from ${last.from}.`;
      await setThreadSummary(account, threadId, summary, 'local').catch(() => undefined);
      return { summary, model: 'local' };
    }
    const prompt = [SUMMARY_PROMPT_INSTRUCTIONS, '', 'Thread:', concatThread(messages)].join('\n');
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

/** The most threads one `bulk_triage` call takes. Callers split larger selections. */
export const BULK_TRIAGE_LIMIT = 40;

export const bulkTriage = defineTool({
  name: 'bulk_triage',
  description:
    'Triage many threads in a single call and save each verdict on its thread. Returns verdicts keyed by thread id. The saved verdicts show in Activity with Undo.',
  category: 'ai',
  mutating: true,
  risk: 'write_self',
  input: z.object({
    items: z
      .array(
        z.object({
          id: z.string(),
          /** The mailbox of the thread. With it, the verdict is saved on the thread. */
          account: z.string().optional(),
          from: z.string().optional(),
          subject: z.string().optional(),
          snippet: z.string().optional(),
        }),
      )
      .max(BULK_TRIAGE_LIMIT),
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
    /** How many verdicts were saved on their threads. */
    saved: z.number().optional(),
    operationId: z.string().optional(),
  }),
  async handler({ items }, ctx) {
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
    const changes: TriageChange[] = [];
    const saved = await saveBulkTriageVerdicts(items, verdicts, changes);
    const operationId = changes.length
      ? await recordMailOperation({
          userId: ctx?.userId,
          tool: 'bulk_triage',
          summary: `Triaged ${pluralThreads(changes.length)}`,
          reason: mailOperationReason(ctx ?? {}, 'Each thread got a priority and a suggested next step.'),
          target: { kind: 'threads', count: changes.length },
          inverse: { kind: MAIL_UNDO.restoreTriage, payload: { items: changes } },
          batchId: ctx?.operationBatchId,
        })
      : undefined;
    // Fill in missing ids with defaults so the UI never has gaps.
    for (const it of items) {
      if (!verdicts.find((v) => v.id === it.id)) {
        verdicts.push({ id: it.id, priority: 2 as const, action: 'read', reason: 'no verdict returned' });
      }
    }
    return { verdicts, model: 'fast', saved, operationId };
  },
});

/**
 * Save model verdicts on their threads through the same store as
 * `triage_thread`. Only verdicts for requested ids with a known account are
 * saved; placeholder verdicts are never saved.
 */
export async function saveBulkTriageVerdicts(
  items: Array<{ id: string; account?: string }>,
  verdicts: Array<{ id: string; priority: 1 | 2 | 3; action: string; reason: string }>,
  /** Filled with the verdict each saved thread had before, for Undo. */
  changes?: TriageChange[],
): Promise<number> {
  const accounts = new Map(items.filter((it) => it.account).map((it) => [it.id, it.account as string]));
  const at = Date.now();
  const writes = verdicts
    .filter((verdict) => accounts.has(verdict.id))
    .map(async (verdict) => {
      const account = accounts.get(verdict.id) as string;
      const previous = changes
        ? ((await getThreadRecord(account, verdict.id).catch(() => null))?.triage ?? null)
        : null;
      return setThreadTriage(account, verdict.id, {
        priority: verdict.priority,
        action: verdict.action,
        reason: verdict.reason.slice(0, 240),
        at,
      }).then(
        () => {
          changes?.push({ account, threadId: verdict.id, previous });
          return true;
        },
        () => false,
      );
    });
  return (await Promise.all(writes)).filter(Boolean).length;
}

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
