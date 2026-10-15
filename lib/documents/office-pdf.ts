// A PDF copy of an Office file (docs/albatross-goal-runs.md G4). The document
// server makes the PDF. This is a placeholder until the documents round adds
// the real conversion; the send path calls it for a draft attachment with
// `format: 'pdf'`.

export async function exportOfficePdf(
  userId: string,
  documentId: string,
): Promise<{ bytes: Uint8Array; name: string }> {
  void userId;
  void documentId;
  throw new Error('PDF export is not ready.');
}
