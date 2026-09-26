import { generateTextForCurrentUser, hasAiForCurrentUser } from '../ai/gateway';
import { api, convexQuery } from '../hosted/convex';
import { kvGet, kvUpsert } from '../store/kv';

// Voice profile (FEATURES item 16). Albatross reads up to 50 recent sent
// messages, at most once a week, and keeps a small "How you write" card:
// greeting, sign-off, typical length, and tone. The user can edit it.
// draft_reply writes in this voice.

export const VOICE_PROFILE_KIND = 'voiceProfile';
export const VOICE_PROFILE_KEY = 'default';
export const VOICE_LEARN_INTERVAL_MS = 7 * 24 * 60 * 60_000;
export const VOICE_SAMPLE_LIMIT = 50;
export const VOICE_MIN_SAMPLES = 5;

export type VoiceLength = 'short' | 'medium' | 'long';

export interface VoiceProfile {
  greeting: string;
  signOff: string;
  length: VoiceLength;
  typicalWords: number;
  tone: string;
  /** The user's own instruction, kept when Albatross learns again. */
  notes: string;
  source: 'learned' | 'edited';
  sampleCount: number;
  learnedAt: number | null;
  editedAt: number | null;
  model?: string;
}

export interface SentSample {
  subject?: string;
  to?: string;
  receivedAt?: number;
  textBody: string;
}

const GREETING =
  /^(hi|hey|hello|dear|good (?:morning|afternoon|evening)|morning|thanks|hiya|yo)\b[^\n]{0,40}$/i;
const SIGN_OFF =
  /^(best|best regards|regards|kind regards|warm regards|warmly|thanks|thank you|many thanks|cheers|talk soon|sincerely|all the best|thx|ty)\b[^\n]{0,25}$/i;

/** The part of a sent message that the user wrote: no quoted reply, no forward. */
export function ownText(body: string) {
  const lines = String(body || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^on .{3,200}wrote:?$/i.test(trimmed)) break;
    if (/^-{2,}\s*(original|forwarded) message\s*-{2,}$/i.test(trimmed)) break;
    if (/^from:\s.+/i.test(trimmed) && kept.length) break;
    if (trimmed.startsWith('>')) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

function wordCount(text: string) {
  return text.split(/\s+/).filter(Boolean).length;
}

function mostCommon(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  let best = '';
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return { value: best, count: bestCount };
}

/** "Hi Ann," becomes "Hi {name},"; the name changes with each recipient. */
function greetingShape(line: string) {
  const match = line.trim().match(/^(\S+(?:\s+(?:morning|afternoon|evening))?)(\s+[A-Z][\w'-]*)?(.*)$/);
  if (!match) return line.trim();
  const [, word, name, rest] = match;
  const punctuation = rest.trim().slice(-1);
  return `${word}${name ? ' {name}' : ''}${/[,!.]/.test(punctuation) ? punctuation : ''}`;
}

export function lengthBucket(words: number): VoiceLength {
  if (words <= 60) return 'short';
  if (words <= 150) return 'medium';
  return 'long';
}

/**
 * What the sent mail shows without a model: the most common greeting and
 * sign-off, and the median length. The model call refines tone.
 */
export function analyzeSentMail(samples: SentSample[]) {
  const texts = samples.map((sample) => ownText(sample.textBody)).filter((text) => wordCount(text) >= 3);
  const greetings: string[] = [];
  const signOffs: string[] = [];
  const words: number[] = [];
  let noGreeting = 0;
  for (const text of texts) {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const first = lines[0] || '';
    if (GREETING.test(first)) greetings.push(greetingShape(first));
    else noGreeting += 1;
    const tail = lines.slice(-3);
    const signOffIndex = tail.findIndex((line) => SIGN_OFF.test(line));
    if (signOffIndex >= 0) signOffs.push(tail.slice(signOffIndex).join('\n'));
    words.push(wordCount(text));
  }
  const sorted = [...words].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  const greeting = mostCommon(greetings);
  const signOff = mostCommon(signOffs);
  return {
    texts,
    sampleCount: texts.length,
    // A greeting counts when most messages open with one.
    greeting: greeting.count >= Math.max(1, noGreeting) ? greeting.value : '',
    signOff: signOff.count >= Math.ceil(texts.length / 3) ? signOff.value : '',
    typicalWords: median,
    length: lengthBucket(median),
  };
}

const LEARN_SYSTEM = `You describe how one person writes email, from samples of their sent mail.
Return only a JSON object: {"greeting": string, "signOff": string, "length": "short"|"medium"|"long", "tone": string}.
- greeting: their usual opening line with {name} for the recipient's name, for example "Hi {name},". Empty when they usually start without one.
- signOff: their usual closing lines, for example "Best,\\nJakob". Empty when they usually end without one.
- tone: at most 25 words on how they write: formality, warmth, sentence length, punctuation, and habits (for example lower-case openers). Describe style only. Do not quote private content, names of other people, or facts from the mail.`;

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Parses the model reply. Anything unusable falls back to the analysis. */
export function parseLearnedVoice(text: string) {
  try {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : null;
    if (!parsed || typeof parsed !== 'object') return null;
    const str = (value: unknown, max: number) => (typeof value === 'string' ? clip(value.trim(), max) : '');
    return {
      greeting: str(parsed.greeting, 80),
      signOff: str(parsed.signOff, 120),
      length: ['short', 'medium', 'long'].includes(parsed.length) ? (parsed.length as VoiceLength) : null,
      tone: str(parsed.tone, 240),
    };
  } catch {
    return null;
  }
}

export interface VoiceDependencies {
  load: () => Promise<VoiceProfile | null>;
  save: (profile: VoiceProfile) => Promise<unknown>;
  sentMessages: (userId: string, limit: number) => Promise<SentSample[]>;
  hasModel: () => Promise<boolean>;
  generate: (input: { system: string; prompt: string }) => Promise<{ text: string; model?: string }>;
  now: () => number;
}

const defaultDependencies: VoiceDependencies = {
  load: () => kvGet<VoiceProfile>(VOICE_PROFILE_KIND, VOICE_PROFILE_KEY),
  save: (profile) => kvUpsert(VOICE_PROFILE_KIND, VOICE_PROFILE_KEY, profile),
  sentMessages: async (userId, limit) =>
    (
      await convexQuery<{ messages: SentSample[] }>(api.mailCorpus.recentSentMessages, {
        userId,
        limit,
      })
    ).messages,
  hasModel: () => hasAiForCurrentUser(),
  generate: async ({ system, prompt }) => {
    const result = await generateTextForCurrentUser({
      feature: 'voice_profile',
      speed: 'fast',
      maxOutputTokens: 400,
      system,
      prompt,
    });
    return { text: result.text, model: (result as any)?.response?.modelId };
  },
  now: () => Date.now(),
};

export async function getVoiceProfile(deps: Pick<VoiceDependencies, 'load'> = defaultDependencies) {
  return await deps.load();
}

/** When learning may run again, or null when it may run now. */
export function nextLearnAt(profile: VoiceProfile | null, now: number) {
  if (!profile?.learnedAt) return null;
  const next = profile.learnedAt + VOICE_LEARN_INTERVAL_MS;
  return next > now ? next : null;
}

export type LearnVoiceResult =
  | { status: 'learned'; profile: VoiceProfile }
  | { status: 'too_soon'; profile: VoiceProfile; nextLearnAt: number }
  | { status: 'edited'; profile: VoiceProfile }
  | { status: 'not_enough_mail'; sampleCount: number; profile: VoiceProfile | null };

/**
 * Learns the voice from sent mail: one model call, at most once a week. A
 * card the user edited is kept unless `replaceEdited` is true. The notes the
 * user wrote are always kept.
 */
export async function learnVoiceProfile(
  input: { userId: string; replaceEdited?: boolean },
  deps: VoiceDependencies = defaultDependencies,
): Promise<LearnVoiceResult> {
  const now = deps.now();
  const existing = await deps.load();
  const wait = nextLearnAt(existing, now);
  if (existing && wait) return { status: 'too_soon', profile: existing, nextLearnAt: wait };
  if (existing?.editedAt && !input.replaceEdited) return { status: 'edited', profile: existing };
  const samples = await deps.sentMessages(input.userId, VOICE_SAMPLE_LIMIT);
  const analysis = analyzeSentMail(samples.slice(0, VOICE_SAMPLE_LIMIT));
  if (analysis.sampleCount < VOICE_MIN_SAMPLES) {
    return { status: 'not_enough_mail', sampleCount: analysis.sampleCount, profile: existing };
  }
  let learned: ReturnType<typeof parseLearnedVoice> = null;
  let model: string | undefined;
  if (await deps.hasModel().catch(() => false)) {
    // Up to 50 samples, each clipped, in one call.
    let budget = 18_000;
    const blocks: string[] = [];
    for (const [index, text] of analysis.texts.entries()) {
      const block = `--- Sample ${index + 1} ---\n${clip(text, 700)}`;
      if (block.length > budget) break;
      budget -= block.length;
      blocks.push(block);
    }
    try {
      const result = await deps.generate({ system: LEARN_SYSTEM, prompt: blocks.join('\n\n') });
      learned = parseLearnedVoice(result.text);
      model = result.model;
    } catch {
      learned = null;
    }
  }
  const profile: VoiceProfile = {
    greeting: learned?.greeting ?? analysis.greeting,
    signOff: learned?.signOff ?? analysis.signOff,
    length: learned?.length ?? analysis.length,
    typicalWords: analysis.typicalWords,
    tone: learned?.tone || '',
    notes: existing?.notes ?? '',
    source: 'learned',
    sampleCount: analysis.sampleCount,
    learnedAt: now,
    editedAt: null,
    ...(model ? { model } : {}),
  };
  await deps.save(profile);
  return { status: 'learned', profile };
}

const FIELD_LIMITS = { greeting: 80, signOff: 120, tone: 240, notes: 500 } as const;

/** Saves the user's edits to the card. Edited cards are not overwritten by learning. */
export async function updateVoiceProfile(
  patch: Partial<Pick<VoiceProfile, 'greeting' | 'signOff' | 'length' | 'tone' | 'notes'>>,
  deps: Pick<VoiceDependencies, 'load' | 'save' | 'now'> = defaultDependencies,
): Promise<VoiceProfile> {
  const existing = await deps.load();
  for (const key of ['greeting', 'signOff', 'tone', 'notes'] as const) {
    const value = patch[key];
    if (value !== undefined && value.length > FIELD_LIMITS[key]) {
      throw new Error(
        `Keep ${key === 'signOff' ? 'the sign-off' : `the ${key}`} under ${FIELD_LIMITS[key]} characters.`,
      );
    }
  }
  const now = deps.now();
  const profile: VoiceProfile = {
    greeting: (patch.greeting ?? existing?.greeting ?? '').trim(),
    signOff: (patch.signOff ?? existing?.signOff ?? '').replace(/\r\n/g, '\n').trim(),
    length: patch.length ?? existing?.length ?? 'short',
    typicalWords: existing?.typicalWords ?? 0,
    tone: (patch.tone ?? existing?.tone ?? '').trim(),
    notes: (patch.notes ?? existing?.notes ?? '').trim(),
    source: 'edited',
    sampleCount: existing?.sampleCount ?? 0,
    learnedAt: existing?.learnedAt ?? null,
    editedAt: now,
    ...(existing?.model ? { model: existing.model } : {}),
  };
  await deps.save(profile);
  return profile;
}

const LENGTH_WORDS: Record<VoiceLength, string> = {
  short: 'short, a few sentences',
  medium: 'medium, one or two short paragraphs',
  long: 'longer, several paragraphs when the thread needs it',
};

/**
 * Prompt lines for a draft in the user's voice. With a mailbox signature on,
 * the draft leaves the name out, because the signature adds it when sent.
 */
export function voicePromptLines(
  profile: VoiceProfile | null | undefined,
  options: { signatureOn?: boolean } = {},
) {
  if (!profile) return [] as string[];
  const lines = ["Write in the user's own voice:"];
  if (profile.greeting)
    lines.push(`- Open like "${profile.greeting}" ({name} is the recipient's first name).`);
  else lines.push('- Start without a greeting line.');
  if (options.signatureOn) {
    lines.push('- End without a sign-off name. The mailbox signature is added when the message is sent.');
  } else if (profile.signOff) {
    lines.push(`- Close with "${profile.signOff.replace(/\n/g, ' / ')}" (a slash marks a line break).`);
  }
  const words = profile.typicalWords ? ` (their median is about ${profile.typicalWords} words)` : '';
  lines.push(`- Length: ${LENGTH_WORDS[profile.length]}${words}.`);
  if (profile.tone) lines.push(`- Tone: ${profile.tone}`);
  if (profile.notes) lines.push(`- The user also asks: ${profile.notes}`);
  return lines;
}

/** The greeting for a recipient, from the card's greeting shape. */
export function greetingFor(profile: VoiceProfile | null | undefined, firstName: string) {
  if (!profile?.greeting) return '';
  return profile.greeting
    .replace('{name}', firstName || '')
    .replace(/\s+,/, ',')
    .trim();
}
