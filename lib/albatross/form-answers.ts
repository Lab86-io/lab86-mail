// The server side of a chat form answer (docs/albatross-thread.md). When the
// user answers an ask_form with "Save to my details" on, the client sends the
// transcript back to continue. Before the model reads it, the server saves
// the bound personal details and writes what it saved into the tool output
// (savedToDetails), so the model does not save them a second time.

import { type PersonalDetailsUser, saveAnsweredDetails } from '../personal-details/store';
import { boundDetailInputs, checkFormAnswer, parseFormQuestion } from './form-question';

function toolName(part: any): string {
  const type = String(part?.type || '');
  if (type === 'dynamic-tool') return String(part?.toolName || '');
  return type.startsWith('tool-') ? type.slice('tool-'.length) : '';
}

/**
 * The answered ask_form parts at the end of the newest assistant message: the
 * parts after its last text. Only these are new answers; an older answer was
 * handled on the request that followed it.
 */
function trailingFormIndexes(message: any): number[] {
  const parts: any[] = Array.isArray(message?.parts) ? message.parts : [];
  const indexes: number[] = [];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    const type = String(part?.type || '');
    if (type === 'step-start') continue;
    if (type !== 'dynamic-tool' && !type.startsWith('tool-')) break;
    if (toolName(part) === 'ask_form' && part.state === 'output-available') indexes.push(index);
  }
  return indexes;
}

export async function applyFormAnswers<M>(
  user: PersonalDetailsUser,
  messages: readonly M[],
  save: typeof saveAnsweredDetails = saveAnsweredDetails,
): Promise<M[]> {
  const last = messages.at(-1) as any;
  if (!last || last.role !== 'assistant') return [...messages];
  const indexes = trailingFormIndexes(last);
  if (!indexes.length) return [...messages];
  const parts = [...last.parts];
  for (const index of indexes) {
    const part = parts[index];
    const output = part.output && typeof part.output === 'object' ? part.output : {};
    if (output.save !== true || output.skipped === true || Array.isArray(output.savedToDetails)) continue;
    const form = parseFormQuestion(part.input);
    if (!form) continue;
    const checked = checkFormAnswer(form, output.values || {});
    const inputs = boundDetailInputs(form, checked.values);
    if (!inputs.length) continue;
    try {
      const result = await save(user, inputs);
      parts[index] = {
        ...part,
        output: {
          ...output,
          savedToDetails: result.saved.map((entry) => entry.label),
          ...(result.rejected.length ? { notSaved: result.rejected.map((entry) => entry.message) } : {}),
        },
      };
    } catch {
      parts[index] = {
        ...part,
        output: { ...output, savedToDetails: [], notSaved: ['The details were not saved. Try again later.'] },
      };
    }
  }
  return [...messages.slice(0, -1), { ...last, parts } as M];
}
