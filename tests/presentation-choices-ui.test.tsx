import { afterEach, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  PresentationChoicesPart,
  PresentationPicker,
  PresentationPreview,
} from '../components/ai-elements/presentation-choices';
import { type PresentationChoiceInput } from '../lib/documents/presentation-choices';
import { FONT_PAIR_NAMES, PALETTE_NAMES } from '../lib/documents/presentation-compositions';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer;
const originalRAF = globalThis.requestAnimationFrame;
afterEach(async () => {
  if (view) await act(async () => view.unmount());
  globalThis.requestAnimationFrame = originalRAF;
});
const text = (node: any): string =>
  typeof node === 'string' ? node : (node.children || []).map(text).join('');
const button = (label: string) =>
  view.root.findAllByType('button').find((node) => text(node).trim() === label)!;
const option = (label: string) =>
  view.root
    .findAllByType('button')
    .find((node) => node.props['aria-pressed'] !== undefined && text(node).includes(label))!;
const base: PresentationChoiceInput = {
  presentationId: 'd',
  stage: 'brief',
  title: 'A better future',
  summary: '',
};
async function mount(input = base) {
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  }) as typeof requestAnimationFrame;
  const result = mock((_output: Record<string, unknown>) => {});
  await act(async () => {
    view = create(<PresentationPicker input={input} onResult={result} />);
  });
  return result;
}
async function click(label: string) {
  await act(async () => button(label).props.onClick());
}
async function choose(label: string) {
  await act(async () => option(label).props.onClick());
}

test('brief pauses until audience, scope, pacing and detail are explicitly submitted', async () => {
  const result = await mount();
  await click('Next');
  expect(text(view.root)).toContain('Add an audience');
  expect(result).not.toHaveBeenCalled();
  await click('Leadership team');
  await act(async () =>
    view.root.findAllByType('textarea')[1].props.onChange({ target: { value: 'Make a decision' } }),
  );
  await click('Next');
  await choose('This conversation & attachments');
  await click('Next');
  expect(text(view.root)).toContain('Choose at least one source');
  await choose('Files');
  await act(async () =>
    view.root.findByType('textarea').props.onChange({ target: { value: 'Only this quarter' } }),
  );
  await click('Next');
  await act(async () => view.root.findAllByType('input')[0].props.onChange({ target: { value: '4' } }));
  await act(async () => view.root.findAllByType('input')[1].props.onChange({ target: { value: '2' } }));
  await choose('detailed');
  expect(text(view.root)).toContain('8 slides total');
  await click('Back');
  expect(view.root.findByType('textarea').props.value).toBe('Only this quarter');
  await click('Next');
  expect(result).not.toHaveBeenCalled();
  await click('Gather the content');
  expect(result.mock.calls[0][0]).toMatchObject({
    decision: 'continue',
    brief: {
      audience: 'Leadership team',
      purpose: 'Make a decision',
      sources: ['files'],
      sourceGuidance: 'Only this quarter',
      contentSlides: 4,
      sectionBreaks: 2,
      detail: 'detailed',
    },
  });
  await click('Choices saved');
  expect(result).toHaveBeenCalledTimes(1);
});

test('theme/font previews are real slides, choices remain editable until confirmation', async () => {
  const result = await mount({ ...base, stage: 'design' });
  expect(view.root.findAll((node) => node.props.className === 'presentation-choice-preview')).toHaveLength(8);
  await choose('lagoon');
  await click('Next');
  expect(view.root.findAll((node) => node.props.className === 'presentation-choice-preview')).toHaveLength(6);
  await choose('Space Grotesk');
  await click('Back');
  expect(option('lagoon').props['aria-pressed']).toBe(true);
  await click('Next');
  await click('Next');
  await choose('Credited paintings');
  await act(async () =>
    view.root.findByType('textarea').props.onChange({ target: { value: 'Large numbers and quiet accents' } }),
  );
  expect(result).not.toHaveBeenCalled();
  await click('Plan my slides');
  expect(result.mock.calls[0][0]).toMatchObject({
    design: {
      theme: 'lagoon',
      fontPair: 'grotesk',
      imagery: 'paintings',
      guidance: 'Large numbers and quiet accents',
    },
  });
});

test('storyboard shows real chart values, accepts another visual and can request revisions', async () => {
  const slides = [
    {
      id: 'a',
      kind: 'cover' as const,
      title: 'Start',
      takeaway: 'Introduction',
      recommended: 'typography' as const,
      alternatives: [],
      evidence: [],
    },
    {
      id: 'b',
      kind: 'content' as const,
      title: 'Adoption',
      takeaway: 'Evidence matters',
      recommended: 'bar' as const,
      alternatives: ['line', 'table'] as const,
      evidence: ['Source report'],
      chart: {
        type: 'bar' as const,
        categories: ['Jan', 'Feb'],
        series: [{ name: 'Users', values: [11, 42] }],
        source: 'Source report',
      },
    },
    {
      id: 'c',
      kind: 'close' as const,
      title: 'End',
      takeaway: 'Decide',
      recommended: 'typography' as const,
      alternatives: [],
      evidence: [],
    },
  ].map((slide) => ({ ...slide, alternatives: [...slide.alternatives] }));
  let result = await mount({ ...base, stage: 'storyboard', slides });
  await click('Next');
  expect(text(view.root)).toContain('42');
  expect(text(view.root)).toContain('Source report');
  await choose('Line chart');
  await click('Next');
  await click('Next');
  expect(text(view.root)).toContain('Line chart');
  await click('Build this presentation');
  expect(result.mock.calls[0][0]).toMatchObject({
    visuals: [
      { slideId: 'a', visual: 'typography' },
      { slideId: 'b', visual: 'line' },
      { slideId: 'c', visual: 'typography' },
    ],
  });
  await act(async () => view.unmount());
  result = await mount({ ...base, stage: 'storyboard', slides });
  await click('Request changes');
  expect(text(view.root)).toContain('Tell me what');
  await act(async () =>
    view.root
      .findByType('textarea')
      .props.onChange({ target: { value: 'Add a comparison against last year' } }),
  );
  await click('Request changes');
  expect(result.mock.calls[0][0]).toMatchObject({
    decision: 'revise',
    guidance: 'Add a comparison against last year',
  });
});

test('cancel and delegation are explicit actions, and submitted receipts survive remount', async () => {
  let result = await mount();
  await click('Cancel presentation');
  expect(result.mock.calls[0][0].decision).toBe('cancel');
  await act(async () => view.unmount());
  result = await mount();
  await click('Decide the rest for me');
  expect(result.mock.calls[0][0].delegateRemaining).toBe(true);
  const html = renderToStaticMarkup(
    <PresentationChoicesPart
      part={{
        input: { ...base, stage: 'design' },
        state: 'output-available',
        output: {
          presentationId: 'd',
          stage: 'design',
          decision: 'continue',
          design: { theme: 'rose', fontPair: 'literary', imagery: 'none', guidance: '' },
        },
      }}
      onResult={() => {
        throw new Error('Must not submit on reload');
      }}
    />,
  );
  expect(html).toContain('Your presentation choices');
  expect(html).toContain('Instrument Serif');
  expect(html).not.toContain('Plan my slides');
});

test('previews resolve every font and theme without app-color substitution', () => {
  for (const theme of PALETTE_NAMES)
    for (const fontPair of FONT_PAIR_NAMES) {
      const html = renderToStaticMarkup(
        <PresentationPreview title="A real title" theme={theme} fontPair={fontPair} />,
      );
      expect(html).toContain('A real title');
      expect(html).toContain('deck-slide');
      expect(html).toContain('--deck-display');
    }
});
