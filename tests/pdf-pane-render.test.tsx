import { describe, expect, test } from 'bun:test';
import { act } from 'react';
import { create } from 'react-test-renderer';
import { PdfPane, sealedFieldsFromKey, sealedFieldsKey } from '../components/albatross/thread/PdfPane';

// Passive effects run inside act only when React knows it is an act environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* The PDF pane loads its file once (CodeRabbit 4287727496): a re-render with
 * an equal sealed-field list, or with the prop omitted, must not start the
 * load again. */

describe('the sealed-field key', () => {
  test('equal lists are one key, and the key reads back as the list', () => {
    expect(sealedFieldsKey(['ssn', 'ein'])).toBe(sealedFieldsKey(['ssn', 'ein']));
    expect(sealedFieldsKey([])).toBe('');
    expect(sealedFieldsFromKey(sealedFieldsKey(['ssn', 'ein']))).toEqual(['ssn', 'ein']);
    expect(sealedFieldsFromKey('')).toEqual([]);
    expect(sealedFieldsKey(['ssn'])).not.toBe(sealedFieldsKey(['ein']));
  });
});

describe('the pane', () => {
  test('a re-render with an equal list, or no list, does not load the file again', async () => {
    // The preview goes through fetch (the Download button uses loadFile).
    const originalFetch = globalThis.fetch;
    let loads = 0;
    globalThis.fetch = (async () => {
      loads += 1;
      return new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { 'x-sealed-fields': 'ssn' },
      });
    }) as unknown as typeof fetch;
    try {
      const props = {
        url: '/api/files/saved/upload_1?preview=1',
        downloadUrl: '/api/files/saved/upload_1',
        title: 'Form W-9, filled',
      };
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(<PdfPane {...props} sealedFields={['ssn']} />);
      });
      expect(loads).toBe(1);
      await act(async () => {
        renderer.update(<PdfPane {...props} sealedFields={['ssn']} />);
      });
      await act(async () => {
        renderer.update(<PdfPane {...props} sealedFields={['ssn']} title="Form W-9, filled" />);
      });
      expect(loads).toBe(1);

      let bare!: ReturnType<typeof create>;
      await act(async () => {
        bare = create(<PdfPane {...props} />);
      });
      await act(async () => {
        bare.update(<PdfPane {...props} />);
      });
      await act(async () => {
        bare.update(<PdfPane {...props} />);
      });
      expect(loads).toBe(2);

      // A different list is a new load.
      await act(async () => {
        renderer.update(<PdfPane {...props} sealedFields={['ssn', 'ein']} />);
      });
      expect(loads).toBe(3);
      await act(async () => {
        renderer.unmount();
        bare.unmount();
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
