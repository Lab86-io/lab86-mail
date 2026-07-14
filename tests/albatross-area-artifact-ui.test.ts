import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('generated Area screen host contract', () => {
  test('renders the full selected-Area canvas as an opaque sandboxed HTML artifact', () => {
    const source = read('components/albatross/AreaHome.tsx');
    expect(source).toContain('data-area-artifact-canvas');
    expect(source).toContain('srcDoc={srcDoc}');
    expect(source).toContain('injectAreaArtifactRuntime(html)');
    expect(source).toContain('sandbox="allow-scripts"');
    expect(source).not.toContain('allow-popups');
    expect(source).not.toContain('allow-same-origin');
  });

  test('trusts only the current iframe window and the validated Area action parser', () => {
    const source = read('components/albatross/AreaHome.tsx');
    expect(source).toContain('event.source !== frame.contentWindow');
    expect(source).toContain('parseAreaArtifactMessage(event.data, areaId)');
    expect(source).toContain("case 'capture_intent'");
    expect(source).toContain('window.confirm(');
  });

  test('preserves last-good HTML during regeneration and bounds persisted documents', () => {
    const mutation = read('convex/albatrossWorkV2.ts');
    expect(mutation).toContain('areaArtifactHtmlForWrite(');
    expect(mutation).toContain('assertAreaArtifactDocumentSize(');
    expect(mutation).not.toContain('args.artifactHtml.slice(');
    const gateway = read('lib/ai/gateway.ts');
    expect(gateway).toContain('albatross_area_artifact: 32000');
    expect(gateway).toContain("'albatross_area_artifact'");
  });
});
