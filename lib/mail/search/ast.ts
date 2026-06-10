export type SearchProvider = 'google' | 'microsoft' | 'icloud' | 'imap';
export type SearchExecutionTier = 'local' | 'structured' | 'native';

export type SearchClause =
  | { type: 'folder'; value: string; negated?: boolean }
  | { type: 'unread'; value: boolean; negated?: boolean }
  | { type: 'starred'; value: boolean; negated?: boolean }
  | { type: 'important'; value: boolean; negated?: boolean }
  | { type: 'attachment'; value: boolean; negated?: boolean }
  | { type: 'from'; value: string; negated?: boolean }
  | { type: 'to'; value: string; negated?: boolean }
  | { type: 'subject'; value: string; negated?: boolean }
  | { type: 'after'; value: string; negated?: boolean }
  | { type: 'before'; value: string; negated?: boolean }
  | { type: 'text'; value: string; negated?: boolean }
  | { type: 'or'; clauses: SearchClause[]; negated?: boolean };

export interface SearchAst {
  kind: 'mail-search';
  clauses: SearchClause[];
  originalQuery?: string;
}

export interface SearchUnsupportedClause {
  clause: SearchClause;
  reason: string;
}

export interface SearchExecutionPlan {
  tier: SearchExecutionTier;
  provider: SearchProvider;
  ast: SearchAst;
  queryParams: Record<string, unknown>;
  dropped: SearchUnsupportedClause[];
  originalQuery?: string;
}
