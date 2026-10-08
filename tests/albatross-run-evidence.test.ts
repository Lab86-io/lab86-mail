import { describe, expect, test } from 'bun:test';
import { OBSERVED_PER_CALL, OBSERVED_TOTAL, observedEvidence } from '../lib/albatross/run-evidence';

// What a step run observed, as "Observed" lines for the proof check
// (docs/albatross-document-handoff.md, D1). Story: a run for the Harbor
// Design studio finds the client address and the hours sheet.

describe('observedEvidence', () => {
  test('no steps, an empty list, or steps without results give no text', () => {
    expect(observedEvidence(undefined)).toBe('');
    expect(observedEvidence(null)).toBe('');
    expect(observedEvidence([])).toBe('');
    expect(observedEvidence([{}, { toolResults: null }, { toolResults: [] }])).toBe('');
    expect(observedEvidence([null as never, undefined as never])).toBe('');
  });

  test('one line for each tool result, oldest first, with the trimmed tool name', () => {
    const text = observedEvidence([
      {
        toolResults: [{ toolName: 'search_threads', output: { threads: [{ from: 'billing@example.com' }] } }],
      },
      { toolResults: [{ toolName: ' document_get ', output: 'Hours: 42 in September' }] },
    ]);
    expect(text).toBe(
      [
        'Observed search_threads: {"threads":[{"from":"billing@example.com"}]}',
        'Observed document_get: Hours: 42 in September',
      ].join('\n'),
    );
  });

  test('skips the handoff and the personal and secure tools', () => {
    const skipped = [
      'step_handoff',
      'personal_details_get',
      'personal_details_save',
      'secure_details_list',
      'secure_fetch',
      'list_accounts',
      'spreadsheet_capabilities',
    ];
    const text = observedEvidence([
      {
        toolResults: [
          ...skipped.map((toolName) => ({ toolName, output: 'private value' })),
          { toolName: 'calendar_list_events', output: 'Studio review on Friday' },
        ],
      },
    ]);
    expect(text).toBe('Observed calendar_list_events: Studio review on Friday');
    expect(text).not.toContain('private value');
  });

  test('a result without a tool name or without a body is left out', () => {
    expect(
      observedEvidence([
        {
          toolResults: [
            { output: 'no name' },
            { toolName: '   ', output: 'blank name' },
            { toolName: 'search_threads' },
            { toolName: 'search_threads', output: null, result: null },
            { toolName: 'search_threads', output: '   ' },
            { toolName: 'search_threads', output: () => 'not JSON' },
          ],
        },
      ]),
    ).toBe('');
  });

  test('uses output first, then the older result field', () => {
    expect(
      observedEvidence([
        {
          toolResults: [
            { toolName: 'document_get', output: 'from output', result: 'from result' },
            { toolName: 'document_get', result: { title: 'Harbor Design invoice' } },
          ],
        },
      ]),
    ).toBe(
      ['Observed document_get: from output', 'Observed document_get: {"title":"Harbor Design invoice"}'].join(
        '\n',
      ),
    );
  });

  test('collapses white space in a result', () => {
    expect(
      observedEvidence([
        { toolResults: [{ toolName: 'read_thread', output: '  Hi,\n\n  the   hours\tare in. ' }] },
      ]),
    ).toBe('Observed read_thread: Hi, the hours are in.');
  });

  test('cuts each result at the per-call limit', () => {
    const long = 'x'.repeat(OBSERVED_PER_CALL + 50);
    const text = observedEvidence([{ toolResults: [{ toolName: 'read_thread', output: long }] }]);
    expect(text).toBe(`Observed read_thread: ${'x'.repeat(OBSERVED_PER_CALL)}`);
    expect(
      observedEvidence([{ toolResults: [{ toolName: 'read_thread', output: 'abcdefgh' }] }], { perCall: 3 }),
    ).toBe('Observed read_thread: abc');
  });

  test('keeps the newest lines when the total is over the limit', () => {
    const steps = ['first', 'second', 'third'].map((word) => ({
      toolResults: [{ toolName: 'search_threads', output: word }],
    }));
    // Each line is "Observed search_threads: <word>" plus one newline.
    const third = 'Observed search_threads: third';
    const second = 'Observed search_threads: second';
    expect(observedEvidence(steps, { total: third.length + 1 + second.length + 1 })).toBe(
      `${second}\n${third}`,
    );
    expect(observedEvidence(steps, { total: third.length + 1 })).toBe(third);
    // A newest line that is over the total alone stops the read: nothing older goes in.
    expect(observedEvidence(steps, { total: 5 })).toBe('');
  });

  test('the default total holds the newest results of a long run', () => {
    const steps = Array.from({ length: 20 }, (_, index) => ({
      toolResults: [{ toolName: 'read_thread', output: `${index}:${'y'.repeat(OBSERVED_PER_CALL)}` }],
    }));
    const text = observedEvidence(steps);
    expect(text.length).toBeLessThanOrEqual(OBSERVED_TOTAL);
    const lines = text.split('\n');
    expect(lines.at(-1)).toStartWith('Observed read_thread: 19:');
    expect(lines.length).toBeLessThan(20);
  });
});
