import { describe, expect, test } from 'bun:test';
import { InvalidContextAttachmentError, normalizeContextAttachments } from '../app/api/agent/route';

// The chat request names the Work of a thread and the document open in its
// document mode (docs/albatross-document-handoff.md, D5).

function refusal(value: unknown): string {
  try {
    normalizeContextAttachments(value);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidContextAttachmentError);
    return (error as Error).message;
  }
  throw new Error('expected an InvalidContextAttachmentError');
}

describe('normalizeContextAttachments', () => {
  test('no attachments is an empty list', () => {
    expect(normalizeContextAttachments(undefined)).toEqual([]);
    expect(normalizeContextAttachments([])).toEqual([]);
  });

  test('accepts a Work and an open document', () => {
    expect(
      normalizeContextAttachments([
        { kind: 'work', id: ' work-1 ' },
        { kind: 'document', id: ' doc_invoice ', provider: 'albatross' },
      ]),
    ).toEqual([
      { kind: 'work', id: 'work-1' },
      { kind: 'document', id: 'doc_invoice', provider: 'albatross' },
    ]);
    expect(
      normalizeContextAttachments([{ kind: 'document', id: 'word_invoice', provider: 'office' }]),
    ).toEqual([{ kind: 'document', id: 'word_invoice', provider: 'office' }]);
  });

  test('refuses a second document, even a different one', () => {
    expect(
      refusal([
        { kind: 'document', id: 'doc_invoice', provider: 'albatross' },
        { kind: 'document', id: 'word_invoice', provider: 'office' },
      ]),
    ).toBe('Duplicate context attachment.');
  });

  test('refuses a document with a bad provider or no id', () => {
    expect(refusal([{ kind: 'document', id: 'doc_invoice', provider: 'drive' }])).toBe(
      'Invalid document context attachment.',
    );
    expect(refusal([{ kind: 'document', id: 'doc_invoice' }])).toBe('Invalid document context attachment.');
    expect(refusal([{ kind: 'document', id: '  ', provider: 'albatross' }])).toBe(
      'Invalid document context attachment.',
    );
  });

  test('still refuses unknown kinds, a duplicate Work, bad entries, and more than three', () => {
    expect(refusal([{ kind: 'card', id: 'card-1' }])).toBe('Invalid Work context attachment.');
    expect(refusal([{ kind: 'work', id: 'w'.repeat(181) }])).toBe('Invalid Work context attachment.');
    expect(
      refusal([
        { kind: 'work', id: 'work-1' },
        { kind: 'work', id: 'work-1' },
      ]),
    ).toBe('Duplicate context attachment.');
    expect(refusal([null])).toBe('Invalid context attachment.');
    expect(refusal('work-1')).toBe('contextAttachments must be an array.');
    expect(
      refusal([
        { kind: 'work', id: 'work-1' },
        { kind: 'work', id: 'work-2' },
        { kind: 'work', id: 'work-3' },
        { kind: 'document', id: 'doc_invoice', provider: 'albatross' },
      ]),
    ).toBe('At most 3 context attachments are allowed.');
  });
});

// A request body replaces the transport body field by field (AI SDK), so every
// Work request in the chat builds its attachments in one place: the open
// document must reach the agent from the transport and from send() alike.
describe('the chat sends the open document with every Work request', () => {
  test('every contextAttachments in AIBar comes from workContextAttachments', async () => {
    const source = await Bun.file(new URL('../components/shell/AIBar.tsx', import.meta.url)).text();
    const fields = [...source.matchAll(/contextAttachments:\s*([^,\n]+)/g)].map((match) => match[1].trim());
    expect(fields.length).toBeGreaterThanOrEqual(2);
    // The transport and send() both: removing either one fails here.
    expect(fields.filter((field) => field === 'workContextAttachments()')).toHaveLength(2);
    for (const field of fields) expect(['workContextAttachments()', '[]']).toContain(field);
    expect(source).toContain('...(threadDocumentRef.current ? [threadDocumentRef.current] : [])');
  });

  test('a Work thread never sends the shared chat Brief context', async () => {
    const source = await Bun.file(new URL('../components/shell/AIBar.tsx', import.meta.url)).text();
    // One read of the store value, inside sharedBriefContext, which is null in a thread.
    expect(source.match(/getState\(\)\.assistantBriefContext/g)).toHaveLength(1);
    expect(source).toContain('inThreadRef.current ? null : useClientStore.getState().assistantBriefContext');
    expect(source).toContain('briefResponse: sharedBriefContext()?.reference');
  });
});
