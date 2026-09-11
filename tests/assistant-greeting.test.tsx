import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantGreeting, assistantGreeting } from '../components/shell/AssistantGreeting';

describe('assistant invitation greeting', () => {
  test('keeps the selected phrase and adds the first name', () => {
    expect(assistantGreeting('Edit this document', ' Alex Morgan ')).toBe('Edit this document, Alex');
    expect(assistantGreeting('What needs attention?', 'Sam Lee')).toBe('What needs attention, Sam?');
  });
  test('uses the invitation alone when no usable display name is available', () => {
    for (const name of [undefined, null, '', '  ', 'alex@example.test']) {
      expect(assistantGreeting('Draft an email', name)).toBe('Draft an email');
    }
  });
  test('the synthetic greeting renders without an authentication provider', () => {
    const html = renderToStaticMarkup(<AssistantGreeting phrase="Plan the day" userName="Alex Morgan" />);
    expect(html).toContain('Plan the day, Alex');
    expect(html).toContain('data-assistant-greeting');
  });
});
