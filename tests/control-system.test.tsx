import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantLauncher } from '../components/shell/ShellActions';
import { MessageDraft } from '../components/tool-ui/message-draft/message-draft';
import { Button, buttonVariants } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { cn } from '../lib/utils';

describe('shared control surfaces', () => {
  test('neutral and primary buttons use the shared depth token; quiet controls stay flat', () => {
    for (const variant of ['default', 'outline'] as const) {
      expect(buttonVariants({ variant })).toContain('shadow-[var(--shadow-control)]');
      expect(buttonVariants({ variant })).toContain('rounded-ui');
      expect(buttonVariants({ variant })).toContain('corner-smooth');
    }
    for (const variant of ['ghost', 'secondary'] as const) {
      expect(buttonVariants({ variant })).toContain('shadow-none');
    }
  });

  test('disabled and invalid field semantics are forwarded without removing values', () => {
    const field = renderToStaticMarkup(
      <Input aria-label="Name" value="Retained draft" readOnly aria-invalid disabled />,
    );
    expect(field).toContain('control-field');
    expect(field).toContain('disabled=""');
    expect(field).toContain('aria-invalid="true"');
    expect(field).toContain('value="Retained draft"');
    expect(renderToStaticMarkup(<Textarea aria-label="Notes" defaultValue="Notes" />)).toContain(
      'control-field',
    );
  });

  test('button overrides and disabled semantics survive the shared styling', () => {
    const button = renderToStaticMarkup(
      <Button variant="outline" size="sm" disabled className="h-11">
        Upload
      </Button>,
    );
    expect(button).toContain('h-11');
    expect(button).not.toContain('h-8');
    expect(button).toContain('disabled=""');
  });

  test('corner roles do not erase explicit circle, square, or panel radius overrides', () => {
    for (const radius of ['rounded-full', 'rounded-none']) {
      const button = renderToStaticMarkup(<Button className={radius}>Override</Button>);
      expect(button).toContain(radius);
      expect(button).not.toContain('rounded-ui');
    }
    const card = renderToStaticMarkup(<Card>Content</Card>);
    expect(card).toContain('shadow-none');
    expect(card).toContain('corner-smooth');
    expect(card).toContain('rounded-[var(--radius-panel)]');
    const squareCard = renderToStaticMarkup(<Card className="rounded-none">Content</Card>);
    expect(squareCard).not.toContain('rounded-[var(--radius-panel)]');
    expect(cn('rounded-xl', 'rounded-ui')).toBe('rounded-ui');
    expect(cn('rounded-ui', 'rounded-none')).toBe('rounded-none');
    expect(cn('rounded-ui', 'rounded-t-none')).toBe('rounded-ui rounded-t-none');
    expect(cn('rounded-ui', 'rounded-t-ui')).toBe('rounded-ui rounded-t-ui');
    expect(cn('rounded-t-ui', 'rounded-t-none')).toBe('rounded-t-none');
    expect(cn('rounded-l-ui', 'rounded-r-none')).toBe('rounded-l-ui rounded-r-none');
  });

  test('launcher keeps one stable name and shortcut in both placements, with no decorative glow', () => {
    for (const placement of ['corner', 'stacked'] as const) {
      const html = renderToStaticMarkup(
        <AssistantLauncher placement={placement} shortcut="Ctrl K" onOpen={() => {}} />,
      );
      expect(html).toContain('aria-label="Ask Albatross or get this off my mind"');
      expect(html).toContain('aria-keyshortcuts="Meta+K Control+K"');
      expect(html).toContain(`data-placement="${placement}"`);
      expect(html).toContain('Ctrl K');
      expect(html).toContain('class="assistant-launcher"');
      // Copy is decorative; the accessible name above is the only label.
      expect(html).toContain('class="assistant-launcher__copy" aria-hidden="true"');
      expect(html).not.toContain('aria-live');
      expect(html).not.toContain('rounded-xl');
      expect(html).not.toContain('sparkle');
      expect(html).not.toContain('border-beam');
      expect(html).not.toContain('ask-assistant-glow');
      expect(html).not.toContain('<svg');
      expect(html).not.toContain('assistant-launcher__mark');
    }
  });

  test('opening a draft editor is explicitly not a send action', () => {
    const html = renderToStaticMarkup(
      <MessageDraft
        id="draft"
        channel="email"
        to={['alex@example.test']}
        subject="Update"
        body="Draft content"
        onEdit={() => {}}
      />,
    );
    expect(html).toContain('Edit draft');
    expect(html).toContain('data-state="review"');
    expect(html).not.toContain('>Send<');
    expect(html).not.toContain('Message sent');
  });
});
