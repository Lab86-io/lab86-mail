import { describe, expect, test } from 'bun:test';
import {
  attachmentIdForPart,
  decodeAttachmentId,
  decodeCharset,
  decodeHtmlEntities,
  decodeMimeWords,
  encodeAttachmentId,
  gmailLabelToNylasFolder,
  gmailMessageToNylas,
  gmailThreadToNylas,
  headerValue,
  isAttachmentPart,
  messageBodies,
  parseAddressList,
  resolveAttachmentPart,
  threadLabelIds,
} from '../lib/google/gmail-message';
import { normalizeNylasMessage } from '../lib/nylas/normalize';
import {
  b64url,
  filePart,
  h,
  INVOICE_PDF,
  LOGO_INLINE,
  multipart,
  plainMessage,
  receiptMessage,
  textPart,
} from './google-gmail-fixtures';

const GRANT = 'google:acct-1';

describe('RFC 2047 encoded words', () => {
  test('decode B and Q words and join adjacent words of one charset', () => {
    expect(decodeMimeWords('=?UTF-8?B?UmVjZWlwdCDigJQg?= =?UTF-8?B?VktIWFJZ?=')).toBe('Receipt — VKHXRY');
    expect(decodeMimeWords('=?UTF-8?Q?Lowe=E2=80=99s_Home?= Improvement')).toBe('Lowe’s Home Improvement');
    expect(decodeMimeWords('=?iso-8859-1?Q?Caf=E9?=')).toBe('Café');
    expect(decodeMimeWords('plain text')).toBe('plain text');
    expect(decodeMimeWords(undefined)).toBe('');
  });

  test('keep a UTF-8 character that one encoder split across two words', () => {
    // "é" is C3 A9; each byte is in its own word.
    expect(decodeMimeWords('=?UTF-8?Q?Caf=C3?= =?UTF-8?Q?=A9?=')).toBe('Café');
  });

  test('keep the text between words of different charsets', () => {
    expect(decodeMimeWords('A =?UTF-8?B?w6k=?= and =?iso-8859-1?B?6Q==?= B')).toBe('A é and é B');
  });

  test('an unknown charset falls back to UTF-8', () => {
    expect(decodeCharset(Buffer.from('ok'), 'x-made-up')).toBe('ok');
    expect(decodeCharset(Buffer.from('ok'), '"us-ascii"')).toBe('ok');
  });
});

describe('address headers', () => {
  test('parse quoted names with commas, encoded names, and bare addresses', () => {
    expect(
      parseAddressList(
        '"Ng, Kin Man (NIH/NLM/NCBI) [C]" <kin.ng@nih.gov>, =?UTF-8?Q?Lowe=E2=80=99s?= <lowes@e.lowes.com>, bare@x.org',
      ),
    ).toEqual([
      { name: 'Ng, Kin Man (NIH/NLM/NCBI) [C]', email: 'kin.ng@nih.gov' },
      { name: 'Lowe’s', email: 'lowes@e.lowes.com' },
      { name: '', email: 'bare@x.org' },
    ]);
  });

  test('keep a comment-like part of an unquoted name, as Nylas does', () => {
    expect(parseAddressList('Nathan (via LinkedIn) <messages-noreply@linkedin.com>')).toEqual([
      { name: 'Nathan (via LinkedIn)', email: 'messages-noreply@linkedin.com' },
    ]);
  });

  test('read group syntax, escaped quotes, and skip empty groups', () => {
    expect(parseAddressList('undisclosed-recipients:;')).toEqual([]);
    expect(parseAddressList('Team: a@x.org, "B \\"Bee\\"" <b@x.org>;')).toEqual([
      { name: '', email: 'a@x.org' },
      { name: 'B "Bee"', email: 'b@x.org' },
    ]);
    expect(parseAddressList('Nobody <>, not-an-address, c@x.org (Carl)')).toEqual([
      { name: '', email: 'c@x.org' },
    ]);
    expect(parseAddressList(undefined)).toEqual([]);
  });

  test('header lookup ignores case and unfolds lines', () => {
    expect(headerValue([h('content-type', 'application/pdf;\r\n name=a.pdf')], 'Content-Type')).toBe(
      'application/pdf; name=a.pdf',
    );
    expect(headerValue(undefined, 'X')).toBeUndefined();
  });
});

describe('attachment ids', () => {
  test('encode the stored Nylas form: name, content type, and size', () => {
    expect(
      encodeAttachmentId({
        filename: 'Invoice-VKHXRY-00028.pdf',
        contentType: 'application/octet-stream',
        size: 4,
      }),
    ).toBe('v0:SW52b2ljZS1WS0hYUlktMDAwMjgucGRm:YXBwbGljYXRpb24vb2N0ZXQtc3RyZWFt:4');
    expect(
      decodeAttachmentId('v0:SW52b2ljZS1WS0hYUlktMDAwMjgucGRm:YXBwbGljYXRpb24vb2N0ZXQtc3RyZWFt:4'),
    ).toEqual({
      filename: 'Invoice-VKHXRY-00028.pdf',
      contentType: 'application/octet-stream',
      size: 4,
    });
    expect(decodeAttachmentId('v0:YQ:Yg')).toEqual({ filename: 'a', contentType: 'b', size: null });
    expect(decodeAttachmentId('ANGjdJ_raw')).toBeNull();
  });

  test('use the whole Content-Type value of the part, with its parameters', () => {
    const part = filePart({
      filename: 'invoice_CR268914.pdf',
      contentType: 'application/pdf; name=invoice_CR268914.pdf',
      size: 53788,
      attachmentId: 'x',
    });
    const decoded = decodeAttachmentId(attachmentIdForPart(part));
    expect(decoded).toEqual({
      filename: 'invoice_CR268914.pdf',
      contentType: 'application/pdf; name=invoice_CR268914.pdf',
      size: 53788,
    });
  });

  test('resolve a stored id against the parts of a new read', () => {
    const payload = receiptMessage().payload;
    const stored = encodeAttachmentId({
      filename: 'Invoice-VKHXRY-00028.pdf',
      contentType: 'application/octet-stream',
      size: 42076,
    });
    expect(resolveAttachmentPart(payload, stored)).toBe(INVOICE_PDF);
    // An inline image without a name resolves by its type and size.
    expect(
      resolveAttachmentPart(
        payload,
        encodeAttachmentId({ filename: '', contentType: 'image/png', size: 123 }),
      ),
    ).toBe(LOGO_INLINE);
    // A raw Gmail attachment id of this read works too.
    expect(resolveAttachmentPart(payload, 'ANGjdJ_volatile_1')).toBe(INVOICE_PDF);
  });

  test('fall back to the name and type when the size differs, then to one named part', () => {
    const payload = receiptMessage().payload;
    expect(
      resolveAttachmentPart(
        payload,
        encodeAttachmentId({
          filename: 'Invoice-VKHXRY-00028.pdf',
          contentType: 'application/octet-stream',
          size: 1,
        }),
      ),
    ).toBe(INVOICE_PDF);
    expect(
      resolveAttachmentPart(
        payload,
        encodeAttachmentId({ filename: 'Invoice-VKHXRY-00028.pdf', contentType: 'x/y', size: 42076 }),
      ),
    ).toBe(INVOICE_PDF);
    expect(
      resolveAttachmentPart(
        payload,
        encodeAttachmentId({ filename: 'Invoice-VKHXRY-00028.pdf', contentType: 'x/y', size: 9 }),
      ),
    ).toBe(INVOICE_PDF);
    expect(
      resolveAttachmentPart(payload, encodeAttachmentId({ filename: 'nope.pdf', contentType: '', size: 1 })),
    ).toBeNull();
    expect(resolveAttachmentPart(payload, 'not-an-id')).toBeNull();
  });

  test('two calendar parts with one name keep two ids', () => {
    const calendar = filePart({
      filename: 'invite.ics',
      contentType: 'text/calendar; charset="UTF-8"; method=REQUEST',
      size: 2396,
      data: b64url('BEGIN:VCALENDAR'),
    });
    const ics = filePart({
      filename: 'invite.ics',
      contentType: 'application/ics; name="invite.ics"',
      size: 2396,
      attachmentId: 'att-ics',
      disposition: 'attachment; filename="invite.ics"',
    });
    const message = gmailMessageToNylas(
      {
        id: 'm',
        threadId: 't',
        payload: multipart('multipart/mixed', [
          multipart('multipart/alternative', [
            textPart('text/plain', 'x'),
            textPart('text/html', '<p>x</p>'),
            calendar,
          ]),
          ics,
        ]),
      },
      GRANT,
    );
    expect(message.attachments.map((a) => a.contentType)).toEqual([
      'text/calendar; charset="UTF-8"; method=REQUEST',
      'application/ics; name="invite.ics"',
    ]);
    expect(new Set(message.attachments.map((a) => a.id)).size).toBe(2);
    expect(message.body).toBe('<p>x</p>');
    expect(
      resolveAttachmentPart(multipart('multipart/mixed', [calendar, ics]), message.attachments[1].id),
    ).toBe(ics);
  });
});

describe('Gmail message to the Nylas shape', () => {
  test('map ids, labels, flags, dates, snippet, addresses, body, and attachments', () => {
    const message = gmailMessageToNylas(receiptMessage({ labelIds: ['UNREAD', 'INBOX', 'STARRED'] }), GRANT);
    expect(message).toMatchObject({
      id: '1a0e656c36a59a89',
      threadId: '1a0e656c36a59a89',
      grantId: GRANT,
      subject: 'Receipt — VKHXRY',
      date: 1789440527,
      snippet: "Your receipt & invoice 'VKHXRY' are attached",
      unread: true,
      starred: true,
      folders: ['UNREAD', 'INBOX', 'STARRED'],
      body: '<p>HTML <b>receipt</b></p>',
      from: [{ name: 'Ng, Kin Man (NIH/NLM/NCBI) [C]', email: 'kin.ng@nih.gov' }],
      cc: [{ name: '', email: 'team@example.com' }],
    });
    expect(message.headers).toBeUndefined();
    expect(message.attachments).toEqual([
      {
        id: 'v0:SW52b2ljZS1WS0hYUlktMDAwMjgucGRm:YXBwbGljYXRpb24vb2N0ZXQtc3RyZWFt:42076',
        grantId: GRANT,
        filename: 'Invoice-VKHXRY-00028.pdf',
        contentType: 'application/octet-stream',
        size: 42076,
        isInline: false,
        contentDisposition: 'attachment; filename="Invoice-VKHXRY-00028.pdf"',
      },
      {
        id: encodeAttachmentId({ filename: '', contentType: 'image/png', size: 123 }),
        grantId: GRANT,
        filename: '',
        contentType: 'image/png',
        size: 123,
        contentId: 'logo@example',
        isInline: true,
      },
    ]);
  });

  test('return headers only when asked', () => {
    const message = gmailMessageToNylas(receiptMessage(), GRANT, { includeHeaders: true });
    expect(message.headers?.find((header) => header.name === 'List-Unsubscribe')?.value).toBe(
      '<https://example.com/unsub>',
    );
  });

  test('keep a text-only body as it is, like Nylas', () => {
    const message = gmailMessageToNylas(plainMessage(), GRANT);
    expect(message.body).toBe('Hey jjalangtry!\r\n\r\nA third-party app was authorized.');
    expect(message.attachments).toEqual([]);
  });

  test('decode a latin-1 body and fall back to the Date header without internalDate', () => {
    const message = gmailMessageToNylas(
      {
        id: 'l1',
        threadId: 't1',
        payload: {
          ...textPart('text/html', '<p>Café</p>', 'ISO-8859-1'),
          headers: [
            h('Content-Type', 'text/html; charset=ISO-8859-1'),
            h('Date', 'Tue, 15 Sep 2026 02:48:47 +0000'),
          ],
        },
      },
      GRANT,
    );
    expect(message.body).toBe('<p>Café</p>');
    expect(message.date).toBe(Date.parse('2026-09-15T02:48:47Z') / 1000);
    expect(message.unread).toBe(false);
    expect(message.folders).toEqual([]);
  });

  test('omit the body of a metadata read', () => {
    const message = gmailMessageToNylas(
      {
        id: 'm',
        threadId: 't',
        labelIds: ['SENT'],
        payload: { mimeType: 'text/plain', headers: [h('Subject', 'Hi')] },
      },
      GRANT,
    );
    expect(message.body).toBeUndefined();
    expect(message.subject).toBe('Hi');
    expect(message.date).toBe(0);
  });

  test('the corpus normalizer reads the mapped message like a Nylas message', () => {
    const normalized = normalizeNylasMessage(gmailMessageToNylas(receiptMessage(), GRANT) as any, 'acct-1');
    expect(normalized.from).toBe('Ng, Kin Man (NIH/NLM/NCBI) [C] <kin.ng@nih.gov>');
    expect(normalized.to).toBe('Jakob Langtry <jakob@example.com>, Lowe’s <lowes@e.lowes.com>');
    expect(normalized.labels).toEqual(['UNREAD', 'INBOX', 'CATEGORY_UPDATES']);
    expect(normalized.unread).toBe(true);
    expect(normalized.date).toBe(1789440527000);
    expect(normalized.textBody).toBe('HTML receipt');
    expect(normalized.attachments).toEqual([
      {
        filename: 'Invoice-VKHXRY-00028.pdf',
        mimeType: 'application/octet-stream',
        size: 42076,
        attachmentId: 'v0:SW52b2ljZS1WS0hYUlktMDAwMjgucGRm:YXBwbGljYXRpb24vb2N0ZXQtc3RyZWFt:42076',
      },
      {
        filename: 'attachment',
        mimeType: 'image/png',
        size: 123,
        attachmentId: encodeAttachmentId({ filename: '', contentType: 'image/png', size: 123 }),
      },
    ]);
  });
});

describe('bodies and parts', () => {
  test('pick the last HTML alternative and join the parts of a mixed body', () => {
    expect(
      messageBodies(
        multipart('multipart/mixed', [
          textPart('text/html', '<p>one</p>'),
          filePart({ filename: 'a.png', contentType: 'image/png', size: 3, attachmentId: 'a' }),
          textPart('text/html', '<p>two</p>'),
          textPart('text/plain', 'text'),
        ]),
      ),
    ).toEqual({ html: '<p>one</p><p>two</p>', text: 'text' });
    expect(messageBodies(undefined)).toEqual({});
    expect(messageBodies(filePart({ filename: 'a.pdf', contentType: 'application/pdf', size: 1 }))).toEqual(
      {},
    );
    expect(messageBodies({ mimeType: 'text/calendar', body: { data: b64url('x') } })).toEqual({});
  });

  test('an attachment part has a name, an attachment disposition, or is not text', () => {
    expect(isAttachmentPart(textPart('text/plain', 'x'))).toBe(false);
    expect(
      isAttachmentPart({ ...textPart('text/plain', 'x'), headers: [h('Content-Disposition', 'attachment')] }),
    ).toBe(true);
    expect(isAttachmentPart({ mimeType: 'image/gif', body: { attachmentId: 'a', size: 1 } })).toBe(true);
    expect(isAttachmentPart({ mimeType: 'image/gif', body: { data: b64url('x'), size: 1 } })).toBe(false);
    expect(isAttachmentPart(multipart('multipart/mixed', []))).toBe(false);
    expect(isAttachmentPart({ mimeType: 'multipart/mixed' })).toBe(false);
  });

  test('a part without a size uses the length of its data', () => {
    const part = { mimeType: 'image/png', filename: 'p.png', body: { data: b64url('12345') } };
    expect(decodeAttachmentId(attachmentIdForPart(part))?.size).toBe(5);
    expect(decodeAttachmentId(attachmentIdForPart({ filename: 'x' }))?.contentType).toBe(
      'application/octet-stream',
    );
  });

  test('decode HTML entities of a snippet', () => {
    expect(decodeHtmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#x27;e&#39; &nbsp;&unknown; &#0;')).toBe(
      'a & b <c> "d" \'e\'  &unknown; &#0;',
    );
  });
});

describe('threads and labels', () => {
  test('a thread has the union of labels, flags, dates, and no draft as a message', () => {
    const thread = gmailThreadToNylas(
      {
        id: 'thread-1',
        snippet: 'Latest &amp; greatest',
        messages: [
          { ...plainMessage({ id: 'a', internalDate: '1000000', labelIds: ['INBOX'] }) },
          { ...plainMessage({ id: 'b', internalDate: '3000000', labelIds: ['SENT'] }) },
          { ...plainMessage({ id: 'c', internalDate: '2000000', labelIds: ['INBOX', 'UNREAD', 'STARRED'] }) },
          { ...plainMessage({ id: 'd', internalDate: '4000000', labelIds: ['DRAFT'] }) },
        ],
      },
      GRANT,
    );
    expect(thread.folders.sort()).toEqual(['DRAFT', 'INBOX', 'SENT', 'STARRED', 'UNREAD']);
    expect(thread.unread).toBe(true);
    expect(thread.starred).toBe(true);
    expect(thread.messageIds).toEqual(['a', 'b', 'c']);
    expect(thread.draftIds).toEqual(['d']);
    expect(thread.earliestMessageDate).toBe(1000);
    expect(thread.latestMessageReceivedDate).toBe(2000);
    expect(thread.latestMessageSentDate).toBe(3000);
    expect(thread.latestDraftOrMessage?.id).toBe('b');
    expect(thread.snippet).toBe('Latest & greatest');
    expect(thread.participants.map((p) => p.email)).toEqual(['noreply@github.com', 'jjalangtry@example.com']);
    expect(
      threadLabelIds({
        id: 't',
        messages: [
          { id: 'x', threadId: 't', labelIds: ['A'] },
          { id: 'y', threadId: 't' },
        ],
      }),
    ).toEqual(['A']);
    const empty = gmailThreadToNylas({ id: 'empty' }, GRANT);
    expect(empty.messageIds).toEqual([]);
    expect(empty.subject).toBe('');
  });

  test('a label becomes a Nylas folder', () => {
    expect(
      gmailLabelToNylasFolder(
        { id: 'INBOX', name: 'INBOX', type: 'system', messagesTotal: 5, messagesUnread: 2 },
        GRANT,
      ),
    ).toEqual({
      id: 'INBOX',
      object: 'folder',
      grantId: GRANT,
      name: 'INBOX',
      systemFolder: true,
      totalCount: 5,
      unreadCount: 2,
    });
    expect(
      gmailLabelToNylasFolder(
        {
          id: 'Label_1',
          name: 'Receipts',
          type: 'user',
          color: { backgroundColor: '#fff', textColor: '#000' },
        },
        GRANT,
      ),
    ).toMatchObject({ systemFolder: false, backgroundColor: '#fff', textColor: '#000' });
  });
});
