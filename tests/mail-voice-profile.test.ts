import { describe, expect, mock, test } from 'bun:test';
import './tools/harness';
import { learnResultMessage, voiceSourceLine } from '../components/settings/VoiceProfileSettings';
import { saveSignature } from '../lib/mail/signature';
import {
  analyzeSentMail,
  greetingFor,
  learnVoiceProfile,
  lengthBucket,
  nextLearnAt,
  ownText,
  parseLearnedVoice,
  updateVoiceProfile,
  VOICE_LEARN_INTERVAL_MS,
  type VoiceProfile,
  voicePromptLines,
} from '../lib/mail/voice-profile';
import { draftReply, kickVoiceLearning } from '../lib/tools/ai';
import { getVoiceProfileTool, updateVoiceProfileTool } from '../lib/tools/mail-voice';
import { runTool, seedThreadMessage, withToolContext } from './tools/harness';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');

const sent = (body: string) => ({
  subject: 'Re: plan',
  to: 'x@example.com',
  receivedAt: NOW,
  textBody: body,
});
const SAMPLES = [
  'Hi Ann,\n\nSounds good, see you Tuesday.\n\nBest,\nJakob',
  'Hi Bob,\n\nThanks for the notes. I will send the deck tonight.\n\nBest,\nJakob\n\nOn Mon, Sep 1, 2026 at 9:00 AM Bob <b@x.com> wrote:\n> old text',
  'Hi Cy,\n\nYes, that works for me.\n\nBest,\nJakob',
  'Hi Dee,\n\nCan we move it to 3pm?\n> quoted line\n\nBest,\nJakob',
  'quick one - is the invoice paid?\n\nthanks',
  'Hi Eve,\n\nAttached is the signed form.\n\nBest,\nJakob\n---------- Forwarded message ----------\nFrom: someone',
];

function profile(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    greeting: 'Hi {name},',
    signOff: 'Best,\nJakob',
    length: 'short',
    typicalWords: 12,
    tone: 'Warm and direct',
    notes: '',
    source: 'learned',
    sampleCount: 6,
    learnedAt: NOW - 1000,
    editedAt: null,
    ...overrides,
  };
}

describe('reading sent mail', () => {
  test('only the part the user wrote counts', () => {
    expect(ownText(SAMPLES[1])).toBe(
      'Hi Bob,\n\nThanks for the notes. I will send the deck tonight.\n\nBest,\nJakob',
    );
    expect(ownText(SAMPLES[3])).not.toContain('quoted line');
    expect(ownText(SAMPLES[5])).not.toContain('someone');
  });

  test('the common greeting, sign-off, and median length come out without a model', () => {
    const analysis = analyzeSentMail(SAMPLES.map(sent));
    expect(analysis.sampleCount).toBe(6);
    expect(analysis.greeting).toBe('Hi {name},');
    expect(analysis.signOff).toBe('Best,\nJakob');
    expect(analysis.length).toBe('short');
    expect(analysis.typicalWords).toBeGreaterThan(5);
    expect(analyzeSentMail([sent('ok'), sent('')]).sampleCount).toBe(0);
    expect([lengthBucket(40), lengthBucket(100), lengthBucket(400)]).toEqual(['short', 'medium', 'long']);
  });

  test('the model reply is parsed defensively', () => {
    expect(
      parseLearnedVoice(
        'Here: {"greeting":"Hey {name},","signOff":"Cheers,\\nJ","length":"medium","tone":"Casual"}',
      ),
    ).toEqual({ greeting: 'Hey {name},', signOff: 'Cheers,\nJ', length: 'medium', tone: 'Casual' });
    expect(parseLearnedVoice('{"length":"huge","tone":5}')).toEqual({
      greeting: '',
      signOff: '',
      length: null,
      tone: '',
    });
    expect(parseLearnedVoice('no json')).toBeNull();
    expect(parseLearnedVoice('{broken')).toBeNull();
  });
});

describe('learning at most once a week', () => {
  function deps(existing: VoiceProfile | null, samples = SAMPLES.map(sent)) {
    const saved: VoiceProfile[] = [];
    return {
      saved,
      deps: {
        load: mock(async () => existing),
        save: mock(async (p: VoiceProfile) => {
          saved.push(p);
        }),
        sentMessages: mock(async () => samples),
        hasModel: mock(async () => true),
        generate: mock(async (_input: { system: string; prompt: string }) => ({
          text: '{"greeting":"Hi {name},","signOff":"Best,\\nJakob","length":"short","tone":"Warm, brief, plain"}',
          model: 'test-model',
        })),
        now: () => NOW,
      },
    };
  }

  test('one model call over the samples, and the notes stay', async () => {
    const h = deps(profile({ learnedAt: NOW - VOICE_LEARN_INTERVAL_MS - 1, notes: 'No exclamation marks.' }));
    const result = await learnVoiceProfile({ userId: 'u' }, h.deps);
    expect(result.status).toBe('learned');
    expect(h.deps.generate).toHaveBeenCalledTimes(1);
    const prompt = (h.deps.generate.mock.calls[0] as any)[0].prompt as string;
    expect(prompt).toContain('--- Sample 6 ---');
    expect(prompt).not.toContain('old text');
    expect(h.saved[0]).toMatchObject({
      tone: 'Warm, brief, plain',
      notes: 'No exclamation marks.',
      source: 'learned',
      learnedAt: NOW,
      editedAt: null,
      sampleCount: 6,
      model: 'test-model',
    });
    expect((h.deps.sentMessages.mock.calls[0] as any)[1]).toBe(50);
  });

  test('a week has not passed, the card was edited, or there is too little mail', async () => {
    const fresh = deps(profile({ learnedAt: NOW - 1000 }));
    const soon = await learnVoiceProfile({ userId: 'u' }, fresh.deps);
    expect(soon).toMatchObject({ status: 'too_soon', nextLearnAt: NOW - 1000 + VOICE_LEARN_INTERVAL_MS });
    expect(fresh.deps.generate).not.toHaveBeenCalled();

    const edited = deps(profile({ learnedAt: null, editedAt: NOW - 5, source: 'edited' }));
    expect((await learnVoiceProfile({ userId: 'u' }, edited.deps)).status).toBe('edited');
    expect((await learnVoiceProfile({ userId: 'u', replaceEdited: true }, edited.deps)).status).toBe(
      'learned',
    );

    const thin = deps(null, [sent('Hi Ann,\n\nSure thing, see you.\n\nBest,\nJakob')]);
    expect(await learnVoiceProfile({ userId: 'u' }, thin.deps)).toEqual({
      status: 'not_enough_mail',
      sampleCount: 1,
      profile: null,
    });
    expect(thin.saved).toEqual([]);
  });

  test('a failed model call still saves the analysis, so the weekly limit holds', async () => {
    const h = deps(null);
    h.deps.generate.mockImplementation(async () => {
      throw new Error('402');
    });
    const result = await learnVoiceProfile({ userId: 'u' }, h.deps);
    expect(result.status).toBe('learned');
    expect(h.saved[0]).toMatchObject({
      greeting: 'Hi {name},',
      signOff: 'Best,\nJakob',
      tone: '',
      learnedAt: NOW,
    });
    const noModel = deps(null);
    noModel.deps.hasModel.mockImplementation(async () => false);
    await learnVoiceProfile({ userId: 'u' }, noModel.deps);
    expect(noModel.deps.generate).not.toHaveBeenCalled();
    expect(nextLearnAt(noModel.saved[0], NOW + 1)).toBe(NOW + VOICE_LEARN_INTERVAL_MS);
    expect(nextLearnAt(null, NOW)).toBeNull();
  });
});

describe('editing the card', () => {
  test("edits are saved as the user's and checked for length", async () => {
    const saved: VoiceProfile[] = [];
    const deps = {
      load: async () => profile(),
      save: async (p: VoiceProfile) => {
        saved.push(p);
      },
      now: () => NOW,
    };
    const next = await updateVoiceProfile({ greeting: ' Hey {name}, ', notes: 'Keep it short.' }, deps);
    expect(next).toMatchObject({
      greeting: 'Hey {name},',
      signOff: 'Best,\nJakob',
      notes: 'Keep it short.',
      source: 'edited',
      editedAt: NOW,
      learnedAt: NOW - 1000,
    });
    await expect(updateVoiceProfile({ tone: 'x'.repeat(241) }, deps)).rejects.toThrow('under 240');
    await expect(updateVoiceProfile({ signOff: 'x'.repeat(121) }, deps)).rejects.toThrow(
      'the sign-off under 120',
    );
  });

  test('the tools read and edit the card for Settings and native', async () => {
    expect(await runTool(getVoiceProfileTool.handler, {}, {})).toEqual({ profile: null, nextLearnAt: null });
    const { profile: edited } = await runTool(updateVoiceProfileTool.handler, {
      greeting: 'Hello {name},',
      length: 'medium',
    });
    expect(edited).toMatchObject({ greeting: 'Hello {name},', length: 'medium', source: 'edited' });
    expect((await runTool(getVoiceProfileTool.handler, {})).profile?.greeting).toBe('Hello {name},');
  });
});

describe('drafts in the user voice', () => {
  test('prompt lines carry greeting, sign-off, length, tone, and notes', () => {
    expect(voicePromptLines(profile({ notes: 'No emoji.' }))).toEqual([
      "Write in the user's own voice:",
      '- Open like "Hi {name}," ({name} is the recipient\'s first name).',
      '- Close with "Best, / Jakob" (a slash marks a line break).',
      '- Length: short, a few sentences (their median is about 12 words).',
      '- Tone: Warm and direct',
      '- The user also asks: No emoji.',
    ]);
    const withSignature = voicePromptLines(profile({ greeting: '', typicalWords: 0 }), { signatureOn: true });
    expect(withSignature).toContain('- Start without a greeting line.');
    expect(withSignature).toContain(
      '- End without a sign-off name. The mailbox signature is added when the message is sent.',
    );
    expect(withSignature).toContain('- Length: short, a few sentences.');
    expect(voicePromptLines(null)).toEqual([]);
    expect(greetingFor(profile(), 'Ann')).toBe('Hi Ann,');
    expect(greetingFor(profile(), '')).toBe('Hi,');
    expect(greetingFor(null, 'Ann')).toBe('');
  });

  test('the local draft uses the card, and leaves the name to an active signature', async () => {
    const account = 'voice@example.test';
    const threadId = 'voice-thread';
    await withToolContext(async () => {
      const { upsertMessage } = await import('../lib/store/messages');
      await upsertMessage({
        _id: 'voice-msg',
        threadId,
        account,
        subject: 'Plans',
        from: 'Ann Lee <ann@example.test>',
        to: 'Me <voice@example.test>',
        cc: '',
        bcc: '',
        date: NOW,
        snippet: 'Can we meet?',
        textBody: 'Can we meet?',
        htmlBody: '',
        labels: ['INBOX'],
        attachments: [],
        headers: {},
        cachedAt: NOW,
      });
      await updateVoiceProfile({ greeting: 'Hey {name},', signOff: 'Cheers,\nJ' });
    });
    const plain = await runTool(draftReply.handler, {
      account,
      threadId,
      instructions: 'Yes, Tuesday works.',
    });
    expect(plain).toEqual({
      draft: 'Hey Ann,\n\nThanks for reaching out. Yes, Tuesday works.\n\nCheers,\nJ',
      model: 'local',
    });

    await withToolContext(() => saveSignature({ accountId: account, enabled: true, text: 'J. Doe' }));
    const signed = await runTool(draftReply.handler, { account, threadId, instructions: 'Yes.' });
    expect(signed.draft).toBe('Hey Ann,\n\nThanks for reaching out. Yes.');
  });

  test('background learning runs once per user and skips fresh or edited cards', async () => {
    let release: () => void = () => undefined;
    const learn = mock(() => new Promise<any>((resolve) => (release = () => resolve({ status: 'learned' }))));
    expect(kickVoiceLearning('kick-user', null, learn as any)).toBe(true);
    expect(kickVoiceLearning('kick-user', null, learn as any)).toBe(false);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kickVoiceLearning('kick-user-2', profile({ learnedAt: Date.now() }), learn as any)).toBe(false);
    expect(kickVoiceLearning('kick-user-3', profile({ editedAt: 1, source: 'edited' }), learn as any)).toBe(
      false,
    );
    expect(kickVoiceLearning('kick-user-4', profile({ learnedAt: 1 }), learn as any)).toBe(true);
    expect(learn).toHaveBeenCalledTimes(2);
  });
});

describe('Settings copy', () => {
  test('source line and learn results read plainly', () => {
    expect(voiceSourceLine(null)).toBe('Not learned yet');
    expect(voiceSourceLine(profile({ learnedAt: NOW, sampleCount: 1 }))).toBe(
      'Learned from 1 sent email on Sep 26',
    );
    expect(voiceSourceLine(profile({ source: 'edited', editedAt: NOW }))).toBe('Edited Sep 26');
    expect(voiceSourceLine(profile({ learnedAt: null }))).toBe('Set by you');
    expect(learnResultMessage({ status: 'learned', profile: null })).toEqual({
      kind: 'success',
      text: 'Albatross learned how you write',
    });
    expect(learnResultMessage({ status: 'too_soon', profile: null, nextLearnAt: NOW }).text).toBe(
      'Albatross learns at most once a week. You can learn again on Sep 26.',
    );
    expect(learnResultMessage({ status: 'edited', profile: null }).text).toContain('Replace my edits');
    expect(learnResultMessage({ status: 'not_enough_mail', profile: null, sampleCount: 2 }).text).toBe(
      'Albatross needs at least 5 sent emails to learn how you write. It found 2.',
    );
  });
});

// seedThreadMessage stays imported for parity with the other mail suites.
void seedThreadMessage;
