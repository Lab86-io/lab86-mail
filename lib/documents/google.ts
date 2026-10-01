import { getCloudFileAccess, listCloudFileConnections } from '@/lib/files/connections';
import { truncateText } from '@/lib/shared/text';
import { upgradeDeckModel } from './deck-versions';
import { googleErrorReasons, isGoogleAppAccessDenied } from './google-access';
import { googleDocHasOpenComments } from './google-comments';
import { googleDocTarget, googleDocUpdateRequests } from './google-doc-diff';
import {
  assertGoogleFileEditable,
  GOOGLE_DOC_OPEN_COMMENTS_REASON,
  type GoogleDocMode,
  GoogleDocumentFidelityError,
  googlePreviewReason,
  projectGoogleDoc,
} from './google-fidelity';
import { googleModelWriteLimitation } from './google-write-policy';
import {
  type AlbatrossDocumentModel,
  type AlbatrossDocumentRecord,
  type DeckElementV2,
  type DeckTheme,
  type DocumentKind,
  parseDocumentModel,
  type SheetGridModel,
  type SheetTab,
  sheetGridModel,
} from './model';
import { linkGoogleDocument } from './service';

function assertGoogleModelFidelity(model: unknown, mode: GoogleDocMode = 'rich') {
  const reason = googleModelWriteLimitation(model, mode);
  if (reason) throw new GoogleDocumentFidelityError(reason);
}

const GOOGLE_MIME: Record<DocumentKind, string> = {
  doc: 'application/vnd.google-apps.document',
  sheet: 'application/vnd.google-apps.spreadsheet',
  deck: 'application/vnd.google-apps.presentation',
};

const GOOGLE_CREATE_ENDPOINT: Record<DocumentKind, string> = {
  doc: 'https://docs.googleapis.com/v1/documents',
  sheet: 'https://sheets.googleapis.com/v4/spreadsheets',
  deck: 'https://slides.googleapis.com/v1/presentations',
};

const defaultDependencies = {
  getCloudFileAccess,
  listCloudFileConnections,
  linkGoogleDocument,
  fetch,
};

let dependencies = defaultDependencies;

export function __setGoogleDocumentDepsForTest(overrides: Partial<typeof defaultDependencies> = {}) {
  dependencies = { ...defaultDependencies, ...overrides };
}

export class GoogleDocumentConflictError extends Error {
  constructor() {
    super(
      'This file changed in Google since Albatross last synced it. Import the Google version before publishing again.',
    );
    this.name = 'GoogleDocumentConflictError';
  }
}

/**
 * A failed Google write. `status` is the HTTP status of the Google answer, and
 * `reasons` are the error reasons of its body (for example
 * `appNotAuthorizedToFile`).
 */
export class GoogleWriteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reasons: readonly string[] = [],
  ) {
    super(message);
    this.name = 'GoogleWriteError';
  }
}

/** The save went through, but the Doc that Google kept is not the same as the model. */
export class GoogleDocumentSaveMismatchError extends Error {
  constructor() {
    super(
      'Google saved your edits, but the Doc is different from your version. Open the Doc in Google to check it, then reload it here.',
    );
    this.name = 'GoogleDocumentSaveMismatchError';
  }
}

export function googleProviderVersionChanged(stored?: string, current?: string) {
  return Boolean(stored && current && stored !== current);
}

async function googleJson(
  accessToken: string,
  endpoint: string,
  init: RequestInit = {},
): Promise<Record<string, any>> {
  let response: Response;
  try {
    response = await dependencies.fetch(endpoint, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      cache: 'no-store',
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
  } catch (error: any) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new Error('Google request timed out. Try again.');
    }
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = String(payload?.error?.message || '');
    const reasons = googleErrorReasons(payload);
    if (response.status === 401 || response.status === 403) {
      throw new GoogleWriteError(
        'Google write access is missing or expired. Reconnect Google Drive and try again.',
        response.status,
        reasons,
      );
    }
    throw new GoogleWriteError(
      detail ? `Google could not update this file: ${detail}` : 'Google could not update this file.',
      response.status,
      reasons,
    );
  }
  return payload;
}

function googleObjectId(value: string, suffix = '') {
  const safe = `${value}${suffix}`.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 45);
  return /^[a-zA-Z_]/u.test(safe) ? safe : `a_${safe}`;
}

const GOOGLE_DOCS_ENDPOINT = 'https://docs.googleapis.com/v1/documents';

/** The whole Doc, with its tabs, so a Doc with more than one tab is seen. */
function googleDocUrl(fileId: string) {
  return `${GOOGLE_DOCS_ENDPOINT}/${encodeURIComponent(fileId)}?includeTabsContent=true`;
}

/** Docs refuses a write whose `requiredRevisionId` is no longer the latest revision. */
function isRevisionConflict(error: unknown) {
  return error instanceof GoogleWriteError && error.status === 400 && /revision/iu.test(error.message);
}

async function writeGoogleDoc(
  accessToken: string,
  fileId: string,
  requests: Record<string, any>[],
  revisionId: string | undefined,
) {
  try {
    return await googleJson(
      accessToken,
      `${GOOGLE_DOCS_ENDPOINT}/${encodeURIComponent(fileId)}:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({
          requests,
          ...(revisionId ? { writeControl: { requiredRevisionId: revisionId } } : {}),
        }),
      },
    );
  } catch (error) {
    if (isRevisionConflict(error)) throw new GoogleDocumentConflictError();
    throw error;
  }
}

/**
 * Saves the model to a Google Doc with the smallest batchUpdate
 * (lib/documents/google-doc-diff.ts). The write is bound to the revision that
 * the diff read. Then the Doc is read again: when it does not match the model
 * (Docs applied a request in an unexpected way), one more write corrects it,
 * and a second miss is an error. When the revision changed after the write,
 * the writer does not correct: a Doc that matches is a save, and a Doc that
 * does not match is a conflict (another edit came in, or Google changed the
 * revision for its own reasons; either way the user reloads).
 */
async function syncGoogleDoc(
  accessToken: string,
  fileId: string,
  model: Extract<AlbatrossDocumentModel, { kind: 'doc' }>,
  createdNow = false,
  expectedProviderVersion?: string,
  mode: GoogleDocMode = 'rich',
) {
  let current = await googleJson(accessToken, googleDocUrl(fileId));
  let projection = projectGoogleDoc(current, createdNow ? 'rich' : mode);
  if (!createdNow) {
    if (projection.reasons.length)
      throw new GoogleDocumentFidelityError(googlePreviewReason(projection.reasons));
    if (!current.revisionId) throw new GoogleDocumentConflictError();
    // Bind the loaded body to the version the user edited, before its revision-guarded write.
    const metadata = await googleDriveMetadata(accessToken, fileId);
    if (!expectedProviderVersion || metadata.providerVersion !== expectedProviderVersion)
      throw new GoogleDocumentConflictError();
    if (await googleDocHasOpenComments((endpoint) => googleJson(accessToken, endpoint), fileId))
      throw new GoogleDocumentFidelityError(googlePreviewReason([GOOGLE_DOC_OPEN_COMMENTS_REASON]));
  }
  const target = googleDocTarget(model.blocks);
  let revisionId = typeof current.revisionId === 'string' ? current.revisionId : undefined;
  for (let attempt = 0; ; attempt += 1) {
    const requests = googleDocUpdateRequests(projection, target);
    if (!requests.length) return;
    if (attempt === 2) throw new GoogleDocumentSaveMismatchError();
    const reply = await writeGoogleDoc(accessToken, fileId, requests, revisionId);
    const written = reply?.writeControl?.requiredRevisionId;
    current = await googleJson(accessToken, googleDocUrl(fileId));
    projection = projectGoogleDoc(current, 'rich');
    if (typeof written === 'string' && written && current.revisionId !== written) {
      if (projection.reasons.length || googleDocUpdateRequests(projection, target).length)
        throw new GoogleDocumentConflictError();
      return;
    }
    if (projection.reasons.length) throw new GoogleDocumentSaveMismatchError();
    revisionId = typeof current.revisionId === 'string' ? current.revisionId : undefined;
  }
}

/** The Drive name, web link, and version of a file. */
async function googleDriveMetadata(accessToken: string, fileId: string) {
  const payload = await googleJson(
    accessToken,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,webViewLink,version`,
  );
  return {
    name: typeof payload.name === 'string' ? payload.name : undefined,
    webUrl: typeof payload.webViewLink === 'string' ? payload.webViewLink : undefined,
    providerVersion:
      typeof payload.version === 'string' || typeof payload.version === 'number'
        ? String(payload.version)
        : undefined,
  };
}

function columnName(index: number) {
  let value = index;
  let out = '';
  while (value > 0) {
    value -= 1;
    out = String.fromCharCode(65 + (value % 26)) + out;
    value = Math.floor(value / 26);
  }
  return out;
}

function valuesForTab(tab: SheetTab) {
  const entries = Object.entries(tab.cells)
    .map(([address, cell]) => {
      const match = /^([A-Z]+)(\d+)$/iu.exec(address);
      if (!match) return null;
      let column = 0;
      for (const character of match[1].toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
      const row = Number(match[2]);
      if (
        !Number.isSafeInteger(row) ||
        row < 1 ||
        row > tab.rowCount ||
        column < 1 ||
        column > tab.columnCount
      ) {
        return null;
      }
      return {
        row,
        column,
        value: cell.formula ? `=${cell.formula.replace(/^=/u, '')}` : (cell.value ?? ''),
      };
    })
    .filter(Boolean) as Array<{ row: number; column: number; value: string | number | boolean }>;
  const maxRow = entries.reduce((maximum, entry) => Math.max(maximum, entry.row), 1);
  const maxColumn = entries.reduce((maximum, entry) => Math.max(maximum, entry.column), 1);
  const values: Array<Array<string | number | boolean>> = Array.from({ length: maxRow }, () =>
    Array.from({ length: maxColumn }, () => ''),
  );
  for (const entry of entries) values[entry.row - 1][entry.column - 1] = entry.value;
  return { values, maxRow, maxColumn };
}

async function syncGoogleSheet(accessToken: string, fileId: string, model: SheetGridModel) {
  const current = await googleJson(
    accessToken,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}?fields=sheets.properties`,
  );
  const currentSheets = Array.isArray(current.sheets) ? current.sheets : [];
  const firstSheetId = Number(currentSheets[0]?.properties?.sheetId ?? 0);
  const requests: Record<string, any>[] = [];
  currentSheets.slice(1).forEach((sheet: any) => {
    requests.push({ deleteSheet: { sheetId: Number(sheet.properties.sheetId) } });
  });
  requests.push({
    updateSheetProperties: {
      properties: { sheetId: firstSheetId, title: model.sheets[0].name },
      fields: 'title',
    },
  });
  model.sheets.slice(1).forEach((sheet) => {
    requests.push({
      addSheet: { properties: { title: sheet.name } },
    });
  });
  await googleJson(
    accessToken,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}:batchUpdate`,
    { method: 'POST', body: JSON.stringify({ requests }) },
  );
  await googleJson(
    accessToken,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}/values:batchClear`,
    {
      method: 'POST',
      body: JSON.stringify({
        ranges: model.sheets.map((sheet) => `'${sheet.name.replaceAll("'", "''")}'`),
      }),
    },
  );
  const data = model.sheets.map((sheet) => {
    const { values, maxRow, maxColumn } = valuesForTab(sheet);
    return {
      range: `'${sheet.name.replaceAll("'", "''")}'!A1:${columnName(maxColumn)}${maxRow}`,
      majorDimension: 'ROWS',
      values,
    };
  });
  await googleJson(
    accessToken,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}/values:batchUpdate`,
    { method: 'POST', body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }) },
  );
}

const GOOGLE_SLIDE_WIDTH_PT = 720;
const GOOGLE_SLIDE_HEIGHT_PT = 405;

function googleBox(element: { x: number; y: number; width: number; height: number }) {
  return {
    width: (element.width / 100) * GOOGLE_SLIDE_WIDTH_PT,
    height: (element.height / 100) * GOOGLE_SLIDE_HEIGHT_PT,
    translateX: (element.x / 100) * GOOGLE_SLIDE_WIDTH_PT,
    translateY: (element.y / 100) * GOOGLE_SLIDE_HEIGHT_PT,
  };
}

/**
 * One version 2 element as Google Slides requests. Text and shapes map
 * directly; lines and https images have native forms; charts become a text
 * box with their data so nothing is silently lost (Slides charts need a
 * linked Sheet).
 */
function slideElementRequests(slideId: string, element: DeckElementV2, index: number, theme: DeckTheme) {
  const objectId = googleObjectId(element.id, `_${index}`);
  const box = googleBox(element);
  const elementProperties = {
    pageObjectId: slideId,
    size: {
      width: { magnitude: Math.max(box.width, 1), unit: 'PT' },
      height: { magnitude: Math.max(box.height, 1), unit: 'PT' },
    },
    transform: { scaleX: 1, scaleY: 1, translateX: box.translateX, translateY: box.translateY, unit: 'PT' },
  };
  const requests: Record<string, any>[] = [];
  const textBox = (
    text: string,
    style: { fontSize: number; bold: boolean; italic?: boolean; color: string },
  ) => {
    requests.push({ createShape: { objectId, shapeType: 'TEXT_BOX', elementProperties } });
    if (!text) return;
    requests.push({ insertText: { objectId, text, insertionIndex: 0 } });
    requests.push({
      updateTextStyle: {
        objectId,
        style: {
          fontSize: { magnitude: style.fontSize, unit: 'PT' },
          bold: style.bold,
          italic: Boolean(style.italic),
          foregroundColor: { opaqueColor: { rgbColor: hexToRgb(style.color) } },
        },
        textRange: { type: 'ALL' },
        fields: 'fontSize,bold,italic,foregroundColor',
      },
    });
  };
  if (element.type === 'text') {
    const size = element.fontSize || (element.role === 'title' ? 28 : element.role === 'number' ? 64 : 16);
    textBox(element.text, {
      fontSize: size,
      bold:
        (element.fontWeight ?? (element.role === 'title' || element.role === 'number' ? 650 : 400)) >= 600,
      italic: element.italic,
      color: element.color || theme.colors.ink,
    });
    if (element.align && element.text) {
      requests.push({
        updateParagraphStyle: {
          objectId,
          style: {
            alignment: element.align === 'center' ? 'CENTER' : element.align === 'right' ? 'END' : 'START',
          },
          textRange: { type: 'ALL' },
          fields: 'alignment',
        },
      });
    }
  } else if (element.type === 'shape') {
    requests.push({
      createShape: {
        objectId,
        shapeType:
          element.shape === 'ellipse'
            ? 'ELLIPSE'
            : element.shape === 'roundRect'
              ? 'ROUND_RECTANGLE'
              : 'RECTANGLE',
        elementProperties,
      },
    });
    requests.push({
      updateShapeProperties: {
        objectId,
        shapeProperties: {
          shapeBackgroundFill: {
            solidFill: { color: { rgbColor: hexToRgb(element.fill || theme.colors.surface) } },
          },
          outline: element.stroke
            ? {
                outlineFill: { solidFill: { color: { rgbColor: hexToRgb(element.stroke.color) } } },
                weight: { magnitude: element.stroke.width, unit: 'PT' },
              }
            : { propertyState: 'NOT_RENDERED' },
        },
        fields: 'shapeBackgroundFill,outline',
      },
    });
  } else if (element.type === 'line') {
    requests.push({
      createLine: {
        objectId,
        lineCategory: 'STRAIGHT',
        elementProperties: {
          ...elementProperties,
          transform: {
            scaleX: 1,
            scaleY: element.flip ? -1 : 1,
            translateX: box.translateX,
            translateY: element.flip ? box.translateY + box.height : box.translateY,
            unit: 'PT',
          },
        },
      },
    });
    requests.push({
      updateLineProperties: {
        objectId,
        lineProperties: {
          lineFill: { solidFill: { color: { rgbColor: hexToRgb(element.stroke.color) } } },
          weight: { magnitude: element.stroke.width, unit: 'PT' },
        },
        fields: 'lineFill,weight',
      },
    });
  } else if (element.type === 'image') {
    if (element.src?.startsWith('https://')) {
      requests.push({ createImage: { objectId, url: element.src, elementProperties } });
    } else {
      textBox(`[Image: ${element.alt || element.assetId}]`, {
        fontSize: 12,
        bold: false,
        color: theme.colors.muted,
      });
    }
  } else if (element.type === 'chart') {
    const lines = element.series.map(
      (series) =>
        `${series.name}: ${element.categories.map((c, i) => `${c} ${series.values[i] ?? ''}${element.unit ?? ''}`).join(', ')}`,
    );
    textBox(lines.join('\n'), { fontSize: 12, bold: false, color: theme.colors.ink });
  }
  return requests;
}

function hexToRgb(value: string) {
  const normalized = value.replace('#', '').padEnd(6, '0').slice(0, 6);
  return {
    red: Number.parseInt(normalized.slice(0, 2), 16) / 255,
    green: Number.parseInt(normalized.slice(2, 4), 16) / 255,
    blue: Number.parseInt(normalized.slice(4, 6), 16) / 255,
  };
}

async function syncGoogleDeck(
  accessToken: string,
  fileId: string,
  model: Extract<AlbatrossDocumentModel, { kind: 'deck' }>,
) {
  const current = await googleJson(
    accessToken,
    `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(fileId)}?fields=slides.objectId`,
  );
  const requests: Record<string, any>[] = (current.slides || []).map((slide: any) => ({
    deleteObject: { objectId: slide.objectId },
  }));
  const deck = upgradeDeckModel(model);
  deck.slides.forEach((slide, slideIndex) => {
    const slideId = googleObjectId(slide.id, `_${slideIndex}`);
    requests.push({
      createSlide: { objectId: slideId, slideLayoutReference: { predefinedLayout: 'BLANK' } },
    });
    slide.elements.forEach((element, index) => {
      requests.push(...slideElementRequests(slideId, element, index, deck.theme));
    });
  });
  await googleJson(
    accessToken,
    `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(fileId)}:batchUpdate`,
    { method: 'POST', body: JSON.stringify({ requests }) },
  );
}

async function createGoogleFile(
  accessToken: string,
  document: AlbatrossDocumentRecord,
): Promise<{ fileId: string; webUrl: string }> {
  const endpoint = GOOGLE_CREATE_ENDPOINT[document.kind];
  const body =
    document.kind === 'doc'
      ? { title: document.title }
      : document.kind === 'sheet'
        ? { properties: { title: document.title } }
        : { title: document.title };
  const created = await googleJson(accessToken, endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const fileId = String(created.documentId || created.spreadsheetId || created.presentationId || '');
  if (!fileId) throw new Error('Google created a file without returning its identifier.');
  const webUrl =
    document.kind === 'doc'
      ? `https://docs.google.com/document/d/${fileId}/edit`
      : document.kind === 'sheet'
        ? `https://docs.google.com/spreadsheets/d/${fileId}/edit`
        : `https://docs.google.com/presentation/d/${fileId}/edit`;
  return { fileId, webUrl };
}

export async function publishDocumentToGoogle(input: {
  userId: string;
  document: AlbatrossDocumentRecord;
  connectionId?: string;
}) {
  // Reject before resolving credentials or creating a provider file. A values /
  // formulas projection must never be presented as a synced full workbook.
  assertGoogleModelFidelity(input.document.model);
  let connectionId = input.connectionId || input.document.google?.connectionId;
  if (!connectionId) {
    const connections = await dependencies.listCloudFileConnections(input.userId);
    connectionId = connections.find((connection) => connection.provider === 'google_drive')?.connectionId;
  }
  if (!connectionId) throw new Error('Connect Google Drive before publishing this file.');
  const access = await dependencies.getCloudFileAccess({ userId: input.userId, connectionId });
  if (!access || access.connection.provider !== 'google_drive') {
    throw new Error('The selected Google Drive connection was not found.');
  }
  let fileId = input.document.google?.fileId;
  let webUrl = input.document.google?.webUrl;
  const isExistingGoogleFile = Boolean(fileId) && input.document.google?.connectionId === connectionId;
  if (isExistingGoogleFile && input.document.kind !== 'doc') assertGoogleFileEditable(input.document.kind);
  if (fileId && isExistingGoogleFile) {
    const current = await googleDriveMetadata(access.accessToken, fileId);
    if (
      !input.document.google?.providerVersion ||
      !current.providerVersion ||
      googleProviderVersionChanged(input.document.google?.providerVersion, current.providerVersion)
    ) {
      throw new GoogleDocumentConflictError();
    }
    webUrl = current.webUrl || webUrl;
  }
  if (!fileId || input.document.google?.connectionId !== connectionId) {
    const created = await createGoogleFile(access.accessToken, input.document);
    fileId = created.fileId;
    webUrl = created.webUrl;
  }
  if (input.document.model.kind === 'doc') {
    await syncGoogleDoc(
      access.accessToken,
      fileId,
      input.document.model,
      !isExistingGoogleFile,
      input.document.google?.providerVersion,
      'rich',
    );
  }
  if (input.document.model.kind === 'sheet') {
    await syncGoogleSheet(access.accessToken, fileId, sheetGridModel(input.document.model)!);
  }
  if (input.document.model.kind === 'deck') {
    await syncGoogleDeck(access.accessToken, fileId, input.document.model);
  }
  const syncedMetadata = await googleDriveMetadata(access.accessToken, fileId);
  webUrl = syncedMetadata.webUrl || webUrl;
  const mimeType = GOOGLE_MIME[input.document.kind];
  await dependencies.linkGoogleDocument({
    userId: input.userId,
    documentId: input.document.documentId,
    connectionId,
    fileId,
    mimeType,
    webUrl,
    providerVersion: syncedMetadata.providerVersion,
    syncedRevision: input.document.currentRevision,
  });
  return {
    connectionId,
    fileId,
    mimeType,
    webUrl,
    providerVersion: syncedMetadata.providerVersion,
    syncedRevision: input.document.currentRevision,
  };
}

export async function updateGoogleNativeFile(input: {
  userId: string;
  connectionId: string;
  fileId: string;
  kind: DocumentKind;
  title: string;
  model: unknown;
  expectedProviderVersion?: string;
  /** `rich` only for a client that edits inline formatting (the web editor). */
  mode?: GoogleDocMode;
}) {
  const mode = input.mode ?? 'plain';
  assertGoogleModelFidelity(input.model, mode);
  if (!input.expectedProviderVersion) throw new GoogleDocumentConflictError();
  if (input.kind !== 'doc') throw new GoogleDocumentFidelityError();
  const access = await dependencies.getCloudFileAccess({
    userId: input.userId,
    connectionId: input.connectionId,
  });
  if (!access || access.connection.provider !== 'google_drive') {
    throw new Error('The selected Google Drive connection was not found.');
  }
  const current = await googleDriveMetadata(access.accessToken, input.fileId);
  if (
    !current.providerVersion ||
    googleProviderVersionChanged(input.expectedProviderVersion, current.providerVersion)
  ) {
    throw new GoogleDocumentConflictError();
  }
  const model = parseDocumentModel(input.model, input.kind);
  if (model.kind === 'doc')
    await syncGoogleDoc(access.accessToken, input.fileId, model, false, input.expectedProviderVersion, mode);
  if (model.kind === 'sheet') await syncGoogleSheet(access.accessToken, input.fileId, sheetGridModel(model)!);
  if (model.kind === 'deck') await syncGoogleDeck(access.accessToken, input.fileId, model);
  const title = truncateText(input.title.trim(), 500) || 'Untitled';
  const renamed = current.name === title || (await renameGoogleFile(access.accessToken, input.fileId, title));
  const updated = await googleDriveMetadata(access.accessToken, input.fileId);
  return {
    // A skipped rename keeps the Google name, so the editor shows the true name.
    title: renamed ? title : current.name || title,
    ...(renamed ? {} : { renameSkipped: true as const }),
    model,
    webUrl: updated.webUrl || current.webUrl,
    providerVersion: updated.providerVersion,
  };
}

/**
 * Renames a Google file after its content is saved. The Drive API renames a
 * file only with the full `drive` scope, or with `drive.file` for a file that
 * Albatross made. Albatross does not ask for `drive`, so Google refuses (403,
 * an app-access reason) the rename of a Doc that the user made in Google. The
 * content is saved at that point, so the rename is skipped and the file keeps
 * its Google name. Each other failure (a rate limit, a quota, a 403 with no
 * reason) goes to the caller as before.
 */
async function renameGoogleFile(accessToken: string, fileId: string, title: string) {
  try {
    await googleJson(
      accessToken,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id`,
      {
        method: 'PATCH',
        body: JSON.stringify({ name: title }),
      },
    );
    return true;
  } catch (error) {
    if (error instanceof GoogleWriteError && isGoogleAppAccessDenied(error.status, error.reasons)) {
      console.warn(
        '[google-docs] rename skipped: the app has no Drive access to this file (appNotAuthorizedToFile)',
      );
      return false;
    }
    throw error;
  }
}
