import { z } from 'zod';
import { generateTextForCurrentUser } from '@/lib/ai/gateway';
import { api, convexMutation } from '@/lib/hosted/convex';
import { invokeTool } from '@/lib/tools/registry';
import { browserbaseFetch, browserbaseSearch } from '@/lib/tools/web';

/* Real-world grounding for named places (epic research protocol: official
 * sources first, store source refs, never silently assume). Given "Joe's
 * Coffee on Main St", search the web via Browserbase, read the top pages, and
 * extract address, hours, and whether it takes online orders. Results become
 * CANDIDATE area facts with source refs — the user confirms; nothing is
 * auto-verified. */

const defaultDeps = {
  api: api as any,
  convexMutation,
  generateTextForCurrentUser,
  invokeTool,
};

let deps = defaultDeps;

export function __setPlaceEnrichmentDepsForTest(overrides: Partial<typeof defaultDeps> = {}) {
  deps = { ...defaultDeps, ...overrides };
}

export const placeProfileSchema = z.object({
  resolvedName: z.string().min(1).max(160),
  address: z.string().max(300).nullish(),
  website: z.string().max(500).nullish(),
  phone: z.string().max(40).nullish(),
  hoursText: z.string().max(600).nullish(),
  onlineOrdering: z
    .object({
      available: z.boolean().nullish(),
      url: z.string().max(500).nullish(),
      notes: z.string().max(300).nullish(),
    })
    .default({}),
  confidence: z.enum(['high', 'medium', 'low']).catch('low'),
  notes: z.string().max(500).nullish(),
});

export type PlaceProfile = z.infer<typeof placeProfileSchema> & { mapsUrl: string };

/** Parse the extraction model's JSON output; tolerate fences and prose. */
export function parsePlaceProfile(raw: string): z.infer<typeof placeProfileSchema> {
  let text = (raw || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Place extraction returned no JSON object.');
  const result = placeProfileSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
  if (!result.success) {
    throw new Error(`Place extraction failed validation: ${result.error.issues[0]?.message}`);
  }
  return result.data;
}

/** Deterministic maps link — never trust a model-fabricated deep link. */
export function mapsUrlFor(name: string, address?: string | null): string {
  const query = [name, address].filter(Boolean).join(' ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

const EXTRACT_SYSTEM = `You extract facts about ONE real-world place from web search results and page content. Output ONE JSON object, no prose:
{
  "resolvedName": string,        // the place's proper name
  "address": string|null,        // street address if found
  "website": string|null,        // official site if identifiable
  "phone": string|null,
  "hoursText": string|null,      // compact human-readable hours, e.g. "Mon-Fri 7am-6pm; Sat 8am-4pm; Sun closed"
  "onlineOrdering": { "available": boolean|null, "url": string|null, "notes": string|null },
  "confidence": "high"|"medium"|"low",
  "notes": string|null           // disambiguation caveats, e.g. multiple locations
}
Rules: only state what the sources support. Unknown -> null. If several distinct places match, pick the most likely, lower confidence, and explain in notes. Never invent URLs.`;

interface EnrichPlaceInput {
  userId: string;
  userEmail?: string | null;
  name: string;
  hint?: string;
  areaId?: string;
}

export interface EnrichPlaceResult {
  profile: PlaceProfile;
  sourceUrls: string[];
  factIds: string[];
}

function looksFetchworthy(url: string): boolean {
  // Skip walled or JS-only aggregators that fetch poorly; prefer anything else.
  return !/facebook\.com|instagram\.com|tiktok\.com|linkedin\.com/i.test(url);
}

export async function enrichPlace(input: EnrichPlaceInput): Promise<EnrichPlaceResult> {
  const query = [input.name, input.hint, 'hours address online ordering'].filter(Boolean).join(' ');
  const search: any = await deps.invokeTool(
    browserbaseSearch,
    { query, limit: 6 },
    { agent: 'ai', userId: input.userId },
  );
  const results: any[] = (search?.results || []).filter((result: any) => result?.url);
  if (!results.length) throw new Error(`No web results found for "${input.name}".`);

  const fetchTargets = results
    .filter((result) => looksFetchworthy(String(result.url)))
    .slice(0, 2)
    .map((result) => String(result.url));
  const pages = await Promise.all(
    fetchTargets.map(async (url) => {
      const page: any = await deps
        .invokeTool(browserbaseFetch, { url }, { agent: 'ai', userId: input.userId })
        .catch(() => null);
      const content = String(page?.content || '').slice(0, 6000);
      return content ? { url, content } : null;
    }),
  );

  const prompt = [
    `Place the user named: "${input.name}"${input.hint ? ` (context: ${input.hint})` : ''}`,
    '',
    '## Search results',
    ...results.map(
      (result, index) =>
        `${index + 1}. ${result.title || 'Untitled'} — ${result.url}${result.snippet ? `\n   ${String(result.snippet).slice(0, 200)}` : ''}`,
    ),
    ...pages.filter(Boolean).flatMap((page) => ['', `## Page content: ${page!.url}`, page!.content]),
  ].join('\n');

  const { text } = await deps.generateTextForCurrentUser({
    feature: 'albatross_place',
    speed: 'fast',
    userId: input.userId,
    userEmail: input.userEmail,
    system: EXTRACT_SYSTEM,
    prompt,
  });
  const extracted = parsePlaceProfile(text);
  const profile: PlaceProfile = {
    ...extracted,
    mapsUrl: mapsUrlFor(extracted.resolvedName || input.name, extracted.address),
  };
  const sourceUrls = [
    ...new Set([...fetchTargets, ...results.slice(0, 3).map((result) => String(result.url))]),
  ].slice(0, 5);

  const factIds: string[] = [];
  if (input.areaId) {
    const sourceRefs = sourceUrls.map((url) => ({ kind: 'url', id: url, url }));
    const facts: Array<{ kind: string; value: string } | null> = [
      { kind: 'location', value: `${profile.resolvedName}${profile.address ? ` — ${profile.address}` : ''}` },
      profile.website ? { kind: 'website', value: profile.website } : null,
      profile.hoursText ? { kind: 'note', value: `Hours: ${profile.hoursText}` } : null,
      profile.onlineOrdering?.available != null
        ? {
            kind: 'note',
            value: `Online ordering: ${profile.onlineOrdering.available ? 'yes' : 'no'}${
              profile.onlineOrdering.url ? ` (${profile.onlineOrdering.url})` : ''
            }`,
          }
        : null,
      { kind: 'website', value: profile.mapsUrl },
    ];
    for (const fact of facts) {
      if (!fact) continue;
      const factId = await deps.convexMutation<string>(deps.api.albatross.addAreaFact, {
        userId: input.userId,
        areaId: input.areaId,
        kind: fact.kind,
        value: fact.value,
        status: 'candidate',
        sourceRefs,
      });
      factIds.push(String(factId));
    }
  }

  return { profile, sourceUrls, factIds };
}
