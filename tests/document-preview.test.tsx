import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentPreviewStack } from '../components/files/DocumentPreview';
import { resolveToolShape, SHAPE_LIST_LIMIT } from '../lib/ai/tool-shapes';
import { referenceDeck } from '../lib/documents/deck-fixtures';
import { documentPreviewPages, previewDocumentId } from '../lib/documents/preview';

describe('document content previews', () => {
  test('version 2 decks retain themes, owned images, and charts through the shared slide renderer', () => {
    const deck = referenceDeck('editorial');
    const imageSlide = deck.slides.find((slide) =>
      slide.elements.some((element) => element.type === 'image'),
    )!;
    const chartSlide = deck.slides.find((slide) =>
      slide.elements.some((element) => element.type === 'chart'),
    )!;
    const input = { ...deck, slides: [imageSlide, chartSlide] };
    const before = JSON.stringify(input);
    const pages = documentPreviewPages(input);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ kind: 'deck-v2', slide: imageSlide, theme: deck.theme });
    const markup = renderToStaticMarkup(<DocumentPreviewStack pages={pages} kind="deck" />);
    expect(markup).toContain('data-element-type="image"');
    expect(markup).toContain('data-element-type="chart"');
    expect(markup).toContain('--deck-bg:');
    expect(markup).not.toContain('<button');
    expect(JSON.stringify(input)).toBe(before);
    expect(documentPreviewPages({ ...input, theme: null })).toEqual([]);
  });

  test('uses real document blocks, bounds the preview, and escapes markup', () => {
    const pages = documentPreviewPages({
      kind: 'doc',
      blocks: Array.from({ length: 40 }, (_, index) => ({
        id: String(index),
        type: 'heading',
        text: '<script>real content</script>',
      })),
    });
    expect(pages).toHaveLength(3);
    const markup = renderToStaticMarkup(<DocumentPreviewStack pages={pages} kind="doc" />);
    expect(markup).toContain('&lt;script&gt;real content&lt;/script&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('data-preview-state="ready"');
  });

  test('preserves slide content and layout without accepting arbitrary style URLs', () => {
    const pages = documentPreviewPages({
      kind: 'deck',
      slides: [
        {
          id: 'slide',
          background: 'url(https://example.test)',
          elements: [
            {
              id: 'title',
              text: 'Real slide',
              x: -12,
              y: 18,
              width: 70,
              height: 30,
              color: '#fff',
              fill: 'url(https://example.test)',
              fontSize: 64,
            },
          ],
        },
      ],
    });
    expect(pages[0]).toMatchObject({
      background: undefined,
      elements: [{ text: 'Real slide', x: 0, y: 18, color: '#fff', fill: undefined }],
    });
  });

  test('reads both spreadsheet models and preserves zero and false', () => {
    for (const version of [1, 2]) {
      const sheets = [
        {
          id: 'sheet',
          name: 'Budget',
          cells:
            version === 1
              ? { A1: { value: 'Actual cost' }, B1: { value: 0 }, C1: { value: false } }
              : { A1: 'Actual cost', B1: '0', C1: 'FALSE' },
        },
      ];
      const pages = documentPreviewPages({ kind: 'sheet', version, sheets, workbook: { sheets } });
      const page = pages[0];
      if (page.kind !== 'sheet') throw new Error('Expected sheet');
      expect(page.rows[0].cells.map((cell) => cell.text)).toEqual([
        'Actual cost',
        '0',
        version === 1 ? 'false' : 'FALSE',
        '',
      ]);
    }
  });

  test('missing previews remain explicit rather than fabricated pages', () => {
    expect(documentPreviewPages(null)).toEqual([]);
    expect(documentPreviewPages({ kind: 'doc', blocks: [] })).toEqual([]);
    const markup = renderToStaticMarkup(<DocumentPreviewStack pages={[]} kind="deck" />);
    expect(markup).toContain('Preview unavailable');
    expect(markup).not.toContain('data-page=');
  });

  test('never reads Office or provider files through the Albatross document endpoint', () => {
    expect(previewDocumentId('/?view=files&document=one')).toBe('one');
    expect(previewDocumentId('/?view=files&office=word', 'word')).toBeUndefined();
    expect(previewDocumentId('/?view=files&provider=google', 'google')).toBeUndefined();
    expect(previewDocumentId('https://example.test/?document=one', 'one')).toBeUndefined();
  });

  test('document lists produce bounded file previews with the same open actions', () => {
    const shape = resolveToolShape(
      'document_list',
      {},
      {
        documents: Array.from({ length: 200 }, (_, index) => ({
          documentId: `doc-${index}`,
          title: 'Real file',
          kind: 'doc',
        })),
      },
    );
    if (shape?.kind !== 'files') throw new Error('Expected file list');
    expect(shape.items).toHaveLength(SHAPE_LIST_LIMIT);
    expect(shape.items[0]).toMatchObject({
      documentId: 'doc-0',
      actions: [{ kind: 'open_document', documentId: 'doc-0' }],
    });
  });
});
