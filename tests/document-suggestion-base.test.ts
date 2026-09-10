import { expect, test } from 'bun:test';
import { documentSuggestionMatchesDraft } from '../lib/documents/autosave';
import { createDefaultDocumentModel } from '../lib/documents/model';

test('a proposal survives a byte-equivalent save/refetch but cannot overwrite newer typing', () => {
  const base = { title: 'Memo', model: createDefaultDocumentModel('doc', 'memo') };
  expect(documentSuggestionMatchesDraft(structuredClone(base), base)).toBe(true);
  expect(documentSuggestionMatchesDraft({ ...base, title: 'New title' }, base)).toBe(false);
  expect(documentSuggestionMatchesDraft({ ...base, model: null }, base)).toBe(false);
  const changed = structuredClone(base);
  if (changed.model.kind !== 'doc') throw new Error('Expected a document');
  changed.model.blocks[0].text = 'Newer typing';
  expect(documentSuggestionMatchesDraft(changed, base)).toBe(false);
});

test('formatting, order and slide notes count as newer edits, not just projected text', () => {
  const base = {
    title: 'Memo',
    model: {
      kind: 'doc' as const,
      version: 1 as const,
      blocks: [
        { id: 'a', type: 'paragraph' as const, text: 'First' },
        { id: 'b', type: 'paragraph' as const, text: 'Second' },
      ],
    },
  };
  expect(
    documentSuggestionMatchesDraft(
      { ...base, model: { ...base.model, blocks: [...base.model.blocks].reverse() } },
      base,
    ),
  ).toBe(false);
  expect(
    documentSuggestionMatchesDraft(
      {
        ...base,
        model: {
          ...base.model,
          blocks: [{ ...base.model.blocks[0], runs: [{ text: 'First', bold: true }] }, base.model.blocks[1]],
        },
      },
      base,
    ),
  ).toBe(false);
  const slides = { title: 'Deck', model: createDefaultDocumentModel('deck', 'deck') };
  const edited = structuredClone(slides);
  if (edited.model.kind !== 'deck') throw new Error('Expected slides');
  edited.model.slides[0].notes = 'Newer notes';
  expect(documentSuggestionMatchesDraft(edited, slides)).toBe(false);
});
