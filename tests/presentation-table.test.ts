import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { checkDeck } from '../lib/documents/deck-quality';
import { exportDocument } from '../lib/documents/export';
import {
  briefTableSchema,
  composePresentationV2,
  presentationBriefV2Schema,
  restyleDeck,
} from '../lib/documents/presentation-design';
import { harborBrief } from './fixtures/presentation-briefs';
export function tableBrief() {
  const brief = harborBrief();
  brief.slides = [
    {
      role: 'table',
      title: 'Where delivery stands',
      kicker: 'Verified evidence',
      body: 'Two delivery states need different next steps.',
      items: [],
      notes: 'Synthetic regression evidence only.',
      visualRole: 'Exact state counts and next steps.',
      table: {
        headers: ['Delivery state', 'Packages', 'Next step'],
        rows: [
          ['Completed', '9632', 'Confirm receipt'],
          ['Blocked', '152', 'Resolve validation'],
        ],
        source: 'Source: supplied delivery report',
      },
    },
  ];
  return brief;
}
describe('editable presentation tables', () => {
  test('all data cells render with the established theme and clear the layout check', () => {
    const brief = presentationBriefV2Schema.parse(tableBrief());
    const model = composePresentationV2(brief);
    expect(checkDeck(model)).toEqual({ ok: true, issues: [] });
    const texts = model.slides[0].elements.flatMap((element) =>
      element.type === 'text' ? [element.text] : [],
    );
    for (const value of [...brief.slides[0].table!.headers, ...brief.slides[0].table!.rows.flat()])
      expect(texts).toContain(value);
    expect(texts).toContain('Source: supplied delivery report');
    const restyled = restyleDeck(model, { palette: 'signal', scope: 'theme-and-layout' });
    expect(
      restyled.slides[0].elements.filter((element) => element.type === 'text').map((element) => element.text),
    ).toEqual(texts);
    expect(checkDeck(restyled).ok).toBe(true);
  });
  test('mismatched rows are rejected, not silently dropped or shifted', () => {
    expect(briefTableSchema.safeParse({ headers: ['State', 'Count'], rows: [['Blocked']] }).success).toBe(
      false,
    );
  });
  test('table values export as editable PowerPoint text cells', async () => {
    const model = composePresentationV2(tableBrief());
    const file = await exportDocument({
      documentId: 'table',
      title: 'Delivery',
      kind: 'deck',
      currentRevision: 1,
      createdAt: 0,
      updatedAt: 0,
      sourceRefs: [],
      model,
    });
    const zip = await JSZip.loadAsync(file.bytes);
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('9632');
    expect(xml).toContain('Resolve validation');
  });
});
