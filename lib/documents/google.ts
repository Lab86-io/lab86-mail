import { getCloudFileAccess, listCloudFileConnections } from '@/lib/files/connections';
import {
  type AlbatrossDocumentModel,
  type AlbatrossDocumentRecord,
  type DeckElement,
  type DocumentKind,
  parseDocumentModel,
  type SheetTab,
} from './model';
import { linkGoogleDocument } from './service';

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
) {
  const current = await googleJson(
    accessToken,
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(fileId)}?fields=revisionId,body.content.endIndex`,
  );
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
  const text = segments.map((segment) => segment.text).join('');
  if (text) {
    requests.push({ insertText: { location: { index: 1 }, text } });
    let startIndex = 1;
    for (const segment of segments) {
      const segmentEndIndex = startIndex + segment.text.length;
      const range = { startIndex, endIndex: segmentEndIndex };
      if (segment.block.type === 'heading') {
        requests.push({
          updateParagraphStyle: {
            range,
            paragraphStyle: {
              namedStyleType:
                segment.block.level === 1
                  ? 'HEADING_1'
                  : segment.block.level === 3
                    ? 'HEADING_3'
                    : 'HEADING_2',
            },
            fields: 'namedStyleType',
          },
        });
      }
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
            textStyle: { italic: true, foregroundColor: { color: { rgbColor: hexToRgb('#52606D') } } },
            fields: 'italic,foregroundColor',
          },
        });
        requests.push({
          updateParagraphStyle: {
            range,
            paragraphStyle: {
              indentStart: { magnitude: 24, unit: 'PT' },
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

async function syncGoogleSheet(
  accessToken: string,
  fileId: string,
  model: Extract<AlbatrossDocumentModel, { kind: 'sheet' }>,
) {
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

function slideElementRequests(slideId: string, element: DeckElement, index: number) {
  const objectId = googleObjectId(element.id, `_${index}`);
  const width = (element.width / 100) * 720;
  const height = (element.height / 100) * 405;
  const createShape = {
    createShape: {
      objectId,
      shapeType: element.type === 'shape' ? 'RECTANGLE' : 'TEXT_BOX',
      elementProperties: {
        pageObjectId: slideId,
        size: {
          width: { magnitude: width, unit: 'PT' },
          height: { magnitude: height, unit: 'PT' },
        },
        transform: {
          scaleX: 1,
          scaleY: 1,
          translateX: (element.x / 100) * 720,
          translateY: (element.y / 100) * 405,
          unit: 'PT',
        },
      },
    },
  };
  const requests: Record<string, any>[] = [createShape];
  if (element.text) requests.push({ insertText: { objectId, text: element.text, insertionIndex: 0 } });
  if (element.text) {
    requests.push({
      updateTextStyle: {
        objectId,
        style: {
          fontSize: { magnitude: element.fontSize || (element.role === 'title' ? 28 : 16), unit: 'PT' },
          bold: element.role === 'title',
          foregroundColor: {
            opaqueColor: { rgbColor: hexToRgb(element.color || '#17202A') },
          },
        },
        textRange: { type: 'ALL' },
        fields: 'fontSize,bold,foregroundColor',
      },
    });
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
  model.slides.forEach((slide, slideIndex) => {
    const slideId = googleObjectId(slide.id, `_${slideIndex}`);
    requests.push({
      createSlide: { objectId: slideId, slideLayoutReference: { predefinedLayout: 'BLANK' } },
    });
    slide.elements.forEach((element, index) => {
      requests.push(...slideElementRequests(slideId, element, index));
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
  if (fileId && isExistingGoogleFile) {
    const current = await googleDriveMetadata(access.accessToken, fileId);
    if (googleProviderVersionChanged(input.document.google?.providerVersion, current.providerVersion)) {
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
    await syncGoogleDoc(access.accessToken, fileId, input.document.model);
  }
  if (input.document.model.kind === 'sheet') {
    await syncGoogleSheet(access.accessToken, fileId, input.document.model);
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
  const access = await dependencies.getCloudFileAccess({
    userId: input.userId,
    connectionId: input.connectionId,
  });
  if (!access || access.connection.provider !== 'google_drive') {
    throw new Error('The selected Google Drive connection was not found.');
  }
  const current = await googleDriveMetadata(access.accessToken, input.fileId);
  if (googleProviderVersionChanged(input.expectedProviderVersion, current.providerVersion)) {
    throw new GoogleDocumentConflictError();
  }
  const model = parseDocumentModel(input.model, input.kind);
  if (model.kind === 'doc') await syncGoogleDoc(access.accessToken, input.fileId, model);
  if (model.kind === 'sheet') await syncGoogleSheet(access.accessToken, input.fileId, model);
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
