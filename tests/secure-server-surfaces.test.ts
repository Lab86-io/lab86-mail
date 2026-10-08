import { afterEach, describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { z } from 'zod';
import { runWithAiRequestContext } from '../lib/ai/context';
import { AgentBrowser } from '../lib/albatross/browser-agent';
import { predictRoute } from '../lib/albatross/route-client';
import { secureRunnerBlock } from '../lib/albatross/step-run-prompt';
import { addSecureFetchTool, buildRunnerTools } from '../lib/albatross/step-run-tools';
import { exportSecureItems } from '../lib/hosted/data-export';
import { redactUserMessages } from '../lib/secure/redact';
import { SecureRefused, type SecureRunAccess } from '../lib/secure/runner-access';
import { SecureScrubber } from '../lib/secure/scrub';
import { saveChatSession } from '../lib/store/chat-sessions';
import { secureDetailsList, secureDetailsToolDeps } from '../lib/tools/secure-details';

// Where Passwords and IDs meets the rest: the chat tool, the export, the
// runner's error results, the prompt block, and the saved chat
// (docs/albatross-secure-store.md).

const original = { ...secureDetailsToolDeps };
afterEach(() => Object.assign(secureDetailsToolDeps, original));

const ctx = { agent: 'ai' as const, userId: 'user-1' };
const license = 'D1234821';

describe('secure_details_list', () => {
  test('lists the inventory, or says the store is off', async () => {
    secureDetailsToolDeps.enabled = () => false;
    expect(await secureDetailsList.handler(undefined, ctx)).toEqual({
      enabled: false,
      items: [],
      message: 'Passwords and IDs is not available for this account.',
    });
    secureDetailsToolDeps.enabled = () => true;
    secureDetailsToolDeps.inventory = async () => [
      { id: 'si_1', kind: 'sign_in', label: 'Chase', sites: ['chase.com'], fields: ['password', 'username'] },
    ];
    expect(await secureDetailsList.handler(undefined, ctx)).toEqual({
      enabled: true,
      items: [
        {
          id: 'si_1',
          kind: 'sign_in',
          label: 'Chase',
          sites: ['chase.com'],
          fields: ['password', 'username'],
        },
      ],
    });
    await expect(secureDetailsList.handler(undefined, { agent: 'ai' })).rejects.toThrow(/signed-in/);
  });
});

test('the export lists items without hints or sealed values', async () => {
  const rows = await exportSecureItems('user-1', (async (ref: any, args: any) => {
    expect(getFunctionName(ref)).toBe('secureDetails:listItems');
    expect(args).toEqual({ userId: 'user-1' });
    return [
      {
        itemId: 'si_1',
        kind: 'id_number',
        label: "Driver's license",
        sites: ['ny.gov'],
        hints: [{ field: 'number', hint: 'ends 4821' }],
        facts: [{ name: 'type', value: 'drivers_license' }],
        createdAt: 1,
        updatedAt: 2,
      },
    ];
  }) as any);
  expect(rows).toEqual([
    {
      id: 'si_1',
      kind: 'id_number',
      label: "Driver's license",
      sites: ['ny.gov'],
      facts: { type: 'drivers_license' },
      createdAt: 1,
      updatedAt: 2,
      lastUsedAt: null,
    },
  ]);
});

describe('runner tools with saved values', () => {
  function secureAccess(): SecureRunAccess {
    const scrubber = new SecureScrubber();
    scrubber.add([license], "Driver's license");
    return {
      cleanPage: async (_url: string, parts: readonly string[]) => parts.map((part) => scrubber.scrub(part)),
      cleanText: (text: string) => scrubber.scrub(text),
      resolveForField: async () => {
        throw new SecureRefused('Only the user types sign-in codes and card data.');
      },
      resolveForFetch: async () => ({ value: 'k', label: 'OpenAI key' }),
      pendingAllow: () => null,
      signInOffer: async () => null,
    };
  }

  function host(browser: AgentBrowser | null, secure: SecureRunAccess | null) {
    return {
      log: async () => undefined,
      artifact: async () => undefined,
      browser: async () => {
        if (!browser) throw new Error('no browser');
        return browser;
      },
      browserStatus: async () => undefined,
      enqueueApproval: async () => 'a1',
      finish: () => undefined,
      browserAvailable: true,
      secure,
    };
  }

  test('a refusal is a plain error result; a page error never shows a saved value', async () => {
    const secure = secureAccess();
    const page = {
      goto: async () => {
        throw new Error(`Navigation failed near ${license}`);
      },
      url: () => 'https://dmv.ny.gov',
      title: async () => 'DMV',
      snapshot: async () => '- textbox "Code" [ref=e1]',
      click: async () => undefined,
      fill: async () => undefined,
      select: async () => undefined,
      press: async () => undefined,
      back: async () => undefined,
      wait: async () => undefined,
      inputKind: async () => ({
        type: 'text',
        autocomplete: 'one-time-code',
        documentUrl: 'https://dmv.ny.gov',
      }),
      text: async () => '',
    };
    const browser = new AgentBrowser(page, secure);
    const tools = buildRunnerTools({}, host(browser, secure));
    await tools.browser_snapshot.execute({});
    expect(
      await tools.browser_type.execute({ ref: 'e1', text: '{{secure:si_x0000000000000000000.number}}' }),
    ).toEqual({
      ok: false,
      message: 'Only the user types sign-in codes and card data.',
    });
    const failed = await tools.browser_open.execute({ url: 'https://dmv.ny.gov' });
    expect(failed.ok).toBe(false);
    expect(failed.message).not.toContain(license);
    expect(failed.message).toContain("[secure: Driver's license]");
    expect(tools.browser_type.description).toContain('{{secure:<id>.<field>}}');
    expect(buildRunnerTools({}, host(null, null)).browser_type.description).not.toContain('secure');
  });

  test('secure_fetch exists only with the store and maps the header list', async () => {
    expect(addSecureFetchTool({}, null)).toEqual({});
    const tools = addSecureFetchTool({}, secureAccess());
    expect(tools.secure_fetch.inputSchema).toBeDefined();
    const result = await tools.secure_fetch.execute({
      url: 'http://api.openai.com/',
      headers: [{ name: 'Authorization', value: 'Bearer {{secure:si_k0000000000000000000.key}}' }],
    });
    expect(result).toEqual({ ok: false, message: 'secure_fetch calls https addresses only.' });
    void z;
  });

  test('the prompt block lists items and rules without values', () => {
    const block = secureRunnerBlock([
      { id: 'si_1', kind: 'sign_in', label: 'Chase', sites: ['chase.com'], fields: ['password', 'username'] },
      {
        id: 'si_2',
        kind: 'date_of_birth',
        label: 'Date of birth',
        sites: [],
        fields: ['date'],
        ageYears: 36,
      },
      {
        id: 'si_3',
        kind: 'id_number',
        label: 'Passport',
        sites: [],
        fields: ['number'],
        idType: 'passport',
        country: 'US',
        expired: true,
      },
      {
        id: 'si_4',
        kind: 'api_key',
        label: 'OpenAI',
        sites: ['api.openai.com'],
        fields: ['key'],
        header: 'x-api-key',
      },
    ]);
    expect(block).toContain('- si_1 · sign-in "Chase" · sites chase.com · fields password, username');
    expect(block).toContain('- si_2 · date of birth "Date of birth" (age 36) · sites none yet · fields date');
    expect(block).toContain('(passport, US, expired)');
    expect(block).toContain('(header x-api-key)');
    expect(block).toContain('Never write a reference or a guess of a saved value');
    expect(secureRunnerBlock([])).toContain('(Nothing is saved.)');
  });
});

test('a saved chat never keeps a secret the user wrote', async () => {
  const ssn = ['123', '-45-', '6789'].join('');
  await runWithAiRequestContext({ userId: 'secure-chat-user', agent: 'ai' }, async () => {
    const saved = await saveChatSession('secure-chat-1', [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: `My SSN is ${ssn}` }] },
    ]);
    expect(JSON.stringify(saved.messages)).not.toContain('6789');
    expect((saved.messages[0] as any).parts[0].text).toBe(
      'My SSN is [removed: looks like a Social Security number]',
    );
  });
});

test('a saved chat title never keeps a secret, from the messages or from the client', async () => {
  const ssn = ['123', '-45-', '6789'].join('');
  await runWithAiRequestContext({ userId: 'secure-title-user', agent: 'ai' }, async () => {
    const fromMessages = await saveChatSession('secure-title-1', [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: `My SSN is ${ssn} please file` }] },
    ]);
    expect(fromMessages.title).not.toContain('6789');
    const fromClient = await saveChatSession('secure-title-2', [], `File ${ssn}`);
    expect(fromClient.title).toBe('File [removed: looks like a Social Security number]');
  });
});

test('every question answer is redacted, not only forms', () => {
  const ssn = ['123', '-45-', '6789'].join('');
  const [message] = redactUserMessages([
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'tool-ask_user', toolCallId: 't1', output: { response: `use ${ssn}` } },
        { type: 'dynamic-tool', toolName: 'ask_question_flow', toolCallId: 't2', output: { answers: [ssn] } },
      ],
    },
  ]) as any[];
  expect(message.parts[0].output.response).toBe('use [removed: looks like a Social Security number]');
  expect(message.parts[1].output.answers[0]).toBe('[removed: looks like a Social Security number]');
});

test('the route prediction never sends a secret from the draft', async () => {
  const bodies: string[] = [];
  await predictRoute(`my ssn is ${['123', '-45-', '6789'].join('')}`, {
    fetchImpl: (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ ok: true, route: 'ask', confidence: 0.5 }));
    }) as any,
  });
  expect(bodies[0]).not.toContain('6789');
});
