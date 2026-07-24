import { describe, expect, test } from 'bun:test';
import { briefDocumentV2Enabled } from '../lib/brief/feature';
import { BRIEF_DOCUMENT_V2_SYSTEM_PROMPT } from '../lib/mail/brief-document-prompt';
import {
  BRIEF_DOCUMENT_LIMITS,
  BriefDocumentV2Schema,
  lintBriefDocument,
  parseBriefDocument,
} from '../lib/shared/brief-document';
import {
  degenerateBriefDocumentFixture,
  futureBriefDocumentFixture,
  quietBriefDocumentFixture,
  richBriefDocumentFixture,
} from '../lib/shared/brief-document-fixtures';

describe('Brief Document v2', () => {
  test('is opt-in and the generation prompt freezes the native vocabulary', () => {
    expect(briefDocumentV2Enabled({})).toBe(false);
    expect(briefDocumentV2Enabled({ BRIEF_DOCUMENT_V2: 'true' })).toBe(true);
    expect(briefDocumentV2Enabled({ BRIEF_DOCUMENT_V2: '1' })).toBe(true);
    expect(BRIEF_DOCUMENT_V2_SYSTEM_PROMPT).toContain('place_region');
    expect(BRIEF_DOCUMENT_V2_SYSTEM_PROMPT).toContain('finalize_brief');
    expect(BRIEF_DOCUMENT_V2_SYSTEM_PROMPT).toContain('area_open_work');
    expect(BRIEF_DOCUMENT_V2_SYSTEM_PROMPT).toContain('Immediate with undo');
    expect(BRIEF_DOCUMENT_V2_SYSTEM_PROMPT).toContain('Canvas is frozen ornament');
  });
  test('accepts the canonical rich and quiet documents', () => {
    expect(BriefDocumentV2Schema.parse(richBriefDocumentFixture)).toEqual(richBriefDocumentFixture);
    expect(BriefDocumentV2Schema.parse(quietBriefDocumentFixture)).toEqual(quietBriefDocumentFixture);
    expect(lintBriefDocument(richBriefDocumentFixture)).toEqual([]);
  });

  test('repairs unknown layouts, leaves, enums, actions, and queries without a blank region', () => {
    const repaired = parseBriefDocument(degenerateBriefDocumentFixture);
    const json = JSON.stringify(repaired);

    expect(repaired.regions).toHaveLength(1);
    expect(repaired.regions[0].tree.kind).toBe('stack');
    expect(json).toContain('A future leaf becomes a readable card.');
    expect(json).toContain('This query is not available yet.');
    expect(json).toContain('open_view');
    expect(json).not.toContain('future_action');
    expect(json).not.toContain('"neon"');
    expect(json).not.toContain('"tiles"');
  });

  test('degrades a future document version to title and summary', () => {
    const repaired = parseBriefDocument(futureBriefDocumentFixture);
    expect(repaired.version).toBe(2);
    expect(repaired.title).toBe(futureBriefDocumentFixture.title);
    expect(repaired.regions).toHaveLength(1);
    expect(JSON.stringify(repaired)).toContain(futureBriefDocumentFixture.summary);
  });

  test('clamps region count, depth, node count, hero count, canvas count, and long values', () => {
    const nested = (depth: number): any =>
      depth <= 0
        ? {
            kind: 'canvas',
            canvasId: `canvas-${Math.random()}`,
            title: 'Canvas',
            html: `<p>${'x'.repeat(BRIEF_DOCUMENT_LIMITS.canvasHtml + 50)}</p>`,
            fallbackText: 'Fallback',
            allowedActions: [],
            height: 'enormous',
          }
        : { kind: 'hero', surface: 'glass', children: [nested(depth - 1)] };
    const raw = {
      version: 2,
      title: 'x'.repeat(500),
      summary: 'summary',
      generatedAt: 1,
      regions: Array.from({ length: 20 }, (_, index) => ({
        id: `region-${index}`,
        summary: `Summary ${index}`,
        tree: nested(10),
      })),
    };
    const repaired = parseBriefDocument(raw);
    const json = JSON.stringify(repaired);

    expect(repaired.title.length).toBe(BRIEF_DOCUMENT_LIMITS.title);
    expect(repaired.regions.length).toBe(BRIEF_DOCUMENT_LIMITS.regions);
    expect((json.match(/"kind":"hero"/g) || []).length).toBeLessThanOrEqual(BRIEF_DOCUMENT_LIMITS.heroes);
    for (const region of repaired.regions) {
      expect(countNodes(region.tree)).toBeLessThanOrEqual(BRIEF_DOCUMENT_LIMITS.nodesPerRegion);
      expect(maxDepth(region.tree)).toBeLessThanOrEqual(BRIEF_DOCUMENT_LIMITS.depth);
    }
  });

  test('turns heterogeneous grids into adaptive stacks', () => {
    const raw = {
      ...quietBriefDocumentFixture,
      regions: [
        {
          id: 'mixed',
          summary: 'Mixed',
          tree: {
            kind: 'grid',
            columns: 3,
            children: [
              { kind: 'text', role: 'body', text: 'One' },
              { kind: 'stat', label: 'Two', value: 2 },
            ],
          },
        },
      ],
    };
    expect(parseBriefDocument(raw).regions[0].tree.kind).toBe('stack');
  });

  test('repairs bounded optional thread handoffs while old entity items remain valid', () => {
    const raw = {
      ...quietBriefDocumentFixture,
      regions: [
        {
          id: 'needs-you',
          summary: 'One reply needs attention.',
          tree: {
            kind: 'entity_list',
            items: [
              {
                ref: { kind: 'thread', id: 'thread-1', account: 'jakob@example.com' },
                framing: { lane: 'reply_owed' },
                handoff: {
                  handoffId: 'triage-thread-1',
                  itemCount: 2,
                  situation: 'Maya wrote about launch.',
                  background: ['One', 'Two', 'Three', 'Four'],
                  assessment: 'The date blocks planning.',
                  recommendation: 'Confirm the delivery date.',
                  recommendations: Array.from({ length: 6 }, (_, index) => ({
                    label: `Move ${index + 1}`,
                    ref: { kind: 'thread', id: `thread-${index + 1}`, account: 'jakob@example.com' },
                  })),
                  evidence: Array.from({ length: 7 }, (_, index) => ({
                    label: `Evidence ${index + 1}`,
                  })),
                },
                actions: [],
              },
              {
                ref: { kind: 'thread', id: 'legacy-thread', account: 'jakob@example.com' },
                framing: { reason: 'Legacy framing remains enough.' },
                actions: [],
              },
            ],
          },
        },
      ],
    };
    const repaired = parseBriefDocument(raw);
    const tree = repaired.regions[0].tree;
    expect(tree.kind).toBe('entity_list');
    if (tree.kind !== 'entity_list') throw new Error('Expected entity list');

    expect(tree.items[0].handoff?.background).toEqual(['One', 'Two', 'Three']);
    expect(tree.items[0].handoff?.handoffId).toBe('triage-thread-1');
    expect(tree.items[0].handoff?.itemCount).toBe(2);
    expect(tree.items[0].handoff?.recommendations).toHaveLength(4);
    expect(tree.items[0].handoff?.evidence).toHaveLength(4);
    expect(tree.items[1].handoff).toBeUndefined();
  });
});

function countNodes(node: any): number {
  return (
    1 +
    (Array.isArray(node.children)
      ? node.children.reduce((sum: number, child: any) => sum + countNodes(child), 0)
      : 0)
  );
}

function maxDepth(node: any): number {
  return (
    1 + (Array.isArray(node.children) && node.children.length ? Math.max(...node.children.map(maxDepth)) : 0)
  );
}
