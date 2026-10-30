import { describe, expect, test } from 'bun:test';
import { assessmentDue, type JevAssessment } from '../lib/jev/contract';
import { assessmentFromResponse, buildMailQuestions } from '../lib/jev/mail';
import { PUSH_PROBABILITY } from '../lib/obligations/contract';
import {
  clip,
  codeObligation,
  dueAtFromEvidence,
  fallbackTitle,
  headerName,
  type MailThreadFacts,
  mailObligations,
  ownText,
  requestLine,
  startOfLocalDay,
  whyLine,
} from '../lib/obligations/rules';
import { assessment, mailInput, NOW, responseFor } from './fixtures/jev';

// Invented people and companies only.
const MONDAY = Date.parse('2026-09-21T12:00:00Z');
const NY = 'America/New_York';
const endOfDay = (day: string, zone = NY) =>
  new Date(`${day}T23:59:59.999${zone === 'UTC' ? 'Z' : '-04:00'}`).getTime();

describe('Jev due question (S1)', () => {
  test('the mail questions ask for the due bucket; the question version does not change', () => {
    const questions = buildMailQuestions(mailInput());
    expect(questions.due).toMatchObject({ type: 'choice' });
    expect(Object.keys((questions.due as any).criteria)).toEqual(['today', 'soon', 'later', 'none']);
    expect(assessmentFromResponse(mailInput(), responseFor(mailInput()), NOW).questionVersion).toBe('mail-1');
  });

  test('a clear due answer is stored; an unclear or missing one is left out and reads as none', () => {
    const input = mailInput();
    expect(assessmentFromResponse(input, responseFor(input, { due: 'soon' }), NOW).due).toBe('soon');
    const unclear = responseFor(input, { due: 'today' });
    (unclear.answers.due as any).confidence = 0.2;
    expect(assessmentFromResponse(input, unclear, NOW).due).toBeUndefined();
    const missing = responseFor(input);
    delete (missing.answers as any).due;
    const old = assessmentFromResponse(input, missing, NOW);
    expect(old.due).toBeUndefined();
    expect(assessmentDue(old)).toBe('none');
    expect(assessmentDue(null)).toBe('none');
    const wrongType = responseFor(input);
    (wrongType.answers as any).due = { type: 'noul', noul: 0.9 };
    expect(assessmentFromResponse(input, wrongType, NOW).due).toBeUndefined();
  });
});

describe('text helpers', () => {
  test('clip cuts at a word end', () => {
    expect(clip('  short  text ', 40)).toBe('short text');
    expect(clip('one two three four five six', 15)).toBe('one two three…');
    expect(clip('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghi…');
  });

  test('headerName gives the display name, else the address', () => {
    expect(headerName('"Maya Chen" <maya@university.test>')).toBe('Maya Chen');
    expect(headerName('<maya@university.test>')).toBe('maya@university.test');
    expect(headerName('maya@university.test')).toBe('maya@university.test');
    expect(headerName('')).toBe('Someone');
    expect(headerName('Harbor Air')).toBe('Harbor Air');
  });

  test('ownText drops quoted lines, earlier messages, and the signature', () => {
    const body = [
      'Can you sign the lease today?',
      '> quoted request from before',
      '--',
      'Marco Ruiz, Ruiz Property',
    ].join('\n');
    expect(ownText(body)).toBe('Can you sign the lease today?');
    expect(ownText('Thanks!\nOn Mon, Sep 21, 2026, Ana wrote:\nOld text')).toBe('Thanks!');
    expect(ownText('See below.\n----- Forwarded Message -----\nOld')).toBe('See below.');
    expect(ownText('')).toBe('');
  });

  test('requestLine picks the sentence that says what is owed', () => {
    const text = 'Hi there. Hope the week is good. Could you confirm the revised start date? Thanks.';
    expect(requestLine(text, 'reply')).toBe('Could you confirm the revised start date?');
    expect(requestLine('Hello again. Please upload the signed form to the portal.', 'reply')).toBe(
      'Please upload the signed form to the portal.',
    );
    expect(requestLine('Status update. Please pay the open invoice this week.', 'action')).toBe(
      'Please pay the open invoice this week.',
    );
    expect(requestLine('Good news. I will send the signed agreement tomorrow.', 'waiting')).toBe(
      'I will send the signed agreement tomorrow.',
    );
    expect(requestLine('Hello. Your flight HA 220 now departs at 6:40 pm.', 'change')).toBe(
      'Your flight HA 220 now departs at 6:40 pm.',
    );
    expect(requestLine('Nice to meet you all.', 'action')).toBeUndefined();
  });

  test('fallback titles and why lines name the kind in plain words', () => {
    expect(fallbackTitle('reply', 'Re: Budget approval')).toBe('Reply about Budget approval');
    expect(fallbackTitle('action', 'Form')).toBe('Action needed: Form');
    expect(fallbackTitle('waiting', 'Lease')).toBe('Waiting for an answer: Lease');
    expect(fallbackTitle('change', 'Flight')).toBe('Changed: Flight');
    expect(fallbackTitle('code', '')).toBe('Sign-in code: (no subject)');
    expect(whyLine('reply', 'Maya')).toContain('Maya asked you something');
    expect(whyLine('action', 'Maya')).toContain('not done yet');
    expect(whyLine('waiting', 'Marco')).toBe('You wait for Marco. No answer is in the thread yet.');
    expect(whyLine('change', 'Harbor Air', 'booking')).toBe('Harbor Air reports a change to a booking.');
    expect(whyLine('change', 'Shop', 'general')).toBe('Shop reports a change to something you have.');
    expect(whyLine('code', 'Northwind Bank')).toContain('sign-in code');
    for (const kind of ['reply', 'action', 'waiting', 'change', 'code'] as const)
      expect(whyLine(kind, 'A') + fallbackTitle(kind, 'S')).not.toMatch(/\bAI\b/);
  });
});

describe('due parsing (dueAtFromEvidence)', () => {
  test('none, no phrase, and an empty text give no date', () => {
    expect(dueAtFromEvidence('Please reply today.', 'none', NY, MONDAY)).toBeUndefined();
    expect(dueAtFromEvidence('Please reply when you can.', 'soon', NY, MONDAY)).toBeUndefined();
    expect(dueAtFromEvidence('', 'soon', NY, MONDAY)).toBeUndefined();
  });

  test('today, tonight, end of day, and tomorrow', () => {
    expect(dueAtFromEvidence('Can you send it today?', 'today', NY, MONDAY)).toBe(endOfDay('2026-09-21'));
    expect(dueAtFromEvidence('Need this by EOD.', 'today', NY, MONDAY)).toBe(endOfDay('2026-09-21'));
    expect(dueAtFromEvidence('Can you reply tomorrow?', 'soon', NY, MONDAY)).toBe(endOfDay('2026-09-22'));
  });

  test('a weekday after a cue is the next such day from the message date', () => {
    expect(dueAtFromEvidence('Please confirm by Friday.', 'soon', NY, MONDAY)).toBe(endOfDay('2026-09-25'));
    expect(dueAtFromEvidence('Please confirm by Monday.', 'today', NY, MONDAY)).toBe(endOfDay('2026-09-21'));
    expect(dueAtFromEvidence('Send it this Wednesday.', 'soon', NY, MONDAY)).toBe(endOfDay('2026-09-23'));
    // "next Friday" can mean two days: not sure.
    expect(dueAtFromEvidence('Please confirm by next Friday.', 'later', NY, MONDAY)).toBeUndefined();
  });

  test('the end of the week is Friday; on a weekend it is unclear', () => {
    expect(dueAtFromEvidence('Can you finish by end of week?', 'soon', NY, MONDAY)).toBe(
      endOfDay('2026-09-25'),
    );
    const saturday = Date.parse('2026-09-26T16:00:00Z');
    expect(dueAtFromEvidence('Can you finish by end of week?', 'soon', NY, saturday)).toBeUndefined();
  });

  test('a named date, in both orders, rolls to the next year when it is before the message', () => {
    expect(dueAtFromEvidence('Please sign by October 31.', 'later', NY, MONDAY)).toBe(endOfDay('2026-10-31'));
    expect(dueAtFromEvidence('Due on the 2nd of Oct.', 'later', NY, MONDAY)).toBe(endOfDay('2026-10-02'));
    expect(dueAtFromEvidence('Pay before Friday, Sept. 25th.', 'soon', NY, MONDAY)).toBe(
      endOfDay('2026-09-25'),
    );
    const december = Date.parse('2026-12-20T12:00:00Z');
    expect(dueAtFromEvidence('Reply by January 5.', 'later', 'UTC', december)).toBe(
      endOfDay('2027-01-05', 'UTC'),
    );
    expect(dueAtFromEvidence('Reply by February 31.', 'later', NY, MONDAY)).toBeUndefined();
  });

  test('two different days, or a quoted phrase only, give no date', () => {
    expect(dueAtFromEvidence('Reply today or by Friday.', 'soon', NY, MONDAY)).toBeUndefined();
    expect(dueAtFromEvidence('Thanks.\n> Please reply by Friday.', 'soon', NY, MONDAY)).toBeUndefined();
    // The same day twice is one day.
    expect(dueAtFromEvidence('Today, please. By Monday.', 'today', NY, MONDAY)).toBe(endOfDay('2026-09-21'));
  });

  test('an unknown or empty zone falls back to UTC', () => {
    expect(dueAtFromEvidence('Reply today.', 'today', 'Not/AZone', MONDAY)).toBe(
      endOfDay('2026-09-21', 'UTC'),
    );
    expect(dueAtFromEvidence('Reply today.', 'today', '', MONDAY)).toBe(endOfDay('2026-09-21', 'UTC'));
  });

  test('startOfLocalDay follows the zone', () => {
    expect(new Date(startOfLocalDay(Date.parse('2026-09-22T02:00:00Z'), NY)).toISOString()).toBe(
      '2026-09-21T04:00:00.000Z',
    );
    expect(new Date(startOfLocalDay(MONDAY, 'Bad/Zone')).toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });
});

function facts(patch: Partial<MailThreadFacts> = {}): MailThreadFacts {
  return {
    accountId: 'account-a',
    threadId: 'thread-a',
    subject: 'Budget approval',
    messages: [
      {
        id: 'm1',
        from: 'Maya Chen <maya@university.test>',
        to: 'owner@example.test',
        subject: 'Budget approval',
        body: 'Hi. Could you confirm the budget by Friday?',
        date: MONDAY,
      },
    ],
    selfAddresses: ['owner@example.test'],
    ...patch,
  };
}
const settings = { vipSenders: [] as string[], timezone: NY };
function verdict(patch: Partial<JevAssessment> = {}) {
  return assessment({
    obligations: [
      {
        kind: 'reply',
        evidence: { messageId: 'm1', text: 'Hi. Could you confirm the budget by Friday?' },
        probability: 0.97,
      },
    ],
    ...patch,
  });
}

describe('the rule table (mailObligations)', () => {
  test('a person asks, due soon: one reply that pushes', () => {
    const [item, ...rest] = mailObligations(verdict({ due: 'soon' }), facts(), settings, MONDAY);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      kind: 'reply',
      title: 'Could you confirm the budget by Friday?',
      asker: 'Maya Chen',
      askerAddress: 'maya@university.test',
      due: 'soon',
      dueAt: endOfDay('2026-09-25'),
      probability: 0.97,
      pushLevel: 'normal',
      messageId: 'm1',
    });
    expect(item.why).toBe(
      'Maya Chen asked you something that is still open. No reply from you came after it.',
    );
    expect(item.excerpt).toBe('Hi. Could you confirm the budget by Friday?');
  });

  test('a person asks with no due date: in-app only, unless a VIP or a recent Albatross', () => {
    const noDate = verdict({
      due: 'none',
      obligations: [
        { kind: 'reply', evidence: { messageId: 'm1', text: 'Thoughts on this?' }, probability: 0.97 },
      ],
    });
    expect(mailObligations(noDate, facts(), settings, MONDAY)[0].pushLevel).toBe('none');
    expect(
      mailObligations(noDate, facts(), { ...settings, vipSenders: ['@university.test'] }, MONDAY)[0]
        .pushLevel,
    ).toBe('normal');
    expect(
      mailObligations(noDate, facts({ workId: 'w1' }), { ...settings, recentWorkIds: ['w1'] }, MONDAY)[0]
        .pushLevel,
    ).toBe('normal');
    expect(mailObligations(noDate, facts({ workId: 'w1' }), settings, MONDAY)[0]).toMatchObject({
      pushLevel: 'none',
      workId: 'w1',
    });
  });

  test('a dated phrase within three days pushes even when Jev says later', () => {
    const later = verdict({ due: 'later' });
    // Friday is four days after Monday: it is not soon.
    expect(mailObligations(later, facts(), settings, MONDAY)[0].pushLevel).toBe('none');
    expect(mailObligations(later, facts(), settings, Date.parse('2026-09-24T12:00:00Z'))[0].pushLevel).toBe(
      'normal',
    );
  });

  test('an automated sender (not a person) is in-app only', () => {
    expect(
      mailObligations(verdict({ purpose: 'transaction', due: 'today' }), facts(), settings, MONDAY)[0]
        .pushLevel,
    ).toBe('none');
  });

  test('below the push bar it is in-app only', () => {
    const low = verdict({
      due: 'today',
      obligations: [
        { kind: 'action', evidence: { messageId: 'm1', text: 'Please send the form.' }, probability: 0.8 },
      ],
    });
    expect(0.8).toBeLessThan(PUSH_PROBABILITY);
    expect(mailObligations(low, facts(), settings, MONDAY)[0]).toMatchObject({
      kind: 'action',
      pushLevel: 'none',
    });
    expect(mailObligations(low, facts(), { ...settings, pushProbability: 0.75 }, MONDAY)[0].pushLevel).toBe(
      'normal',
    );
  });

  test('waiting is in-app only and names the other person of an outbound request', () => {
    const outbound = facts({
      messages: [
        {
          id: 'm1',
          from: 'Owner <owner@example.test>',
          to: 'owner@example.test, "Marco Ruiz" <marco@ruiz.test>',
          body: 'Could you send the signed lease?',
          date: MONDAY,
        },
      ],
    });
    const [item] = mailObligations(
      verdict({
        due: 'today',
        obligations: [
          {
            kind: 'waiting',
            evidence: { messageId: 'm1', text: 'Could you send the signed lease?' },
            probability: 0.99,
          },
        ],
      }),
      outbound,
      settings,
      MONDAY,
    );
    expect(item).toMatchObject({
      kind: 'waiting',
      asker: 'Marco Ruiz',
      askerAddress: 'marco@ruiz.test',
      pushLevel: 'none',
    });
    expect(item.title).toBe('Could you send the signed lease?');
    // A note to self names the user, as the only person in it.
    outbound.messages[0].to = 'owner@example.test';
    const [self] = mailObligations(
      verdict({
        obligations: [
          { kind: 'action', evidence: { messageId: 'm1', text: 'Send the lease.' }, probability: 0.99 },
        ],
      }),
      outbound,
      settings,
      MONDAY,
    );
    expect(self).toMatchObject({ asker: 'Owner', askerAddress: 'owner@example.test' });
  });

  test('a new problem on a booking, an account, or a bill is time-sensitive; another change is in-app only', () => {
    const change = (
      subjectKind: JevAssessment['subjectKind'],
      probability = 0.95,
      text = 'Your flight HA 220 now departs at 6:40 pm.',
    ) =>
      verdict({
        purpose: 'transaction',
        subjectKind,
        obligations: [],
        meaningfulChange: true,
        changeEvidence: { messageId: 'm1', text },
        probabilities: { reply: 0.02, action: 0.02, waiting: 0.02, change: probability },
      });
    expect(mailObligations(change('booking'), facts(), settings, MONDAY)[0]).toMatchObject({
      kind: 'change',
      pushLevel: 'time_sensitive',
      title: 'Your flight HA 220 now departs at 6:40 pm.',
      sourceAt: MONDAY,
    });
    for (const [kind, text] of [
      ['account', 'Your account is locked after three failed sign-in attempts.'],
      ['finance', 'Your payment of $20.00 failed. Update your card.'],
    ] as const)
      expect(mailObligations(change(kind, 0.95, text), facts(), settings, MONDAY)[0].pushLevel).toBe(
        'time_sensitive',
      );
    // The same flight text is not an account or a bill problem.
    expect(mailObligations(change('account'), facts(), settings, MONDAY)[0].pushLevel).toBe('none');
    expect(mailObligations(change('order'), facts(), settings, MONDAY)[0].pushLevel).toBe('none');
    expect(mailObligations(change('booking', 0.8), facts(), settings, MONDAY)[0].pushLevel).toBe('none');
    // A change verdict without its probability still opens, at the full value.
    const noProbability = change('booking');
    noProbability.probabilities = {};
    expect(mailObligations(noProbability, facts(), settings, MONDAY)[0].probability).toBe(1);
  });

  test('promotions, newsletters, excluded threads, and an uncertain band give none', () => {
    expect(mailObligations(verdict({ purpose: 'promotion' }), facts(), settings, MONDAY)).toEqual([]);
    expect(mailObligations(verdict({ purpose: 'newsletter' }), facts(), settings, MONDAY)).toEqual([]);
    expect(mailObligations(verdict(), facts(), { ...settings, excluded: true }, MONDAY)).toEqual([]);
    // Jev keeps no obligation for a kind in the band (0.25-0.75).
    const band = verdict({
      obligations: [],
      probabilities: { reply: 0.5, action: 0.1, waiting: 0.1, change: 0.1 },
    });
    expect(mailObligations(band, facts(), settings, MONDAY)).toEqual([]);
  });

  test('an evidence id outside the window falls back to the newest message, and a dull text to the subject', () => {
    const [item] = mailObligations(
      verdict({
        obligations: [{ kind: 'reply', evidence: { messageId: 'gone', text: 'Ok.' }, probability: 0.9 }],
      }),
      facts(),
      settings,
      MONDAY,
    );
    expect(item).toMatchObject({ messageId: 'm1', title: 'Reply about Budget approval', asker: 'Maya Chen' });
    expect(item.dueAt).toBeUndefined();
    const [empty] = mailObligations(
      verdict({
        obligations: [{ kind: 'action', evidence: { messageId: 'x', text: '> only' }, probability: 0.9 }],
      }),
      facts({ messages: [] }),
      settings,
      MONDAY,
    );
    expect(empty).toMatchObject({ messageId: 'x', asker: 'Someone', excerpt: '> only' });
  });
});

describe('codes (codeObligation)', () => {
  test('a code pushes at once, time-sensitive, due at its expiry', () => {
    const item = codeObligation({
      messageId: 'm9',
      from: 'Northwind Bank <alerts@northwind.test>',
      subject: 'Your sign-in code',
      issuer: 'Northwind Bank',
      label: 'Northwind Bank',
      confidence: 0.95,
      expiresAt: MONDAY + 600_000,
    });
    expect(item).toMatchObject({
      kind: 'code',
      title: 'Sign-in code for Northwind Bank',
      asker: 'Northwind Bank',
      askerAddress: 'alerts@northwind.test',
      due: 'today',
      dueAt: MONDAY + 600_000,
      pushLevel: 'time_sensitive',
      messageId: 'm9',
      excerpt: 'Your sign-in code',
    });
    const bare = codeObligation({ messageId: 'm', from: 'Shop', subject: '', confidence: 3, expiresAt: 1 });
    expect(bare).toMatchObject({ asker: 'Shop', probability: 1, excerpt: 'Sign-in code' });
    expect(bare.askerAddress).toBeUndefined();
  });
});
