import type { SearchAst, SearchClause } from './ast';

const TOKEN_RE = /"[^"]+"|\([^)]*\)|\S+/g;

export function parseMailSearchQuery(query: string): SearchAst {
  const clauses: SearchClause[] = [];
  for (const rawToken of query.match(TOKEN_RE) || []) {
    const negated = rawToken.startsWith('-');
    const token = negated ? rawToken.slice(1) : rawToken;
    const clause = parseToken(token, negated);
    if (clause) clauses.push(clause);
  }
  return { kind: 'mail-search', clauses, originalQuery: query };
}

function parseToken(token: string, negated: boolean): SearchClause | null {
  const [operator, rawValue] = splitOperator(token);
  const value = stripQuotes(rawValue);
  if (!operator) return value ? { type: 'text', value, negated } : null;

  switch (operator) {
    case 'in':
    case 'label':
    case 'category':
      return { type: 'folder', value, negated };
    case 'is':
      if (value === 'unread') return { type: 'unread', value: true, negated };
      if (value === 'read') return { type: 'unread', value: false, negated };
      if (value === 'starred') return { type: 'starred', value: true, negated };
      if (value === 'important') return { type: 'important', value: true, negated };
      return { type: 'text', value: `${operator}:${value}`, negated };
    case 'has':
      if (value === 'attachment') return { type: 'attachment', value: true, negated };
      return { type: 'text', value: `${operator}:${value}`, negated };
    case 'from':
      return { type: 'from', value, negated };
    case 'to':
    case 'cc':
    case 'bcc':
      return { type: 'to', value, negated };
    case 'subject':
      return { type: 'subject', value, negated };
    case 'newer_than':
    case 'after':
      return { type: 'after', value: dateValue(value), negated };
    case 'older_than':
    case 'before':
      return { type: 'before', value: dateValue(value), negated };
    default:
      return { type: 'text', value: `${operator}:${value}`, negated };
  }
}

function splitOperator(token: string): [string, string] | ['', string] {
  const index = token.indexOf(':');
  if (index < 1) return ['', stripQuotes(token)];
  return [token.slice(0, index).toLowerCase(), token.slice(index + 1)];
}

function stripQuotes(value: string) {
  return value.replace(/^"|"$/g, '').trim();
}

function dateValue(value: string) {
  const relative = value.match(/^(\d+)([dwmy])$/i);
  if (!relative) return value;
  const amount = Number(relative[1]);
  const unit = relative[2].toLowerCase();
  const days = unit === 'd' ? amount : unit === 'w' ? amount * 7 : unit === 'm' ? amount * 30 : amount * 365;
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}
