import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkLog } from '../components/ai-elements/work-log';
import { MessageView } from '../components/shell/AIBar';

describe('chat surfaces', () => {
  test('user messages use an Odyssey message bubble and preserve attachments', () => {
    const markup = renderToStaticMarkup(
      <MessageView
        message={{
          role: 'user',
          parts: [
            { type: 'text', text: 'My own message' },
            {
              type: 'file',
              mediaType: 'text/plain',
              filename: 'notes.txt',
              url: 'data:text/plain;base64,aGk=',
            },
          ],
        }}
      />,
    );
    expect(markup).toContain('data-message-role="user"');
    expect(markup).toContain('data-slot="message-bubble-content"');
    expect(markup).toContain('rounded-br-sm');
    expect(markup).toContain('My own message');
    expect(markup).toContain('notes.txt');
  });

  test('failed tool calls keep their error and status inside Odyssey steps and thought chain', () => {
    const markup = renderToStaticMarkup(
      <WorkLog
        finished
        rows={[
          {
            toolCallId: 'failed',
            toolName: 'document_edit',
            state: 'failed',
            shape: null,
            part: {
              type: 'tool-document_edit',
              state: 'output-error',
              errorText: 'The file changed. Read it again.',
              input: {},
            },
          },
        ]}
      />,
    );
    expect(markup).toContain('data-slot="thought-chain"');
    expect(markup).toContain('data-status="failed"');
    expect(markup).toContain('data-work-state="failed"');
    expect(markup).toContain('The file changed. Read it again.');
    expect(markup).toContain('1 step failed');
  });
});
