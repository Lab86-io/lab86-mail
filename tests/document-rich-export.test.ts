import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { exportDocument } from '../lib/documents/export';
import type { AlbatrossDocumentModel, AlbatrossDocumentRecord } from '../lib/documents/model';

function record(model: AlbatrossDocumentModel): AlbatrossDocumentRecord {
  return {
    documentId: 'synthetic-export',
    kind: model.kind,
    title: 'Synthetic editing acceptance',
    model,
    currentRevision: 3,
    sourceRefs: [],
    createdAt: 1,
    updatedAt: 2,
  };
}

async function part(model: AlbatrossDocumentModel, path: string) {
  const file = await exportDocument(record(model));
  const archive = await JSZip.loadAsync(file.bytes);
  return archive.file(path)?.async('string');
}

describe('document and presentation editing exports', () => {
  test('DOCX preserves inline formatting, canonical text and explicit line breaks', async () => {
    const xml = await part(
      {
        kind: 'doc',
        version: 1,
        blocks: [
          {
            id: 'rich',
            type: 'paragraph',
            text: 'Strong italic under strike code\nnext & <line>',
            runs: [
              { text: 'Strong ', bold: true },
              { text: 'italic ', italic: true },
              { text: 'under ', underline: true },
              { text: 'strike ', strike: true },
              { text: 'code\nnext & <line>', code: true },
            ],
          },
        ],
      },
      'word/document.xml',
    );
    expect(xml).toContain('<w:b/>');
    expect(xml).toContain('<w:i/>');
    expect(xml).toContain('<w:u w:val="single"/>');
    expect(xml).toContain('<w:strike/>');
    expect(xml).toContain('Consolas');
    expect(xml).toContain('<w:br/>');
    expect(xml).toContain('next &amp; &lt;line&gt;');
  });

  test('DOCX exports heading and list styles without removing inline marks', async () => {
    const model: AlbatrossDocumentModel = {
      kind: 'doc',
      version: 1,
      blocks: [
        { id: 'h', type: 'heading', level: 1, text: 'Header', runs: [{ text: 'Header', italic: true }] },
        { id: 'b', type: 'bullet', text: 'Bullet', runs: [{ text: 'Bullet', bold: true }] },
        { id: 'n1', type: 'numbered', text: 'First' },
        { id: 'n2', type: 'numbered', text: 'Second' },
        { id: 'q', type: 'quote', text: 'Separate groups' },
        { id: 'n3', type: 'numbered', text: 'Restart' },
      ],
    };
    const xml = (await part(model, 'word/document.xml'))!;
    expect(xml).toContain('Heading1');
    expect(xml).toContain('<w:b/>');
    expect(xml).toContain('<w:i/>');
    const numbers = [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((match) => match[1]);
    expect(numbers).toHaveLength(4);
    expect(numbers[1]).toBe(numbers[2]);
    expect(numbers[3]).not.toBe(numbers[2]);
  });

  test('DOCX never substitutes stale rich runs for the authoritative plain text', async () => {
    const xml = await part(
      {
        kind: 'doc',
        version: 1,
        blocks: [
          {
            id: 'edited',
            type: 'paragraph',
            text: 'New native text',
            runs: [{ text: 'Old rich text', bold: true }],
          },
        ],
      },
      'word/document.xml',
    );
    expect(xml).toContain('New native text');
    expect(xml).not.toContain('Old rich text');
  });

  test('PPTX preserves edited slide order, shape geometry, color and speaker notes', async () => {
    const model: AlbatrossDocumentModel = {
      kind: 'deck',
      version: 1,
      activeSlideId: 'second',
      slides: [
        {
          id: 'second',
          title: 'Moved first',
          background: '#102030',
          notes: 'Private speaker cue',
          elements: [
            {
              id: 'shape',
              type: 'shape',
              x: 25,
              y: 20,
              width: 40,
              height: 30,
              fill: '#abcdef',
              color: '#123456',
            },
            {
              id: 'text',
              type: 'text',
              role: 'title',
              x: 8,
              y: 12,
              width: 84,
              height: 16,
              text: 'Edited title',
              fontSize: 32,
              color: '#fedcba',
            },
          ],
        },
        {
          id: 'first',
          title: 'Moved later',
          elements: [{ id: 'last', type: 'text', x: 10, y: 10, width: 80, height: 20, text: 'Later slide' }],
        },
      ],
    };
    const file = await exportDocument(record(model));
    const archive = await JSZip.loadAsync(file.bytes);
    const first = (await archive.file('ppt/slides/slide1.xml')?.async('string'))!;
    const second = (await archive.file('ppt/slides/slide2.xml')?.async('string'))!;
    const notes = (await archive.file('ppt/notesSlides/notesSlide1.xml')?.async('string'))!;
    expect(first).toContain('Edited title');
    expect(first).toContain('102030');
    expect(first).toContain('ABCDEF');
    expect(first).toContain('123456');
    expect(first).toContain('FEDCBA');
    expect(first).toContain('sz="3200"');
    expect(first).toContain('x="3047924"');
    expect(second).toContain('Later slide');
    expect(notes).toContain('Private speaker cue');
  });
});
