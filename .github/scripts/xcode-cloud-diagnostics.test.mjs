import assert from 'node:assert/strict';
import test from 'node:test';
import { preserveLogBundles } from './xcode-cloud-diagnostics.mjs';

function logBundle(fileName, downloadUrl = `https://example.com/${fileName}`) {
  return {
    attributes: {
      fileType: 'LOG_BUNDLE',
      fileName,
      downloadUrl,
    },
  };
}

function response({ ok = true, status = 200, contents = 'log', arrayBufferError } = {}) {
  return {
    ok,
    status,
    async arrayBuffer() {
      if (arrayBufferError) throw arrayBufferError;
      return Buffer.from(contents);
    },
  };
}

test('does nothing when diagnostics are not configured', async () => {
  let fetchCount = 0;

  const result = await preserveLogBundles([logBundle('build.zip')], {
    fetchImpl: async () => {
      fetchCount += 1;
      return response();
    },
  });

  assert.deepEqual(result, { preserved: [], failed: [] });
  assert.equal(fetchCount, 0);
});

test('writes successful log bundles through the exported preservation API', async () => {
  const directories = [];
  const writes = [];

  const result = await preserveLogBundles([logBundle('../Archive Logs.zip')], {
    diagnosticsDirectory: '/tmp/diagnostics',
    fetchImpl: async () => response({ contents: 'archive log' }),
    makeDirectory: (...arguments_) => directories.push(arguments_),
    writeFile: (...arguments_) => writes.push(arguments_),
    logger: { log() {}, warn() {} },
  });

  assert.deepEqual(result, { preserved: ['Archive Logs.zip'], failed: [] });
  assert.deepEqual(directories, [['/tmp/diagnostics', { recursive: true }]]);
  assert.equal(writes[0][0], '/tmp/diagnostics/Archive Logs.zip');
  assert.equal(writes[0][1].toString(), 'archive log');
});

test('preserves duplicate basenames without overwriting either bundle', async () => {
  const writes = [];
  const result = await preserveLogBundles(
    [
      logBundle('../Archive Logs.zip', 'https://example.com/first'),
      logBundle('Archive Logs.zip', 'https://example.com/second'),
    ],
    {
      diagnosticsDirectory: '/tmp/diagnostics',
      fetchImpl: async (url) => response({ contents: url }),
      makeDirectory() {},
      writeFile: (path, contents) => writes.push([path, contents.toString()]),
      logger: { log() {}, warn() {} },
    },
  );

  assert.deepEqual(result, {
    preserved: ['Archive Logs.zip', 'Archive Logs-2.zip'],
    failed: [],
  });
  assert.deepEqual(
    writes.map(([path]) => path),
    ['/tmp/diagnostics/Archive Logs.zip', '/tmp/diagnostics/Archive Logs-2.zip'],
  );
  assert.notEqual(writes[0][1], writes[1][1]);
});

test('isolates response, body, fetch, and file-write failures and continues', async () => {
  const warnings = [];
  const written = [];
  const bundles = [
    logBundle('response.zip'),
    logBundle('body.zip'),
    logBundle('fetch.zip'),
    logBundle('write.zip'),
    logBundle('success.zip'),
  ];

  const result = await preserveLogBundles(bundles, {
    diagnosticsDirectory: '/tmp/diagnostics',
    fetchImpl: async (url) => {
      if (url.endsWith('response.zip')) return response({ ok: false, status: 503 });
      if (url.endsWith('body.zip')) return response({ arrayBufferError: new Error('body failed') });
      if (url.endsWith('fetch.zip')) throw new Error('fetch failed');
      return response({ contents: url });
    },
    makeDirectory() {},
    writeFile: (path, contents) => {
      if (path.endsWith('write.zip')) throw new Error('write failed');
      written.push([path, contents.toString()]);
    },
    logger: { log() {}, warn: (message) => warnings.push(message) },
  });

  assert.deepEqual(result, {
    preserved: ['success.zip'],
    failed: ['response.zip', 'body.zip', 'fetch.zip', 'write.zip'],
  });
  assert.equal(written.length, 1);
  assert.match(written[0][0], /success\.zip$/);
  assert.equal(warnings.length, 4);
  assert.match(warnings[0], /response\.zip.*HTTP 503/);
  assert.match(warnings[1], /body\.zip.*body failed/);
  assert.match(warnings[2], /fetch\.zip.*fetch failed/);
  assert.match(warnings[3], /write\.zip.*write failed/);
});

test('reports every bundle when the diagnostics directory cannot be created', async () => {
  const warnings = [];

  const result = await preserveLogBundles([logBundle('one.zip'), logBundle('two.zip')], {
    diagnosticsDirectory: '/tmp/diagnostics',
    makeDirectory: () => {
      throw new Error('directory failed');
    },
    logger: { log() {}, warn: (message) => warnings.push(message) },
  });

  assert.deepEqual(result, {
    preserved: [],
    failed: ['one.zip', 'two.zip'],
  });
  assert.deepEqual(warnings, ['Could not create Xcode Cloud diagnostics directory: directory failed']);
});

test('times out one download and continues with the next bundle', async () => {
  const result = await preserveLogBundles([logBundle('slow.zip'), logBundle('success.zip')], {
    diagnosticsDirectory: '/tmp/diagnostics',
    fetchImpl: async (url, { signal }) => {
      if (url.endsWith('slow.zip')) {
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('download timed out')), {
            once: true,
          });
        });
      }
      return response();
    },
    makeDirectory() {},
    writeFile() {},
    logger: { log() {}, warn() {} },
    timeoutMilliseconds: 1,
  });

  assert.deepEqual(result, {
    preserved: ['success.zip'],
    failed: ['slow.zip'],
  });
});
