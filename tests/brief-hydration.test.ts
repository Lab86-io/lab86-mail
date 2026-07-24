import { describe, expect, test } from 'bun:test';
import { collectBriefRefs } from '../lib/brief/hydration';
import type { BriefDocumentV2 } from '../lib/shared/brief-document';

describe('Brief handoff hydration', () => {
  test('collects actionable recommendation and evidence refs from merged handoffs', () => {
    const document: BriefDocumentV2 = {
      version: 2,
      title: 'Daily Brief',
      summary: 'A merged handoff.',
      generatedAt: Date.parse('2026-07-24T12:00:00Z'),
      regions: [
        {
          id: 'handoffs',
          summary: 'One merged handoff.',
          tree: {
            kind: 'entity_list',
            emphasis: 'standard',
            tone: 'neutral',
            variant: 'rows',
            items: [
              {
                ref: { kind: 'mcp', id: 'pull-86' },
                framing: {},
                handoff: {
                  handoffId: 'triage-1',
                  itemCount: 2,
                  situation: 'Ship the backbone.',
                  background: [],
                  assessment: 'The implementation and release belong together.',
                  recommendation: 'Finish the task.',
                  recommendations: [
                    {
                      label: 'Finish the task.',
                      ref: { kind: 'task', id: 'task-1', label: 'Finish SBAR' },
                    },
                    { label: 'Review the connected item.' },
                  ],
                  evidence: [
                    {
                      label: 'Related work',
                      ref: { kind: 'work', id: 'work-1', label: 'SBAR backbone' },
                    },
                    {
                      label: 'Same task is deduplicated',
                      ref: { kind: 'task', id: 'task-1', label: 'Finish SBAR' },
                    },
                  ],
                },
                actions: [],
              },
            ],
          },
        },
      ],
    };

    expect(collectBriefRefs(document)).toEqual([
      { kind: 'task', id: 'task-1', label: 'Finish SBAR' },
      { kind: 'work', id: 'work-1', label: 'SBAR backbone' },
    ]);
  });
});
