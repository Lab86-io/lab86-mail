import { describe, expect, test } from 'bun:test';
import {
  boundDetailInputs,
  checkFieldValue,
  checkFormAnswer,
  formAnswerText,
  parseFormQuestion,
} from '../lib/albatross/form-question';
import {
  type FormQuestion,
  formQuestionSchema,
  isPersonalDetailKey,
  isWorkThreadSessionId,
  legacyQuestionToForm,
  mergeThreadTimeline,
  type ThreadRunView,
  threadQuestionForm,
  workThreadSessionId,
} from '../lib/albatross/thread-contract';

// Form questions and the thread contract (docs/albatross-thread.md).

const classForm: FormQuestion = {
  title: 'Which class?',
  fields: [
    {
      id: 'class',
      label: 'Class',
      kind: 'choice',
      options: [
        {
          id: 'mon',
          label: 'Monday, October 19',
          detail: '4:00–8:00 PM · Zoom · $70',
          recommended: 'Matches what you said',
        },
        {
          id: 'wed',
          label: 'Wednesday, October 21',
          calendar: { fit: 'conflict', note: 'Conflicts with Team sync' },
        },
      ],
    },
    { id: 'phone', label: 'Phone', kind: 'phone', detailKey: 'phone' },
    { id: 'address', label: 'Home address', kind: 'address', detailKey: 'home_address' },
    { id: 'employer', label: 'Employer', kind: 'text', detailKey: 'custom:employer', required: false },
    { id: 'when', label: 'Start date', kind: 'date', required: false },
  ],
};

describe('form schema', () => {
  test('a valid form parses', () => {
    expect(parseFormQuestion(classForm)).not.toBeNull();
  });

  test('choice fields need options, other kinds must not have them', () => {
    expect(
      formQuestionSchema.safeParse({ title: 'x', fields: [{ id: 'a', label: 'A', kind: 'choice' }] }).success,
    ).toBe(false);
    expect(
      formQuestionSchema.safeParse({
        title: 'x',
        fields: [
          {
            id: 'a',
            label: 'A',
            kind: 'text',
            options: [
              { id: '1', label: '1' },
              { id: '2', label: '2' },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  test('ids must be unique, keys known, and only one option recommended', () => {
    expect(
      formQuestionSchema.safeParse({
        title: 'x',
        fields: [
          { id: 'a', label: 'A', kind: 'text' },
          { id: 'a', label: 'B', kind: 'text' },
        ],
      }).success,
    ).toBe(false);
    expect(
      formQuestionSchema.safeParse({
        title: 'x',
        fields: [{ id: 'a', label: 'A', kind: 'text', detailKey: 'ssn' }],
      }).success,
    ).toBe(false);
    expect(
      formQuestionSchema.safeParse({
        title: 'x',
        fields: [
          {
            id: 'a',
            label: 'A',
            kind: 'choice',
            options: [
              { id: '1', label: '1', recommended: 'Best' },
              { id: '2', label: '2', recommended: 'Also best' },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('checking answers', () => {
  test('a complete answer normalizes each kind', () => {
    const checked = checkFormAnswer(classForm, {
      class: 'mon',
      phone: '(555) 555-0100',
      address: {
        line1: '12 Elm Street',
        city: 'Springfield',
        region: 'IL',
        postalCode: '62704',
        country: 'us',
      },
      employer: '  Acme  ',
    });
    expect(checked.ok).toBe(true);
    expect(checked.values.class).toEqual({ choices: ['mon'] });
    expect(checked.values.address).toMatchObject({ country: 'US' });
    expect(checked.values.employer).toBe('Acme');
    expect(checked.values.when).toBeUndefined();
  });

  test('missing required fields and bad values get user copy per field', () => {
    const checked = checkFormAnswer(classForm, {
      class: { choices: ['nope'] },
      phone: 'call me',
      when: '2026-02-30',
    });
    expect(checked.ok).toBe(false);
    expect(checked.errors).toEqual({
      class: 'Choose one.',
      phone: 'Type a phone number.',
      address: 'This is required.',
      when: 'Choose a date.',
    });
  });

  test('choice rules: one for a single choice, Other only when allowed', () => {
    const field = {
      id: 'c',
      label: 'C',
      kind: 'choice' as const,
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    };
    expect(checkFieldValue(field, ['a', 'b'])).toEqual({ error: 'Choose only one.' });
    expect(checkFieldValue({ ...field, multiple: true }, ['a', 'b'])).toEqual({
      value: { choices: ['a', 'b'] },
    });
    expect(checkFieldValue(field, { choices: [], other: 'Friday' })).toEqual({ error: 'Choose one.' });
    expect(checkFieldValue({ ...field, allowOther: true }, { choices: [], other: 'Friday' })).toEqual({
      value: { choices: [], other: 'Friday' },
    });
  });

  test('email, number, name, and contact kinds', () => {
    expect(checkFieldValue({ id: 'e', label: 'E', kind: 'email' }, 'sam@example.com')).toEqual({
      value: 'sam@example.com',
    });
    expect(checkFieldValue({ id: 'e', label: 'E', kind: 'email' }, 'nope')).toEqual({
      error: 'Type an email address.',
    });
    expect(checkFieldValue({ id: 'n', label: 'N', kind: 'number' }, '2')).toEqual({ value: '2' });
    expect(checkFieldValue({ id: 'n', label: 'N', kind: 'name' }, { first: 'Sam' })).toEqual({
      error: 'Type the first and last name.',
    });
    expect(
      checkFieldValue({ id: 'c', label: 'C', kind: 'contact' }, { name: 'Alex', phone: '555 555 0111' }),
    ).toEqual({
      value: { name: 'Alex', phone: '555 555 0111' },
    });
  });

  test('bound fields become personal detail inputs only for a matching kind', () => {
    const checked = checkFormAnswer(classForm, {
      class: 'mon',
      phone: '555 555 0100',
      address: {
        line1: '12 Elm Street',
        city: 'Springfield',
        region: 'IL',
        postalCode: '62704',
        country: 'US',
      },
      employer: 'Acme',
    });
    expect(boundDetailInputs(classForm, checked.values)).toEqual([
      { key: 'phone', value: '555 555 0100' },
      { key: 'home_address', value: expect.objectContaining({ city: 'Springfield' }) },
      { key: 'custom:employer', value: 'Acme', label: 'Employer' },
    ]);
    const mismatched: FormQuestion = {
      title: 'x',
      fields: [{ id: 'p', label: 'P', kind: 'text', detailKey: 'phone' }],
    };
    expect(boundDetailInputs(mismatched, { p: '555' })).toEqual([]);
  });

  test('the answer text names options and the saved details', () => {
    const checked = checkFormAnswer(classForm, {
      class: 'mon',
      phone: '+15555550100',
      address: {
        line1: '12 Elm Street',
        city: 'Springfield',
        region: 'IL',
        postalCode: '62704',
        country: 'US',
      },
    });
    expect(formAnswerText(classForm, checked.values, ['Phone'])).toBe(
      [
        'Class: Monday, October 19 (4:00–8:00 PM · Zoom · $70)',
        'Phone: (555) 555-0100',
        'Home address: 12 Elm Street, Springfield, IL 62704, US',
        "Saved to the user's personal details: Phone.",
      ].join('\n'),
    );
    expect(formAnswerText(classForm, {})).toBe('The user answered.');
  });
});

describe('thread contract', () => {
  test('a planner question becomes a one-field form', () => {
    expect(
      legacyQuestionToForm({
        prompt: 'Which venue?',
        options: [
          { id: 'a', label: 'Hall' },
          { id: 'b', label: 'Park' },
        ],
      }),
    ).toEqual({
      title: 'Which venue?',
      fields: [
        {
          id: 'answer',
          label: 'Answer',
          kind: 'choice',
          options: [
            { id: 'a', label: 'Hall' },
            { id: 'b', label: 'Park' },
          ],
          allowOther: true,
        },
      ],
    });
    expect(legacyQuestionToForm({ prompt: 'When?', reason: 'For the invite.' }).fields[0].kind).toBe('text');
    expect(
      threadQuestionForm({
        id: 'q',
        form: null,
        prompt: 'When?',
        reason: null,
        options: null,
        status: 'pending',
        answer: null,
        answeredIn: null,
      }).title,
    ).toBe('When?');
  });

  test('canonical session ids fit the chats id rule', () => {
    expect(workThreadSessionId('k57abc123')).toBe('work-k57abc123');
    expect(workThreadSessionId('a/b c')).toBe('work-abc');
    expect(isWorkThreadSessionId('work-k57abc123')).toBe(true);
    expect(isWorkThreadSessionId('chat-123456')).toBe(false);
    expect(/^[a-zA-Z0-9_-]{8,64}$/.test(workThreadSessionId('x'.repeat(200)))).toBe(true);
  });

  test('personal detail keys', () => {
    expect(isPersonalDetailKey('phone')).toBe(true);
    expect(isPersonalDetailKey('custom:shoe-size')).toBe(true);
    expect(isPersonalDetailKey('custom:')).toBe(false);
    expect(isPersonalDetailKey('custom:Bad Key')).toBe(false);
    expect(isPersonalDetailKey(7)).toBe(false);
  });

  const run = (id: string, createdAt: number, parentRunId: string | null = null) =>
    ({ id, createdAt, parentRunId }) as unknown as ThreadRunView;
  type Message = { id: string; at?: number; started?: string[] };
  const read = {
    createdAt: (message: Message) => message.at,
    startedRunIds: (message: Message) => message.started || [],
  };

  test('the timeline sorts by time, keeps untimed messages first, and drops inline runs', () => {
    const messages: Message[] = [
      { id: 'old' },
      { id: 'u1', at: 100 },
      { id: 'a1', at: 110, started: ['r2'] },
      { id: 'u2', at: 300 },
    ];
    const items = mergeThreadTimeline(messages, [run('r1', 50), run('r2', 120), run('r3', 200, 'r1')], read);
    expect(items.map((item) => (item.kind === 'message' ? item.message.id : item.run.id))).toEqual([
      'old',
      'r1',
      'u1',
      'a1',
      'r3',
      'u2',
    ]);
    const continued = items.find((item) => item.kind === 'run' && item.run.id === 'r3');
    expect(continued && continued.kind === 'run' && continued.continues).toBe(true);
  });

  test('a run whose parent is not in the list does not show as continued', () => {
    const [item] = mergeThreadTimeline<Message>([], [run('r9', 10, 'gone')], read);
    expect(item.kind === 'run' && item.continues).toBe(false);
  });
});

describe('formAnswerText modes', () => {
  const values = {
    class: { choices: ['mon'] },
    phone: '+15555550100',
    employer: 'Acme',
  } as Record<string, any>;

  test('record mode never shows a detail value', () => {
    const text = formAnswerText(classForm, values, ['Phone'], { details: 'record' });
    expect(text).toContain('Phone: saved to your personal details');
    expect(text).toContain('Employer: given in the form');
    expect(text).not.toContain('555');
    expect(text).not.toContain('Acme');
  });

  test('run mode keeps unsaved detail values so the run can type them', () => {
    const text = formAnswerText(classForm, values, ['Phone'], { details: 'run' });
    expect(text).toContain("Phone: saved to the user's personal details (read it with personal_details_get)");
    expect(text).toContain('Employer: Acme');
  });
});
