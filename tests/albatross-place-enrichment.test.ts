import { describe, expect, test } from 'bun:test';
import {
  __setPlaceEnrichmentDepsForTest,
  enrichPlace,
  mapsUrlFor,
  parsePlaceProfile,
} from '../lib/albatross/place-enrichment';

const goodProfile = {
  resolvedName: "Joe's Coffee",
  address: '123 Main St, Albany, NY',
  website: 'https://joescoffee.example',
  phone: '(518) 555-0100',
  hoursText: 'Mon-Fri 7am-6pm; Sat 8am-4pm; Sun closed',
  onlineOrdering: { available: true, url: 'https://joescoffee.example/order', notes: null },
  confidence: 'high',
  notes: null,
};

describe('parsePlaceProfile', () => {
  test('parses clean JSON and fenced JSON', () => {
    expect(parsePlaceProfile(JSON.stringify(goodProfile)).resolvedName).toBe("Joe's Coffee");
    const fenced = `\`\`\`json\n${JSON.stringify(goodProfile)}\n\`\`\``;
    expect(parsePlaceProfile(fenced).hoursText).toContain('Mon-Fri');
  });

  test('coerces bad confidence and tolerates nulls', () => {
    const parsed = parsePlaceProfile(
      JSON.stringify({ ...goodProfile, confidence: 'very sure', address: null, onlineOrdering: {} }),
    );
    expect(parsed.confidence).toBe('low');
    expect(parsed.address).toBeNull();
  });

  test('throws without a JSON object', () => {
    expect(() => parsePlaceProfile('no idea')).toThrow(/no JSON object/);
  });
});

describe('mapsUrlFor', () => {
  test('builds a deterministic encoded maps link', () => {
    const url = mapsUrlFor("Joe's Coffee", '123 Main St');
    expect(url).toStartWith('https://www.google.com/maps/search/?api=1&query=');
    expect(decodeURIComponent(url.split('query=')[1])).toBe("Joe's Coffee 123 Main St");
  });

  test('works without an address', () => {
    expect(decodeURIComponent(mapsUrlFor('Joes').split('query=')[1])).toBe('Joes');
  });
});

describe('enrichPlace orchestration', () => {
  const SEARCH_RESULTS = [
    { title: "Joe's Coffee — Albany", url: 'https://joescoffee.example', snippet: 'Coffee shop' },
    { title: "Joe's on Facebook", url: 'https://facebook.com/joes', snippet: 'social' },
    { title: 'Yelp: Joes Coffee', url: 'https://yelp.example/joes', snippet: 'reviews' },
  ];

  function wire(overrides: { results?: any[]; extractText?: string; fetchFails?: boolean }) {
    const calls: { tools: Array<{ name: string; args: any }>; mutations: any[] } = {
      tools: [],
      mutations: [],
    };
    __setPlaceEnrichmentDepsForTest({
      api: { albatross: { addAreaFact: 'm:addAreaFact' } },
      invokeTool: async (tool: any, args: any) => {
        calls.tools.push({ name: tool.name, args });
        if (tool.name === 'browserbase_search') {
          return { results: overrides.results ?? SEARCH_RESULTS };
        }
        if (overrides.fetchFails) throw new Error('fetch failed');
        return { content: `# Joe's Coffee\nHours: Mon-Fri 7-6\nOrder online at /order` };
      },
      convexMutation: async (_fn: any, args: any) => {
        calls.mutations.push(args);
        return `fact_${calls.mutations.length}`;
      },
      generateTextForCurrentUser: async () => ({
        text: overrides.extractText ?? JSON.stringify(goodProfile),
      }),
    });
    return calls;
  }

  test('happy path without areaId returns profile + sources, saves nothing', async () => {
    const calls = wire({});
    const result = await enrichPlace({ userId: 'user_1', name: "Joe's Coffee", hint: 'Albany' });
    expect(result.profile.resolvedName).toBe("Joe's Coffee");
    expect(result.profile.mapsUrl).toContain('google.com/maps');
    expect(result.factIds).toHaveLength(0);
    expect(calls.mutations).toHaveLength(0);
    // Social pages are skipped as fetch targets.
    const fetches = calls.tools.filter((t) => t.name === 'browserbase_fetch');
    expect(fetches.every((f) => !String(f.args.url).includes('facebook'))).toBe(true);
    expect(result.sourceUrls.length).toBeGreaterThan(0);
  });

  test('with areaId saves candidate facts with url source refs', async () => {
    const calls = wire({});
    const result = await enrichPlace({ userId: 'user_1', name: "Joe's Coffee", areaId: 'area_1' });
    expect(result.factIds.length).toBeGreaterThanOrEqual(4);
    for (const mutation of calls.mutations) {
      expect(mutation.status).toBe('candidate');
      expect(mutation.sourceRefs.length).toBeGreaterThan(0);
      expect(mutation.areaId).toBe('area_1');
    }
    const values = calls.mutations.map((m) => m.value).join('\n');
    expect(values).toContain('Hours:');
    expect(values).toContain('Online ordering: yes');
    expect(values).toContain('google.com/maps');
  });

  test('no search results throws a readable error', async () => {
    wire({ results: [] });
    await expect(enrichPlace({ userId: 'user_1', name: 'Nowhere Place' })).rejects.toThrow(/No web results/);
  });

  test('page fetch failures still produce a profile from search snippets', async () => {
    wire({ fetchFails: true });
    const result = await enrichPlace({ userId: 'user_1', name: "Joe's Coffee" });
    expect(result.profile.resolvedName).toBe("Joe's Coffee");
  });
});
