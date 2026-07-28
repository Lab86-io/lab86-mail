import { randomUUID } from 'node:crypto';
import { getCloudFileAccess } from '@/lib/files/connections';
import {
  type AlbatrossDocumentModel,
  type DeckElement,
  type DocumentKind,
  MAX_SHEET_CELLS,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  type SheetCell,
} from './model';

export const GOOGLE_NATIVE_MIME = {
  'application/vnd.google-apps.document': 'doc',
  'application/vnd.google-apps.spreadsheet': 'sheet',
  'application/vnd.google-apps.presentation': 'deck',
} as const satisfies Record<string, DocumentKind>;
export type GoogleNativeMime = keyof typeof GOOGLE_NATIVE_MIME;
export const GOOGLE_NATIVE_MIME_TYPES = Object.keys(GOOGLE_NATIVE_MIME) as [
  GoogleNativeMime,
  ...GoogleNativeMime[],
];

const defaultDependencies = {
  getCloudFileAccess,
  fetch,
};

let dependencies = defaultDependencies;

export function __setGoogleImportDepsForTest(overrides: Partial<typeof defaultDependencies> = {}) {
  dependencies = { ...defaultDependencies, ...overrides };
}

async function googleJson(accessToken: string, endpoint: string) {
  let response: Response;
  try {
    response = await dependencies.fetch(endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error: any) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new Error('Google file request timed out. Try again.');
    }
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Google file access is missing or expired. Reconnect Google Drive.');
    }
    if (response.status === 404) throw new Error('The Google file was not found.');
    throw new Error(String(payload?.error?.message || 'Google could not open this file.'));
  }
  return payload;
}

async function googleDriveMetadata(accessToken: string, fileId: string) {
  const payload = await googleJson(
    accessToken,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,mimeType,webViewLink,version`,
  );
  return {
    title: typeof payload.name === 'string' ? payload.name : undefined,
    webUrl: typeof payload.webViewLink === 'string' ? payload.webViewLink : undefined,
    providerVersion:
      typeof payload.version === 'string' || typeof payload.version === 'number'
        ? String(payload.version)
        : undefined,
  };
}

function importGoogleDoc(payload: any): AlbatrossDocumentModel {
  const blocks = (Array.isArray(payload?.body?.content) ? payload.body.content : [])
    .filter((entry: any) => entry?.paragraph)
    .map((entry: any, index: number) => {
      const paragraph = entry.paragraph;
      const text = (Array.isArray(paragraph.elements) ? paragraph.elements : [])
        .map((element: any) => String(element?.textRun?.content || ''))
        .join('')
        .replace(/\n$/u, '');
      const namedStyle = String(paragraph?.paragraphStyle?.namedStyleType || '');
      const heading = /^HEADING_([123])$/u.exec(namedStyle);
      return {
        id: `google-paragraph-${index + 1}-${randomUUID().slice(0, 8)}`,
        type: heading
          ? ('heading' as const)
          : paragraph.bullet
            ? ('bullet' as const)
            : ('paragraph' as const),
        text,
        ...(heading ? { level: Number(heading[1]) as 1 | 2 | 3 } : {}),
      };
    })
    .filter((block: any, index: number, all: any[]) => block.text || index === all.length - 1);
  return {
    kind: 'doc',
    version: 1,
    blocks: blocks.length
      ? blocks
      : [{ id: `google-paragraph-${randomUUID().slice(0, 8)}`, type: 'paragraph', text: '' }],
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

async function importGoogleSheet(accessToken: string, fileId: string): Promise<AlbatrossDocumentModel> {
  const metadata = await googleJson(
    accessToken,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}?fields=properties.title,sheets.properties`,
  );
  const sourceSheets = Array.isArray(metadata.sheets) ? metadata.sheets : [];
  const titles = sourceSheets.map((sheet: any) => String(sheet?.properties?.title || ''));
  const requestedTitles = titles.filter(Boolean);
  const ranges = requestedTitles
    .map(
      (title: string) =>
        `ranges=${encodeURIComponent(
          `'${title.replaceAll("'", "''")}'!A1:${columnName(MAX_SHEET_COLUMNS)}${MAX_SHEET_ROWS}`,
        )}`,
    )
    .join('&');
  const values = await googleJson(
    accessToken,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}/values:batchGet?majorDimension=ROWS&valueRenderOption=FORMULA&${ranges}`,
  );
  const byRange = Array.isArray(values.valueRanges) ? values.valueRanges : [];
  const rowsByTitle = new Map<string, any[]>();
  requestedTitles.forEach((title: string, index: number) => {
    const rows = byRange[index]?.values;
    rowsByTitle.set(title, Array.isArray(rows) ? rows : []);
  });
  const sheets = sourceSheets.map((source: any, sheetIndex: number) => {
    const id = `google-sheet-${source?.properties?.sheetId ?? sheetIndex}`;
    const rows = rowsByTitle.get(titles[sheetIndex]) || [];
    const observedColumns = rows.reduce(
      (maximum: number, row: any[]) => Math.max(maximum, Array.isArray(row) ? row.length : 0),
      0,
    );
    const rowCount = Math.min(
      MAX_SHEET_ROWS,
      Math.max(Number(source?.properties?.gridProperties?.rowCount) || 100, rows.length, 1),
    );
    const columnCount = Math.min(
      MAX_SHEET_COLUMNS,
      Math.max(Number(source?.properties?.gridProperties?.columnCount) || 26, observedColumns, 1),
    );
    const cells: Record<string, SheetCell> = {};
    let storedCellCount = 0;
    rows.forEach((row: any[], rowIndex: number) => {
      if (!Array.isArray(row) || rowIndex >= rowCount || storedCellCount >= MAX_SHEET_CELLS) {
        return;
      }
      row.forEach((raw, columnIndex) => {
        if (columnIndex >= columnCount || storedCellCount >= MAX_SHEET_CELLS) return;
        if (raw === '' || raw === null || raw === undefined) return;
        const address = `${columnName(columnIndex + 1)}${rowIndex + 1}`;
        if (typeof raw === 'string' && raw.startsWith('=')) cells[address] = { formula: raw.slice(1) };
        else if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'string') {
          cells[address] = { value: raw };
        }
        if (cells[address]) storedCellCount += 1;
      });
    });
    return {
      id,
      name: String(source?.properties?.title || `Sheet ${sheetIndex + 1}`),
      rowCount,
      columnCount,
      cells,
    };
  });
  const fallbackId = `google-sheet-${randomUUID().slice(0, 8)}`;
  return {
    kind: 'sheet',
    version: 1,
    activeSheetId: sheets[0]?.id || fallbackId,
    sheets: sheets.length
      ? sheets
      : [{ id: fallbackId, name: 'Sheet 1', rowCount: 100, columnCount: 26, cells: {} }],
  };
}

function pointMagnitude(dimension: any) {
  const magnitude = Number(dimension?.magnitude) || 0;
  const unit = String(dimension?.unit || 'PT');
  if (unit === 'EMU') return magnitude / 12_700;
  return magnitude;
}

function importSlideElement(element: any, slideIndex: number, elementIndex: number): DeckElement | null {
  const text = (Array.isArray(element?.shape?.text?.textElements) ? element.shape.text.textElements : [])
    .map((entry: any) => String(entry?.textRun?.content || ''))
    .join('')
    .replace(/\n$/u, '');
  if (!element?.shape && !text) return null;
  const transform = element.transform || {};
  const widthPt = pointMagnitude(element?.size?.width) * (Number(transform.scaleX) || 1);
  const heightPt = pointMagnitude(element?.size?.height) * (Number(transform.scaleY) || 1);
  const xPt = pointMagnitude({ magnitude: transform.translateX, unit: transform.unit });
  const yPt = pointMagnitude({ magnitude: transform.translateY, unit: transform.unit });
  const placeholder = String(element?.shape?.placeholder?.type || '');
  const role =
    placeholder === 'TITLE' || placeholder === 'CENTERED_TITLE'
      ? ('title' as const)
      : placeholder === 'SUBTITLE'
        ? ('subtitle' as const)
        : ('body' as const);
  return {
    id: String(element.objectId || `google-element-${slideIndex}-${elementIndex}`),
    type: text || element?.shape?.shapeType === 'TEXT_BOX' ? 'text' : 'shape',
    role: text ? role : 'shape',
    x: Math.max(0, Math.min(100, (xPt / 720) * 100)),
    y: Math.max(0, Math.min(100, (yPt / 405) * 100)),
    width: Math.max(1, Math.min(100, (widthPt / 720) * 100 || 20)),
    height: Math.max(1, Math.min(100, (heightPt / 405) * 100 || 10)),
    text,
    fontSize: role === 'title' ? 30 : role === 'subtitle' ? 20 : 16,
  };
}

function importGoogleDeck(payload: any): AlbatrossDocumentModel {
  const slides = (Array.isArray(payload.slides) ? payload.slides : []).map(
    (source: any, slideIndex: number) => {
      const elements = (Array.isArray(source.pageElements) ? source.pageElements : [])
        .map((element: any, elementIndex: number) => importSlideElement(element, slideIndex, elementIndex))
        .filter(Boolean) as DeckElement[];
      const title = (
        elements.find((element) => element.role === 'title')?.text || `Slide ${slideIndex + 1}`
      ).slice(0, 500);
      return {
        id: String(source.objectId || `google-slide-${slideIndex + 1}`),
        title,
        elements,
      };
    },
  );
  const fallbackId = `google-slide-${randomUUID().slice(0, 8)}`;
  return {
    kind: 'deck',
    version: 1,
    activeSlideId: slides[0]?.id || fallbackId,
    slides: slides.length ? slides : [{ id: fallbackId, title: 'Title slide', elements: [] }],
  };
}

export async function importGoogleNativeFile(input: {
  userId: string;
  connectionId: string;
  fileId: string;
  mimeType: GoogleNativeMime;
}) {
  const kind = GOOGLE_NATIVE_MIME[input.mimeType];
  if (!kind) throw new Error('Only Google Docs, Sheets, and Slides can be edited inline.');
  const access = await dependencies.getCloudFileAccess({
    userId: input.userId,
    connectionId: input.connectionId,
  });
  if (!access || access.connection.provider !== 'google_drive') {
    throw new Error('Google Drive connection not found.');
  }
  const driveMetadata = await googleDriveMetadata(access.accessToken, input.fileId);
  if (kind === 'doc') {
    const payload = await googleJson(
      access.accessToken,
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(input.fileId)}`,
    );
    return {
      kind,
      title: String(driveMetadata.title || payload.title || 'Untitled document'),
      model: importGoogleDoc(payload),
      webUrl: driveMetadata.webUrl,
      providerVersion: driveMetadata.providerVersion,
    };
  }
  if (kind === 'sheet') {
    const metadata = await googleJson(
      access.accessToken,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.fileId)}?fields=properties.title`,
    );
    return {
      kind,
      title: String(driveMetadata.title || metadata?.properties?.title || 'Untitled spreadsheet'),
      model: await importGoogleSheet(access.accessToken, input.fileId),
      webUrl: driveMetadata.webUrl,
      providerVersion: driveMetadata.providerVersion,
    };
  }
  const payload = await googleJson(
    access.accessToken,
    `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(input.fileId)}`,
  );
  return {
    kind,
    title: String(driveMetadata.title || payload.title || 'Untitled presentation'),
    model: importGoogleDeck(payload),
    webUrl: driveMetadata.webUrl,
    providerVersion: driveMetadata.providerVersion,
  };
}
