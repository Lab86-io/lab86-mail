export type CanonicalFolder = 'INBOX' | 'SENT' | 'DRAFTS' | 'TRASH' | 'SPAM' | 'ARCHIVE' | 'ALL';

export const SYSTEM_LABEL_ALIASES = {
  INBOX: ['INBOX', 'Inbox', '\\Inbox'],
  SENT: ['SENT', 'Sent', 'Sent Items', 'Sent Mail', 'Sent Messages', '\\Sent'],
  DRAFTS: ['DRAFT', 'DRAFTS', 'Draft', 'Drafts', '\\Drafts'],
  TRASH: ['TRASH', 'Trash', 'Deleted Items', 'DeletedItems', 'Deleted Messages', '\\Trash'],
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

export type FolderRole = 'INBOX' | 'SENT' | 'DRAFTS' | 'TRASH' | 'SPAM' | 'ARCHIVE';
const FOLDER_ROLES: FolderRole[] = ['INBOX', 'SENT', 'DRAFTS', 'TRASH', 'SPAM', 'ARCHIVE'];

/**
 * Stable label for a role, stored next to the provider ids (Gmail ids for
 * Gmail's own roles, so a Gmail row is unchanged).
 */
export const FOLDER_ROLE_LABELS: Record<FolderRole, string> = {
  INBOX: 'INBOX',
  SENT: 'SENT',
  DRAFTS: 'DRAFT',
  TRASH: 'TRASH',
  SPAM: 'SPAM',
  ARCHIVE: 'ARCHIVE',
};

function roleForName(name: string): FolderRole | null {
  const folded = foldLabel(name);
  if (!folded) return null;
  return (
    FOLDER_ROLES.find((role) =>
      (SYSTEM_LABEL_ALIASES[role] as readonly string[]).some((alias) => foldLabel(alias) === folded),
    ) ?? null
  );
}

/**
 * The provider-neutral role of one stored folder label (SEARCH-1). Gmail
 * labels are role ids already. iCloud and IMAP ids end in the folder name
 * (`v0:<uuid>:INBOX`, `v0:<uuid>:Deleted Messages`). Microsoft ids are opaque,
 * so the caller passes the folder name from the provider's folder list.
 */
export function folderRoleOf(label: string, folderName?: string): FolderRole | null {
  const direct = roleForName(label);
  if (direct) return direct;
  const colon = label.lastIndexOf(':');
  if (colon >= 0) {
    const suffix = roleForName(label.slice(colon + 1));
    if (suffix) return suffix;
  }
  return folderName ? roleForName(folderName) : null;
}

/** True when any label on the row has the given role. */
export function labelsHaveRole(labels: readonly string[] | undefined, role: FolderRole): boolean {
  return (labels || []).some((label) => folderRoleOf(label) === role);
}

/**
 * Labels plus the role labels they imply, so role checks and searches work
 * the same for every provider. `names` maps opaque folder ids to names.
 */
export function withFolderRoleLabels(
  labels: readonly string[],
  names?: ReadonlyMap<string, string>,
): string[] {
  const out = [...labels];
  for (const label of labels) {
    const role = folderRoleOf(label, names?.get(label));
    const roleLabel = role ? FOLDER_ROLE_LABELS[role] : null;
    if (roleLabel && !out.includes(roleLabel)) out.push(roleLabel);
  }
  return out;
}
