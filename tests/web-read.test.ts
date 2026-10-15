import { afterEach, describe, expect, test } from 'bun:test';
import { BrowserbaseRequestError } from '../lib/web/browserbase-client';
import {
  __setWebReadDepsForTest,
  displayHost,
  PAGE_READ_MAX_CHARS,
  publicWebUrl,
  readJson,
  readPage,
  searchWeb,
  WebUrlError,
} from '../lib/web/read';

afterEach(() => __setWebReadDepsForTest());

const PDF = Buffer.from('%PDF-1.7 fake').toString('base64');

function fetchStub(answers: Record<'markdown' | 'raw', unknown>) {
  const calls: Array<{ url: string; format: string }> = [];
  __setWebReadDepsForTest({
    fetch: async (input) => {
      calls.push({ url: input.url, format: input.format });
      const answer = answers[input.format];
      if (answer instanceof Error) throw answer;
      return answer as any;
    },
  });
  return calls;
}

describe('publicWebUrl', () => {
  test('keeps public http and https addresses, without the fragment', () => {
    expect(publicWebUrl(' https://www.irs.gov/forms#top ').toString()).toBe('https://www.irs.gov/forms');
    expect(publicWebUrl('http://example.com/a?b=1').toString()).toBe('http://example.com/a?b=1');
    expect(publicWebUrl('https://[2606:4700:4700::1111]/').hostname).toBe('[2606:4700:4700::1111]');
  });

  test('refuses other schemes, credentials, private and single-label hosts', () => {
    for (const [raw, message] of [
      ['not a url', /full http or https/],
      ['ftp://example.com/f', /Only http and https/],
      ['file:///etc/passwd', /Only http and https/],
      ['https://user:pw@example.com/', /user name or password/],
      ['http://127.0.0.1/', /private network/],
      ['http://10.1.2.3/x', /private network/],
      ['http://localhost:3000/', /private network/],
      ['http://metadata/computeMetadata', /private network/],
      ['http://[::1]/', /private network/],
      ['http://printer.local/', /private network/],
    ] as const) {
      expect(() => publicWebUrl(raw)).toThrow(message);
      expect(() => publicWebUrl(raw)).toThrow(WebUrlError);
    }
  });

  test('displayHost drops www and is empty for a bad address', () => {
    expect(displayHost('https://www.IRS.gov/x')).toBe('irs.gov');
    expect(displayHost('nope')).toBe('');
  });
});

describe('searchWeb', () => {
  test('maps rows to title, url, and the known date and author', async () => {
    const seen: unknown[] = [];
    __setWebReadDepsForTest({
      search: async (input) => {
        seen.push(input);
        return [
          {
            url: 'https://www.irs.gov/w9',
            title: 'About W-9',
            publishedDate: '2024-03-01',
            id: 'x',
            favicon: 'f',
          },
          { url: 'https://example.com/a', author: 'Ada' },
          { url: 'https://example.com/b' },
        ];
      },
    });
    expect(await searchWeb('w9', 2)).toEqual([
      { title: 'About W-9', url: 'https://www.irs.gov/w9', publishedDate: '2024-03-01' },
      { title: 'example.com', url: 'https://example.com/a', author: 'Ada' },
    ]);
    expect(seen).toEqual([{ query: 'w9', numResults: 2 }]);
  });
});

describe('readPage', () => {
  test('a web page is markdown; a site error status shows; long text is cut', async () => {
    const calls = fetchStub({
      markdown: { statusCode: 404, headers: {}, content: `  ${'a'.repeat(30)}  `, contentType: '' },
      raw: new Error('unused'),
    });
    expect(await readPage('https://example.com/missing', { maxChars: 10 })).toEqual({
      url: 'https://example.com/missing',
      contentType: 'text/markdown',
      status: 404,
      content: 'aaaaaaaaaa',
      truncated: true,
    });
    expect(calls).toEqual([{ url: 'https://example.com/missing', format: 'markdown' }]);
    expect(PAGE_READ_MAX_CHARS).toBe(80_000);
  });

  test('a PDF: markdown gives 400, so the raw bytes give the text', async () => {
    const calls = fetchStub({
      markdown: new BrowserbaseRequestError('Browserbase /fetch failed (400): cannot convert', 400),
      raw: { statusCode: 200, headers: {}, content: PDF, contentType: 'application/pdf', encoding: 'base64' },
    });
    const extracted: unknown[] = [];
    __setWebReadDepsForTest({
      fetch: async (input) => {
        calls.push({ url: input.url, format: input.format });
        if (input.format === 'markdown') throw new BrowserbaseRequestError('x', 400);
        return {
          statusCode: 200,
          headers: {},
          content: PDF,
          contentType: 'application/octet-stream',
          encoding: 'base64',
        };
      },
      extract: async (bytes, mime, name) => {
        extracted.push({ head: Buffer.from(bytes).subarray(0, 5).toString(), mime, name });
        return { text: '[Page 1]\nForm W-9 (Rev. March 2024)', partial: false };
      },
    });
    expect(await readPage('https://www.irs.gov/pub/irs-pdf/fw9.pdf')).toEqual({
      url: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf',
      contentType: 'application/pdf',
      content: '[Page 1]\nForm W-9 (Rev. March 2024)',
    });
    expect(extracted).toEqual([{ head: '%PDF-', mime: 'application/pdf', name: 'fw9.pdf' }]);
  });

  test('a long PDF says it is cut; a scan with no text is an error', async () => {
    __setWebReadDepsForTest({
      fetch: async (input) => {
        if (input.format === 'markdown') throw new BrowserbaseRequestError('x', 400);
        return {
          statusCode: 200,
          headers: {},
          content: PDF,
          contentType: 'application/pdf',
          encoding: 'base64',
        };
      },
      extract: async () => ({ text: '[Page 1]\nText', partial: true }),
    });
    expect((await readPage('https://example.com/doc'))?.truncated).toBe(true);
    __setWebReadDepsForTest({
      fetch: async (input) => {
        if (input.format === 'markdown') throw new BrowserbaseRequestError('x', 400);
        return {
          statusCode: 200,
          headers: {},
          content: PDF,
          contentType: 'application/pdf',
          encoding: 'base64',
        };
      },
      extract: async () => ({ text: '[Page 1]\n  [Page 2]\n', partial: true }),
    });
    await expect(readPage('https://example.com/scan.pdf')).rejects.toThrow(/probably a scan/);
  });

  test('an Office file and a text file give their text; other files are refused', async () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    let raw: any = {
      statusCode: 200,
      headers: {},
      content: 'UEsDBA==',
      contentType: docx,
      encoding: 'base64',
    };
    __setWebReadDepsForTest({
      fetch: async (input) => {
        if (input.format === 'markdown') throw new BrowserbaseRequestError('x', 400);
        return raw;
      },
      extract: async (_bytes, mime) => ({ text: `text of ${mime}`, partial: false }),
    });
    expect(await readPage('https://example.com/letter.docx')).toEqual({
      url: 'https://example.com/letter.docx',
      contentType: docx,
      content: `text of ${docx}`,
    });
    raw = { statusCode: 403, headers: {}, content: 'a,b\n1,2', contentType: 'text/csv', encoding: 'utf-8' };
    expect(await readPage('https://example.com/data.csv')).toEqual({
      url: 'https://example.com/data.csv',
      contentType: 'text/csv',
      status: 403,
      content: 'a,b\n1,2',
    });
    raw = {
      statusCode: 200,
      headers: {},
      content: 'iVBORw0KGgo=',
      contentType: 'image/png',
      encoding: 'base64',
    };
    await expect(readPage('https://example.com/logo.png')).rejects.toThrow(
      'This address gives a image/png file, not text. Save it with web_file_save.',
    );
    raw = { statusCode: 200, headers: {}, content: 'AAAA', contentType: '', encoding: 'base64' };
    await expect(readPage('https://example.com/blob')).rejects.toThrow(/application\/octet-stream/);
  });

  test('a raw body over 5 MB and other errors are plain errors', async () => {
    fetchStub({
      markdown: new BrowserbaseRequestError('x', 400),
      raw: new BrowserbaseRequestError('Browserbase /fetch failed (502): too big', 502),
    });
    await expect(readPage('https://example.com/big.pdf')).rejects.toThrow(
      'The file is larger than the 5 MB read limit.',
    );
    fetchStub({ markdown: new BrowserbaseRequestError('x', 400), raw: new Error('raw down') });
    await expect(readPage('https://example.com/x.pdf')).rejects.toThrow('raw down');
    fetchStub({
      markdown: new BrowserbaseRequestError('Browserbase /fetch failed (403): off', 403),
      raw: {},
    });
    await expect(readPage('https://example.com/x')).rejects.toThrow('(403)');
    fetchStub({ markdown: new Error('network'), raw: {} });
    await expect(readPage('https://example.com/x')).rejects.toThrow('network');
    await expect(readPage('http://192.168.1.1/')).rejects.toThrow(/private network/);
  });
});

describe('readJson', () => {
  test('parses the raw answer, text or base64; a site error and a private host are errors', async () => {
    const calls = fetchStub({
      markdown: new Error('unused'),
      raw: {
        statusCode: 200,
        headers: {},
        content: '{"address":{"city":"Albany"}}',
        contentType: 'application/json',
        encoding: 'utf-8',
      },
    });
    expect(await readJson('https://nominatim.example/reverse?lat=1&lon=2')).toEqual({
      address: { city: 'Albany' },
    });
    expect(calls).toEqual([{ url: 'https://nominatim.example/reverse?lat=1&lon=2', format: 'raw' }]);
    fetchStub({
      markdown: new Error('unused'),
      raw: {
        statusCode: 200,
        headers: {},
        content: Buffer.from('[1]').toString('base64'),
        contentType: '',
        encoding: 'base64',
      },
    });
    expect(await readJson('https://api.example/x')).toEqual([1]);
    fetchStub({
      markdown: new Error('unused'),
      raw: { statusCode: 429, headers: {}, content: '', contentType: '' },
    });
    await expect(readJson('https://api.example/x')).rejects.toThrow('GET https://api.example/x failed (429)');
    await expect(readJson('http://127.0.0.1/x')).rejects.toThrow(/private network/);
  });
});
