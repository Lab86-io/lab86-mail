export const DEFAULT_MAIL_QUERY = 'in:inbox newer_than:30d';

export const SMART_CATEGORY_CANDIDATE_QUERIES: Record<string, string> = {
  main: 'in:inbox (category:primary OR is:important) -in:trash -in:spam',
  needs_reply: 'in:inbox (category:primary OR is:important) -in:trash -in:spam',
  waiting: 'in:inbox (category:primary OR is:important) -in:trash -in:spam',
  codes: 'newer_than:30d (code OR verification OR login OR security OR "magic link") -in:trash -in:spam',
  orders:
    'newer_than:90d (order OR shipped OR delivery OR tracking OR refund OR receipt OR invoice OR booking) -in:trash -in:spam',
  finance_admin:
    'newer_than:180d (invoice OR billing OR payment OR tax OR legal OR contract OR subscription) -in:trash -in:spam',
  noise: 'newer_than:30d -in:trash -in:spam',
  default: 'in:inbox newer_than:45d -in:trash -in:spam',
};

export const QUICK_SEARCH_QUERIES = {
  inbox: DEFAULT_MAIL_QUERY,
  unread: 'is:unread newer_than:30d',
  starred: 'is:starred newer_than:365d',
  important: 'is:important newer_than:60d',
  icloud: 'from:(icloud.com OR me.com) newer_than:365d',
  attachments: 'has:attachment newer_than:90d',
  thisWeek: 'newer_than:7d',
  sent: 'in:sent newer_than:365d',
  drafts: 'in:drafts newer_than:365d',
  allMail: '-in:trash newer_than:365d',
  trash: 'in:trash newer_than:365d',
} as const;
