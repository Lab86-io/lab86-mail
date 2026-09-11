/** Illustrative UI results only. No model call, mail send, or provider write. */
export function previewBriefResponseEvents() {
  const draft = {
    id: 'preview-brief-reply',
    channel: 'email',
    from: 'alex@example.test',
    to: ['maya@example.test'],
    subject: 'North House · photography and review',
    body: 'Hi Maya,\n\nThanks for the revised schedule. I’ve put together a short proposal covering the photography, site updates, and opening event. Can you confirm the photography slot before we lock Friday’s review?\n\nAlex',
  };
  return [
    {
      type: 'tool-input-available',
      toolCallId: 'preview-brief-reply',
      toolName: 'show_message_draft',
      dynamic: true,
      input: draft,
    },
    {
      type: 'tool-output-available',
      toolCallId: 'preview-brief-reply',
      output: { ok: true, component: 'message-draft', payload: draft },
    },
    {
      type: 'tool-input-available',
      toolCallId: 'preview-brief-file',
      toolName: 'document_create',
      dynamic: true,
      input: { kind: 'doc', title: 'North House proposal' },
    },
    {
      type: 'tool-output-available',
      toolCallId: 'preview-brief-file',
      output: {
        ok: true,
        title: 'North House proposal',
        kind: 'doc',
        documentId: 'preview-document-0',
        revision: 1,
        summary: 'Sample editable proposal for local review.',
        openPath: '/?view=files&document=preview-document-0',
      },
    },
    { type: 'text-end', id: 'synthetic-text' },
    { type: 'finish', finishReason: 'stop' },
  ];
}
