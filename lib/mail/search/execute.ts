import type { SearchProvider } from './ast';
import { compileQueryToNylasStructuredParams } from './compiler';

export function planStructuredProviderSearch(input: {
  provider: SearchProvider;
  query: string;
  max: number;
  pageToken?: string;
}) {
  return compileQueryToNylasStructuredParams(input);
}
