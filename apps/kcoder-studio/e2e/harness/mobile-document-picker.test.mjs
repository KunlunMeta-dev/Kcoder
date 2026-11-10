import assert from "node:assert/strict";
import test from "node:test";
import { setExpoWebDocumentPickerFiles } from "./mobile-document-picker.mjs";

function inputNode({ multiple = true, accept = "*/*" } = {}) {
  return {
    type: "file",
    style: { display: "none" },
    multiple,
    accept,
    isConnected: true,
    files: [],
    getAttribute(name) { return this[name] ?? null; },
  };
}

function createPage({ chooserAvailable = true, cancelBeforeChooser = false } = {}) {
  const order = [];
  const nodes = [inputNode({ multiple: false, accept: null })];
  const observers = new Map();
  let captureKey = null;
  let resolveChooser;
  let domSetFilesCalls = 0;
  const input = inputNode();
  const chooser = {
    element: () => ({ evaluate: async callback => callback(input) }),
    isMultiple: async () => input.multiple,
    async setFiles(files) {
      order.push("setFiles");
      domSetFilesCalls += 1;
      input.files = files.map(file => ({
        name: file.name,
        type: file.mimeType,
        size: file.buffer.length,
        lastModified: 0,
      }));
      const observer = observers.get(captureKey);
      const selection = input.files.map(file => ({ ...file }));
      observer.events.push(
        { type: "input", inputIndex: nodes.indexOf(input), fileCount: input.files.length, files: selection },
        { type: "change", inputIndex: nodes.indexOf(input), fileCount: input.files.length, files: selection },
      );
    },
  };
  const page = {
    locator(selector) {
      assert.equal(selector, 'input[type="file"]');
      return { count: async () => nodes.length };
    },
    async evaluate(_callback, argument) {
      if (argument && typeof argument === "object" && argument.key) {
        order.push("install-observer");
        captureKey = argument.key;
        observers.set(captureKey, { events: [], listeners: [] });
        return;
      }
      order.push("collect-observer");
      const observer = observers.get(argument);
      observers.delete(argument);
      return observer?.events ?? [];
    },
    waitForEvent(name, options) {
      order.push("wait-filechooser");
      assert.equal(name, "filechooser");
      assert.deepEqual(options, { timeout: 10_000 });
      assert.ok(captureKey, "DOM observations must be installed before waiting for the chooser");
      if (!chooserAvailable) return Promise.reject(new Error("filechooser timed out"));
      return new Promise(resolve => { resolveChooser = resolve; });
    },
    async waitForFunction(_callback, key, options) {
      order.push("wait-change");
      assert.equal(key, captureKey);
      assert.deepEqual(options, { timeout: 10_000 });
      assert.ok(observers.get(key)?.events.some(event => event.type === "change"));
    },
    getByText(text, options) {
      assert.equal(text, "选择文件");
      assert.deepEqual(options, { exact: true });
      return {
        async click() {
          order.push("click-picker-button");
          nodes.push(input);
          if (cancelBeforeChooser) {
            observers.get(captureKey).events.push({
              type: "cancel",
              inputIndex: nodes.indexOf(input),
              fileCount: 0,
              files: [],
            });
          } else if (chooserAvailable) {
            resolveChooser(chooser);
          }
        },
      };
    },
  };
  return { page, order, nodes, get domSetFilesCalls() { return domSetFilesCalls; } };
}

test("Expo picker waits for Playwright filechooser before clicking and captures the real selection events", async () => {
  const fixture = createPage();
  const files = [{ name: "picked.txt", mimeType: "text/plain", buffer: Buffer.from("actual picker input") }];

  const evidence = await setExpoWebDocumentPickerFiles(fixture.page, files);

  assert.deepEqual(fixture.order, [
    "install-observer",
    "wait-filechooser",
    "click-picker-button",
    "setFiles",
    "wait-change",
    "collect-observer",
  ]);
  assert.equal(fixture.domSetFilesCalls, 1, "the selected file must go through FileChooser.setFiles");
  assert.equal(fixture.nodes.length, 2, "the Expo-created input must be new and separate from an earlier input");
  assert.deepEqual(evidence, {
    inputCountBefore: 1,
    inputCountAfterCreate: 2,
    inputIndex: 1,
    filechooserObserved: true,
    filechooserMultiple: true,
    chooserSetFilesCompleted: true,
    inputType: "file",
    inputHidden: true,
    multiple: true,
    accept: "*/*",
    fileCount: 1,
    inputEventCount: 1,
    changeEventCount: 1,
    cancelEventCount: 0,
    selectionEvents: [
      { type: "input", inputIndex: 1, fileCount: 1, files: [{ name: "picked.txt", type: "text/plain", size: 19, lastModified: 0 }] },
      { type: "change", inputIndex: 1, fileCount: 1, files: [{ name: "picked.txt", type: "text/plain", size: 19, lastModified: 0 }] },
    ],
    selectedFiles: [{ name: "picked.txt", type: "text/plain", size: 19, lastModified: 0 }],
  });
});

test("a cancelled or unavailable chooser is reported with pre-click observations and never falls back to DOM setInputFiles", async () => {
  const fixture = createPage({ chooserAvailable: false, cancelBeforeChooser: true });
  const files = [{ name: "picked.txt", mimeType: "text/plain", buffer: Buffer.from("actual picker input") }];

  await assert.rejects(
    setExpoWebDocumentPickerFiles(fixture.page, files),
    error => {
      assert.match(error.message, /filechooser flow failed/);
      assert.deepEqual(error.pickerEvidence, {
        inputCountBefore: 1,
        inputCountAfterCreate: null,
        inputIndex: null,
        filechooserObserved: false,
        filechooserMultiple: null,
        chooserSetFilesCompleted: false,
        inputType: null,
        inputHidden: false,
        multiple: null,
        accept: null,
        fileCount: 1,
        inputEventCount: 0,
        changeEventCount: 0,
        cancelEventCount: 1,
        selectionEvents: [{ type: "cancel", inputIndex: 1, fileCount: 0, files: [] }],
        selectedFiles: [],
      });
      return true;
    },
  );
  assert.deepEqual(fixture.order, ["install-observer", "wait-filechooser", "click-picker-button", "collect-observer"]);
  assert.equal(fixture.domSetFilesCalls, 0);
});

test("Expo picker rejects an empty selection before installing browser observers", async () => {
  let pageCalls = 0;
  const page = new Proxy({}, { get() { pageCalls += 1; throw new Error("page must not be accessed"); } });

  await assert.rejects(setExpoWebDocumentPickerFiles(page, []), /at least one file/);
  assert.equal(pageCalls, 0);
});
