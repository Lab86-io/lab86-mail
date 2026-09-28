import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { RecipientInput } from '../components/compose/RecipientInput';
import {
  addChips,
  formatRecipient,
  formatRecipients,
  highlightParts,
  isCompleteAddress,
  parseRecipientText,
  splitAddressList,
} from '../lib/contacts/address-field';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let view: ReactTestRenderer | undefined;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (view) await act(async () => view?.unmount());
  view = undefined;
});

describe('address field helpers', () => {
  test('split, parse, and format a pasted list', () => {
    expect(splitAddressList('"Doe, Ann" <ann@x.io>; bob@y.io\ncy@z.io, ')).toEqual([
      '"Doe, Ann" <ann@x.io>',
      'bob@y.io',
      'cy@z.io',
    ]);
    const chips = parseRecipientText(
      '"Doe, Ann" <ANN@x.io>, bob@y.io, ann@x.io, not valid, not valid, <c@d.io>',
    );
    expect(chips).toEqual([
      { email: 'ann@x.io', name: 'Doe Ann', valid: true },
      { email: 'bob@y.io', valid: true },
      { email: '', valid: false, raw: 'not valid' },
      { email: 'c@d.io', valid: true },
    ]);
    expect(formatRecipients(chips, ' dr')).toBe('Doe Ann <ann@x.io>, bob@y.io, not valid, c@d.io, dr');
    expect(formatRecipient({ email: 'e@f.io', name: 'Eve, "E"', valid: true })).toBe('Eve E <e@f.io>');
    expect(formatRecipient({ email: '', valid: false, raw: 'a,b;c' })).toBe('a b c');
    expect(formatRecipient({ email: '', valid: false })).toBe('');
    expect(parseRecipientText('bob@y.io <bob@y.io>')).toEqual([{ email: 'bob@y.io', valid: true }]);
  });

  test('complete addresses, chip dedupe, and highlight parts', () => {
    expect(isCompleteAddress('ann@x.io')).toBe(true);
    expect(isCompleteAddress('Ann <ann@x.io>')).toBe(true);
    expect(isCompleteAddress('ann@x')).toBe(false);
    expect(isCompleteAddress('see ann@x.io now')).toBe(false);
    expect(isCompleteAddress('  ')).toBe(false);
    const chips = addChips(
      [{ email: 'a@b.io', valid: true }],
      [
        { email: 'a@b.io', name: 'A', valid: true },
        { email: '', valid: false, raw: 'x' },
        { email: '', valid: false, raw: 'x' },
      ],
    );
    expect(chips).toHaveLength(2);
    expect(
      highlightParts('Jakob Langtry', [
        { start: 6, length: 1 },
        { start: 0, length: 1 },
      ]),
    ).toEqual([
      { text: 'J', match: true },
      { text: 'akob ', match: false },
      { text: 'L', match: true },
      { text: 'angtry', match: false },
    ]);
    expect(highlightParts('abc', [{ start: 1, length: 5 }])).toEqual([{ text: 'abc', match: false }]);
    expect(
      highlightParts('abc', [
        { start: 0, length: 2 },
        { start: 1, length: 1 },
      ]),
    ).toEqual([
      { text: 'ab', match: true },
      { text: 'c', match: false },
    ]);
    expect(highlightParts('', [])).toEqual([{ text: '', match: false }]);
  });
});

describe('RecipientInput', () => {
  const people = [
    {
      email: 'jakob@lab86.io',
      name: 'Jakob Langtry',
      alternateEmails: [],
      savedContact: true,
      directory: false,
      sources: ['addressBook'],
      sentCount: 3,
      receivedCount: 1,
      highlights: [{ field: 'name', start: 0, length: 2 }],
      score: 100,
    },
    {
      email: 'jane@partner.example',
      alternateEmails: [],
      savedContact: false,
      directory: false,
      sources: ['mail'],
      sentCount: 1,
      receivedCount: 0,
      highlights: [{ field: 'email', start: 0, length: 2 }],
      score: 90,
    },
  ];

  async function mount(initial = '') {
    const requests: string[] = [];
    const values: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json({ ok: true, items: people });
    }) as unknown as typeof fetch;
    let setOutside: (value: string) => void = () => undefined;
    function Harness() {
      const [value, setValue] = useState(initial);
      setOutside = setValue;
      return (
        <RecipientInput
          label="To"
          value={value}
          fromAccount="acct_work"
          onChange={(next) => {
            values.push(next);
            setValue(next);
          }}
        />
      );
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      view = create(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      );
    });
    const input = () => view!.root.findByType('input');
    const key = async (name: string) => {
      const event = { key: name, preventDefault() {}, stopPropagation() {} };
      await act(async () => input().props.onKeyDown(event));
    };
    const type = async (text: string) => {
      await act(async () => input().props.onChange({ target: { value: text } }));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
    };
    const options = () => view!.root.findAll((node) => node.props?.role === 'option' && node.type === 'div');
    const chips = () =>
      view!.root
        .findAll((node) => node.type === 'span' && typeof node.props.title === 'string')
        .map((node) => node.props.title);
    return {
      requests,
      values,
      input,
      key,
      type,
      options,
      chips,
      setOutside: (v: string) => act(async () => setOutside(v)),
    };
  }

  test('focus shows top people; typing searches; Enter picks the first row', async () => {
    const field = await mount();
    await act(async () => field.input().props.onFocus());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
    expect(field.requests[0]).toContain('/api/contacts/recipients?q=&limit=8&from=acct_work');
    expect(field.options()).toHaveLength(2);
    await field.type('ja');
    expect(field.requests.at(-1)).toContain('q=ja');
    await field.key('Enter');
    expect(field.values.at(-1)).toBe('Jakob Langtry <jakob@lab86.io>');
    expect(field.chips()).toEqual(['Jakob Langtry <jakob@lab86.io>']);
    // Picked addresses are excluded from the next search.
    await field.type('j');
    expect(field.requests.at(-1)).toContain('exclude=jakob%40lab86.io');
  });

  test('arrows move the selection; Tab picks; Escape closes; Backspace removes the last chip', async () => {
    const field = await mount();
    await act(async () => field.input().props.onFocus());
    await field.type('ja');
    await field.key('ArrowDown');
    await field.key('ArrowDown');
    await field.key('ArrowUp');
    await field.key('ArrowDown');
    await field.key('Tab');
    expect(field.values.at(-1)).toBe('jane@partner.example');
    await field.key('Escape');
    expect(field.options()).toHaveLength(0);
    await field.key('Backspace');
    expect(field.values.at(-1)).toBe('');
    // With nothing typed, Enter picks a row only after an arrow key.
    await field.key('ArrowDown');
    await field.key('Enter');
    expect(field.values.at(-1)).toBe('Jakob Langtry <jakob@lab86.io>');
  });

  test('comma, space after an address, paste, and blur make chips', async () => {
    const field = await mount();
    await act(async () => field.input().props.onFocus());
    await field.type('new@else.io');
    await field.key(' ');
    expect(field.values.at(-1)).toBe('new@else.io');
    await field.type('bad value');
    await field.key(',');
    expect(field.chips()).toEqual(['new@else.io', 'This address is not valid.']);
    const pasted = { clipboardData: { getData: () => 'Ann <ann@x.io>, bob@y.io' }, preventDefault() {} };
    await act(async () => field.input().props.onPaste(pasted));
    expect(field.values.at(-1)).toBe('new@else.io, bad value, Ann <ann@x.io>, bob@y.io');
    // Plain text pastes as text.
    let prevented = false;
    await act(async () =>
      field.input().props.onPaste({
        clipboardData: { getData: () => 'plain' },
        preventDefault() {
          prevented = true;
        },
      }),
    );
    expect(prevented).toBe(false);
    await field.type('cy@z.io');
    await act(async () => field.input().props.onBlur());
    expect(field.values.at(-1)).toBe('new@else.io, bad value, Ann <ann@x.io>, bob@y.io, cy@z.io');
    // A chip's remove button takes it out.
    const remove = view!.root.findAll((node) => node.type === 'button')[0];
    await act(async () => remove.props.onClick({ stopPropagation() {} }));
    expect(field.values.at(-1)).toBe('bad value, Ann <ann@x.io>, bob@y.io, cy@z.io');
  });

  test('a new value from outside replaces the chips; clicking a row picks it', async () => {
    const field = await mount('Old <old@x.io>');
    expect(field.chips()).toEqual(['Old <old@x.io>']);
    await field.setOutside('');
    expect(field.chips()).toEqual([]);
    await act(async () => field.input().props.onFocus());
    await field.type('j');
    const row = field.options()[1];
    await act(async () => row.props.onMouseEnter());
    await act(async () => row.props.onClick());
    expect(field.values.at(-1)).toBe('jane@partner.example');
  });
});
