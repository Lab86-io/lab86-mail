/**
 * The messages the reader marks read when a thread opens. The provider's
 * `unread` flag is the truth for every provider; the Gmail `UNREAD` label
 * exists only on Gmail, so iCloud and Outlook threads never matched it.
 * The label is read only when a row has no `unread` flag (older cache rows).
 */
export function unreadMessageIds(
  messages: Array<{ _id?: string | null; unread?: boolean | null; labels?: string[] | null }>,
): string[] {
  return messages
    .filter((m) => (typeof m.unread === 'boolean' ? m.unread : Boolean(m.labels?.includes('UNREAD'))))
    .map((m) => m._id)
    .filter((id): id is string => Boolean(id));
}
