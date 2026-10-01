import { describe, expect, test } from 'bun:test';
import {
  buildMimeMessage,
  encodeHeaderText,
  formatMimeAddress,
  replyReferences,
  replySubject,
} from '../lib/google/mime';

const DATE = new Date('2026-09-28T12:00:00Z');

function counter() {
  let n = 0;
  return () => `b${++n}`;
}

function headersOf(mime: string) {
  return mime.slice(0, mime.indexOf('\r\nContent-Type')).split('\r\n');
}

function decodeBase64Section(mime: string, after: string) {
  const start = mime.indexOf(after);
  const bodyStart = mime.indexOf('\r\n\r\n', start) + 4;
  const bodyEnd = mime.indexOf('\r\n--', bodyStart);
  return Buffer.from(
    mime.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd).replace(/\r\n/g, ''),
    'base64',
  );
}

describe('header encoding', () => {
  test('ASCII stays; other text becomes UTF-8 encoded words of at most 45 bytes', () => {
    expect(encodeHeaderText('Plain subject')).toBe('Plain subject');
    const encoded = encodeHeaderText('Grüße — ünïcödé '.repeat(4));
    const words = encoded.split(' ');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(Buffer.from(word.slice(10, -2), 'base64').length).toBeLessThanOrEqual(45);
    }
    const decoded = words.map((word) => Buffer.from(word.slice(10, -2), 'base64').toString('utf8')).join('');
    expect(decoded).toBe('Grüße — ünïcödé '.repeat(4));
    expect(encodeHeaderText('a\r\nBcc: x@y.z')).toBe('a Bcc: x@y.z');
  });

  test('addresses quote special names and encode other names', () => {
    expect(formatMimeAddress({ email: 'a@x.org' })).toBe('a@x.org');
    expect(formatMimeAddress({ name: 'a@x.org', email: 'a@x.org' })).toBe('a@x.org');
    expect(formatMimeAddress({ name: 'Ann Lee', email: 'a@x.org' })).toBe('Ann Lee <a@x.org>');
    expect(formatMimeAddress({ name: 'Lee, Ann "AL"', email: 'a@x.org' })).toBe(
      '"Lee, Ann \\"AL\\"" <a@x.org>',
    );
    expect(formatMimeAddress({ name: 'Zoë', email: '<a@x.org>\r\n' })).toBe('=?UTF-8?B?Wm/Dqw==?= <a@x.org>');
  });
});

describe('buildMimeMessage', () => {
  test('a plain message has one text part and no multipart', () => {
    const mime = buildMimeMessage({
      to: [{ name: 'Ann', email: 'ann@x.org' }],
      subject: 'Hello',
      body: 'Line one\nLine two',
      isPlaintext: true,
      date: DATE,
    });
    const headers = headersOf(mime);
    expect(headers).toContain('To: Ann <ann@x.org>');
    expect(headers).toContain('Subject: Hello');
    expect(headers).toContain('MIME-Version: 1.0');
    expect(headers).toContain(`Date: ${DATE.toUTCString()}`);
    expect(mime).not.toContain('multipart');
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(decodeBase64Section(mime, 'Content-Type: text/plain').toString('utf8')).toBe('Line one\nLine two');
    expect(mime.endsWith('\r\n')).toBe(true);
  });

  test('an HTML message has a text and an HTML alternative, with UTF-8 subject', () => {
    const mime = buildMimeMessage({
      to: [{ email: 'ann@x.org' }],
      cc: [{ name: 'Bo', email: 'bo@x.org' }],
      bcc: [{ email: 'hidden@x.org' }],
      replyTo: [{ email: 'reply@x.org' }],
      subject: 'Café ☕',
      body: '<p>Hi <b>there</b></p>',
      date: DATE,
      boundary: counter(),
    });
    expect(mime).toContain('Subject: =?UTF-8?B?');
    expect(mime).toContain('Cc: Bo <bo@x.org>');
    expect(mime).toContain('Bcc: hidden@x.org');
    expect(mime).toContain('Reply-To: reply@x.org');
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="b1"');
    expect(decodeBase64Section(mime, 'Content-Type: text/plain').toString('utf8')).toBe('Hi there');
    expect(decodeBase64Section(mime, 'Content-Type: text/html').toString('utf8')).toBe(
      '<p>Hi <b>there</b></p>',
    );
    expect(mime).toContain('--b1--');
  });

  test('a reply carries In-Reply-To and References', () => {
    const mime = buildMimeMessage({
      to: [{ email: 'ann@x.org' }],
      subject: 'Re: Plans',
      body: 'ok',
      isPlaintext: true,
      inReplyTo: '<parent@x.org>',
      references: replyReferences('<parent@x.org>', '<root@x.org>'),
      date: DATE,
    });
    expect(mime).toContain('In-Reply-To: <parent@x.org>');
    expect(mime).toContain('References: <root@x.org> <parent@x.org>');
  });

  test('attachments are base64 parts in multipart/mixed, with RFC 2231 names', () => {
    const mime = buildMimeMessage({
      to: [{ email: 'ann@x.org' }],
      subject: 'Files',
      body: '<p>see files</p>',
      date: DATE,
      boundary: counter(),
      attachments: [
        {
          filename: 'report "final".pdf',
          contentType: 'application/pdf; name=x',
          content: Buffer.from('%PDF-1'),
        },
        { filename: 'résumé.txt', contentType: 'text/plain', content: Buffer.from('cv').toString('base64') },
        {
          filename: 'logo.png',
          contentType: 'image/png',
          content: new Uint8Array([1, 2]),
          contentId: 'logo',
          isInline: true,
        },
        { content: Buffer.from('x') },
      ],
    });
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="b2"');
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="b1"');
    expect(mime).toContain('Content-Type: application/pdf; name="report \\"final\\".pdf"');
    expect(mime).toContain('Content-Disposition: attachment; filename="report \\"final\\".pdf"');
    expect(decodeBase64Section(mime, 'filename="report').toString('utf8')).toBe('%PDF-1');
    expect(mime).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.txt");
    expect(decodeBase64Section(mime, "filename*=UTF-8''r%C3%A9sum%C3%A9.txt").toString('utf8')).toBe('cv');
    expect(mime).toContain('Content-Disposition: inline; filename="logo.png"');
    expect(mime).toContain('Content-ID: <logo>');
    expect(mime).toContain('Content-Type: application/octet-stream; name="attachment"');
    expect(mime.trimEnd().endsWith('--b2--')).toBe(true);
  });

  test('a long address list folds after each comma', () => {
    const to = Array.from({ length: 6 }, (_, i) => ({ email: `person${i}@example.org` }));
    const mime = buildMimeMessage({ to, subject: 's', body: 'b', isPlaintext: true, date: DATE });
    expect(mime).toContain('To: person0@example.org,\r\n person1@example.org,');
    for (const line of mime.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
  });

  // The lines of one header field: its first line and the continuation lines.
  function field(mime: string, name: string) {
    const lines = mime.split('\r\n');
    const start = lines.findIndex((line) => line.startsWith(`${name}:`));
    const end = lines.findIndex((line, index) => index > start && !line.startsWith(' '));
    return lines.slice(start, end);
  }

  test('a long subject folds at spaces and unfolds to the same text', () => {
    const cafe = 'Caf\u00e9 \u2615 '.repeat(120);
    const words = 'quarterly planning notes '.repeat(40).trim();
    for (const subject of [cafe, words]) {
      const lines = field(buildMimeMessage({ subject, body: 'b', isPlaintext: true, date: DATE }), 'Subject');
      expect(lines.length).toBeGreaterThan(5);
      expect(lines.join('')).toBe(`Subject: ${encodeHeaderText(subject)}`);
      // The first line keeps the name with the first encoded word (72 characters).
      expect(lines[0].length).toBeLessThanOrEqual(82);
      for (const line of lines.slice(1)) expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  test('a long References value folds between the message ids', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `<message-${i}.1790000000@mail.example.org>`).join(' ');
    const mime = buildMimeMessage({
      subject: 's',
      body: 'b',
      isPlaintext: true,
      references: ids,
      date: DATE,
    });
    const lines = field(mime, 'References');
    expect(lines.join('')).toBe(`References: ${ids}`);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
    expect(field(mime, 'Subject')).toEqual(['Subject: s']);
  });

  test('empty lists and a missing subject are left out or empty', () => {
    const mime = buildMimeMessage({ to: [{ email: '' }], isPlaintext: true });
    expect(mime).not.toContain('To:');
    expect(mime).not.toContain('From:');
    expect(mime).toContain('Subject: \r\n');
  });

  test('a send-as From is the first header, with its name', () => {
    const mime = buildMimeMessage({
      from: { name: 'Ann at Work', email: 'ann@work.example' },
      to: [{ email: 'bob@x.org' }],
      replyTo: [{ email: 'team@work.example' }],
      subject: 's',
      isPlaintext: true,
      date: DATE,
    });
    const headers = headersOf(mime);
    expect(headers[0]).toBe('From: Ann at Work <ann@work.example>');
    expect(headers).toContain('Reply-To: team@work.example');
    expect(buildMimeMessage({ from: { email: 'ann@work.example' }, isPlaintext: true })).toContain(
      'From: ann@work.example\r\n',
    );
  });

  test('a non-ASCII From name is an RFC 2047 encoded word; a special name is quoted', () => {
    const mime = buildMimeMessage({
      from: { name: 'Zoë Ünal', email: 'zoe@work.example' },
      isPlaintext: true,
    });
    const from = headersOf(mime)[0];
    expect(from).toBe(`From: =?UTF-8?B?${Buffer.from('Zoë Ünal').toString('base64')}?= <zoe@work.example>`);
    expect(buildMimeMessage({ from: { name: 'Lee, Ann', email: 'a@x.org' }, isPlaintext: true })).toContain(
      'From: "Lee, Ann" <a@x.org>\r\n',
    );
    // A line break in the name cannot add a header.
    expect(
      headersOf(
        buildMimeMessage({ from: { name: 'Ann\r\nBcc: x@y.org', email: 'a@x.org' }, isPlaintext: true }),
      ),
    ).not.toContain('Bcc: x@y.org');
  });
});

describe('reply helpers', () => {
  test('references keep the chain and add the parent once', () => {
    expect(replyReferences('<p@x>', undefined)).toBe('<p@x>');
    expect(replyReferences('<p@x>', '<a@x>  <p@x>')).toBe('<a@x> <p@x>');
    expect(replyReferences(undefined, undefined)).toBeUndefined();
    expect(replySubject('Plans')).toBe('Re: Plans');
    expect(replySubject('RE: Plans')).toBe('RE: Plans');
  });
});
