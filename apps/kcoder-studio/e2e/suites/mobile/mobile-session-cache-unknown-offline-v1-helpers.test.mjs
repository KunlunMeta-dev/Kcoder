import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "../../../renderer/node_modules/typescript/lib/typescript.js";
import {
  COMPATIBILITY_ROOT_UNKNOWN_REASON,
  matchesExactCompatibilityRootUnknown,
  shouldWithholdExactCompatibilityRootUnknown,
} from "./mobile-session-cache-unknown-offline-v1-helpers.mjs";

const request = { id: "browser-17", method: "thread/presence/read", threadId: "thread-owned" };
const response = {
  jsonrpc: "2.0",
  id: "browser-17",
  result: { status: "unknown", threadId: "thread-owned", reason: COMPATIBILITY_ROOT_UNKNOWN_REASON },
};

test("real compatibility-root unknown must match the exact Browser request and thread", () => {
  assert.equal(matchesExactCompatibilityRootUnknown(response, {
    requestId: request.id,
    threadId: request.threadId,
  }), true);
  assert.equal(matchesExactCompatibilityRootUnknown({ ...response, id: "other" }, {
    requestId: request.id,
    threadId: request.threadId,
  }), false);
  assert.equal(matchesExactCompatibilityRootUnknown({
    ...response,
    result: { ...response.result, threadId: "thread-peer" },
  }, { requestId: request.id, threadId: request.threadId }), false);
  assert.equal(matchesExactCompatibilityRootUnknown({
    ...response,
    result: { ...response.result, reason: "observationFailed" },
  }, { requestId: request.id, threadId: request.threadId }), false);
});

test("offline fault withholds one exact typed response and cannot consume a peer frame", () => {
  const fault = { injected: true, consumed: false, threadId: request.threadId };
  assert.equal(shouldWithholdExactCompatibilityRootUnknown({ ...request, threadId: "thread-peer" }, response, fault), false);
  assert.equal(shouldWithholdExactCompatibilityRootUnknown({ ...request, method: "thread/resume" }, response, fault), false);
  assert.equal(shouldWithholdExactCompatibilityRootUnknown(request, { ...response, id: "other" }, fault), false);
  assert.equal(fault.consumed, false);
  assert.equal(shouldWithholdExactCompatibilityRootUnknown(request, response, fault), true);
  assert.equal(fault.consumed, true);
  assert.equal(shouldWithholdExactCompatibilityRootUnknown(request, response, fault), false,
    "the injected response loss must be single-use");
});

test("fault injection is opt-in and does not turn Rust errors into an offline result", () => {
  const fault = { injected: false, consumed: false, threadId: request.threadId };
  assert.equal(shouldWithholdExactCompatibilityRootUnknown(request, response, fault), false);
  assert.equal(shouldWithholdExactCompatibilityRootUnknown(request, {
    jsonrpc: "2.0", id: request.id, error: { code: -32000 },
  }, { ...fault, injected: true }), false);
});

test("every async uniqueTestId locator is awaited before any locator method is called", async () => {
  const suiteUrl = new URL("./mobile-session-cache-unknown-offline-v1.e2e.mjs", import.meta.url);
  const sourceText = await readFile(suiteUrl, "utf8");
  const source = ts.createSourceFile(String(suiteUrl), sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const locatorCalls = [];
  const violations = [];
  const isUniqueTestIdCall = node => ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) && node.expression.text === "uniqueTestId";
  const visit = node => {
    if (isUniqueTestIdCall(node)) {
      locatorCalls.push(node);
      if (!ts.isAwaitExpression(node.parent)) {
        violations.push(`uniqueTestId result is not awaited at line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        isUniqueTestIdCall(node.expression.expression)) {
      violations.push(`locator method ${node.expression.name.text} is called on the uniqueTestId Promise at line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(locatorCalls.length >= 10, "the guard must inspect the suite's actual async locator callsites");
  assert.deepEqual(violations, []);
});
