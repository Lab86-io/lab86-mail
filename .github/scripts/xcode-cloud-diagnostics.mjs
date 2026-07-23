import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { findLogBundles } from './xcode-cloud-artifacts.mjs';

const DEFAULT_DOWNLOAD_TIMEOUT_MILLISECONDS = 30_000;

function allocateFileName(value, allocatedFileNames) {
  const baseName = basename(value || 'xcode-cloud.logbundle.zip');
  const extension = extname(baseName);
  const stem = extension ? baseName.slice(0, -extension.length) : baseName;
  let fileName = baseName;
  let suffix = 2;
  while (allocatedFileNames.has(fileName)) {
    fileName = `${stem}-${suffix}${extension}`;
    suffix += 1;
  }
  allocatedFileNames.add(fileName);
  return fileName;
}

export async function preserveLogBundles(
  artifacts,
  {
    diagnosticsDirectory,
    fetchImpl = fetch,
    makeDirectory = mkdirSync,
    writeFile = writeFileSync,
    logger = console,
    timeoutMilliseconds = DEFAULT_DOWNLOAD_TIMEOUT_MILLISECONDS,
  } = {},
) {
  if (!diagnosticsDirectory) {
    return { preserved: [], failed: [] };
  }

  const logBundles = findLogBundles(artifacts);
  if (logBundles.length === 0) {
    logger.warn('Xcode Cloud returned no downloadable log bundle for the failed archive.');
    return { preserved: [], failed: [] };
  }

  const preserved = [];
  const failed = [];

  const allocatedFileNames = new Set();
  const fileNames = logBundles.map(({ attributes }) =>
    allocateFileName(attributes.fileName, allocatedFileNames),
  );

  try {
    makeDirectory(diagnosticsDirectory, { recursive: true });
  } catch (error) {
    logger.warn(
      `Could not create Xcode Cloud diagnostics directory: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { preserved, failed: fileNames };
  }

  for (const [index, { attributes }] of logBundles.entries()) {
    const fileName = fileNames[index];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);

    try {
      const response = await fetchImpl(attributes.downloadUrl, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`download returned HTTP ${response.status}`);
      }
      const contents = Buffer.from(await response.arrayBuffer());
      writeFile(join(diagnosticsDirectory, fileName), contents);
      preserved.push(fileName);
      logger.log(`Preserved Xcode Cloud diagnostic log bundle: ${fileName}`);
    } catch (error) {
      failed.push(fileName);
      logger.warn(
        `Could not preserve Xcode Cloud log bundle ${fileName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  return { preserved, failed };
}
