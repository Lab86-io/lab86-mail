import type {
  SearchAst,
  SearchClause,
  SearchExecutionPlan,
  SearchProvider,
  SearchUnsupportedClause,
} from './ast';
import { parseMailSearchQuery } from './parser';

export interface CompileSearchOptions {
  provider: SearchProvider;
  tier?: 'local' | 'structured';
  limit: number;
  pageToken?: string;
}

export function compileMailSearch(ast: SearchAst, options: CompileSearchOptions): SearchExecutionPlan {
  const tier = options.tier || 'structured';
  const dropped: SearchUnsupportedClause[] = [];
  const queryParams: Record<string, unknown> = {
    limit: Math.min(options.limit, 80),
  };
  if (options.pageToken) queryParams.page_token = options.pageToken;

  if (tier === 'local') {
    return {
      tier,
      provider: options.provider,
      ast,
      queryParams,
      dropped,
      originalQuery: ast.originalQuery,
    };
  }

  for (const clause of ast.clauses) {
    applyStructuredClause(queryParams, dropped, clause);
  }

  return {
    tier,
    provider: options.provider,
    ast,
    queryParams,
    dropped,
    originalQuery: ast.originalQuery,
  };
}

export function compileQueryToNylasStructuredParams({
  provider,
  query,
  max,
  pageToken,
}: {
  provider: SearchProvider;
  query: string;
  max: number;
  pageToken?: string;
}) {
  return compileMailSearch(parseMailSearchQuery(query), {
    provider,
    tier: 'structured',
    limit: max,
    pageToken,
  });
}

function applyStructuredClause(
  queryParams: Record<string, unknown>,
  dropped: SearchUnsupportedClause[],
  clause: SearchClause,
) {
  if (clause.negated) {
    dropped.push({ clause, reason: 'structured search does not support negation yet' });
    return;
  }

  switch (clause.type) {
    case 'folder':
      setFirst(queryParams, 'in', normalizeFolder(clause.value), dropped, clause);
      return;
    case 'unread':
      queryParams.unread = clause.value;
      return;
    case 'starred':
      queryParams.starred = clause.value;
      return;
    case 'important':
      dropped.push({ clause, reason: 'structured search does not expose provider importance' });
      return;
    case 'attachment':
      queryParams.has_attachment = clause.value;
      return;
    case 'from':
      setFirst(queryParams, 'from', clause.value, dropped, clause);
      return;
    case 'to':
      setFirst(queryParams, 'to', clause.value, dropped, clause);
      return;
    case 'subject':
      setFirst(queryParams, 'subject', clause.value, dropped, clause);
      return;
    case 'after':
      setFirst(queryParams, 'latest_message_after', clause.value, dropped, clause);
      return;
    case 'before':
      setFirst(queryParams, 'latest_message_before', clause.value, dropped, clause);
      return;
    case 'or':
      dropped.push({ clause, reason: 'structured search does not support OR groups yet' });
      return;
    case 'text':
      dropped.push({ clause, reason: 'structured search does not support free-text body search yet' });
      return;
  }
}

function setFirst(
  queryParams: Record<string, unknown>,
  key: string,
  value: string,
  dropped: SearchUnsupportedClause[],
  clause: SearchClause,
) {
  if (queryParams[key] !== undefined) {
    dropped.push({ clause, reason: `structured search already has a ${key} filter` });
    return;
  }
  queryParams[key] = value;
}

function normalizeFolder(value: string) {
  const lower = value.toLowerCase();
  if (lower === 'sent') return 'SENT';
  if (lower === 'draft' || lower === 'drafts') return 'DRAFTS';
  if (lower === 'trash') return 'TRASH';
  if (lower === 'spam') return 'SPAM';
  if (lower === 'inbox') return 'INBOX';
  if (lower === 'archive' || lower === 'archived') return 'ARCHIVE';
  return value;
}
