import { getCloudFileAccess, listCloudFileConnections } from '@/lib/files/connections';
import { upgradeDeckModel } from './deck-versions';
import {
  assertGoogleFileEditable,
  GOOGLE_QUOTE_COLOR,
  GOOGLE_QUOTE_INDENT_PT,
  GoogleDocumentFidelityError,
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

function assertGoogleModelFidelity(model: unknown) {
  const reason = googleModelWriteLimitation(model);
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
    if (response.status === 401 || response.status === 403) {
      throw new Error('Google write access is missing or expired. Reconnect Google Drive and try again.');
    }
    throw new Error(
      detail ? `Google could not update this file: ${detail}` : 'Google could not update this file.',
    );
  }
  return payload;
}

function googleObjectId(value: string, suffix = '') {
  const safe = `${value}${suffix}`.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 45);
  return /^[a-zA-Z_]/u.test(safe) ? safe : `a_${safe}`;
}

async function syncGoogleDoc(
  accessToken: string,
  fileId: string,
  model: Extract<AlbatrossDocumentModel, { kind: 'doc' }>,
  createdNow = false,
  expectedProviderVersion?: string,
) {
  const current = await googleJson(
    accessToken,
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(fileId)}`,
  );
  if (!createdNow) assertGoogleFileEditable('doc', current);
  if (!createdNow && !current.revisionId) throw new GoogleDocumentConflictError();
  if (!createdNow) {
    // Bind the loaded body to the version the user edited, before its revision-guarded write.
    const metadata = await googleDriveMetadata(accessToken, fileId);
    if (!expectedProviderVersion || metadata.providerVersion !== expectedProviderVersion)
      throw new GoogleDocumentConflictError();
  }
  const endIndex = Math.max(
    1,
    ...(Array.isArray(current?.body?.content)
      ? current.body.content.map((entry: any) => Number(entry?.endIndex) || 1)
      : [1]),
  );
  const requests: Record<string, any>[] = [];
  if (endIndex > 2) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
  }
  const segments = model.blocks.map((block) => ({
    block,
    text: `${block.text}\n`,
  }));
  // Docs retains one mandatory final newline. Inserting another creates a new
  // blank paragraph on every round-trip.
  const text = segments
    .map((segment) => segment.text)
    .join('')
    .replace(/\n$/u, '');
  if (segments.length) {
    if (text) requests.push({ insertText: { location: { index: 1 }, text } });
    let startIndex = 1;
    for (const segment of segments) {
      const segmentEndIndex = startIndex + segment.text.length;
      const range = { startIndex, endIndex: segmentEndIndex };
      requests.push({
        updateParagraphStyle: {
          range,
          paragraphStyle: {
            namedStyleType:
              segment.block.type !== 'heading'
                ? 'NORMAL_TEXT'
                : segment.block.level === 1
                  ? 'HEADING_1'
                  : segment.block.level === 3
                    ? 'HEADING_3'
                    : 'HEADING_2',
          },
          fields: 'namedStyleType',
        },
      });
      if (segment.block.type === 'bullet' || segment.block.type === 'numbered') {
        requests.push({
          createParagraphBullets: {
            range,
            bulletPreset:
              segment.block.type === 'numbered' ? 'NUMBERED_DECIMAL_NESTED' : 'BULLET_DISC_CIRCLE_SQUARE',
          },
        });
      }
      if (segment.block.type === 'quote' && segment.block.text) {
        requests.push({
          updateTextStyle: {
            range: { startIndex, endIndex: segmentEndIndex - 1 },
            textStyle: {
              italic: true,
              foregroundColor: { color: { rgbColor: hexToRgb(GOOGLE_QUOTE_COLOR) } },
            },
            fields: 'italic,foregroundColor',
          },
        });
        requests.push({
          updateParagraphStyle: {
            range,
            paragraphStyle: {
              indentStart: { magnitude: GOOGLE_QUOTE_INDENT_PT, unit: 'PT' },
            },
            fields: 'indentStart',
          },
        });
      }
      startIndex = segmentEndIndex;
    }
  }
  if (!requests.length) return;
  await googleJson(
    accessToken,
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(fileId)}:batchUpdate`,
    {
      method: 'POST',
      body: JSON.stringify({
        requests,
        ...(typeof current.revisionId === 'string' && current.revisionId
          ? { writeControl: { requiredRevisionId: current.revisionId } }
          : {}),
      }),
    },
  );
}

async function googleDriveMetadata(accessToken: string, fileId: string) {
  const payload = await googleJson(
    accessToken,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,webViewLink,version`,
  );
  return {
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
}) {
  assertGoogleModelFidelity(input.model);
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
    await syncGoogleDoc(access.accessToken, input.fileId, model, false, input.expectedProviderVersion);
  if (model.kind === 'sheet') await syncGoogleSheet(access.accessToken, input.fileId, sheetGridModel(model)!);
  if (model.kind === 'deck') await syncGoogleDeck(access.accessToken, input.fileId, model);
  const title = input.title.trim().slice(0, 500) || 'Untitled';
  await googleJson(
    access.accessToken,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(input.fileId)}?supportsAllDrives=true&fields=id`,
    {
      method: 'PATCH',
      body: JSON.stringify({ name: title }),
    },
  );
  const updated = await googleDriveMetadata(access.accessToken, input.fileId);
  return {
    title,
    model,
    webUrl: updated.webUrl || current.webUrl,
    providerVersion: updated.providerVersion,
  };
}
