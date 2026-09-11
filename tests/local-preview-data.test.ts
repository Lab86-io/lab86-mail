import { expect, test } from 'bun:test';
import { workspaceResponseSchema } from '../lib/narrative/workspace';
import { previewNarrative, previewReport, previewWorkspace } from '../scripts/fixtures/app-preview-data';

test('the fictional Today fixture satisfies the actual workspace response contract', () => {
  expect(workspaceResponseSchema.safeParse(previewWorkspace).success).toBe(true);
  expect(previewNarrative.entry.text).toContain('studio proposal');
  expect(previewReport.title).toContain('Fictional preview');
  expect(previewReport.document.timezone).toBe('America/New_York');
});

test('the brief demo links to a real fixture document and never simulates sending', async () => {
  const { previewBriefResponseEvents } = await import('../scripts/fixtures/preview-brief-response');
  const events = previewBriefResponseEvents();
  expect(events.at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' });
  const results = events
    .filter((event) => event.type === 'tool-output-available')
    .map((event) => event.output);
  expect(results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        documentId: 'preview-document-0',
        openPath: '/?view=files&document=preview-document-0',
      }),
    ]),
  );
  expect(
    events.some((event) => 'toolName' in event && /send_email|schedule_send/.test(event.toolName || '')),
  ).toBe(false);
});
