import { describe, expect, test } from 'bun:test';
import { answerFromForm } from '../lib/albatross/form-answer-route';
import { applyFormAnswers } from '../lib/albatross/form-answers';
import type { FormQuestion } from '../lib/albatross/thread-contract';

// Form answers: the chat path (the agent route saves bound details before the
// model reads the answer) and the Work question path (the answer route).

const user = { userId: 'user_a', name: 'Sam Rivera', email: 'sam.rivera@example.com' };
const form: FormQuestion = {
  title: 'Which class?',
  fields: [
    {
      id: 'class',
      label: 'Class',
      kind: 'choice',
      options: [
        { id: 'mon', label: 'Monday' },
        { id: 'wed', label: 'Wednesday' },
      ],
    },
    { id: 'phone', label: 'Phone', kind: 'phone', detailKey: 'phone' },
  ],
};

function saver(
  labels: string[] = ['Phone'],
  rejected: Array<{ key: string; code: any; message: string }> = [],
) {
  const calls: any[] = [];
  const save = async (_user: unknown, inputs: any[]) => {
    calls.push(inputs);
    return { saved: labels.map((label) => ({ label }) as any), rejected };
  };
  return { calls, save: save as any };
}

const answeredPart = (output: Record<string, unknown>) => ({
  type: 'tool-ask_form',
  toolCallId: 'call_1',
  state: 'output-available',
  input: form,
  output,
});

describe('applyFormAnswers (chat)', () => {
  test('a new answer with save on saves the bound details and marks the output', async () => {
    const { calls, save } = saver();
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Register me' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'One question.' },
          { type: 'step-start' },
          answeredPart({ values: { class: 'mon', phone: '555 555 0100' }, save: true }),
        ],
      },
    ];
    const result = await applyFormAnswers(user, messages, save);
    expect(calls).toEqual([[{ key: 'phone', value: '555 555 0100' }]]);
    expect((result[1] as any).parts[2].output).toMatchObject({ savedToDetails: ['Phone'] });
    // The input array is not changed in place.
    expect((messages[1] as any).parts[2].output.savedToDetails).toBeUndefined();
  });

  test('save off, a skip, or an older answer saves nothing', async () => {
    const { calls, save } = saver();
    await applyFormAnswers(
      user,
      [
        {
          id: 'a',
          role: 'assistant',
          parts: [answeredPart({ values: { phone: '555 555 0100' }, save: false })],
        },
      ],
      save,
    );
    await applyFormAnswers(
      user,
      [{ id: 'a', role: 'assistant', parts: [answeredPart({ values: {}, save: true, skipped: true })] }],
      save,
    );
    // Text after the form means the model already continued past this answer.
    await applyFormAnswers(
      user,
      [
        {
          id: 'a',
          role: 'assistant',
          parts: [
            answeredPart({ values: { phone: '555 555 0100' }, save: true }),
            { type: 'text', text: 'Thanks.' },
          ],
        },
      ],
      save,
    );
    await applyFormAnswers(user, [{ id: 'u', role: 'user', parts: [] }], save);
    expect(calls).toEqual([]);
  });

  test('a failed save tells the model that nothing was saved', async () => {
    const save = (async () => {
      throw new Error('down');
    }) as any;
    const result = await applyFormAnswers(
      user,
      [
        {
          id: 'a',
          role: 'assistant',
          parts: [answeredPart({ values: { class: 'mon', phone: '555 555 0100' }, save: true })],
        },
      ],
      save,
    );
    expect((result[0] as any).parts[0].output).toMatchObject({
      savedToDetails: [],
      notSaved: [expect.any(String)],
    });
  });

  test('refusals reach the model as notSaved', async () => {
    const { save } = saver(
      [],
      [{ key: 'phone', code: 'refused', message: 'Albatross does not keep card numbers.' }],
    );
    const result = await applyFormAnswers(
      user,
      [
        {
          id: 'a',
          role: 'assistant',
          parts: [answeredPart({ values: { class: 'mon', phone: '555 555 0100' }, save: true })],
        },
      ],
      save,
    );
    expect((result[0] as any).parts[0].output.notSaved).toEqual(['Albatross does not keep card numbers.']);
  });
});

describe('answerFromForm (Work questions)', () => {
  const pending = { status: 'pending', prompt: form.title, form };

  test('a typed form is checked, saved when asked, and written without detail values', async () => {
    const { calls, save } = saver();
    const result = await answerFromForm(
      user,
      'q1',
      { values: { class: 'wed', phone: '555 555 0100' }, save: true },
      { readQuestion: async () => pending, saveDetails: save },
    );
    expect(calls).toHaveLength(1);
    expect(result).toEqual({
      ok: true,
      answer:
        "Class: Wednesday\nPhone: saved to your personal details\nSaved to the user's personal details: Phone.",
      note: "Class: Wednesday\nPhone: saved to the user's personal details (read it with personal_details_get)\nSaved to the user's personal details: Phone.",
      savedLabels: ['Phone'],
    });
  });

  test('an unsaved detail stays out of the record but reaches the run', async () => {
    const { save } = saver([]);
    const result = await answerFromForm(
      user,
      'q1',
      { values: { class: 'mon', phone: '555 555 0100' }, save: false },
      { readQuestion: async () => pending, saveDetails: save },
    );
    if (!result.ok) throw new Error('expected an answer');
    expect(result.answer).toBe('Class: Monday\nPhone: given in the form');
    expect(result.answer).not.toContain('555');
    expect(result.note).toBe('Class: Monday\nPhone: (555) 555-0100');
  });

  test('bad fields come back per field, and nothing is saved', async () => {
    const { calls, save } = saver();
    const result = await answerFromForm(
      user,
      'q1',
      { values: { phone: 'x' }, save: true },
      {
        readQuestion: async () => pending,
        saveDetails: save,
      },
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'Check the answers.',
      errors: { class: 'Choose one.', phone: 'Type a phone number.' },
    });
    expect(calls).toEqual([]);
  });

  test('a missing or closed question is refused', async () => {
    expect(await answerFromForm(user, 'q1', {}, { readQuestion: async () => null })).toMatchObject({
      status: 404,
    });
    expect(
      await answerFromForm(
        user,
        'q1',
        {},
        { readQuestion: async () => ({ ...pending, status: 'answered' }) },
      ),
    ).toMatchObject({ status: 409 });
  });

  test('a planner question keeps its label and option id answer', async () => {
    const legacy = {
      status: 'pending',
      prompt: 'Which venue?',
      options: [
        { id: 'hall', label: 'The hall' },
        { id: 'park', label: 'The park' },
      ],
    };
    expect(
      await answerFromForm(
        user,
        'q1',
        { values: { answer: 'park' }, save: false },
        { readQuestion: async () => legacy },
      ),
    ).toEqual({ ok: true, answer: 'The park', answeredOptionId: 'park', savedLabels: [] });
    expect(
      await answerFromForm(
        user,
        'q1',
        { values: { answer: { choices: [], other: 'The beach' } } },
        { readQuestion: async () => legacy },
      ),
    ).toEqual({ ok: true, answer: 'The beach', answeredOptionId: undefined, savedLabels: [] });
    expect(
      await answerFromForm(
        user,
        'q1',
        { values: { answer: 'Next Tuesday' } },
        { readQuestion: async () => ({ status: 'pending', prompt: 'When?' }) },
      ),
    ).toEqual({ ok: true, answer: 'Next Tuesday', savedLabels: [] });
  });
});
