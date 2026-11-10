import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assertFormalHomeThreadPresentationStable,
  captureThreadListFixtureFields,
  safeAuthCleanupErrorField,
} from "./formal-home-thread-observation.mjs";

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function presentation(overrides = {}) {
  return {
    rowTextFingerprint: "row-1",
    titleFingerprint: "title-1",
    relativeTimeText: "31 天",
    statusTextFingerprints: [],
    workspaceHeaderFingerprint: "workspace-1",
    fixtureFields: {
      threadIdFingerprint: "thread-1",
      titleFingerprint: "title-1",
      status: "idle",
      cwdFingerprint: "cwd-1",
      updatedAt: 1_700_000_000_000,
      previewFingerprint: null,
      summaryFingerprint: null,
    },
    ...overrides,
  };
}

test("formal Home fixture fingerprints all stable thread/list fields without storing source text", () => {
  const fields = captureThreadListFixtureFields({
    id: "thread-id",
    title: "fixture title",
    status: "idle",
    cwd: "/private/workspace",
    updatedAt: 1_700_000_000_000,
    preview: "private preview",
    summary: "private summary",
  });

  assert.deepEqual(fields, {
    threadIdFingerprint: fingerprint("thread-id"),
    titleFingerprint: fingerprint("fixture title"),
    status: "idle",
    cwdFingerprint: fingerprint("/private/workspace"),
    updatedAt: 1_700_000_000_000,
    recordFingerprint: fingerprint(JSON.stringify({
      id: "thread-id",
      title: "fixture title",
      status: "idle",
      cwd: "/private/workspace",
      updatedAt: 1_700_000_000_000,
      preview: "private preview",
      summary: "private summary",
    })),
    previewFingerprint: fingerprint("private preview"),
    summaryFingerprint: fingerprint("private summary"),
  });
  assert.equal(JSON.stringify(fields).includes("/private/workspace"), false);
  assert.equal(JSON.stringify(fields).includes("private preview"), false);
});

test("formal Home comparison retains the entire row and exact relative-time text", () => {
  const before = presentation();
  const after = presentation();
  assert.deepEqual(assertFormalHomeThreadPresentationStable(before, after, "after response"), {
    stable: true,
    relativeTimeText: "31 天",
    fixtureFieldsStable: true,
    fullRowTextStable: true,
  });

  assert.throws(
    () => assertFormalHomeThreadPresentationStable(before, presentation({ rowTextFingerprint: "row-preview-changed" }), "after response"),
    /full Home row text/,
  );
  assert.throws(
    () => assertFormalHomeThreadPresentationStable(before, presentation({ relativeTimeText: "32 天" }), "after response"),
    /raw Home relative-time label/,
  );
});

test("formal Home comparison detects hidden thread/list field changes even when visible row hash matches", () => {
  const before = presentation();
  const after = presentation({
    fixtureFields: { ...before.fixtureFields, previewFingerprint: "changed-preview" },
  });
  assert.throws(
    () => assertFormalHomeThreadPresentationStable(before, after, "after response"),
    /exact thread\/list row fields/,
  );
});

test("auth cleanup diagnostics retain safe error codes and discard free-form text", () => {
  assert.equal(safeAuthCleanupErrorField("TypeError"), "TypeError");
  assert.equal(safeAuthCleanupErrorField("ECONNRESET"), "ECONNRESET");
  assert.equal(safeAuthCleanupErrorField("Bearer private-token"), null);
  assert.equal(safeAuthCleanupErrorField({ message: "private error" }), null);
});
