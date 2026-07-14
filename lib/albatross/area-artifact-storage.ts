export const AREA_ARTIFACT_DOCUMENT_MAX = 400_000;

type AreaBriefStatus = 'generating' | 'ready' | 'error';

/**
 * A ready write replaces the edition only when the caller supplied the field.
 * Transitional/error writes always retain the last known-good document.
 */
export function areaArtifactHtmlForWrite(
  status: AreaBriefStatus,
  incoming: string | undefined,
  existing: string | undefined,
) {
  return status === 'ready' && incoming !== undefined ? incoming : existing;
}

/** JSON UTF-8 size is a conservative, deterministic preflight for this record. */
export function encodedAreaArtifactDocumentSize(document: unknown) {
  return new TextEncoder().encode(JSON.stringify(document)).byteLength;
}

export function assertAreaArtifactDocumentSize(document: unknown) {
  if (encodedAreaArtifactDocumentSize(document) > AREA_ARTIFACT_DOCUMENT_MAX) {
    throw new Error('Area artifact document exceeds the maximum size.');
  }
}
