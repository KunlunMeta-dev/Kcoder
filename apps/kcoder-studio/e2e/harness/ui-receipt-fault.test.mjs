import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeUiReceiptFrame,
  encodeUiReceiptFrame,
  uiReceiptMatches,
} from "./ui-receipt-fault.mjs";
test("receipt frame decoding preserves IDs and rejects incomplete/control frames", () => {
  for (const title of ["A", "A".repeat(200)]) {
    const frame = { jsonrpc: "2.0", id: 37, result: { draft: { title } } };
    const bytes = encodeUiReceiptFrame(frame);
    assert.deepEqual(decodeUiReceiptFrame(bytes), frame);
    assert.equal(
      decodeUiReceiptFrame(bytes.subarray(0, bytes.length - 1)),
      null,
    );
  }
  assert.equal(decodeUiReceiptFrame(Buffer.from([0x89, 0])), null);
});
test("fault modes select only the owned operation and never a write acknowledgement as a read", () => {
  assert.equal(
    uiReceiptMatches("page-A", { draft: { title: "Owned B" } }),
    false,
  );
  assert.equal(
    uiReceiptMatches("page-A", { draft: { title: "Owned A" } }),
    true,
  );
  assert.equal(
    uiReceiptMatches("edit-read", { pageId: "page", revisionId: "r2" }),
    false,
  );
  assert.equal(
    uiReceiptMatches("edit-read", { draft: { title: "Owned B" } }),
    true,
  );
  assert.equal(
    uiReceiptMatches("node-save", { nodes: [{ prompt: "OWNED_SUBMITTED" }] }),
    true,
  );
  assert.equal(
    uiReceiptMatches("node-timeout", { nodes: [{ prompt: "OWNED_TIMEOUT" }] }),
    true,
  );
  assert.equal(
    uiReceiptMatches("node-timeout", {
      nodes: [{ prompt: "OWNED_SUBMITTED" }],
    }),
    false,
  );
  assert.equal(
    uiReceiptMatches("citation-timeout", { source: { title: "Owned source" } }),
    true,
  );
  assert.equal(
    uiReceiptMatches("citation-timeout", {
      source: { title: "Another source" },
    }),
    false,
  );
});
test("file-kind fault holds only a genuine owned A parent-directory lookup", () => {
  assert.equal(
    uiReceiptMatches("file-kind", {
      stdout: JSON.stringify({
        path: "/owned/nav-a",
        entries: [{ path: "/owned/nav-a/owned-nav-A.ts" }],
      }),
    }),
    true,
  );
  assert.equal(
    uiReceiptMatches("file-kind", {
      stdout: JSON.stringify({
        path: "/owned",
        entries: [{ path: "/owned/nav-a" }],
      }),
    }),
    false,
  );
  assert.equal(uiReceiptMatches("file-kind", { stdout: "{broken" }), false);
});
