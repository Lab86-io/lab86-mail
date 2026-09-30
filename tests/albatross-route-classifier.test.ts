import { describe, expect, test } from 'bun:test';
import {
  ASK_FALLBACK,
  classifyRoute,
  looksEnumerated,
  ROUTE_MODEL_MAX_OUTPUT_TOKENS,
  ROUTE_MODEL_TIMEOUT_MS,
  routeHeuristic,
} from '../lib/albatross/route-classifier';

const ASK_PHRASES = [
  'what did Sarah say about the venue?',
  'what did Sarah say about the venue',
  'show me the last email from Alex',
  'find the invoice from March',
  'who is coming to the dinner on Friday',
  'when is my next flight',
  'where did we land on the contract',
  'why did the deploy fail',
  'how many meetings do I have tomorrow',
  'which thread has the venue quote',
  'did the passport arrive',
  'is the dentist confirmed',
  'are we still on for lunch',
  'can you summarize the board thread',
  'could you draft a reply to Dana',
  'tell me about the Acme renewal',
  'summarize my inbox',
  'explain the difference between the two quotes',
  'pull up the thread with Marco',
  'open the latest message from HR',
  'draft a note to the landlord about the leak',
  'write a short reply that says yes',
  'search for the hotel confirmation',
  'look up the flight number',
  'list my meetings for tomorrow',
  'give me the top three unread threads',
  'I need to know what Sarah said about the venue?',
  'how much did we pay for the venue',
  'does Alex know about the date change',
  'compare the two insurance offers',
];

const HOLD_PHRASES = [
  'book the dentist before the trip',
  'I need to renew the passport, but not before November',
  'remind me to call mom on Sunday',
  'I have to file the taxes by Friday',
  'renew the car registration',
  'pay the electric bill',
  'buy a gift for Dana',
  'cancel the gym membership',
  'sign up for the pottery class',
  'submit the expense report',
  'Movie list: Heat, Alien, Dune part two',
  'lose fifteen pounds by spring',
  'ship the Albatross Mac app',
  'hold this',
  'keep this as work',
  'remember to water the plants',
  'note to self: ask Priya about the budget',
  'I should clean the garage this weekend',
  'I want to learn Portuguese',
  'we need to replace the roof next year',
  'call the plumber tomorrow',
  'pick up the dry cleaning',
  'fix the bike brakes',
  'finish the grant application by the end of the month',
  "don't forget the passport photos",
  'someday visit Kyoto',
  'apply for the residency permit',
  'order new running shoes',
  'groceries:\n- milk\n- eggs\n- bread',
  '1. renew passport\n2. book flights\n3. reserve hotel',
];

describe('routeHeuristic', () => {
  test.each(ASK_PHRASES)('reads "%s" as ask', (phrase) => {
    const verdict = routeHeuristic(phrase);
    expect(verdict?.route).toBe('ask');
    expect(verdict!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  test.each(HOLD_PHRASES)('reads "%s" as hold', (phrase) => {
    const verdict = routeHeuristic(phrase);
    expect(verdict?.route).toBe('hold');
    expect(verdict!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  test('a question mark wins over hold words', () => {
    expect(routeHeuristic('should I renew the passport before the trip?')).toMatchObject({ route: 'ask' });
    expect(routeHeuristic('remind me, did I book the dentist?')).toMatchObject({ route: 'ask' });
  });

  test('explicit hold words win over ask words', () => {
    expect(routeHeuristic('can you remind me to renew the passport')).toMatchObject({
      route: 'hold',
      confidence: 0.95,
    });
  });

  test('returns null when the signals are mixed or absent', () => {
    expect(routeHeuristic('I need to know what Sarah said about the venue')).toBeNull();
    expect(routeHeuristic('the venue')).toBeNull();
    expect(routeHeuristic('Sarah and the budget')).toBeNull();
  });

  test('empty text is ask with confidence zero', () => {
    expect(routeHeuristic('')).toEqual({ route: 'ask', confidence: 0, reason: 'empty' });
    expect(routeHeuristic('   ')).toEqual({ route: 'ask', confidence: 0, reason: 'empty' });
  });
});

describe('looksEnumerated', () => {
  test('sees bullets, numbers, and comma lists after a colon', () => {
    expect(looksEnumerated('- one\n- two')).toBe(true);
    expect(looksEnumerated('1. one\n2) two')).toBe(true);
    expect(looksEnumerated('films: Heat, Alien')).toBe(true);
  });

  test('does not see a single item or plain prose', () => {
    expect(looksEnumerated('- one')).toBe(false);
    expect(looksEnumerated('films: Heat')).toBe(false);
    expect(looksEnumerated('we met Sarah, then left')).toBe(false);
  });
});

function modelDeps(
  behavior: (options: any) => Promise<{ object: unknown }>,
  timeoutMs = ROUTE_MODEL_TIMEOUT_MS,
) {
  const calls: any[] = [];
  return {
    calls,
    deps: {
      generateObject: (async (options: any) => {
        calls.push(options);
        return behavior(options);
      }) as any,
      timeoutMs,
    },
  };
}

describe('classifyRoute', () => {
  test('answers clear text without a model call', async () => {
    const { calls, deps } = modelDeps(async () => ({ object: { route: 'hold', confidence: 1 } }));
    expect(await classifyRoute({ text: 'what did Sarah say?' }, deps)).toMatchObject({ route: 'ask' });
    expect(calls).toHaveLength(0);
  });

  test('asks the fast model once for unclear text with the route feature and a small cap', async () => {
    const { calls, deps } = modelDeps(async () => ({ object: { route: 'hold', confidence: 0.72 } }));
    const verdict = await classifyRoute(
      { text: 'I need to know what Sarah said about the venue', userId: 'user_1' },
      deps,
    );
    expect(verdict).toEqual({ route: 'hold', confidence: 0.72, reason: 'model' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      feature: 'albatross_route',
      speed: 'fast',
      userId: 'user_1',
      maxOutputTokens: ROUTE_MODEL_MAX_OUTPUT_TOKENS,
    });
    expect(JSON.parse(calls[0].prompt)).toEqual({ text: 'I need to know what Sarah said about the venue' });
  });

  test('falls back to ask with confidence zero when the model fails', async () => {
    const { deps } = modelDeps(async () => {
      throw new Error('provider down');
    });
    expect(await classifyRoute({ text: 'Sarah and the budget' }, deps)).toEqual(ASK_FALLBACK);
  });

  test('falls back to ask with confidence zero when the model is slow', async () => {
    const { deps } = modelDeps(
      () =>
        new Promise((resolve) => setTimeout(() => resolve({ object: { route: 'hold', confidence: 1 } }), 50)),
      5,
    );
    expect(await classifyRoute({ text: 'Sarah and the budget' }, deps)).toEqual(ASK_FALLBACK);
  });

  test('falls back to ask when the model returns a shape outside the schema', async () => {
    const { deps } = modelDeps(async () => ({ object: { route: 'maybe', confidence: 2 } }));
    expect(await classifyRoute({ text: 'Sarah and the budget' }, deps)).toEqual(ASK_FALLBACK);
  });

  test('clips long text to the route limit before the model sees it', async () => {
    const { calls, deps } = modelDeps(async () => ({ object: { route: 'ask', confidence: 0.5 } }));
    await classifyRoute({ text: `Sarah ${'x'.repeat(5_000)}` }, deps);
    expect(JSON.parse(calls[0].prompt).text.length).toBe(2_000);
  });
});

describe('WRK-6 contractions, curly apostrophes, and "may"', () => {
  test.each([
    'what’s on my calendar tomorrow',
    "what's on my calendar tomorrow",
    'when’s my flight next week',
    'who’s coming on friday',
    'may i see the invoice',
    'may we move the call to next week',
  ])('"%s" is a question', (text) => {
    expect(routeHeuristic(text)?.route).toBe('ask');
  });

  test.each([
    'renew the passport in may',
    'book the cabin by may 12',
    'don’t forget to pay the rent',
    'i’m going to finish the deck this weekend',
  ])('"%s" is still held', (text) => {
    expect(routeHeuristic(text)?.route).toBe('hold');
  });
});

// 2026-09-30 demo bug: "Add the label Offsite to the message "Board meeting
// materials for October 9" and mark it as unread." moved the chip to Hold,
// because "October 9" read as a horizon. An imperative that acts on mail,
// events, contacts, files, or tasks is Ask, also with a date in it.
describe('app actions with a date stay Ask', () => {
  test('the demo request is Ask, with no model call', async () => {
    const text =
      'Add the label Offsite to the message "Board meeting materials for October 9" and mark it as unread.';
    expect(routeHeuristic(text)).toEqual({ route: 'ask', confidence: 0.85, reason: 'app action' });
    const { calls, deps } = modelDeps(async () => ({ object: { route: 'hold', confidence: 1 } }));
    expect(await classifyRoute({ text }, deps)).toMatchObject({ route: 'ask', reason: 'app action' });
    expect(calls).toHaveLength(0);
  });

  test.each([
    'Archive the message "Board meeting materials for October 9"',
    'Label the “Q3 offsite, October 9” thread as Offsite',
    'Accept the "Board prep sync" invitation on Friday.',
    'Cancel "Board prep sync" tomorrow',
    'Create an event on October 9 at 3pm called Offsite',
    'Move the October 9 board meeting to October 10',
    'Mark the email from Dana as unread',
    'mark it as read by tomorrow',
    'Forward the October 9 minutes to Priya',
    'Delete the calendar event next week',
    'Cancel the meeting with Sam tomorrow',
    'Decline the invite for next week',
    'Please trash the newsletters from last month',
    'Add a task to the Offsite board for October 9',
    'RSVP yes to the October 9 dinner',
    'Reply to Dana by Friday',
    'Rename the file "Budget October 9" to Budget',
    'Send the October 9 deck to Dana',
    'Snooze the thread from Dana until Monday',
  ])('"%s" is Ask', (text) => {
    expect(routeHeuristic(text)?.route).toBe('ask');
  });

  test('a quoted subject gives no date signal, and a quoted question mark does not win', () => {
    expect(routeHeuristic('"Board meeting materials for October 9"')).toMatchObject({ route: 'hold' });
    expect(routeHeuristic('Remind me about "Can we meet?" next week')).toMatchObject({
      route: 'hold',
      reason: 'explicit hold',
    });
    expect(routeHeuristic('Find “Board meeting materials for October 9”')).toMatchObject({ route: 'ask' });
    expect(routeHeuristic('the “October 9” notes')).toBeNull();
  });

  test.each([
    'remind me on October 9 to send the board materials',
    'Remind me on October 9 to archive the board email',
    'hold this until Friday',
    'follow up next week about the contract',
    'Follow up with Dana on October 9 about the offsite',
    'Send flowers to mom on October 9',
    'Delete my old Facebook account next week',
    'cancel the gym membership',
    'file the taxes by Friday',
    'I need to archive the October 9 email',
    'schedule the car service by Friday',
  ])('the deferral "%s" stays Hold', (text) => {
    expect(routeHeuristic(text)?.route).toBe('hold');
  });

  test('the model prompt says the same', async () => {
    const { calls, deps } = modelDeps(async () => ({ object: { route: 'ask', confidence: 0.6 } }));
    await classifyRoute({ text: 'the venue' }, deps);
    expect(calls[0].system).toContain('also when it names a date or a time');
    expect(calls[0].system).toContain('A date inside quoted text names a thing');
  });
});
