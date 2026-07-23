import assert from "node:assert/strict";
import test from "node:test";
import {
  findAppStoreExport,
  findArchiveAction,
  findLogBundles,
  findTestFlightAction,
} from "./xcode-cloud-artifacts.mjs";

test("selects release artifacts and actions by durable API attributes", () => {
  const actions = [
    {
      id: "build",
      attributes: { actionType: "BUILD", name: "Build - iOS" },
    },
    {
      id: "archive",
      attributes: { actionType: "ARCHIVE", name: "Archive - iOS" },
    },
    {
      id: "testflight",
      attributes: {
        actionType: "TESTFLIGHT",
        name: "TestFlight Internal Testing - iOS",
      },
    },
  ];
  const artifacts = [
    {
      attributes: {
        fileType: "ARCHIVE_EXPORT",
        fileName: "Lab86Mail 0.1.0 development.zip",
        downloadUrl: "https://example.com/development",
      },
    },
    {
      attributes: {
        fileType: "ARCHIVE_EXPORT",
        fileName: "Lab86Mail 0.1.0 app-store.zip",
        downloadUrl: "https://example.com/app-store",
      },
    },
    {
      attributes: {
        fileType: "LOG_BUNDLE",
        fileName: "Lab86Mail Logs.zip",
        downloadUrl: "https://example.com/logs",
      },
    },
    {
      attributes: {
        fileType: "LOG_BUNDLE",
        fileName: "Expired Logs.zip",
        downloadUrl: null,
      },
    },
  ];

  assert.equal(findArchiveAction(actions)?.id, "archive");
  assert.equal(findTestFlightAction(actions)?.id, "testflight");
  assert.equal(
    findAppStoreExport(artifacts)?.attributes.downloadUrl,
    "https://example.com/app-store",
  );
  assert.deepEqual(
    findLogBundles(artifacts).map(({ attributes }) => attributes.fileName),
    ["Lab86Mail Logs.zip"],
  );
});
