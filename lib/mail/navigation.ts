import { QUICK_SEARCH_QUERIES } from './search/constants';

export const PRIMARY_MAIL_VIEWS = [
  { id: 'main', label: 'Main' },
  { id: 'needs_reply', label: 'Needs reply' },
  { id: 'noise', label: 'Noise' },
  { id: 'codes', label: 'Codes' },
] as const;

export const MORE_MAIL_VIEWS = [
  { id: 'needs_action', label: 'Needs action' },
  { id: 'waiting_for', label: 'Waiting for' },
  { id: 'important_changes', label: 'Changes' },
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
  { query: QUICK_SEARCH_QUERIES.trash, label: 'Trash' },
];

// Lists that open in a dialog from the More menu. They are not thread views:
// scheduled sends wait at the provider, and snoozed threads stay archived
// until their time comes.
export const MAIL_LISTS = [
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'snoozed', label: 'Snoozed' },
] as const;

export type MailListId = (typeof MAIL_LISTS)[number]['id'];

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
