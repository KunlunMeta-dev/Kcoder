import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import test from "node:test";

const socketKey = "__phoneUxApplicationWebSocketConnectionsV1";
const frameKey = "__phoneUxApplicationWebSocketFramesV1";
const healthKey = "__phoneUxApplicationWebSocketCaptureHealthV1";
const bootstraps = [];

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const values = listeners.get(type) ?? [];
      values.push(listener);
      listeners.set(type, values);
    },
    emit(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

function createPage({ storage = new Map(), holdDigest = false, rejectDigest = false, bootstrap = bootstraps[0] } = {}) {
  const counts = { writes: 0, historySerializations: 0, sent: 0 };
  const digestResolvers = [];
  const window = eventTarget();
  const document = { ...eventTarget(), visibilityState: "visible", querySelector: () => null };
  class NativeWebSocket {
    constructor() { Object.assign(this, eventTarget()); }
    send() { counts.sent++; }
  }
  window.WebSocket = NativeWebSocket;
  const sessionStorage = {
    fail: false,
    getItem: key => storage.get(key) ?? null,
    setItem(key, value) {
      counts.writes++;
      if (this.fail) throw new Error("synthetic quota failure");
      storage.set(key, String(value));
    },
  };
  const page = createContext({
    window, document, sessionStorage, TextEncoder, URL,
    location: { href: "http://127.0.0.1/" },
    performance: { timeOrigin: 100, now: () => 1 },
    crypto: { subtle: { digest(_algorithm, bytes) {
      if (rejectDigest) return Promise.reject(new Error("synthetic fingerprint failure"));
      const result = createHash("sha256").update(bytes).digest();
      return holdDigest ? new Promise(resolve => digestResolvers.push(() => resolve(result))) : Promise.resolve(result);
    } } },
    JSON: {
      parse: JSON.parse,
      stringify(value) {
        if (Array.isArray(value) && value.some(row => row?.socketId !== undefined)) counts.historySerializations++;
        return JSON.stringify(value);
      },
    },
    Element: class {}, HTMLInputElement: class {}, HTMLTextAreaElement: class {},
    MutationObserver: class { observe() {} },
    // Hidden pages deliberately have no animation frame callbacks.
    requestAnimationFrame() {},
    setTimeout, clearTimeout,
  });
  runInContext(`(${bootstrap.toString()})({ pageId: "test-page" })`, page);
  return {
    window, document, sessionStorage, storage, counts,
    settle: async () => { for (let index = 0; index < 60; index++) await Promise.resolve(); },
    releaseDigests() { for (const resolve of digestResolvers.splice(0)) resolve(); },
  };
}

function send(page, count) {
  const socket = new page.window.WebSocket("ws://127.0.0.1/rpc");
  for (let id = 0; id < count; id++) socket.send(JSON.stringify({ id, method: "thread/read" }));
  return socket;
}

for (const [index, bootstrap] of bootstraps.entries()) {
  test(`model-independent recorder ${index}: hot frame capture performs zero history serializations or storage writes`, async () => {
    const page = createPage({ bootstrap });
    page.counts.writes = 0;
    send(page, 400);
    await page.settle();
    assert.equal(page.counts.sent, 400);
    assert.equal(page.counts.writes, 0);
    assert.equal(page.counts.historySerializations, 0);
  });
}

test("model-independent new burst after drain writes one constant marker and crash fails closed", async () => {
  const page = createPage();
  await page.window.__phoneUxDrainApplicationWebSocketEvidence();
  assert.equal(JSON.parse(page.storage.get(healthKey)).state, "complete");
  page.counts.writes = 0;
  send(page, 100);
  await page.settle();
  assert.equal(page.counts.writes, 1);
  assert.equal(page.counts.historySerializations, 0);
  assert.ok(page.storage.get(healthKey).length < 256);
  const restored = createPage({ storage: page.storage });
  await assert.rejects(restored.window.__phoneUxDrainApplicationWebSocketEvidence(), /incomplete/);
});

test("model-independent hidden-page drain includes latest frames without animation frames", { timeout: 2000 }, async () => {
  const page = createPage();
  send(page, 40);
  page.document.visibilityState = "hidden";
  const evidence = await page.window.__phoneUxDrainApplicationWebSocketEvidence();
  assert.equal(evidence.frames.length, 40);
  assert.equal(evidence.sockets.length, 1);
  assert.equal(evidence.storageWriteFailureCount, 0);
  assert.deepEqual(JSON.parse(page.storage.get(frameKey)), []);
});

test("model-independent lifecycle checkpoints preserve legacy V1 evidence through reload", async () => {
  const oldSocket = { pageId: "legacy", socketId: 7, path: "/rpc" };
  const oldFrame = { pageId: "legacy", socketId: 7, direction: "sent", method: "thread/list" };
  const storage = new Map([[socketKey, JSON.stringify([oldSocket])], [frameKey, JSON.stringify([oldFrame])]]);
  const page = createPage({ storage });
  assert.equal(storage.get(frameKey), JSON.stringify([oldFrame]));
  send(page, 30);
  await page.settle();
  page.window.emit("pagehide");
  assert.equal(JSON.parse(storage.get(frameKey)).length, 31);
  assert.equal(JSON.parse(storage.get(healthKey)).state, "complete");
  const restored = createPage({ storage });
  const evidence = await restored.window.__phoneUxDrainApplicationWebSocketEvidence();
  assert.equal(evidence.frames.length, 31);
  assert.deepEqual(JSON.parse(JSON.stringify(evidence.frames[0])), oldFrame);
  assert.equal(evidence.storageWriteFailureCount, 0);
});

test("model-independent hidden lifecycle finishes pending capture and persists current V1 arrays", async () => {
  const page = createPage({ holdDigest: true });
  send(page, 1);
  page.document.visibilityState = "hidden";
  page.document.emit("visibilitychange");
  assert.equal(JSON.parse(page.storage.get(healthKey)).state, "active");
  page.releaseDigests();
  await page.settle();
  assert.equal(JSON.parse(page.storage.get(frameKey)).length, 1);
  assert.equal(JSON.parse(page.storage.get(healthKey)).state, "complete");
});

test("model-independent pagehide with unresolved capture fails closed after reload", async () => {
  const page = createPage({ holdDigest: true });
  send(page, 1);
  page.window.emit("pagehide");
  const restored = createPage({ storage: page.storage });
  await assert.rejects(restored.window.__phoneUxDrainApplicationWebSocketEvidence(), /incomplete/);
  page.releaseDigests();
  await page.settle();
});

test("model-independent detached hidden checkpoint cannot overwrite a new document's health", async () => {
  const page = createPage({ holdDigest: true });
  send(page, 1);
  page.document.visibilityState = "hidden";
  page.document.emit("visibilitychange");
  page.window.emit("pagehide");
  const restored = createPage({ storage: page.storage });
  await assert.rejects(restored.window.__phoneUxDrainApplicationWebSocketEvidence(), /incomplete/);
  const healthBeforeOldCompletion = page.storage.get(healthKey);
  page.releaseDigests();
  await page.settle();
  assert.equal(page.storage.get(healthKey), healthBeforeOldCompletion);
});

test("model-independent storage failures retain captured frames for a later drain", async () => {
  const page = createPage();
  send(page, 5);
  await page.settle();
  page.sessionStorage.fail = true;
  await assert.rejects(page.window.__phoneUxDrainApplicationWebSocketEvidence(), /persist/);
  page.sessionStorage.fail = false;
  const evidence = await page.window.__phoneUxDrainApplicationWebSocketEvidence();
  assert.equal(evidence.frames.length, 5);
  assert.ok(evidence.storageWriteFailureCount > 0);
});

test("model-independent malformed V1 evidence is retained and rejected", () => {
  const storage = new Map([[frameKey, "{broken"]]);
  assert.throws(() => createPage({ storage }), /evidence/);
  assert.equal(storage.get(frameKey), "{broken");
});

test("model-independent rejected route fingerprints stay visible as capture failures", async () => {
  for (const bootstrap of bootstraps) {
    const page = createPage({ rejectDigest: true, bootstrap });
    new page.window.WebSocket("ws://127.0.0.1/rpc?serverId=synthetic-target");
    await assert.rejects(page.window.__phoneUxDrainApplicationWebSocketEvidence(), /incomplete/);
    assert.equal(JSON.parse(page.storage.get(healthKey)).state, "active");
  }
});

test("model-independent socket overflow remains bounded and survives reload", async () => {
  const page = createPage();
  for (let index = 0; index < 514; index++) new page.window.WebSocket("ws://127.0.0.1/rpc");
  await page.settle();
  page.window.emit("pagehide");
  const restored = createPage({ storage: page.storage });
  const evidence = await restored.window.__phoneUxDrainApplicationWebSocketEvidence();
  assert.equal(evidence.sockets.length, 512);
  assert.equal(evidence.socketOverflowCount, 2);
});

test("model-independent frame overflow remains bounded and survives a lifecycle checkpoint", async () => {
  const page = createPage();
  send(page, 8200);
  await page.settle();
  assert.equal(page.counts.historySerializations, 0);
  page.window.emit("pagehide");
  const restored = createPage({ storage: page.storage });
  const evidence = await restored.window.__phoneUxDrainApplicationWebSocketEvidence();
  assert.equal(evidence.frames.length, 8192);
  assert.equal(evidence.frameOverflowCount, 8);
});
