export const AREA_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

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
