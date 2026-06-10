export interface SearchAccountCandidate {
  accountId: string;
  email?: string;
  displayName?: string;
}

export interface AccountScopedQuery {
  query: string;
  accountIds: string[] | null;
  accountLabels: string[];
}

const ACCOUNT_FILTER_RE = /(^|\s)(?:account|mailbox):("[^"]+"|\S+)/gi;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function resolveAccountScopedQuery(
  query: string,
  accounts: SearchAccountCandidate[],
): AccountScopedQuery {
  const filters: string[] = [];
  const stripped = query
    .replace(ACCOUNT_FILTER_RE, (_match, prefix: string, raw: string) => {
      filters.push(stripQuotes(raw));
      return prefix || ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();

  if (!filters.length) return { query: stripped || query.trim(), accountIds: null, accountLabels: [] };

  const matches = new Map<string, SearchAccountCandidate>();
  for (const filter of filters) {
    for (const account of accounts) {
      if (accountMatchesFilter(account, filter)) matches.set(account.accountId, account);
    }
  }

  return {
    query: stripped,
    accountIds: [...matches.keys()],
    accountLabels: [...matches.values()].map(
      (account) => account.displayName || account.email || account.accountId,
    ),
  };
}

export function applyNaturalLanguageAccountHint(description: string, query: string) {
  const email = accountEmailFromDescription(description);
  if (!email || /\b(?:account|mailbox):/i.test(query)) return query;

  const fromToken = new RegExp(`(^|\\s)from:${escapeRegExp(email)}(?=\\s|$)`, 'i');
  if (fromToken.test(query)) {
    return query.replace(fromToken, (_match, prefix: string) => `${prefix}account:${email}`);
  }
  return `account:${email} ${query}`.trim();
}

function accountEmailFromDescription(description: string) {
  const text = description.trim();
  const email = text.match(EMAIL_RE)?.[0];
  if (!email) return null;

  const afterEmail = new RegExp(`${escapeRegExp(email)}\\s+(?:account|mailbox)\\b`, 'i');
  const beforeEmail = new RegExp(`\\b(?:account|mailbox)\\s+(?:for\\s+)?${escapeRegExp(email)}\\b`, 'i');
  if (afterEmail.test(text) || beforeEmail.test(text)) return email;
  return null;
}

function accountMatchesFilter(account: SearchAccountCandidate, filter: string) {
  const needle = normalize(filter);
  const values = [account.accountId, account.email, account.displayName, account.email?.split('@')[0]].filter(
    Boolean,
  ) as string[];
  return values.some((value) => normalize(value) === needle);
}

function stripQuotes(value: string) {
  return value.replace(/^"|"$/g, '').trim();
}

function normalize(value: string) {
  return stripQuotes(value).toLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
