/**
 * Image upload for the slide editor. The route stores the file as an owned
 * asset and answers with the reference the deck model keeps. A failure
 * surfaces the server's own message so the user sees why.
 */
export interface UploadedDeckAsset {
  assetId: string;
  src: string;
  width?: number;
  height?: number;
  aspect?: number;
  mime?: string;
}

export const DECK_ASSET_ROUTE = '/api/documents/assets';
export const MAX_DECK_ASSET_BYTES = 12 * 1024 * 1024;

export async function uploadDeckAsset(
  file: File,
  fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
): Promise<UploadedDeckAsset> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > MAX_DECK_ASSET_BYTES) throw new Error('The image is larger than 12 MB.');
  const body = new FormData();
  body.append('file', file, file.name);
  const response = await fetchImpl(DECK_ASSET_ROUTE, { method: 'POST', body });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const message =
      (typeof payload.error === 'string' && payload.error) ||
      (typeof payload.message === 'string' && payload.message) ||
      (text && text.length < 300 ? text : '') ||
      `Upload failed (${response.status}).`;
    throw new Error(message);
  }
  if (typeof payload.assetId !== 'string' || typeof payload.src !== 'string')
    throw new Error('The upload did not return an asset.');
  const width = typeof payload.width === 'number' ? payload.width : undefined;
  const height = typeof payload.height === 'number' ? payload.height : undefined;
  const aspect =
    typeof payload.aspect === 'number' && payload.aspect > 0
      ? payload.aspect
      : width && height
        ? width / height
        : undefined;
  return {
    assetId: payload.assetId,
    src: payload.src,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(aspect ? { aspect } : {}),
    ...(typeof payload.mime === 'string' ? { mime: payload.mime } : {}),
  };
}
