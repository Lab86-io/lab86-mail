import { QUICK_SEARCH_QUERIES } from './search/constants';

export const PRIMARY_MAIL_VIEWS = [
  { id: 'main', label: 'Main' },
  { id: 'needs_reply', label: 'Needs reply' },
  { id: 'noise', label: 'Noise' },
] as const;

export const MORE_MAIL_VIEWS = [
  { id: 'needs_action', label: 'Needs action' },
  { id: 'waiting_for', label: 'Waiting for' },
  { id: 'important_changes', label: 'Changes' },
  { id: 'codes', label: 'Codes' },
  { id: 'orders', label: 'Orders' },
  { id: 'finance_admin', label: 'Finance / admin' },
  { id: 'review', label: 'Review' },
] as const;

export const MAILBOXES = [
  { query: QUICK_SEARCH_QUERIES.unread, label: 'Unread' },
  { query: QUICK_SEARCH_QUERIES.starred, label: 'Starred' },
  { query: QUICK_SEARCH_QUERIES.important, label: 'Important' },
  { query: QUICK_SEARCH_QUERIES.attachments, label: 'Attachments' },
  { query: QUICK_SEARCH_QUERIES.thisWeek, label: 'This week' },
  { query: QUICK_SEARCH_QUERIES.sent, label: 'Sent' },
  { query: QUICK_SEARCH_QUERIES.drafts, label: 'Drafts' },
  { query: QUICK_SEARCH_QUERIES.allMail, label: 'All mail' },
  { query: 'label:MailOS/Snoozed', label: 'Snoozed' },
  { query: QUICK_SEARCH_QUERIES.trash, label: 'Trash' },
];

export function mailNavigationSelection(
  category: string | null,
  query: string,
  customLabels: Array<{ _id: string; name: string }>,
) {
  const folder = !category ? MAILBOXES.find((item) => item.query === query) : undefined;
  const extra = [
    ...MORE_MAIL_VIEWS,
    ...customLabels.map((item) => ({ id: `custom:${item._id}`, label: item.name })),
  ].find((item) => item.id === category);
  return { folder, moreLabel: folder?.label || extra?.label || 'More', moreActive: Boolean(folder || extra) };
}
