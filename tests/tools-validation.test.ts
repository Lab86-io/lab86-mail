import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { getTool, listToolMetadata } from '../lib/tools/index';
import { invokeTool, ToolValidationError } from '../lib/tools/registry';
import { harborBrief } from './fixtures/presentation-briefs';
import { toolContext, withToolContext } from './tools/harness';

const SAMPLE_INVALID_ARGS: Record<string, unknown> = {
  search_threads: { account: 'a@test', query: 'in:inbox', max: 999 },
  bulk_triage: { items: Array.from({ length: 41 }, (_, i) => ({ id: `t${i}` })) },
  remember: { email: 'a@test' },
  schedule_send: {
    account: 'a@test',
    to: 'b@test',
    body: 'Body',
    scheduledFor: Date.now() + 120_000,
  },
  browserbase_fetch: { url: 'not-a-url' },
  tasks_attach_link: { cardId: 'card_1', url: '', title: 'Docs' },
  create_smart_label: {
    name: 'X',
    description: 'Y',
    positiveExamples: [],
    negativeExamples: ['no'],
  },
  dismiss_daily_report_task: { cardId: '' },
  resolve_photos: { account: 'a@test', emails: Array.from({ length: 201 }, (_, i) => `u${i}@test`) },
};

describe('tool input validation', () => {
  test('oversized presentation copy reaches internal review while structural errors still reject', () => {
    const presentation = harborBrief();
    presentation.slides[0].body = 'x'.repeat(321);
    presentation.slides[1].title = 'x'.repeat(121);
    const input = getTool('document_create')!.input;
    expect(input.safeParse({ kind: 'deck', title: 'Review', presentation }).success).toBe(true);
    presentation.slides = Array.from({ length: 31 }, () => presentation.slides[0]);
    expect(input.safeParse({ kind: 'deck', title: 'Invalid', presentation }).success).toBe(false);
  });

  for (const [name, args] of Object.entries(SAMPLE_INVALID_ARGS)) {
    test(`${name} rejects invalid args`, async () => {
      const tool = getTool(name);
      expect(tool).toBeTruthy();
      await withToolContext(async () => {
        await expect(invokeTool(tool!, args, toolContext())).rejects.toBeInstanceOf(ToolValidationError);
      });
    });
  }
});

describe('tool metadata coverage', () => {
  test('every registered tool exposes input and output schemas', () => {
    for (const meta of listToolMetadata()) {
      const tool = getTool(meta.name);
      expect(tool?.input).toBeTruthy();
      expect(tool?.output).toBeTruthy();
      expect(typeof tool?.handler).toBe('function');
    }
  });
});
