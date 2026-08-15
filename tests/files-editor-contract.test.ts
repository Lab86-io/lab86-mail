import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { paginateDocBlocks } from '../components/files/DocumentEditor';

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('provider-faithful file editing contracts', () => {
  test('opens Google-native files through the provider editor without importing a copy', () => {
    const files = source('components/files/FilesSurface.tsx');
    const route = source('app/api/files/google/editor/route.ts');

    expect(files).toContain('openGoogleDocument({');
    expect(files).toContain('<GoogleDocumentEditor source={openGoogleFile}');
    expect(files).not.toContain(
      "fetchJson<{ ok: true; document: AlbatrossDocumentRecord }>('/api/files/google/import'",
    );
    expect(route).toContain('updateGoogleNativeFile({');
    expect(route).not.toContain('createAndLinkGoogleDocument');
    expect(route).not.toContain('createDocument(');
  });

  test('renders wrapped document content at its full intrinsic height', () => {
    const web = source('components/files/DocumentEditor.tsx');
    const ios = source('apps/ios/Lab86Mail/Features/Files/DocumentEditorView.swift');

    expect(web).toContain("import TextareaAutosize from 'react-textarea-autosize'");
    expect(web).toContain('<TextareaAutosize');
    expect(web).not.toContain("rows={Math.max(1, block.text.split('\\n').length)}");
    expect(ios).toContain('GrowingTextEditor(');
    expect(ios).toContain('view.isScrollEnabled = false');
    expect(ios).toContain('sizeThatFits(');
  });

  test('lays long documents out as multiple editable pages without dropping blocks', () => {
    const blocks = Array.from({ length: 24 }, (_, index) => ({
      id: `block-${index}`,
      type: 'paragraph' as const,
      text: `Paragraph ${index} ${'content '.repeat(24)}`,
    }));
    const pages = paginateDocBlocks(blocks, { charactersPerLine: 40, linesPerPage: 20 });

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat().map(({ block }) => block.id)).toEqual(blocks.map((block) => block.id));
  });

  test('opens iCloud and Files-provider documents in place on iOS', () => {
    const files = source('apps/ios/Lab86Mail/Features/Files/FilesView.swift');
    const navigation = source('apps/ios/Lab86Mail/Features/Shell/NavigationModel.swift');

    expect(files).toContain('forOpeningContentTypes: [.item]');
    expect(files).toContain('asCopy: false');
    expect(files).toContain('.quickLookPreview($previewURL)');
    expect(files).not.toContain('store.importGoogle(item)');
    expect(files).not.toContain('uploadLocalFile(');
    expect(navigation).toContain('case google(GoogleDocumentRoute)');
    expect(navigation).toContain('func openGoogleDocument(_ item: CloudFileItem)');
  });

  test('all distributed iOS builds use production services', () => {
    const postClone = source('apps/ios/ci_scripts/ci_post_clone.sh');
    const verifier = source('apps/ios/ci_scripts/verify_built_configuration.sh');

    expect(postClone).toContain('refs/heads/main|refs/heads/staging)');
    expect(postClone).toContain('refs/tags/ios-staging-*');
    expect(postClone).not.toContain('mail-staging.lab86.io');
    expect(postClone).not.toContain('pk_test_');
    expect(verifier).toContain('refs/heads/main|refs/heads/staging)');
    expect(verifier).toContain('refs/tags/ios-staging-*');
    expect(verifier).not.toContain('mail-staging.lab86.io');
  });

  test('turns a brief-required deliverable into a reviewable reply attachment', () => {
    const triage = source('lib/brief/triage-index.ts');
    const webBrief = source('components/report/brief-canvas/BriefCanvas.tsx');
    const iosBrief = source('apps/ios/Lab86Mail/Features/Today/DailyBriefView.swift');

    expect(triage).toContain('attachToReply: true');
    expect(webBrief).toContain(
      'await prepareDocumentReply(result.documentId, result.title, result.kind, payload',
    );
    expect(webBrief).toContain('setComposeRecoveredFiles([attachment])');
    expect(webBrief).toContain("fetch('/api/compose/draft'");
    expect(iosBrief).toContain('MailIntentAttachmentStore.shared.saveComposeAttachments');
    expect(iosBrief).toContain('attachmentsKey: attachmentsKey');
    expect(iosBrief).toContain('environment.navigation.sheet = .compose');
  });
});
