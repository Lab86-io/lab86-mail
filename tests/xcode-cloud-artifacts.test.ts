import { describe, expect, test } from 'bun:test';
import {
  findAppStoreExport,
  findArchiveAction,
  findTestFlightAction,
} from '../.github/scripts/xcode-cloud-artifacts.mjs';

describe('Xcode Cloud distribution artifacts', () => {
  const actions = [
    {
      id: 'build-action',
      attributes: { name: 'Build - iOS', actionType: 'BUILD', completionStatus: 'SUCCEEDED' },
    },
    {
      id: 'archive-action',
      attributes: { name: 'Archive - iOS', actionType: 'ARCHIVE', completionStatus: 'SUCCEEDED' },
    },
    {
      id: 'testflight-action',
      attributes: {
        name: 'TestFlight Internal Testing - iOS',
        actionType: 'ANALYZE',
        completionStatus: 'SUCCEEDED',
      },
    },
  ];

  test('finds the archive and direct TestFlight actions by their durable contracts', () => {
    expect(findArchiveAction(actions)?.id).toBe('archive-action');
    expect(findTestFlightAction(actions)?.id).toBe('testflight-action');
  });

  test('selects only an App Store archive export', () => {
    const artifacts = [
      {
        id: 'archive',
        attributes: {
          fileType: 'ARCHIVE',
          fileName: 'Albatross.xcarchive.zip',
          downloadUrl: 'https://example.test/archive',
        },
      },
      {
        id: 'development-export',
        attributes: {
          fileType: 'ARCHIVE_EXPORT',
          fileName: 'Albatross development.zip',
          downloadUrl: 'https://example.test/development',
        },
      },
      {
        id: 'app-store-export',
        attributes: {
          fileType: 'ARCHIVE_EXPORT',
          fileName: 'Albatross app-store.zip',
          downloadUrl: 'https://example.test/app-store',
        },
      },
    ];

    expect(findAppStoreExport(artifacts)?.id).toBe('app-store-export');
    expect(findAppStoreExport([])).toBeUndefined();
  });
});
