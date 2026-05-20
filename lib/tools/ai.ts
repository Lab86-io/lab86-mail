import { z } from 'zod';
import { generateText } from 'ai';
import { defineTool } from './registry';
import { fastModel, hasAi, primaryModel } from '../ai/client';
import { getThreadMessages, upsertMessage as upsertMessageRecord } from '../store/messages';
import { setThreadSummary, setThreadTriage, upsertThread } from '../store/threads';
import { recallSender } from '../store/memories';
import { runGogJson } from '../gog/pool';
import { normalizeGogMessage } from '../gog/normalize';

async function loadThread(account: string, threadId: string) {
  try {
    const raw = await runGogJson<any>([
      '--account', account, '--json', 'gmail', 'thread', 'get', threadId, '--full', '--no-input',
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
          'You are lab86-mail, Jakob\'s local email assistant. Be concrete. Never claim an action was performed; you can only reason.',
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
  description: 'Classify a thread by priority (1=urgent, 2=normal, 3=low), suggest an action, and store the verdict.',
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
    if (!messages.length) return { priority: 3 as const, action: 'archive', reason: 'empty thread', model: 'none' };
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
    const priority = ((parsed.priority === 1 || parsed.priority === 2 || parsed.priority === 3) ? parsed.priority : 2) as 1 | 2 | 3;
    const action = String(parsed.action || 'read');
    const reason = String(parsed.reason || '').slice(0, 240);
    await setThreadTriage(account, threadId, { priority, action, reason, at: Date.now() }).catch(() => undefined);
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
      'Return only the body text — no greeting/signature scaffolding unless the situation needs it. Match Jakob\'s style: concise, warm, lower-case openers ok.',
      '',
      'Thread:',
      concatThread(messages),
    ].filter(Boolean).join('\n');
    const { text } = await generateText({
      model: primaryModel(),
      system: 'You are lab86-mail drafting on Jakob\'s behalf. Never claim the message was sent.',
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
    items: z.array(
      z.object({
        id: z.string(),
        from: z.string().optional(),
        subject: z.string().optional(),
        snippet: z.string().optional(),
      }),
    ).max(40),
  }),
  output: z.object({
    verdicts: z.array(z.object({
      id: z.string(),
      priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      action: z.string(),
      reason: z.string(),
    })),
    model: z.string(),
  }),
  async handler({ items }) {
    if (!items.length) return { verdicts: [], model: 'none' };
    if (!hasAi()) {
      return {
        verdicts: items.map((it) => ({ id: it.id, priority: 2 as const, action: 'read', reason: 'no AI configured' })),
        model: 'local',
      };
    }
    const lines = items
      .map((it, i) => `${i + 1}. id=${it.id} from=${it.from || ''} subject=${(it.subject || '').slice(0, 100)} snippet=${(it.snippet || '').slice(0, 160)}`)
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
        if (obj.id) verdicts.push({
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
      prompt: ['Extract action items as a bullet list. One per line, prefixed with "- ".', '', concatThread(messages)].join('\n'),
    });
    const items = text.split('\n').map((l) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
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
