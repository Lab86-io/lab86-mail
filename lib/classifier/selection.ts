import { api, convexMutation, convexQuery } from '../hosted/convex';
import { type ClassifierModel, resolveClassifier } from './catalog';

export interface ClassifierSelection {
  classifierId: string | null;
  revision: number;
}

// Every sweep, search rerank and demo resolves the classifier; a short cache
// keeps that to one Convex read per instance while a switch lands within seconds.
const CACHE_MS = 10_000;
let cached: { at: number; selection: ClassifierSelection } | null = null;

export async function loadClassifierSelection(query = convexQuery): Promise<ClassifierSelection> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.selection;
  const selection = await query<ClassifierSelection>((api as any).classifier.selection, {});
  cached = { at: Date.now(), selection };
  return selection;
}

export async function loadSelectedClassifier(): Promise<ClassifierModel> {
  return resolveClassifier((await loadClassifierSelection()).classifierId);
}

export async function saveClassifierSelection(
  input: { classifierId: string; revision: number; updatedBy: string },
  mutate = convexMutation,
) {
  const result = await mutate<{ classifierId: string; revision: number; requeued: boolean }>(
    (api as any).classifier.select,
    input,
  );
  cached = null;
  return result;
}
