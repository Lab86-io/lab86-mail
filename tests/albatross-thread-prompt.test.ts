import { describe, expect, test } from 'bun:test';
import { steerMessage, threadUserNotes } from '../lib/albatross/step-run-prompt';
import { formatWorkChatContext } from '../lib/albatross/work-chat-context';

// What the chat and the runner read about a Work in the thread round
// (docs/albatross-thread.md).

const detail = {
  work: { _id: 'work-1', title: 'Register for the course', rawText: 'Register for Alive at 25 before Nov 2' },
  questions: [
    { _id: 'q-run', status: 'pending', prompt: 'Which class?' },
    { _id: 'q-plan', status: 'pending', prompt: 'Which court?' },
  ],
  execution: {
    guideSteps: [
      {
        key: 'step-1',
        title: 'Register for the course',
        runnable: true,
        run: {
          state: 'handed_off',
          outcome: 'needs_answer',
          summary: 'Found three classes.',
          next: {
            kind: 'answer',
            label: 'Answer',
            detail: 'Pick a class.',
            target: { kind: 'question', id: 'q-run' },
          },
        },
      },
      {
        key: 'step-2',
        title: 'Attend the court date',
        runnable: false,
        run: null,
      },
      {
        key: 'step-3',
        title: 'Save the certificate',
        runnable: true,
        run: { state: 'running', log: [{ text: 'Opened the portal.' }] },
      },
    ],
  },
};

describe('the Work chat context', () => {
  const context = formatWorkChatContext(detail);

  test('it lists each step with its key and what its run waits on', () => {
    expect(context).toContain('Steps and their runs (stepKey in brackets):');
    expect(context).toContain('1. [step-1] Register for the course — waits on the user (answer: Answer)');
    expect(context).toContain('   It asked: Pick a class.');
    expect(context).toContain('2. [step-2] Attend the court date — the user does it');
    expect(context).toContain('3. [step-3] Save the certificate — a run works on it now');
    expect(context).toContain('   Now: Opened the portal.');
  });

  test('a question a run asked is marked for albatross_handle_step; a planner question is not', () => {
    expect(context).toContain(
      '[questionId: q-run] [asked by a step run: answer with albatross_handle_step] Which class?',
    );
    expect(context).toContain('[questionId: q-plan] Which court?');
  });

  test('the chat rules name the run tool and the details tool', () => {
    expect(context).toContain('call albatross_handle_step with this workId');
    expect(context).toContain('never offer to email someone instead of filling a web form');
    expect(context).toContain('call personal_details_save as well');
  });

  test('the runner gets the reference data without the chat rules or the step list', () => {
    const runner = formatWorkChatContext(detail, { audience: 'runner' });
    expect(runner).toContain('--- END UNTRUSTED WORK REFERENCE DATA ---');
    expect(runner).not.toContain('Behavior for this attached Work');
    expect(runner).not.toContain('Steps and their runs');
    expect(runner).not.toContain('albatross_handle_step');
  });
});

describe('runner thread helpers', () => {
  test('threadUserNotes keeps the newest eight user texts, oldest first', () => {
    const messages = [
      { role: 'assistant', parts: [{ type: 'text', text: 'Hello' }] },
      ...Array.from({ length: 10 }, (_, index) => ({
        role: 'user',
        parts: [
          { type: 'text', text: `Note  ${index}` },
          { type: 'file', url: 'x' },
        ],
      })),
      { role: 'user', parts: [{ type: 'text', text: '   ' }] },
    ];
    const notes = threadUserNotes(messages);
    expect(notes).toHaveLength(8);
    expect(notes[0]).toBe('Note 2');
    expect(notes.at(-1)).toBe('Note 9');
  });

  test('steerMessage lists each note and says not to start again', () => {
    expect(steerMessage(['Use Monday.', 'Skip the newsletter box.'])).toEqual({
      role: 'user',
      content:
        'The user says while you work:\n- Use Monday.\n- Skip the newsletter box.\nFollow this now, from where you are. Do not start the step again.',
    });
  });
});
