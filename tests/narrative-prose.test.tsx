import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NarrativeProse, narrativeProse } from '../components/narrative/NarrativeProse';
import { splitInitial } from '../components/ui/drop-cap';

describe('Today narrative lede', () => {
  test('keeps the complete opening word, quotes and combining marks in reading order', () => {
    for (const text of [
      'Give this your attention.',
      '“Élan matters.”',
      'E\u0301lan matters.',
      '<script>unsafe</script>',
      '📬 Mail is here.',
      '',
    ]) {
      expect(splitInitial(text).join('')).toBe(text);
    }
    expect(splitInitial('“Élan matters.”')).toEqual(['“É', 'lan matters.”']);
    expect(splitInitial('E\u0301lan matters.')[0]).toBe('E\u0301');
    expect(splitInitial('📬 Mail is here.')[0]).toBe('');
    const html = renderToStaticMarkup(<NarrativeProse text="Give this your attention." />);
    expect(html).toContain('data-drop-cap');
    expect(html).toContain('>G</span>ive this your attention.');
  });
  test('uses a short opening paragraph and keeps subsequent paragraphs distinct', () => {
    expect(
      narrativeProse('Review the proposal today.\n\nThe meeting is tomorrow.\n\nNo reply is confirmed.'),
    ).toEqual({
      lede: 'Review the proposal today.',
      paragraphs: ['The meeting is tomorrow.', 'No reply is confirmed.'],
    });
  });

  test('separates a long legacy block at a sentence boundary without losing content', () => {
    const text = `Review the proposal from alex@example.test today. ${'The release remains unconfirmed. '.repeat(15).trim()}`;
    const prose = narrativeProse(text);
    expect(prose.lede).toBe('Review the proposal from alex@example.test today.');
    expect([prose.lede, ...prose.paragraphs].join(' ')).toBe(text);
  });

  test('never truncates a long sentence or invents text for an empty edition', () => {
    const sentence = 'A source-backed observation '.repeat(20).trim();
    expect(narrativeProse(sentence)).toEqual({ lede: sentence, paragraphs: [] });
    expect(narrativeProse('  ')).toEqual({ lede: '', paragraphs: [] });
    expect(narrativeProse('One short edition.')).toEqual({ lede: 'One short edition.', paragraphs: [] });
  });

  test('renders a distinct lede and body as safe, readable text', () => {
    const html = renderToStaticMarkup(
      <NarrativeProse text={'Opening.\n\n<script>unsafe</script>\n\nClosing.'} />,
    );
    expect(html).toContain('data-narrative-lede');
    expect(html).toContain('data-narrative-body');
    expect(html).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<p class="indent-[1.5em]">Closing.</p>');
    expect(renderToStaticMarkup(<NarrativeProse text="Only the opening." />)).not.toContain(
      'data-narrative-body',
    );
  });
});
