import { expect, test } from 'bun:test';
import { wordEditorTransport } from '../scripts/fixtures/word-editor-transport.mjs';

test('reset cancels a pending Word fixture edit before it can alter the next session', async () => {
  const transport = wordEditorTransport();
  const call = (path: string) =>
    transport(new Request(`http://localhost${path}`, { method: 'POST', body: '{}' }), {});
  await call('/fixture-word-edit');
  await call('/api/office/word-a/editing');
  await call('/fixture-reset');
  await new Promise((resolve) => setTimeout(resolve, 550));
  const response = await call('/fixture-word-state');
  expect(await response.json()).toMatchObject({
    currentRevision: 1,
    text: 'Original saved content',
    events: [],
  });
});
