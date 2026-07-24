export const AREA_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export interface AreaImageSourceLike {
  imageUrl?: string | null;
  faviconUrl?: string | null;
}

// Ordered fallback chain for an area's rendered identity mark: the area's own
// image first, then its favicon, dropping blank/whitespace-only values.
// Shared by every desktop surface that renders an area icon so the
// image → favicon → colored-dot ordering never drifts between them.
export function orderedAreaImageSources(area: AreaImageSourceLike): string[] {
  return [area.imageUrl, area.faviconUrl].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
}

export interface AreaImageUploadLike {
  contentType?: string | null;
  size: number;
}

export function validateAreaImageUpload(upload: AreaImageUploadLike) {
  if (
    !String(upload.contentType || '')
      .toLowerCase()
      .startsWith('image/')
  ) {
    throw new Error('Choose an image file.');
  }
  if (!Number.isFinite(upload.size) || upload.size <= 0) throw new Error('The image is empty.');
  if (upload.size > AREA_IMAGE_MAX_BYTES) throw new Error('Area images must be 8MB or smaller.');
}
