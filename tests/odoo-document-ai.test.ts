import { afterEach, describe, expect, mock, test } from 'bun:test';
import { ZodError } from 'zod';
import {
  __setDocumentAiDepsForTest,
  DocumentGenerationError,
  generateDocumentProposal,
} from '../lib/documents/ai';
import { type AlbatrossDocumentRecord, createDefaultDocumentModel } from '../lib/documents/model';
import { type SheetWorkbookModel, workbookText } from '../lib/documents/sheet-workbook';

function currentWorkbook(): AlbatrossDocumentRecord & { model: SheetWorkbookModel } {
  return {
    documentId: 'forecast',
    title: 'Launch forecast',
    kind: 'sheet',
    currentRevision: 4,
    createdAt: 1,
    updatedAt: 2,
    sourceRefs: [],
    model: {
      kind: 'sheet',
      version: 2,
      engine: 'o-spreadsheet',
      engineVersion: '19.0.50',
      activeSheetId: 'forecast',
      workbook: {
        version: '19',
        styles: { '1': { bold: true } },
        sheets: [
          {
            id: 'forecast',
            name: 'Forecast',
            rowNumber: 100,
            colNumber: 26,
            cells: { B1: 'Projected', A1: 'Revenue', A2: '40', B2: '=A2*2' },
            merges: ['A3:B3'],
            styles: { A1: 1 },
            figures: [{ id: 'chart', data: { type: 'bar' } }],
          },
        ],
      },
    },
  };
}

const validOutput = {
  title: 'Add forecast totals',
  summary: 'Total the supplied revenue in a separate summary sheet.',
  changes: [
    { sheet: 'Forecast', cell: 'B3', content: '' },
    { sheet: 'Summary', cell: 'A1', content: '=SUM(Forecast!A2:B2)' },
  ],
  newSheets: ['Summary'],
};

afterEach(() => __setDocumentAiDepsForTest());

describe('engine-backed spreadsheet AI proposals', () => {
  test('proposes reviewable cell commands with grounded text, preserving the canonical workbook', async () => {
    const current = currentWorkbook();
    const original = structuredClone(current);
    const gateway = mock(async (_input: any) => ({ object: validOutput }));
    __setDocumentAiDepsForTest({ generateObjectForCurrentUser: gateway as any });

    const proposal = await generateDocumentProposal({
      userId: 'owner',
      userEmail: 'owner@example.test',
      userName: 'Owner',
      kind: 'sheet',
      current,
      instruction: '  Add a summary of the supplied forecast.  ',
      sourceContext: '  Meeting: use only the current forecast values.  ',
    });

    expect(gateway).toHaveBeenCalledTimes(1);
    const request = gateway.mock.calls[0][0];
    expect(request).toMatchObject({
      userId: 'owner',
      userEmail: 'owner@example.test',
      userName: 'Owner',
      feature: 'document_suggestion',
      speed: 'primary',
      maxOutputTokens: 14_000,
    });
    expect(request.prompt).toBe(
      'Current spreadsheet "Launch forecast":\nForecast\nA1: Revenue\nB1: Projected\nA2: 40\nB2: =A2*2\nGrounding material:\nMeeting: use only the current forecast values.\n\nUser instruction:\nAdd a summary of the supplied forecast.',
    );
    expect(request.system).toContain('Propose only cell-level changes');
    expect(request.system).toContain('Formulas start with "="');
    expect(request.system).toContain('Never invent data');
    expect(request.system).toContain('newSheets');
    expect(request.schema.parse(validOutput)).toEqual(validOutput);
    expect(proposal).toEqual({
      title: validOutput.title,
      summary: validOutput.summary,
      model: { kind: 'sheet-changes', version: 1, changes: validOutput.changes, newSheets: ['Summary'] },
    });
    expect(current).toEqual(original);
    expect(JSON.stringify(proposal.model)).not.toContain('workbook');
  });

  test('bounds current workbook text, grounding, and instruction independently', async () => {
    const current = currentWorkbook();
    current.model.workbook.sheets[0].cells = { A1: 'a'.repeat(90_000), A2: 'b'.repeat(90_000) };
    const gateway = mock(async (_input: any) => ({ object: validOutput }));
    __setDocumentAiDepsForTest({ generateObjectForCurrentUser: gateway as any });
    await generateDocumentProposal({
      userId: 'owner',
      kind: 'sheet',
      current,
      instruction: `  ${'i'.repeat(20_010)}  `,
      sourceContext: `  ${'s'.repeat(40_010)}  `,
    });
    expect(gateway.mock.calls[0][0].prompt).toBe(
      `Current spreadsheet "Launch forecast":\n${workbookText(current.model).slice(0, 120_000)}\nGrounding material:\n${'s'.repeat(40_000)}\n\nUser instruction:\n${'i'.repeat(20_000)}`,
    );
  });

  test.each([
    undefined,
    '',
    ' \n ',
  ])('omits absent grounding (%p) and accepts an existing-sheet-only edit', async (sourceContext) => {
    const { newSheets: _newSheets, ...output } = validOutput;
    const gateway = mock(async (_input: any) => ({ object: output }));
    __setDocumentAiDepsForTest({ generateObjectForCurrentUser: gateway as any });
    const result = await generateDocumentProposal({
      userId: 'owner',
      kind: 'sheet',
      current: currentWorkbook(),
      instruction: 'Calculate totals',
      sourceContext,
    });
    expect(gateway.mock.calls[0][0].prompt).not.toContain('Grounding material');
    expect(result.model).toEqual({
      kind: 'sheet-changes',
      version: 1,
      changes: output.changes,
      newSheets: undefined,
    });
  });

  test('rejects invalid changes, unbounded output, and full-workbook replacements with a typed cause', async () => {
    const invalidOutputs = [
      null,
      { ...validOutput, title: '' },
      { ...validOutput, summary: 's'.repeat(1_001) },
      { ...validOutput, changes: [] },
      { ...validOutput, changes: Array(501).fill(validOutput.changes[0]) },
      { ...validOutput, newSheets: Array(21).fill('Summary') },
      { title: 'Replacement', summary: 'Drop everything', model: currentWorkbook().model },
      ...['a1', 'A0', '$A$1', 'A1:B2', 'AAAA1'].map((cell) => ({
        ...validOutput,
        changes: [{ sheet: 'Forecast', cell, content: '10' }],
      })),
      { ...validOutput, changes: [{ sheet: '', cell: 'A1', content: '10' }] },
      { ...validOutput, changes: [{ sheet: 'Forecast', cell: 'A1', content: 'x'.repeat(10_001) }] },
    ];
    for (const object of invalidOutputs) {
      __setDocumentAiDepsForTest({ generateObjectForCurrentUser: (async () => ({ object })) as any });
      try {
        await generateDocumentProposal({
          userId: 'owner',
          kind: 'sheet',
          current: currentWorkbook(),
          instruction: 'Update forecast',
        });
        throw new Error('Expected invalid proposal rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(DocumentGenerationError);
        expect((error as Error).name).toBe('DocumentGenerationError');
        expect((error as Error).message).toBe('The spreadsheet model returned invalid cell changes.');
        expect((error as Error).cause).toBeInstanceOf(ZodError);
      }
    }
  });

  test('preserves gateway failure identity rather than presenting an invented or malformed proposal', async () => {
    const timeout = new Error('Model timed out');
    __setDocumentAiDepsForTest({
      generateObjectForCurrentUser: (async () => {
        throw timeout;
      }) as any,
    });
    await expect(
      generateDocumentProposal({
        userId: 'owner',
        kind: 'sheet',
        current: currentWorkbook(),
        instruction: 'Sum costs',
      }),
    ).rejects.toBe(timeout);
  });

  test('retains full-model generation for legacy sheets until the editor upgrades them', async () => {
    const current = { ...currentWorkbook(), model: createDefaultDocumentModel('sheet', 'legacy') };
    const output = { title: 'Legacy calculation', summary: 'Add totals', model: current.model };
    const gateway = mock(async (_input: any) => ({ object: output }));
    __setDocumentAiDepsForTest({ generateObjectForCurrentUser: gateway as any });
    expect(
      await generateDocumentProposal({ userId: 'owner', kind: 'sheet', current, instruction: 'Sum costs' }),
    ).toEqual(output);
    expect(gateway.mock.calls[0][0].system).toContain('Return the full model');
    expect(gateway.mock.calls[0][0].feature).toBe('document_suggestion');
    expect(gateway.mock.calls[0][0].prompt).toContain('"version":1');
  });
});
