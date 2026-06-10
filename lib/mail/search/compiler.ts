import type {
  SearchAst,
  SearchClause,
  SearchExecutionPlan,
  SearchProvider,
  SearchUnsupportedClause,
} from './ast';
import { epochSecondsForDayEnd, epochSecondsForDayStart } from './dates';
import { googleFolderId, normalizeFolder } from './folders';
import { parseMailSearchQuery } from './parser';

export interface CompileSearchOptions {
  provider: SearchProvider;
  tier?: 'local' | 'structured';
  limit: number;
  pageToken?: string;
}

// Marker key for folder clauses that need provider-side resolution (Microsoft
// and IMAP folder ids are opaque, so the transport layer resolves the
// canonical name against the grant's folder list before calling Nylas).
export const UNRESOLVED_FOLDER_PARAM = '__resolveFolder';

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
    applyStructuredClause(queryParams, dropped, clause, options.provider);
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

// Verbatim native plan: the user's query string is passed straight through to
// the provider's own search engine. Nylas only allows in/limit/page_token as
// companions to search_query_native, so nothing else is compiled.
export function buildNativeSearchPlan({
  provider,
  query,
  max,
  pageToken,
}: {
  provider: SearchProvider;
  query: string;
  max: number;
  pageToken?: string;
}): SearchExecutionPlan {
  const queryParams: Record<string, unknown> = {
    limit: Math.min(max, 80),
    search_query_native: query,
  };
  if (pageToken) queryParams.page_token = pageToken;
  return {
    tier: 'native',
    provider,
    ast: parseMailSearchQuery(query),
    queryParams,
    dropped: [],
    originalQuery: query,
  };
}

function applyStructuredClause(
  queryParams: Record<string, unknown>,
  dropped: SearchUnsupportedClause[],
  clause: SearchClause,
  provider: SearchProvider,
) {
  if (clause.negated) {
    dropped.push({ clause, reason: 'structured search does not support negation yet' });
    return;
  }

  switch (clause.type) {
    case 'folder': {
      if (provider === 'google') {
        const folderId = googleFolderId(clause.value);
        if (!folderId) {
          dropped.push({ clause, reason: 'folder has no Gmail system label equivalent' });
          return;
        }
        setFirst(queryParams, 'in', folderId, dropped, clause);
        return;
      }
      setFirst(queryParams, UNRESOLVED_FOLDER_PARAM, normalizeFolder(clause.value), dropped, clause);
      return;
    }
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
    case 'after': {
      const epochSeconds = epochSecondsForDayStart(clause.value);
      if (epochSeconds === null) {
        dropped.push({ clause, reason: 'unparseable date' });
        return;
      }
      setFirst(queryParams, 'latest_message_after', epochSeconds, dropped, clause);
      return;
    }
    case 'before': {
      const epochSeconds = epochSecondsForDayEnd(clause.value);
      if (epochSeconds === null) {
        dropped.push({ clause, reason: 'unparseable date' });
        return;
      }
      setFirst(queryParams, 'latest_message_before', epochSeconds, dropped, clause);
      return;
    }
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
  value: string | number,
  dropped: SearchUnsupportedClause[],
  clause: SearchClause,
) {
  if (queryParams[key] !== undefined) {
    dropped.push({ clause, reason: `structured search already has a ${key} filter` });
    return;
  }
  queryParams[key] = value;
}
