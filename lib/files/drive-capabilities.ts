// What a Google Drive connection can do, from the scopes that the user gave
// on the Google consent screen. Google lets the user clear each box, so a
// connection can have only some of the scopes that Albatross asks for
// (lib/files/providers.ts). Isomorphic: the Files surface and the routes use
// the same rules.
//
// - read: `drive.readonly`. Without it there is nothing to connect.
// - createFiles: `drive.file` makes new Google files (save to Google).
// - editDocs: `documents` saves edits to a Google Doc that the user made.
//
// The full `drive` scope (old connections) gives all three.

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DOCUMENTS_SCOPE = 'https://www.googleapis.com/auth/documents';

export type DriveCapability = 'createFiles' | 'editDocs';

export interface DriveCapabilities {
  read: boolean;
  createFiles: boolean;
  editDocs: boolean;
}

export function driveCapabilities(scopes: readonly string[] | undefined | null): DriveCapabilities {
  const granted = new Set((scopes || []).map((scope) => scope.trim()));
  const full = granted.has(DRIVE_SCOPE);
  return {
    read: full || granted.has(DRIVE_READONLY_SCOPE),
    createFiles: full || granted.has(DRIVE_FILE_SCOPE),
    editDocs: full || granted.has(DOCUMENTS_SCOPE),
  };
}

/** The write capabilities that the user did not give, in a fixed order. */
export function missingDriveCapabilities(scopes: readonly string[] | undefined | null): DriveCapability[] {
  const capabilities = driveCapabilities(scopes);
  return (['createFiles', 'editDocs'] as const).filter((capability) => !capabilities[capability]);
}

const CAPABILITY_TEXT: Record<DriveCapability, string> = {
  createFiles: 'make new Google files',
  editDocs: 'save edits to Google Docs',
};

/** "Reconnect Google Drive to let Albatross make new Google files." */
export function driveReconnectMessage(missing: readonly DriveCapability[]): string {
  const parts = missing.map((capability) => CAPABILITY_TEXT[capability]);
  if (!parts.length) return '';
  return `Reconnect Google Drive to let Albatross ${parts.join(' and ')}.`;
}

export const DRIVE_READ_REFUSED =
  'Albatross did not connect Google Drive because it cannot read your files. Connect again and select "See and download all your Google Drive files".';

/** A Drive consent without `drive.readonly`: the connection is refused. */
export class DriveConsentError extends Error {
  constructor(message = DRIVE_READ_REFUSED) {
    super(message);
    this.name = 'DriveConsentError';
  }
}

/** A Drive action that needs a capability that the connection does not have. */
export class DriveCapabilityError extends Error {
  readonly status = 403;
  readonly code = 'GOOGLE_DRIVE_RECONNECT';
  readonly capability: DriveCapability;
  constructor(capability: DriveCapability) {
    super(driveReconnectMessage([capability]));
    this.name = 'DriveCapabilityError';
    this.capability = capability;
  }
}

/**
 * The capability that a write to Google needs, or null when the connection
 * can do it or when only Google can tell. A new Doc needs `drive.file` or
 * `documents`; a new Sheet or Slides file needs `drive.file`. A save to a
 * linked Doc needs `documents`, or `drive.file` for a Doc that Albatross
 * made; Google decides that case.
 */
export function driveWriteRefusal(input: {
  scopes: readonly string[] | undefined | null;
  newFile: boolean;
  kind: string;
}): DriveCapability | null {
  const can = driveCapabilities(input.scopes);
  if (input.newFile) {
    if (can.createFiles) return null;
    if (input.kind === 'doc' && can.editDocs) return null;
    return 'createFiles';
  }
  if (input.kind === 'doc') return can.editDocs || can.createFiles ? null : 'editDocs';
  return can.createFiles ? null : 'createFiles';
}
