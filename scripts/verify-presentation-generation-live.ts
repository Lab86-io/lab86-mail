import { readFileSync, writeFileSync } from 'node:fs';
import { generateDocumentProposal } from '../lib/documents/ai';
import { exportDocument } from '../lib/documents/export';

const records = JSON.parse(readFileSync('/tmp/chat-doc-google-connections.json', 'utf8'));
const userId = records.find((row: any) => row.status === 'connected')?.userId;
if (!userId) throw new Error('No test user available.');
const result = await generateDocumentProposal({
  userId,
  kind: 'deck',
  instruction:
    'Create exactly six designed slides for a synthetic release recap. Include a cover, overview metrics, implementation, build pipeline, delivery and takeaways. Use varied layouts and the ink palette.',
  sourceContext:
    "SYNTHETIC TEST DATA. Project: Flight Notes. September 10: 4 staging builds succeeded. Version 1.2. The work: shared progress logs, then a fix preserving interrupted durations. Test delivery: iOS beta released to 12 internal testers. Next step: collect tester feedback. These are invented fixture facts, not the real user's activity.",
});
if (result.model.kind !== 'deck' || result.model.slides.length !== 6)
  throw new Error('Expected six populated slides.');
writeFileSync('/tmp/chat-doc-generated-presentation.json', JSON.stringify(result));
const output = await exportDocument({
  documentId: 'synthetic',
  title: result.title,
  kind: 'deck',
  model: result.model,
  currentRevision: 1,
  sourceRefs: [],
  createdAt: 1,
  updatedAt: 1,
});
writeFileSync('/tmp/chat-doc-generated-presentation.pptx', output.bytes);
console.log(
  JSON.stringify({
    title: result.title,
    slides: result.model.slides.map((slide) => ({
      title: slide.title,
      background: slide.background,
      elements: slide.elements.length,
    })),
    output: '/tmp/chat-doc-generated-presentation.pptx',
  }),
);
