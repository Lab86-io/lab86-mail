import { afterEach, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { AllowSendChoice } from '../components/thread/allow-send-choice';
import { allowSendWithoutCheck } from '../components/thread/use-allow-send';
import {
  ALLOW_SEND_COPY,
  allowSendAlwaysLabel,
  allowSendBody,
  allowSendSentences,
  isAllowSendCheckBody,
  joinDomains,
  parseAllowSendRefusal,
  postAllowSendOrCheck,
  sendRetryFields,
} from '../lib/mail/allow-send';

/* The send permission of a sealed file (docs/albatross-goal-runs.md G5): the
 * compose refusal, the one choice in the send area, both answers, the
 * identity-check retry, and a permission that ended. */

const refusalBody = {
  ok: false,
  code: 'needs_allow',
  grant: 'send',
  sendId: 'outbox:1b4e28ba-2fa1-11d2-883f-0016d3cca427',
  domains: ['bramble-press.example.com'],
  allow: [
    {
      itemId: 'secure_tax_id',
      itemLabel: 'Tax ID',
      fieldLabels: ['Social security number'],
      domains: ['bramble-press.example.com'],
    },
  ],
  error: 'A sealed file needs your permission for this send.',
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('the refusal', () => {
  test('a 409 needs_allow or allow_ended is a refusal; anything else is not', () => {
    const refusal = parseAllowSendRefusal(409, refusalBody)!;
    expect(refusal.code).toBe('needs_allow');
    expect(refusal.sendId).toBe(refusalBody.sendId);
    expect(refusal.allow[0].itemLabel).toBe('Tax ID');
    expect(
      parseAllowSendRefusal(409, {
        ...refusalBody,
        code: 'allow_ended',
        error: 'This permission ended. Allow the send again.',
      })?.code,
    ).toBe('allow_ended');
    expect(parseAllowSendRefusal(409, { code: 'gone' })).toBeNull();
    expect(parseAllowSendRefusal(200, refusalBody)).toBeNull();
    expect(parseAllowSendRefusal(409, null)).toBeNull();
  });

  test('the sentence names the item, the file, and the domain', () => {
    const refusal = parseAllowSendRefusal(409, refusalBody)!;
    expect(allowSendSentences(refusal, ['Form W-9.pdf'])).toEqual([
      'Tax ID goes in Form W-9.pdf for mail to bramble-press.example.com.',
    ]);
    expect(allowSendSentences(refusal)[0]).toBe(
      'Tax ID goes in the attached file for mail to bramble-press.example.com.',
    );
    expect(allowSendSentences(refusal, ['a.pdf', 'b.pdf'])[0]).toContain('the attached files');
    expect(allowSendAlwaysLabel(refusal)).toBe('Always for mail to bramble-press.example.com');
    expect(joinDomains(['a.com', 'b.com'])).toBe('a.com and b.com');
    expect(joinDomains(['a.com', 'b.com', 'c.com'])).toBe('a.com, b.com, and c.com');
  });

  test('the choice body and the retry fields', () => {
    const refusal = parseAllowSendRefusal(409, refusalBody)!;
    expect(allowSendBody(refusal, 'once')).toEqual({
      sendId: refusalBody.sendId,
      scope: 'once',
      items: [{ itemId: 'secure_tax_id', domains: ['bramble-press.example.com'] }],
    });
    expect(sendRetryFields(refusal, { ok: true, scope: 'once', allowToken: 'tok_1', expiresAt: 1 })).toEqual({
      pendingId: refusalBody.sendId,
      allowToken: 'tok_1',
    });
    expect(sendRetryFields(refusal, { ok: true, scope: 'always' })).toEqual({
      pendingId: refusalBody.sendId,
    });
  });
});

describe('the choice in the send area', () => {
  test('one sentence and two plain buttons', () => {
    const refusal = parseAllowSendRefusal(409, refusalBody)!;
    const html = renderToStaticMarkup(
      <AllowSendChoice
        refusal={refusal}
        sealedFileNames={['Form W-9.pdf']}
        busy={null}
        error={null}
        onChoose={() => undefined}
      />,
    );
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelector('[data-slot="allow-send"]')?.textContent).toContain(
      'Tax ID goes in Form W-9.pdf for mail to bramble-press.example.com.',
    );
    const buttons = [...doc.querySelectorAll('button')].map((button) => button.textContent);
    expect(buttons).toEqual(['Allow for this send', 'Always for mail to bramble-press.example.com']);
    expect(doc.querySelector('svg')).toBeNull();
    expect(doc.body.textContent).not.toContain(refusalBody.error);
  });

  test('a permission that ended shows the server sentence and the choice again', () => {
    const refusal = parseAllowSendRefusal(409, {
      ...refusalBody,
      code: 'allow_ended',
      error: 'This permission ended. Allow the send again.',
    })!;
    const html = renderToStaticMarkup(
      <AllowSendChoice refusal={refusal} busy="once" error={null} onChoose={() => undefined} />,
    );
    const doc = new JSDOM(html).window.document;
    expect(doc.body.textContent).toContain('This permission ended. Allow the send again.');
    expect(doc.querySelector('button')?.textContent).toBe(ALLOW_SEND_COPY.busy);
    expect(doc.querySelector('button')?.hasAttribute('disabled')).toBe(true);
  });
});

describe('the allow-send call', () => {
  test('once answers a token, always answers a scope', async () => {
    const calls: unknown[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      const body = JSON.parse(String(init?.body)) as { scope: string };
      return Response.json(
        body.scope === 'once'
          ? { ok: true, scope: 'once', allowToken: 'tok_1', expiresAt: 1 }
          : { ok: true, scope: 'always' },
      );
    }) as typeof fetch;
    const refusal = parseAllowSendRefusal(409, refusalBody)!;
    const once = await allowSendWithoutCheck(allowSendBody(refusal, 'once'));
    expect(once).toMatchObject({ ok: true, scope: 'once', allowToken: 'tok_1' });
    const always = await allowSendWithoutCheck(allowSendBody(refusal, 'always'));
    expect(always).toEqual({ ok: true, scope: 'always' });
    expect(calls[0]).toMatchObject({ sendId: refusalBody.sendId, scope: 'once' });
  });

  test('a 403 for the identity check comes back as a value for the reverification wrapper', async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { code: 'verify_identity', clerk_error: { type: 'forbidden', reason: 'reverification-error' } },
        { status: 403 },
      )) as typeof fetch;
    const result = await postAllowSendOrCheck(
      allowSendBody(parseAllowSendRefusal(409, refusalBody)!, 'once'),
    );
    expect('check' in result && result.check).toBe(true);
    expect(isAllowSendCheckBody({ code: 'verify_identity' })).toBe(true);
    await expect(
      allowSendWithoutCheck(allowSendBody(parseAllowSendRefusal(409, refusalBody)!, 'once')),
    ).rejects.toMatchObject({
      code: 'verify_identity',
    });
  });

  test('a gone item or a store that is off throws the server line', async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { ok: false, code: 'off', error: 'Passwords and IDs is off.' },
        { status: 404 },
      )) as typeof fetch;
    await expect(
      postAllowSendOrCheck(allowSendBody(parseAllowSendRefusal(409, refusalBody)!, 'always')),
    ).rejects.toMatchObject({
      status: 404,
      code: 'off',
      message: 'Passwords and IDs is off.',
    });
  });
});
