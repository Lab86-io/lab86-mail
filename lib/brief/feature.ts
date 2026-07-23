export function briefDocumentV2Enabled(env: Record<string, string | undefined> = process.env): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    String(env.BRIEF_DOCUMENT_V2 || '')
      .trim()
      .toLowerCase(),
  );
}
