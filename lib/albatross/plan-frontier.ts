import {
  type BriefDocumentV2,
  type BriefNode,
  type BriefRegion,
  parseBriefDocument,
} from '../shared/brief-document';

/**
 * The frontier: a plan document grows section by section until it needs an
 * answer. The gate region carries the one open question — options as real
 * choices, free text always — and an outline of the steps that wait behind it.
 *
 * The gate is built here, deterministically, never by the composing model.
 * A page must not depend on a model remembering to render its own door.
 */

export const FRONTIER_GATE_REGION_ID = 'frontier-gate';

export interface FrontierQuestionOption {
  id: string;
  title: string;
  detail?: string;
  address?: string;
  hoursText?: string;
  website?: string;
}

export interface FrontierQuestion {
  id: string;
  prompt: string;
  options?: FrontierQuestionOption[];
}

export interface FrontierStep {
  key?: string;
  title: string;
}

const clamp = (value: string, max: number) => value.trim().slice(0, max);

function optionDescription(option: FrontierQuestionOption): string | undefined {
  const parts = [option.detail, option.address, option.hoursText].filter((part): part is string =>
    Boolean(part?.trim()),
  );
  return parts.length ? clamp(parts.join(' · '), 500) : undefined;
}

/** Build the gate region for one open question plus the steps that wait. */
export function frontierGateRegion(input: {
  workId: string;
  question: FrontierQuestion;
  steps?: FrontierStep[];
}): BriefRegion {
  const { workId, question } = input;
  const children: Record<string, unknown>[] = [];

  const options = (question.options || []).filter((option) => option.title?.trim()).slice(0, 6);
  if (options.length >= 2) {
    children.push({
      kind: 'decision',
      title: clamp(question.prompt, 160),
      options: options.map((option, index) => ({
        id: option.id || `option-${index + 1}`,
        label: clamp(option.title, 160),
        description: optionDescription(option),
        action: {
          action: 'answer_question',
          label: 'Choose this',
          payload: {
            questionId: question.id,
            text: option.title,
            answeredOptionId: option.id || `option-${index + 1}`,
          },
          style: 'primary',
        },
      })),
      sourceRefs: [{ kind: 'work', id: workId }],
    });
  } else {
    children.push({ kind: 'text', role: 'body', text: clamp(question.prompt, 4000) });
  }

  children.push({
    kind: 'prompt',
    variant: 'question',
    questionId: question.id,
    placeholder: options.length >= 2 ? 'Or answer in your own words' : 'Answer in your own words',
  });

  const steps = (input.steps || []).filter((step) => step.title?.trim()).slice(0, 24);
  if (steps.length) {
    children.push({
      kind: 'checklist',
      title: 'What waits behind this answer',
      items: steps.map((step) => ({
        label: clamp(step.title, 500),
        checked: false,
        stepKey: step.key,
      })),
    });
  }

  return {
    id: FRONTIER_GATE_REGION_ID,
    summary: 'One question is open. The rest of the plan continues after the answer.',
    tree: {
      kind: 'group',
      title: 'Answer this to continue',
      kicker: 'The plan pauses here',
      surface: 'elevated',
      emphasis: 'primary',
      tone: 'warning',
      collapsible: false,
      children: children as unknown as BriefNode[],
    } as unknown as BriefNode,
  } as BriefRegion;
}

/**
 * Append the gate to a composed document, replacing any earlier gate. The
 * result is re-parsed so a malformed gate can never corrupt a stored document.
 */
export function appendFrontierGate(
  document: BriefDocumentV2,
  input: { workId: string; question: FrontierQuestion; steps?: FrontierStep[] },
): BriefDocumentV2 {
  const regions = document.regions.filter((region) => region.id !== FRONTIER_GATE_REGION_ID).slice(0, 11);
  return parseBriefDocument({
    ...document,
    regions: [...regions, frontierGateRegion(input)],
  });
}

/** True when the document already carries a gate for this question. */
export function hasFrontierGate(document: unknown, questionId?: string): boolean {
  const regions = (document as BriefDocumentV2 | null)?.regions;
  if (!Array.isArray(regions)) return false;
  const gate = regions.find((region) => region?.id === FRONTIER_GATE_REGION_ID);
  if (!gate) return false;
  if (!questionId) return true;
  let found = false;
  walkNodes(gate.tree, (node) => {
    const record = node as Record<string, unknown>;
    if (record.kind === 'prompt' && record.questionId === questionId) found = true;
  });
  return found;
}

function walkNodes(node: BriefNode, visit: (node: BriefNode) => void) {
  visit(node);
  const children = (node as { children?: BriefNode[] }).children;
  if (Array.isArray(children)) for (const child of children) walkNodes(child, visit);
}

/**
 * A stored document is plain validated JSON, so a JSON round-trip clones it
 * losslessly. structuredClone is avoided on purpose: these helpers run inside
 * Convex mutations, and the Convex runtime is not the browser.
 */
function cloneDocument(document: unknown): BriefDocumentV2 {
  return JSON.parse(JSON.stringify(document)) as BriefDocumentV2;
}

/**
 * The durable question row is created after the document is composed, so the
 * gate is first written with the planner's inline id. This rebinds every
 * reference to the durable id the answer endpoint expects.
 */
export function bindFrontierQuestionId(
  document: unknown,
  legacyQuestionId: string,
  durableQuestionId: string,
): { document: unknown; changed: boolean } {
  if (!document || legacyQuestionId === durableQuestionId) return { document, changed: false };
  let changed = false;
  const next = cloneDocument(document);
  if (!Array.isArray(next.regions)) return { document, changed: false };
  for (const region of next.regions) {
    walkNodes(region.tree, (node) => {
      const record = node as Record<string, unknown>;
      if (record.kind === 'prompt' && record.questionId === legacyQuestionId) {
        record.questionId = durableQuestionId;
        changed = true;
      }
      if (record.kind === 'decision' && Array.isArray(record.options)) {
        for (const option of record.options as Array<Record<string, unknown>>) {
          const action = option.action as Record<string, unknown> | undefined;
          const payload = action?.payload as Record<string, unknown> | undefined;
          if (action?.action === 'answer_question' && payload?.questionId === legacyQuestionId) {
            payload.questionId = durableQuestionId;
            changed = true;
          }
        }
      }
    });
  }
  return { document: next, changed };
}

/**
 * After apply, plan steps exist as real cards. Bind each checklist item that
 * names a stepKey to its card so the checkbox becomes a live toggle_task and
 * every surface reads the same record.
 */
export function bindPlanDocumentSteps(
  document: unknown,
  appliedSteps: Array<{ stepKey?: string; cardId?: string }>,
): { document: unknown; bound: number } {
  if (!document) return { document, bound: 0 };
  const cardByStep = new Map<string, string>();
  for (const step of appliedSteps) {
    if (step.stepKey && step.cardId) cardByStep.set(step.stepKey, String(step.cardId));
  }
  if (!cardByStep.size) return { document, bound: 0 };
  let bound = 0;
  const next = cloneDocument(document);
  if (!Array.isArray(next.regions)) return { document, bound: 0 };
  for (const region of next.regions) {
    walkNodes(region.tree, (node) => {
      const record = node as Record<string, unknown>;
      if (record.kind !== 'checklist' || !Array.isArray(record.items)) return;
      for (const item of record.items as Array<Record<string, unknown>>) {
        const stepKey = typeof item.stepKey === 'string' ? item.stepKey : undefined;
        const cardId = stepKey ? cardByStep.get(stepKey) : undefined;
        if (!cardId) continue;
        item.ref = { kind: 'card', id: cardId };
        item.action = {
          action: 'toggle_task',
          label: 'Mark done',
          payload: { cardId },
          style: 'quiet',
        };
        bound += 1;
      }
    });
  }
  return { document: next, bound };
}
