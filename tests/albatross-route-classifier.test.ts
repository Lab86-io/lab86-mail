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
