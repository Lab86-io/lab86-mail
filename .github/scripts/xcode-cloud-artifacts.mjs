export function findTestFlightAction(actions) {
  return actions.find(({ attributes }) => attributes.name === 'TestFlight Internal Testing - iOS');
}

export function findArchiveAction(actions) {
  return actions.find(({ attributes }) => attributes.actionType === 'ARCHIVE');
}

export function findAppStoreExport(artifacts) {
  return artifacts.find(
    ({ attributes }) =>
      attributes.fileType === 'ARCHIVE_EXPORT' && attributes.fileName.endsWith(' app-store.zip'),
  );
}

export function findLogBundles(artifacts) {
  return artifacts.filter(({ attributes }) => attributes.fileType === 'LOG_BUNDLE' && attributes.downloadUrl);
}
