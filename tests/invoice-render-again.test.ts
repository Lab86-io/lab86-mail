import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import type { OfficeFile } from '../lib/documents/office-service';
import { parseStrictXml } from '../lib/documents/office-verify';
import {
  applyInvoiceBlanks,
  invoiceDataSchema,
  parseInvoiceNumber,
} from '../lib/documents/templates/invoice';
import { readWordPackage } from '../lib/documents/word-package';
import { createWordService } from '../lib/documents/word-service';

// A real invoice through the real renderer, with an in-memory file row. Invented data only.
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function harness(overrides: Record<string, unknown> = {}) {
  let bytes: Uint8Array = new Uint8Array();
  let file: OfficeFile | null = null;
  const saves: any[] = [];
  const stored: Uint8Array[] = [];
  const service = createWordService({
    requireOffice: () => ({
      server: 'https://o.test',
      app: 'https://a.test',
      secret: 's',
      provider: 'collabora',
    }),
    getOfficeFile: async () => file,
    fetch: async () => new Response(new Uint8Array(bytes)),
    storeOfficeBytes: async (_owner: string, next: Uint8Array) => {
      stored.push(next);
      bytes = next;
      return 'storage';
    },
    createOfficeFile: async (input: any) => {
      saves.push(input);
      file = {
        documentId: 'invoice-1',
        title: input.title,
        extension: 'docx',
        currentRevision: 1,
        createdAt: 1,
        updatedAt: 1,
        versions: [],
        version: { revision: 1, url: 'https://s.test/1', size: input.size, sha256: input.sha256 },
        ...(input.template ? { template: input.template } : {}),
      };
      return file;
    },
    convexMutation: async (_api: unknown, input: any) => {
      saves.push(input);
      const revision = file!.currentRevision + 1;
      file = {
        ...file!,
        currentRevision: revision,
        version: { revision, url: 'https://s.test/n', size: input.size, sha256: input.sha256 },
        ...(input.template ? { template: input.template } : {}),
      };
      return { ok: true, revision };
    },
    ...overrides,
  } as any);
  return {
    service,
    saves,
    stored,
    file: () => file!,
    bytes: () => bytes,
    setFile: (next: OfficeFile) => {
      file = next;
    },
    setBytes: (next: Uint8Array) => {
      bytes = next;
    },
    text: async () => (await readWordPackage(bytes)).paragraphs.map((entry) => entry.text).join(' | '),
  };
}

const invoice = {
  from: { name: 'Mara Ellison' },
  billTo: { name: 'Harbor Design' },
  number: 'INV-7',
  issued: '2026-10-15',
  payment: 'Net 30',
  items: [
    { title: 'July', summary: 'Design review.', hours: 10 },
    { title: 'August', summary: 'Site visit.', hours: 2, rate: 100 },
  ],
};

async function created(overrides: Record<string, unknown> = {}) {
  const h = harness(overrides);
  const result = await h.service.create('owner', { title: 'Invoice 7', template: 'invoice', data: invoice });
  return { h, result };
}

describe('an invoice renders again from its data', () => {
  test('the first render stores the data and the hash of the file', async () => {
    const { h, result } = await created();
    expect(result.blanks).toEqual(['Total due', 'Rate: July', 'Amount: July']);
    const row = h.file().template!;
    expect(row.kind).toBe('invoice');
    expect(row.renderedSha256).toBe(sha(h.bytes()));
    expect(JSON.parse(row.dataJson).items[1].rate).toBe(100);
  });

  test('a filled rate computes the amount and the total, and those blanks go away', async () => {
    const { h } = await created();
    const edited = await h.service.edit('owner', 'invoice-1', 1, [
      { op: 'fill_blank', blank: 'Rate: July', value: '$90.00' },
    ]);
    expect(edited).toMatchObject({ ok: true, revision: 2, blanks: [] });
    const text = await h.text();
    expect(text).toContain('$900.00');
    // 10 x 90 + 2 x 100.
    expect(text).toContain('$1,100.00');
    expect(text).toContain('Total hours');
    expect(JSON.parse(h.file().template!.dataJson).items[0].rate).toBe(90);
    expect(h.file().template!.renderedSha256).toBe(sha(h.bytes()));
    const zip = await JSZip.loadAsync(h.bytes());
    expect(parseStrictXml(await zip.file('word/document.xml')!.async('string'))).toEqual({
      root: 'document',
    });
  });

  test('a corrected value renders again, though the blank has gone', async () => {
    const { h } = await created();
    await h.service.edit('owner', 'invoice-1', 1, [{ op: 'fill_blank', blank: 'Rate: July', value: '90' }]);
    await h.service.edit('owner', 'invoice-1', 2, [{ op: 'fill_blank', blank: 'Rate: July', value: '120' }]);
    const text = await h.text();
    expect(text).toContain('$1,200.00');
    expect(text).toContain('$1,400.00');
    expect(text).not.toContain('$1,100.00');
  });

  test('an empty value shows the blanks again', async () => {
    const { h } = await created();
    await h.service.edit('owner', 'invoice-1', 1, [{ op: 'fill_blank', blank: 'Rate: July', value: '90' }]);
    const cleared = await h.service.edit('owner', 'invoice-1', 2, [
      { op: 'fill_blank', blank: 'Rate: July', value: '' },
    ]);
    expect(cleared.blanks).toEqual(['Total due', 'Rate: July', 'Amount: July']);
  });

  test('a total is never a value to fill, and a rate must be a number', async () => {
    const { h } = await created();
    await expect(
      h.service.edit('owner', 'invoice-1', 1, [{ op: 'fill_blank', blank: 'Total due', value: '5000' }]),
    ).rejects.toThrow('The server computes "Total due"');
    await expect(
      h.service.edit('owner', 'invoice-1', 1, [{ op: 'fill_blank', blank: 'Rate: July', value: 'about 90' }]),
    ).rejects.toThrow('"Rate: July" takes a number');
    await expect(
      h.service.edit('owner', 'invoice-1', 1, [{ op: 'fill_blank', blank: 'Nickname', value: 'x' }]),
    ).rejects.toThrow('No field of this invoice is named "Nickname"');
    expect(h.file().currentRevision).toBe(1);
  });

  test('fill_blank goes by itself, because a render replaces the whole file', async () => {
    const { h } = await created();
    await expect(
      h.service.edit('owner', 'invoice-1', 1, [
        { op: 'fill_blank', blank: 'Rate: July', value: '90' },
        { op: 'insert_paragraph', text: 'Thanks.' },
      ]),
    ).rejects.toThrow('Send fill_blank edits by themselves');
  });

  test('an edit in the word processor stops the render, so the edit survives, and the result says so', async () => {
    const { h } = await created();
    // Another save: the same row, a new hash. The stored data no longer matches the file.
    h.setFile({ ...h.file(), version: { ...h.file().version!, sha256: 'saved-by-the-editor' } });
    const edited = await h.service.edit('owner', 'invoice-1', 1, [
      { op: 'fill_blank', blank: 'Rate: July', value: '90' },
    ]);
    expect(edited.notes?.[0]).toContain('did not update');
    const text = await h.text();
    expect(text).toContain('90');
    expect(text).not.toContain('$900.00');
  });

  test('another template and a file with no stored data fill in place, with no note', async () => {
    const h = harness();
    await h.service.create('owner', {
      title: 'Memo',
      template: 'memo',
      data: { to: 'Team', from: 'Mara Ellison', subject: 'Note', body: ['Hello.'] },
    });
    expect(h.file().template).toBeUndefined();
    const edited = await h.service.edit('owner', 'invoice-1', 1, [
      { op: 'fill_blank', blank: 'Date', value: 'October 15, 2026' },
    ]);
    expect(edited.notes).toBeUndefined();
    expect(edited.blanks).toEqual([]);
  });

  test('create with edits keeps no data, because a render would lose the edits', async () => {
    const h = harness();
    await h.service.create('owner', {
      title: 'Invoice',
      template: 'invoice',
      data: invoice,
      edits: [{ op: 'insert_paragraph', text: 'Extra' }],
    });
    expect(h.file().template).toBeUndefined();
  });
});

describe('invoice blank fields', () => {
  const data = invoiceDataSchema.parse({
    from: {},
    billTo: {},
    items: [{ title: 'Visit', quantity: 2 }],
    adjustments: [{ label: 'Sales tax' }],
  });

  test('each blank maps to its field and leaves the source alone', () => {
    const next = applyInvoiceBlanks(data, [
      { blank: 'Your name', value: 'Mara Ellison' },
      { blank: 'client name', value: 'Harbor Design' },
      { blank: 'Invoice number', value: 'INV-9' },
      { blank: 'Invoice date', value: '2026-10-15' },
      { blank: 'Payment details', value: 'Net 30' },
      { blank: 'Summary: Visit', value: 'Two visits.' },
      { blank: 'Qty: Visit', value: '3' },
      { blank: 'Rate: Visit', value: '1,500.50' },
      { blank: 'Amount: Sales tax', value: '-12.5' },
    ]);
    expect(next.from.name).toBe('Mara Ellison');
    expect(next.billTo.name).toBe('Harbor Design');
    expect(next).toMatchObject({ number: 'INV-9', issued: '2026-10-15', payment: 'Net 30' });
    expect(next.items[0]).toMatchObject({ summary: 'Two visits.', quantity: 3, rate: 1500.5 });
    expect(next.adjustments?.[0].amount).toBe(-12.5);
    expect(data.from.name).toBeUndefined();
  });

  test('a number reads as a person writes it, and other text is null', () => {
    expect(parseInvoiceNumber('$1,500.00')).toBe(1500);
    expect(parseInvoiceNumber('12.5')).toBe(12.5);
    expect(parseInvoiceNumber('150 USD')).toBe(150);
    expect(parseInvoiceNumber('-$5')).toBe(-5);
    expect(parseInvoiceNumber('€90')).toBe(90);
    expect(parseInvoiceNumber('1.5k')).toBeNull();
    expect(parseInvoiceNumber('12 hours')).toBeNull();
    expect(parseInvoiceNumber('soon')).toBeNull();
  });
});

describe('Stop', () => {
  const stopped = () => {
    const controller = new AbortController();
    controller.abort(new Error('Stopped'));
    return controller;
  };

  test('a create that was stopped stores nothing and commits nothing', async () => {
    const h = harness();
    await expect(
      h.service.create(
        'owner',
        { title: 'Invoice', template: 'invoice', data: invoice },
        { signal: stopped().signal },
      ),
    ).rejects.toThrow('Stopped');
    expect(h.stored).toEqual([]);
    expect(h.saves).toEqual([]);
  });

  test('Stop during the upload stops the commit of a new file', async () => {
    const controller = new AbortController();
    const h = harness({
      storeOfficeBytes: async () => {
        controller.abort(new Error('Stopped'));
        return 'storage';
      },
    });
    await expect(
      h.service.create(
        'owner',
        { title: 'Invoice', template: 'invoice', data: invoice },
        { signal: controller.signal },
      ),
    ).rejects.toThrow('Stopped');
    expect(h.saves).toEqual([]);
  });

  test('Stop during the upload stops the commit of a new revision', async () => {
    const controller = new AbortController();
    const h = harness();
    await h.service.create('owner', { title: 'Invoice', template: 'invoice', data: invoice });
    const committed = h.saves.length;
    h.setFile({ ...h.file() });
    const service = createWordService({
      requireOffice: () => ({
        server: 'https://o.test',
        app: 'https://a.test',
        secret: 's',
        provider: 'collabora',
      }),
      getOfficeFile: async () => h.file(),
      fetch: async () => new Response(new Uint8Array(h.bytes())),
      storeOfficeBytes: async () => {
        controller.abort(new Error('Stopped'));
        return 'storage';
      },
      convexMutation: async (_api: unknown, input: any) => {
        h.saves.push(input);
        return { ok: true, revision: 2 };
      },
    } as any);
    await expect(
      service.edit('owner', 'invoice-1', 1, [{ op: 'fill_blank', blank: 'Rate: July', value: '90' }], {
        signal: controller.signal,
      }),
    ).rejects.toThrow('Stopped');
    expect(h.saves.length).toBe(committed);
  });

  test('the run and the tool call go with each commit, so the effect lands with the file', async () => {
    const execution = { runId: 'run-1', key: 'key-1' };
    const h = harness({ documentExecution: () => execution });
    await h.service.create('owner', { title: 'Invoice', template: 'invoice', data: invoice });
    expect(h.saves[0].execution).toEqual(execution);
    await h.service.edit('owner', 'invoice-1', 1, [{ op: 'fill_blank', blank: 'Rate: July', value: '90' }]);
    expect(h.saves.at(-1).execution).toEqual(execution);
    expect(h.saves.at(-1).template.kind).toBe('invoice');
  });

  test('a file made outside a tool call sends no execution', async () => {
    const h = harness({ documentExecution: () => undefined });
    await h.service.create('owner', { title: 'Invoice', template: 'invoice', data: invoice });
    expect(h.saves[0]).not.toHaveProperty('execution');
  });
});
