export interface QuestionIdentity {
  workId?: string;
  projectId?: string;
  routineId?: string;
  kind?: string;
  prompt: string;
}

/**
 * Keep the user's question queue conversational instead of form-like. This is
 * deliberately conservative: punctuation, casing, and generic lead-ins do not
 * create a new question, while a materially different noun or outcome does.
 */
export function canonicalQuestionPrompt(prompt: string) {
  return prompt
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(?:please|quick question|one thing|before i continue)\b/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]*(?:can|could|would|will) you\s+/iu, '')
    .replace(/^do you (?:want|mean|prefer)\s+/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function stableHash(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function questionDedupeKey(input: QuestionIdentity) {
  const target = input.routineId
    ? `routine:${input.routineId}`
    : input.projectId
      ? `project:${input.projectId}`
      : input.workId
        ? `work:${input.workId}`
        : 'global';
  const canonical = canonicalQuestionPrompt(input.prompt);
  return `question:${target}:${input.kind || 'question'}:${stableHash(canonical)}`;
}

export function shouldAdvanceWorkAfterAnswer(kind: string, answer: string) {
  return kind !== 'completion' || !/^(yes|done|completed|finished)$/i.test(answer.trim());
}
