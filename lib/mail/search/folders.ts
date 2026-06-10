export type CanonicalFolder = 'INBOX' | 'SENT' | 'DRAFTS' | 'TRASH' | 'SPAM' | 'ARCHIVE' | 'ALL';

export const SYSTEM_LABEL_ALIASES = {
  INBOX: ['INBOX', 'Inbox', '\\Inbox'],
  SENT: ['SENT', 'Sent', 'Sent Items', 'Sent Mail', '\\Sent'],
  DRAFTS: ['DRAFT', 'DRAFTS', 'Draft', 'Drafts', '\\Drafts'],
  TRASH: ['TRASH', 'Trash', 'Deleted Items', 'DeletedItems', '\\Trash'],
  SPAM: ['SPAM', 'Spam', 'Junk', 'Junk Email', 'JunkEmail', '\\Junk'],
  ARCHIVE: ['ARCHIVE', 'Archive', 'Archived', 'All Mail', '\\Archive'],
} as const;

// Gmail system label ids are stable and double as Nylas folder ids for Google
// grants. Gmail has no ARCHIVE label (archive = absence of INBOX), so it has
// no entry here and must be dropped/special-cased by callers.
const GOOGLE_FOLDER_IDS: Partial<Record<CanonicalFolder, string>> = {
  INBOX: 'INBOX',
  SENT: 'SENT',
  DRAFTS: 'DRAFT',
  TRASH: 'TRASH',
  SPAM: 'SPAM',
};

export function normalizeFolder(value: string): string {
  const lower = value.toLowerCase();
  if (lower === 'sent') return 'SENT';
  if (lower === 'draft' || lower === 'drafts') return 'DRAFTS';
  if (lower === 'trash') return 'TRASH';
  if (lower === 'spam' || lower === 'junk') return 'SPAM';
  if (lower === 'inbox') return 'INBOX';
  if (lower === 'archive' || lower === 'archived') return 'ARCHIVE';
  if (lower === 'all' || lower === 'allmail' || lower === 'all_mail') return 'ALL';
  return value;
}

export function googleFolderId(folder: string): string | null {
  return GOOGLE_FOLDER_IDS[normalizeFolder(folder) as CanonicalFolder] ?? null;
}

// Match a canonical folder against a provider folder row returned by the Nylas
// folders endpoint (Microsoft/IMAP folder ids are opaque, so we resolve by
// name/attribute).
export function folderRowMatches(folder: string, row: { id?: string; name?: string; attributes?: string[] }) {
  const canonical = normalizeFolder(folder);
  const aliases = SYSTEM_LABEL_ALIASES[canonical as keyof typeof SYSTEM_LABEL_ALIASES];
  if (!aliases) return foldLabel(row.name || '') === foldLabel(folder);
  const attribute = `\\${canonical.charAt(0)}${canonical.slice(1).toLowerCase()}`;
  if ((row.attributes || []).some((item) => foldLabel(item) === foldLabel(attribute))) return true;
  return aliases.some((alias) => foldLabel(alias) === foldLabel(row.name || ''));
}

export function foldLabel(value: string) {
  return String(value || '')
    .replace(/^\\/, '')
    .replace(/[\s_-]+/g, '')
    .toLowerCase();
}
