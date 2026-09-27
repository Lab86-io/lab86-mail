/**
 * Hosted typed-decision classifiers selectable for the whole deployment.
 *
 * Every entry answers the same typed questions (choice / noul); adapters in
 * `./client` translate them to the provider's wire protocol. Thresholds live
 * here because each model's probabilities are calibrated differently — never
 * reuse one model's cutoffs for another without an eval run
 * (`scripts/eval-jev-mail.ts --model <id>`).
 */

export type ClassifierProtocol = 'systemone' | 'together-choice';
export type ClassifierCredential = 'openrouter' | 'together';

export interface ClassifierThresholds {
  /** Minimum purpose-choice confidence before the assessment is accepted. */
  purposeConfidence: number;
  /** A noul probability strictly between low and high is uncertain. */
  noulLow: number;
  /** A noul probability at or above this establishes the fact. */
  noulHigh: number;
  /** Minimum confidence for the selected evidence message. */
  evidenceConfidence: number;
}

export interface ClassifierModel {
  id: string;
  label: string;
  vendor: string;
  description: string;
  protocol: ClassifierProtocol;
  credential: ClassifierCredential;
  endpoint: string;
  /** Model identifier sent on the wire. */
  wireModel: string;
  /** Served model identifiers the adapter accepts back. */
  responseModel: RegExp;
  /** Largest choice option count the model accepts, including `none`. */
  maxOptions: number;
  /** Whether probabilities are native (true) or derived from token logprobs. */
  nativeProbabilities: boolean;
  thresholds: ClassifierThresholds;
  /** USD per million input tokens; output is free for every current entry. */
  inputPerMillion: number;
  /** `evaluated` passed the synthetic mail probe; `experimental` has not. */
  status: 'evaluated' | 'experimental';
}

export const CLASSIFIER_MODELS: readonly ClassifierModel[] = [
  {
    id: 'jev-1.13',
    label: 'Jev 1.13',
    vendor: 'TypeSafe via OpenRouter',
    description:
      'Native typed decisions with calibrated probabilities. Answers every question in one request.',
    protocol: 'systemone',
    credential: 'openrouter',
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    wireModel: 'typesafe/jev-1.13',
    responseModel: /^typesafe\/jev-1\.13(?:-\d{8})?$/,
    maxOptions: 255,
    nativeProbabilities: true,
    thresholds: { purposeConfidence: 0.6, noulLow: 0.25, noulHigh: 0.75, evidenceConfidence: 0.5 },
    inputPerMillion: 0.042,
    status: 'evaluated',
  },
  {
    id: 'tev1-4b',
    label: 'Tev1 4B (experimental)',
    vendor: 'Together AI',
    description:
      'Choice-only decision model. Yes/no questions become two options; probabilities come from token logprobs, one request per question.',
    protocol: 'together-choice',
    credential: 'together',
    endpoint: 'https://api.together.ai/v1/chat/completions',
    wireModel: 'together/Tev1-4B-experimental',
    responseModel: /^(?:together|togethercomputer)\/Tev1-4B-experimental$/i,
    maxOptions: 24,
    nativeProbabilities: false,
    // Logprobs are model preferences, not calibrated confidence; stricter
    // cutoffs keep uncertain mail in review until an eval run retunes them.
    thresholds: { purposeConfidence: 0.7, noulLow: 0.2, noulHigh: 0.8, evidenceConfidence: 0.6 },
    inputPerMillion: 0.042,
    status: 'experimental',
  },
];

export const DEFAULT_CLASSIFIER_ID = 'jev-1.13';

export function classifierById(id: string | null | undefined): ClassifierModel | undefined {
  return CLASSIFIER_MODELS.find((model) => model.id === id);
}

/** The deployment default: `LAB86_MAIL_CLASSIFIER` when it names a catalog entry, else Jev. */
export function defaultClassifier(env: Record<string, string | undefined> = process.env): ClassifierModel {
  return classifierById(env.LAB86_MAIL_CLASSIFIER) || classifierById(DEFAULT_CLASSIFIER_ID)!;
}

/** Resolve a stored selection, ignoring ids removed from the catalog. */
export function resolveClassifier(
  selectedId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): ClassifierModel {
  return classifierById(selectedId) || defaultClassifier(env);
}

/** Map a served model name (as stored on assessments and usage) back to its catalog entry. */
export function classifierForServedModel(served: string): ClassifierModel | undefined {
  return CLASSIFIER_MODELS.find((model) => model.responseModel.test(served));
}
