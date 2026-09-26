/**
 * How a reply draft lands in the composer. The draft never replaces text the
 * user typed, and a starter template (no model set up) is named as one, so
 * neither case is silent.
 */
export type DraftReplyNotice = { kind: 'info' | 'error'; text: string };

export function applyDraftReply(
  currentBody: string,
  result: { draft?: string | null; model?: string | null },
): { body: string; notice: DraftReplyNotice | null } {
  const draft = (result.draft || '').trim();
  if (!draft) return { body: currentBody, notice: { kind: 'error', text: 'Could not draft a reply.' } };
  if (currentBody.trim())
    return {
      body: currentBody,
      notice: {
        kind: 'info',
        text: 'Your message already has text, so the draft was not added. Clear it and try again.',
      },
    };
  if (result.model === 'local')
    return {
      body: result.draft || draft,
      notice: {
        kind: 'info',
        text: 'No model is set up, so this is a starter reply. Set up a model in Settings, Intelligence.',
      },
    };
  return { body: result.draft || draft, notice: null };
}
