import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { findLogBundles } from './xcode-cloud-artifacts.mjs';

const DEFAULT_DOWNLOAD_TIMEOUT_MILLISECONDS = 30_000;

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

  try {
    makeDirectory(diagnosticsDirectory, { recursive: true });
  } catch (error) {
    const fileNames = logBundles.map(({ attributes }) =>
      basename(attributes.fileName || 'xcode-cloud.logbundle.zip'),
    );
    logger.warn(
      `Could not create Xcode Cloud diagnostics directory: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { preserved, failed: fileNames };
  }

  for (const { attributes } of logBundles) {
    const fileName = basename(attributes.fileName || 'xcode-cloud.logbundle.zip');
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
