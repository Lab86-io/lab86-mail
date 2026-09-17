import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import JSZip from 'jszip';
import { liftToolsForAgent } from '../lib/ai/loop';
import { agentToolTimeoutMs, withToolTimeout } from '../lib/ai/tool-timeout';
import {
  __setDocumentAiDepsForTest,
  composeDocumentPresentation,
  generateDocumentProposal,
} from '../lib/documents/ai';
import { checkDeck } from '../lib/documents/deck-quality';
import { exportDocument } from '../lib/documents/export';
import { type AlbatrossDocumentRecord, documentModelText } from '../lib/documents/model';
import { presentationSessionFromMessages } from '../lib/documents/presentation-choices';
import { presentationBriefV2Schema } from '../lib/documents/presentation-design';
import { __setDocumentToolDepsForTest, documentCreate, documentGet } from '../lib/tools/documents';
import { harborBrief, passingSlideReviews, retroBrief, VALLEY } from './fixtures/presentation-briefs';
import { runTool } from './tools/harness';

const presentation = {
  title: 'PubMed modernization',
  summary: 'A report grounded in meeting notes and email.',
  palette: 'ink' as const,
  slides: [
    {
      layout: 'cover' as const,
      title: 'From publisher to editorial workspace',
      kicker: 'PubMed',
      body: 'A browser-based publishing workflow.',
      items: [],
      notes: 'Source: supplied project report.',
    },
    {
      layout: 'metrics' as const,
      title: 'Corpus validation',
      kicker: 'Evidence',
      body: 'The completed run still had publication blockers.',
      items: [
        { label: '9,632 editions', detail: 'Completed processing' },
        { label: '152 blocked', detail: 'Not a complete delivery package' },
      ],
      notes:
        'Sources: Granola meeting g-1; email thread mail-1. FTP delivery does not prove NCBI acceptance.',
    },
  ],
};

afterEach(() => {
  jest.useRealTimers();
  __setDocumentToolDepsForTest();
  __setDocumentAiDepsForTest();
});

describe('presentation creation dogfood', () => {
  test('a confirmed nine-slide storyboard creates and reads back despite old counts, omitted breaks and blank item labels', async () => {
    const kinds = [
      'cover',
      'content',
      'content',
      'divider',
      'content',
      'content',
      'divider',
      'content',
      'close',
    ];
    const slides = kinds.map((kind, index) => ({
      id: `s${index}`,
      kind,
      title: `Approved chapter ${index + 1}`,
      takeaway: 'A carefully sourced historical account.',
      recommended: kind === 'content' ? 'process' : 'typography',
      alternatives: [],
      evidence: ['Supplied archive excerpt'],
    }));
    const part = (stage: string, output: object, extra: object = {}) => ({
      type: 'tool-ask_presentation_choices',
      toolCallId: stage,
      state: 'output-available',
      input: { presentationId: 'history', stage, title: 'History deck', ...extra },
      output: { presentationId: 'history', stage, decision: 'continue', ...output },
    });
    const session = presentationSessionFromMessages([
      {
        role: 'assistant',
        parts: [
          part('brief', {
            brief: {
              audience: 'Students',
              purpose: 'Understand the history',
              sources: ['provided'],
              sourceGuidance: '',
              contentSlides: 7,
              sectionBreaks: 2,
              detail: 'balanced',
            },
          }),
          part('design', { design: { theme: 'rose', fontPair: 'literary', imagery: 'none', guidance: '' } }),
          part(
            'storyboard',
            { visuals: slides.map((slide) => ({ slideId: slide.id, visual: slide.recommended })) },
            { slides },
          ),
        ],
      },
    ]);
    __setDocumentAiDepsForTest({
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: (async (options: any) => passingSlideReviews(options)) as any,
    });
    let saved: AlbatrossDocumentRecord;
    const save = mock(async (input: any) => {
      saved = {
        ...input,
        documentId: 'recovered-history',
        currentRevision: 1,
        createdAt: 1,
        updatedAt: 1,
        sourceRefs: input.sourceRefs || [],
      };
      return saved;
    });
    __setDocumentToolDepsForTest({
      createDocument: save,
      getDocument: async () => ({ ...saved, suggestions: [] }),
      recordOperation: async () => 'operation',
    });
    const base = harborBrief();
    const draft = {
      ...base,
      audience: '',
      slides: slides
        .filter((slide) => slide.kind === 'content')
        .map((slide) => ({
          ...base.slides[0],
          title: slide.title,
          role: 'process' as const,
          body: slide.takeaway,
          items: [
            { label: '', detail: 'Read the original archive account.' },
            { label: 'Context', detail: 'Distinguish evidence from later interpretation.' },
            { label: '', detail: '' },
          ],
          notes: 'Source: supplied archive excerpt.',
        })),
    };
    const created = await runTool(
      () =>
        liftToolsForAgent(undefined, 'UTC', session).document_create.execute({
          kind: 'deck',
          title: 'History deck',
          presentation: draft,
          artwork: 'none',
        }),
      {},
    );
    expect(created).toMatchObject({ ok: true, documentId: 'recovered-history' });
    expect(save).toHaveBeenCalledTimes(1);
    const read = await runTool(documentGet.handler, { documentId: created.documentId });
    const model = read.document.model;
    if (model.kind !== 'deck' || model.version !== 2) throw new Error('Expected version 2 deck');
    expect(model.slides).toHaveLength(9);
    expect(model.slides.map((slide) => slide.title)).toEqual(slides.map((slide) => slide.title));
    expect(checkDeck(model).ok).toBe(true);
    expect(documentModelText(model)).toContain('Read the original archive account.');
    expect(model.slides[1].notes).toContain('"label":""');
    expect(model.theme.fonts.display.family).toContain('Instrument');
  });
  test('a thirteen-slide brief with four-item lists and a chart without callouts saves all slides', async () => {
    __setDocumentAiDepsForTest({
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: (async (options: any) => passingSlideReviews(options)) as any,
    });
    const brief = harborBrief();
    const list = {
      role: 'list' as const,
      title: 'Publishing workflow',
      kicker: 'Delivery',
      body: 'The publishing workflow records approvals, validates the source, assembles the package, and checks receipts before completing delivery. Editors can review the supporting evidence and correct individual sections while the delivery history records each completed transfer.',
      items: Array.from({ length: 4 }, (_, index) => ({
        label: `Stage ${index + 1}`,
        detail: 'The recorded evidence confirms this stage completed.',
      })),
      notes: 'Source: synthetic test report.',
      visualRole: 'Workflow stages',
    };
    const raw = {
      ...brief,
      slides: Array.from({ length: 13 }, (_, index) => ({ ...list, title: `Workflow ${index + 1}` })),
    };
    const chart: any = {
      ...list,
      role: 'chart',
      chart: {
        type: 'column',
        categories: ['Completed', 'Blocked'],
        series: [{ name: 'Packages', values: [20, 2] }],
      },
    };
    delete chart.items;
    raw.slides[10] = chart;
    const parsed = presentationBriefV2Schema.parse(raw);
    expect(parsed.slides[10].items).toEqual([]);
    const proposal = await composeDocumentPresentation({
      userId: 'owner',
      instruction: 'Make 13 slides',
      presentation: parsed,
      artwork: 'none',
    });
    if (proposal.model.kind !== 'deck' || proposal.model.version !== 2) throw new Error('Wrong model');
    expect(proposal.model.slides).toHaveLength(13);
    expect(checkDeck(proposal.model).ok).toBe(true);
    for (const slide of proposal.model.slides) {
      expect(slide.elements.some((element) => element.type === 'text' && element.text === slide.title)).toBe(
        true,
      );
      if (slide.id !== 'slide-11') {
        for (const item of list.items)
          expect(
            slide.elements.some((element) => element.type === 'text' && element.text === item.label),
          ).toBe(true);
      }
    }
    const exported = await exportDocument({
      documentId: 'complete',
      title: 'Complete',
      kind: 'deck',
      model: proposal.model,
      currentRevision: 1,
      sourceRefs: [],
      createdAt: 1,
      updatedAt: 1,
    });
    const zip = await JSZip.loadAsync(exported.bytes);
    for (let number = 1; number <= 13; number += 1) {
      expect(await zip.file(`ppt/slides/slide${number}.xml`)!.async('string')).toContain(
        number === 11 ? 'Publishing workflow' : `Workflow ${number}`,
      );
    }
  });

  test('version 2 direct creation reviews all slides while keeping owned images and design checks', async () => {
    const generate = mock(async (options: any) => passingSlideReviews(options)) as any;
    const artwork = mock(async () => {
      throw new Error('must not fetch artwork');
    });
    const create = mock(async (input: any) => ({ ...input, documentId: 'v2-deck', currentRevision: 1 }));
    __setDocumentAiDepsForTest({
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: generate,
      resolveDeckImagery: artwork,
    });
    __setDocumentToolDepsForTest({
      assetsFromUploads: async () => ({ assets: [VALLEY], notes: [] }),
      createDocument: create as any,
      recordOperation: async () => 'operation',
    });
    const args = documentCreate.input.parse({
      kind: 'deck',
      title: 'Harbor',
      presentation: harborBrief(),
      imageUploadIds: ['upload'],
      artwork: 'none',
    });
    await runTool(documentCreate.handler, args);
    const model = create.mock.calls[0][0].model;
    expect(model.version).toBe(2);
    expect(checkDeck(model).ok).toBe(true);
    expect(
      model.slides[2].elements.some(
        (element: any) => element.type === 'image' && element.assetId === VALLEY.assetId,
      ),
    ).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(artwork).not.toHaveBeenCalled();
  });

  test('direct version 2 content repairs overflow even when editorial service is unavailable', async () => {
    const generate = mock(async () => {
      throw new Error('must not generate');
    });
    __setDocumentAiDepsForTest({
      isDeckV2AuthoringEnabled: () => true,
      generateObjectForCurrentUser: generate,
    });
    const brief = retroBrief();
    brief.slides[2].items[0].detail = 'from the launch brief '.repeat(7).trim();
    const proposal = await composeDocumentPresentation({
      userId: 'owner',
      instruction: '',
      presentation: brief,
      artwork: 'none',
    });
    expect(checkDeck(proposal.model as any).ok).toBe(true);
    expect((proposal.model as any).slides[2].notes).toContain(brief.slides[2].items[0].detail);
    expect(generate).toHaveBeenCalled();
  });

  test('direct version 2 content respects the authoring rollout flag', async () => {
    __setDocumentAiDepsForTest({ isDeckV2AuthoringEnabled: () => false });
    await expect(
      composeDocumentPresentation({
        userId: 'owner',
        instruction: '',
        presentation: harborBrief(),
        artwork: 'none',
      }),
    ).rejects.toThrow('authoring is disabled');
  });

  test('cancelled version 2 generation stops before artwork or copy repair', async () => {
    const controller = new AbortController();
    const artwork = mock(async () => {
      throw new Error('must not fetch artwork');
    });
    __setDocumentAiDepsForTest({
      isDeckV2AuthoringEnabled: () => true,
      resolveDeckImagery: artwork,
      generateObjectForCurrentUser: (async (input: any) => {
        expect(input.abortSignal).toBe(controller.signal);
        controller.abort(new Error('Cancelled generation'));
        return { object: harborBrief() };
      }) as any,
    });
    await expect(
      generateDocumentProposal({
        userId: 'owner',
        kind: 'deck',
        instruction: 'Harbor deck',
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow('Cancelled generation');
    expect(artwork).not.toHaveBeenCalled();
  });

  test('researched slide content saves, reads and exports without a second model call', async () => {
    let saved: AlbatrossDocumentRecord;
    const generate = mock(async () => {
      throw new Error('must not generate');
    });
    __setDocumentToolDepsForTest({
      generateDocumentProposal: generate,
      createDocument: async (input) => {
        saved = {
          ...input,
          model: input.model as AlbatrossDocumentRecord['model'],
          documentId: 'pubmed-deck',
          title: input.title!,
          sourceRefs: input.sourceRefs || [],
          currentRevision: 1,
          createdAt: 1,
          updatedAt: 1,
        };
        return saved;
      },
      getDocument: async () => ({ ...saved, suggestions: [] }),
      recordOperation: async () => 'operation',
    });
    const args = documentCreate.input.parse({
      kind: 'deck',
      title: presentation.title,
      instructions: 'Make two slides',
      presentation,
      sourceRefs: [
        { kind: 'granola', id: 'g-1' },
        { kind: 'mail', id: 'mail-1' },
      ],
    });
    const created = await runTool(documentCreate.handler, args);
    expect(created).toMatchObject({
      ok: true,
      title: presentation.title,
      documentId: 'pubmed-deck',
      revision: 1,
    });
    expect(generate).not.toHaveBeenCalled();
    const read = await runTool(documentGet.handler, { documentId: created.documentId });
    expect(read.document.sourceRefs).toEqual(args.sourceRefs);
    expect(read.document.model.kind === 'deck' && read.document.model.slides).toHaveLength(2);
    expect(documentModelText(read.document.model)).toContain('152 blocked');
    const exported = await exportDocument(read.document);
    const zip = await JSZip.loadAsync(exported.bytes);
    expect(await zip.file('ppt/slides/slide2.xml')!.async('string')).toContain('152 blocked');
    expect(await zip.file('ppt/notesSlides/notesSlide2.xml')!.async('string')).toContain(
      'email thread mail-1',
    );
  });

  test('direct content rejects the wrong kind or an incomplete requested slide count', () => {
    expect(documentCreate.input.safeParse({ kind: 'doc', title: 'Wrong kind', presentation }).success).toBe(
      false,
    );
    expect(
      documentCreate.input.safeParse({
        kind: 'deck',
        title: 'Incomplete',
        instructions: 'Make six slides',
        presentation,
      }).success,
    ).toBe(false);
    expect(
      documentCreate.input.safeParse({
        kind: 'deck',
        title: 'Valid',
        instructions: 'Make 2-4 slides',
        presentation,
      }).success,
    ).toBe(true);
  });

  test('generation and reviewed briefs get a longer deadline while reads stay bounded', () => {
    expect(agentToolTimeoutMs('document_create', { instructions: 'Create a deck' })).toBe(210_000);
    expect(agentToolTimeoutMs('document_create', { instructions: 'Create a deck', presentation })).toBe(
      210_000,
    );
    expect(agentToolTimeoutMs('document_create')).toBe(75_000);
    expect(agentToolTimeoutMs('document_get')).toBe(75_000);
    expect(agentToolTimeoutMs('document_apply_instruction')).toBe(210_000);
  });

  test('a generation taking 90 seconds can finish and clears its deadline', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = withToolTimeout(
      (inputSignal) => {
        signal = inputSignal;
        return new Promise<string>((resolve) => setTimeout(() => resolve('saved'), 90_000));
      },
      'document_create',
      { timeoutMs: agentToolTimeoutMs('document_create', { instructions: 'Create a deck' }) },
    );
    jest.advanceTimersByTime(90_000);
    expect(await pending).toBe('saved');
    expect(signal?.aborted).toBe(false);
    jest.advanceTimersByTime(210_000);
    expect(signal?.aborted).toBe(false);
  });

  test('timeout cancels generation and late provider results cannot create an orphan file', async () => {
    let finish!: (value: any) => void;
    let providerSignal: AbortSignal | undefined;
    const create = mock(async () => {
      throw new Error('must not save');
    });
    __setDocumentAiDepsForTest({
      generateObjectForCurrentUser: async (input) => {
        providerSignal = input.abortSignal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    __setDocumentToolDepsForTest({ generateDocumentProposal, createDocument: create });
    const pending = withToolTimeout(
      (abortSignal) =>
        runTool(
          documentCreate.handler,
          {
            kind: 'deck',
            title: 'PubMed',
            instructions: 'Create two slides',
            publishToGoogle: false,
          },
          { abortSignal },
        ),
      'document_create',
      { timeoutMs: 5 },
    );
    await expect(pending).rejects.toThrow('timed out');
    expect(providerSignal?.aborted).toBe(true);
    finish({ object: presentation });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(create).not.toHaveBeenCalled();
  });

  test('the lifted chat tool forwards disconnect cancellation to document generation', async () => {
    let started!: () => void;
    const generating = new Promise<void>((resolve) => {
      started = resolve;
    });
    let providerSignal: AbortSignal | undefined;
    const create = mock(async () => {
      throw new Error('must not save');
    });
    __setDocumentToolDepsForTest({
      createDocument: create,
      generateDocumentProposal: async (input) => {
        providerSignal = input.abortSignal;
        started();
        return new Promise((_resolve, reject) =>
          input.abortSignal!.addEventListener('abort', () => reject(input.abortSignal!.reason), {
            once: true,
          }),
        );
      },
    });
    const controller = new AbortController();
    const pending = runTool(
      async () =>
        liftToolsForAgent().document_create.execute(
          { kind: 'deck', title: 'PubMed', instructions: 'Create two slides' },
          { abortSignal: controller.signal },
        ),
      {},
    );
    await generating;
    controller.abort(new Error('Disconnected'));
    await expect(pending).rejects.toThrow('Disconnected');
    expect(providerSignal?.aborted).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  test('already cancelled work does not start', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Cancelled'));
    const run = mock(async () => 'unexpected');
    await expect(withToolTimeout(run, 'document_create', { signal: controller.signal })).rejects.toThrow(
      'Cancelled',
    );
    expect(run).not.toHaveBeenCalled();
  });
});
