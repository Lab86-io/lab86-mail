// Gmail API JSON fixtures (format=full) for the direct Google transport tests.
import type { GmailHeader, GmailMessage, GmailPart } from '../lib/google/gmail-message';

export function b64url(text: string | Uint8Array, encoding: BufferEncoding = 'utf8') {
  const bytes = typeof text === 'string' ? Buffer.from(text, encoding) : Buffer.from(text);
  return bytes.toString('base64url');
}

export function h(name: string, value: string): GmailHeader {
  return { name, value };
}

export function textPart(mimeType: 'text/plain' | 'text/html', text: string, charset = 'UTF-8'): GmailPart {
  const data = b64url(text, charset.toLowerCase() === 'iso-8859-1' ? 'latin1' : 'utf8');
  return {
    mimeType,
    filename: '',
    headers: [h('Content-Type', `${mimeType}; charset="${charset}"`)],
    body: { size: Buffer.from(data, 'base64url').length, data },
  };
}

export function filePart(input: {
  filename: string;
  contentType: string;
  size: number;
  attachmentId?: string;
  data?: string;
  disposition?: string;
  contentId?: string;
}): GmailPart {
  const headers = [h('Content-Type', input.contentType)];
  if (input.disposition) headers.push(h('Content-Disposition', input.disposition));
  if (input.contentId) headers.push(h('Content-ID', `<${input.contentId}>`));
  return {
    mimeType: input.contentType.split(';')[0].trim(),
    filename: input.filename,
    headers,
    body: {
      size: input.size,
      ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}),
      ...(input.data ? { data: input.data } : {}),
    },
  };
}

export function multipart(mimeType: string, parts: GmailPart[]): GmailPart {
  return { mimeType, filename: '', headers: [h('Content-Type', `${mimeType}; boundary="b"`)], parts };
}

export const INVOICE_PDF = filePart({
  filename: 'Invoice-VKHXRY-00028.pdf',
  contentType: 'application/octet-stream',
  size: 42076,
  attachmentId: 'ANGjdJ_volatile_1',
  disposition: 'attachment; filename="Invoice-VKHXRY-00028.pdf"',
});

export const LOGO_INLINE = filePart({
  filename: '',
  contentType: 'image/png',
  size: 123,
  attachmentId: 'ANGjdJ_volatile_2',
  contentId: 'logo@example',
});

/** A receipt: multipart/mixed with an alternative body, a PDF, and an inline logo. */
export function receiptMessage(overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: '1a0e656c36a59a89',
    threadId: '1a0e656c36a59a89',
    labelIds: ['UNREAD', 'INBOX', 'CATEGORY_UPDATES'],
    snippet: 'Your receipt &amp; invoice &#39;VKHXRY&#39; are attached',
    internalDate: '1789440527000',
    payload: {
      mimeType: 'multipart/mixed',
      filename: '',
      headers: [
        h('From', '"Ng, Kin Man (NIH/NLM/NCBI) [C]" <kin.ng@nih.gov>'),
        h('To', 'Jakob Langtry <jakob@example.com>, =?UTF-8?Q?Lowe=E2=80=99s?= <lowes@e.lowes.com>'),
        h('Cc', 'team@example.com'),
        h('Subject', '=?UTF-8?B?UmVjZWlwdCDigJQg?= =?UTF-8?B?VktIWFJZ?='),
        h('Date', 'Tue, 15 Sep 2026 02:48:47 +0000'),
        h('Message-ID', '<receipt-1@mail.example>'),
        h('List-Unsubscribe', '<https://example.com/unsub>'),
      ],
      parts: [
        multipart('multipart/alternative', [
          textPart('text/plain', 'Plain receipt'),
          textPart('text/html', '<p>HTML <b>receipt</b></p>'),
        ]),
        INVOICE_PDF,
        LOGO_INLINE,
      ],
    },
    ...overrides,
  };
}

export function plainMessage(overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: 'plain-1',
    threadId: 'thread-plain',
    labelIds: ['INBOX'],
    snippet: 'Hey jjalangtry!',
    internalDate: '1789000000000',
    payload: {
      ...textPart('text/plain', 'Hey jjalangtry!\r\n\r\nA third-party app was authorized.'),
      headers: [
        h('Content-Type', 'text/plain; charset="utf-8"'),
        h('From', 'GitHub <noreply@github.com>'),
        h('To', 'jjalangtry@example.com'),
        h('Subject', '[GitHub] A third-party OAuth application'),
      ],
    },
    ...overrides,
  };
}
