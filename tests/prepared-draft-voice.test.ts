import { expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { prepareBriefWork } from '../lib/content/prepare';

const NOW = Date.UTC(2026, 8, 26, 12);
const seed: any = {
  _id: 'source1',
  title: 'Venue question',
  text: 'Can you confirm the venue by Friday?',
  version: 'v1',
  source: 'mail',
  modifiedAt: NOW,
  partial: false,
};
const draft = {
  title: 'Reply about the venue',
  shape: 'quick',
  situation: 'A reply is owed.',
  background: 'The venue needs a yes or no.',
  assessment: 'Confirm it.',
  recommendation: 'Send the reply.',
  questions: [],
  steps: ['Send the reply'],
  files: [{ name: 'reply.txt', content: 'Yes, the venue works.' }],
  evidence: [{ sourceId: 'source1', quote: 'Can you confirm the venue by Friday?' }],
};

async function draftSystemPrompt(voiceProfile?: () => Promise<any>) {
  const calls: any[] = [];
  await prepareBriefWork('owner', {
    convexMutation: async (ref: any) =>
      getFunctionName(ref).endsWith(':claim') ? { _id: 'proposal', lease: 'lease', revision: 1, seed } : true,
    convexQuery: async () => [seed],
    generateObjectForCurrentUser: async (args: any) => {
      calls.push(args);
      return { object: args.feature === 'brief_preparation_research' ? { queries: ['venue'] } : draft };
    },
    searchContent: async () => ({ items: [seed], semanticUnavailable: false }),
    ...(voiceProfile ? { voiceProfile } : {}),
  } as any);
  return calls.find((call) => call.feature === 'brief_preparation')?.system as string;
}

test('prepared drafts follow the user\'s "How you write" card', async () => {
  const system = await draftSystemPrompt(async () => ({
    greeting: 'Hey {name},',
    signOff: 'Thanks,\nJakob',
    length: 'short',
    typicalWords: 40,
    tone: 'Plain and warm.',
    notes: 'No exclamation marks.',
    source: 'edited',
    sampleCount: 20,
    learnedAt: NOW,
    editedAt: NOW,
  }));
  expect(system).toContain(
    "When a file is a reply or an email the user may send, write in the user's own voice:",
  );
  expect(system).toContain('Open like "Hey {name},"');
  expect(system).toContain('Tone: Plain and warm.');
  expect(system).toContain('No exclamation marks.');
});

test('with no voice card, or a failed read, the prompt has no voice lines', async () => {
  expect(await draftSystemPrompt(async () => null)).not.toContain('own voice');
  expect(
    await draftSystemPrompt(async () => {
      throw new Error('no request context');
    }),
  ).not.toContain('own voice');
});
