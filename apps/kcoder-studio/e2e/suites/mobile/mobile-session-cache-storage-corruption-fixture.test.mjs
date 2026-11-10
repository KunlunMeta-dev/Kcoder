import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { test } from "node:test";
import vm from "node:vm";
import { inspect } from "node:util";
import {
  assertCorruptionIsolation,
  buildTranscriptCorruptionPayload,
  installTranscriptCorruptionReadProbe,
  matchesBridgeRecordedResumeResponse,
  selectCacheStorageFixture,
  TRANSCRIPT_DATABASE,
} from "./mobile-session-cache-storage-corruption-fixture.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");

test("bridge string records match only the Mobile numeric resume ID on the exact route", () => {
  const request = { id: "2", method: "thread/resume", threadId: "thread-owned", socketOrdinal: 7 };
  const response = { jsonrpc: "2.0", id: 2, result: { thread: { id: "thread-owned" } } };
  const expected = { socketOrdinal: 7, threadId: "thread-owned" };
  assert.equal(matchesBridgeRecordedResumeResponse(request, response, expected), true);
  for (const [otherRequest, otherResponse, otherExpected] of [
    [request, { ...response, id: "2" }, expected],
    [request, { ...response, id: 3 }, expected],
    [request, { ...response, id: { value: 2 } }, expected],
    [{ ...request, id: "02" }, response, expected],
    [{ ...request, id: "2.0" }, response, expected],
    [{ ...request, id: "9007199254740992" }, response, expected],
    [{ ...request, method: "thread/read" }, response, expected],
    [request, response, { ...expected, socketOrdinal: 8 }],
    [request, response, { ...expected, threadId: "thread-peer" }],
    [request, { ...response, result: { thread: { id: "thread-peer" } } }, expected],
    [request, { ...response, error: { code: -32000 } }, expected],
  ]) assert.equal(matchesBridgeRecordedResumeResponse(otherRequest, otherResponse, otherExpected), false);
});
function seed() {
  const profile = { id: "profile-A", baseUrl: "http://127.0.0.1:12345", authMode: "device",
    authorizationGeneration: "generation-A", deviceId: "device-A" };
  const expectedScope = { gatewayBaseUrl: profile.baseUrl, routeProfileId: profile.id,
    routeServerId: "local", routeCwd: "/owned/workspace",
    serverDescriptor: { id: "local", runtime: "kcoder", transport: "local",
      workspacePath: "/owned/workspace", principalId: "principal-A", role: "owner" } };
  const targetThreadId = "target-thread";
  const peerThreadId = "peer-thread";
  const marker = "REAL_UI_MARKER";
  const draft = "UNSENT_草稿";
  const record = threadId => ({ schemaVersion: 1,
    scope: { version: 1, profile, target: { id: "local", transport: "local", workspacePath: "/owned/workspace",
      principalId: "principal-A", role: "owner", connectionFingerprint: "a".repeat(64) },
    cwd: "/owned/workspace", threadId },
    title: "cached UI fixture", updatedAt: 1,
    messages: [{ id: `${threadId}-user`, role: "user", content: marker, timestampMs: 1, status: "done" }],
    coverage: { hasMoreBefore: false, complete: false, sparse: true } });
  const profileKey = hash(JSON.stringify([profile.id, profile.baseUrl, profile.authMode,
    profile.authorizationGeneration, profile.deviceId]));
  const rows = [targetThreadId, peerThreadId].map((threadId, slot) => ({ slot, revision: slot + 4,
    type: "application/json", raw: JSON.stringify(record(threadId)) }));
  const entries = rows.map(row => ({ slot: row.slot, key: hash(JSON.stringify(JSON.parse(row.raw).scope)),
    profileKey, dataRevision: row.revision, bytes: Buffer.byteLength(row.raw), used: row.slot + 1 }));
  const workspaceScope = [profile.baseUrl, profile.authorizationGeneration, "local", "/owned/workspace", "local",
    null, null, null, null, null, null, "principal-A", "owner"];
  const key = `kcoder-studio:mobile-workspace-state:v3:${encodeURIComponent(profile.id)}:local:${targetThreadId}:scope:` +
    encodeURIComponent(JSON.stringify(workspaceScope));
  const snapshot = { origin: profile.baseUrl,
    manifestRaw: JSON.stringify({ schemaVersion: 1, revision: 7, epoch: "cache-epoch", entries, lastKey: entries[0].key }),
    rows, profiles: [profile], activeId: profile.id,
    workspaceStates: [{ key, raw: JSON.stringify({ activeTab: "agent", composerDraft: draft,
      queuedMessages: [], failedSubmissions: [] }) }] };
  return { snapshot, options: { expectedScope, targetThreadId, peerThreadId, marker, draft } };
}

for (const kind of ["invalid-json", "unsupported-schema"]) {
  test(`${kind} changes only equal-length target record bytes and leaves manifest/peer/draft intact`, () => {
    const { snapshot, options } = seed();
    const fixture = selectCacheStorageFixture(snapshot, options);
    const payload = buildTranscriptCorruptionPayload(fixture.target.raw, kind);
    assert.equal(payload.bytes, fixture.target.entry.bytes);
    assert.equal(payload.equalUtf8Length, true);
    assert.equal(payload.productChecksumClaim, false);
    if (kind === "invalid-json") {
      assert.throws(() => JSON.parse(payload.raw), SyntaxError);
      assert.equal(payload.raw.slice(1), fixture.target.raw.slice(1));
    } else {
      const parsed = JSON.parse(payload.raw);
      assert.equal(parsed.schemaVersion, 2);
      assert.equal(parsed.scope.version, 1);
      assert.deepEqual({ ...parsed, schemaVersion: 1 }, fixture.target.record);
    }
    const after = structuredClone(snapshot);
    after.rows[0].raw = payload.raw;
    assertCorruptionIsolation(fixture, after, payload);
    assert.equal(JSON.parse(after.manifestRaw).schemaVersion, 1);
  });
}

for (const [name, change] of [
  ["last-route key", seed => { const manifest = JSON.parse(seed.snapshot.manifestRaw);
    manifest.lastKey = manifest.entries[1].key; seed.snapshot.manifestRaw = JSON.stringify(manifest); }],
  ["slot wrapper revision", seed => { seed.snapshot.rows[0].revision++; }],
  ["UTF8 byte metadata", seed => { const manifest = JSON.parse(seed.snapshot.manifestRaw);
    manifest.entries[0].bytes++; seed.snapshot.manifestRaw = JSON.stringify(manifest); }],
  ["public authorization generation", seed => { seed.snapshot.profiles[0].authorizationGeneration = "new-generation"; }],
  ["independent principal", seed => { seed.options.expectedScope.serverDescriptor.principalId = "other-principal"; }],
  ["independent role", seed => { seed.options.expectedScope.serverDescriptor.role = "viewer"; }],
  ["actual runtime", seed => { seed.options.expectedScope.serverDescriptor.runtime = "other-runtime"; }],
  ["route cwd", seed => { seed.options.expectedScope.routeCwd = "/other-workspace"; }],
  ["peer thread identity", seed => { seed.options.peerThreadId = seed.options.targetThreadId; }],
  ["real draft state", seed => { seed.snapshot.workspaceStates = []; }],
  ["queued side effect", seed => { const state = JSON.parse(seed.snapshot.workspaceStates[0].raw);
    state.queuedMessages = [{ id: "queued" }]; seed.snapshot.workspaceStates[0].raw = JSON.stringify(state); }],
]) {
  test(`fixture rejects mismatched ${name} before mutation`, () => {
    const value = seed();
    change(value);
    assert.throws(() => selectCacheStorageFixture(value.snapshot, value.options));
  });
}

for (const [name, change] of [
  ["manifest revision", value => { const manifest = JSON.parse(value.manifestRaw); manifest.revision++;
    value.manifestRaw = JSON.stringify(manifest); }],
  ["peer content", value => { value.rows[1].raw += " "; }],
  ["peer revision", value => { value.rows[1].revision++; }],
  ["unsent draft", value => { value.workspaceStates[0].raw = "{}"; }],
]) {
  test(`isolation rejects collateral ${name} changes`, () => {
    const { snapshot, options } = seed();
    const fixture = selectCacheStorageFixture(snapshot, options);
    const payload = buildTranscriptCorruptionPayload(fixture.target.raw, "invalid-json");
    const after = structuredClone(snapshot);
    after.rows[0].raw = payload.raw;
    change(after);
    assert.throws(() => assertCorruptionIsolation(fixture, after, payload));
  });
}

test("native get probe returns the original request and preserves existing success handler/result", async () => {
  const { snapshot, options } = seed();
  const fixture = selectCacheStorageFixture(snapshot, options);
  const payload = buildTranscriptCorruptionPayload(fixture.target.raw, "unsupported-schema");
  const listeners = [];
  const onSuccess = () => {};
  const request = { result: { revision: fixture.target.entry.dataRevision,
    blob: new Blob([payload.raw], { type: "application/json" }) }, onsuccess: onSuccess,
  addEventListener(type, callback) { assert.equal(type, "success"); listeners.push(callback); } };
  const store = class {
    constructor(name) { this.name = name; this.transaction = { db: { name: TRANSCRIPT_DATABASE } }; }
    get(key) { this.lastKey = key; return request; }
  };
  const sandbox = vm.createContext({ IDBObjectStore: store, Blob, crypto: webcrypto, TextEncoder });
  const page = { async addInitScript(callback, value) {
    sandbox.input = value;
    vm.runInContext(`(${callback.toString()})(input)`, sandbox);
  } };
  await installTranscriptCorruptionReadProbe(page, fixture, payload);
  const nativeStore = new store("entries");
  assert.equal(nativeStore.get(fixture.target.entry.slot), request);
  assert.equal(request.onsuccess, onSuccess);
  const originalResult = request.result;
  assert.equal(listeners.length, 1);
  listeners[0]();
  for (let attempt = 0; attempt < 100 && sandbox.__mobileTranscriptCorruptionReadsV1.length === 0; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(request.result, originalResult);
  assert.equal(request.onsuccess, onSuccess);
  const evidence = JSON.parse(JSON.stringify(sandbox.__mobileTranscriptCorruptionReadsV1));
  assert.deepEqual(evidence, [{ slot: fixture.target.entry.slot, revision: fixture.target.entry.dataRevision,
    bytes: payload.bytes, sha256: payload.sha256, classification: "unsupported-schema", schemaVersion: 2,
    scopeMatches: true }]);
  assert.ok(!JSON.stringify(evidence).includes(options.draft));
  assert.equal(new store("manifest").get("current"), request);
  assert.equal(listeners.length, 1, "non-target IDB get must not be observed");
});

test("failure messages, stacks and AssertionError fields exclude synthetic transcript/draft contents", () => {
  const sentinel = "PRIVATE_SYNTHETIC_TRANSCRIPT_AND_DRAFT_7d4f90";
  const value = seed();
  value.options.draft = sentinel;
  const state = JSON.parse(value.snapshot.workspaceStates[0].raw);
  state.composerDraft = sentinel;
  value.snapshot.workspaceStates[0].raw = JSON.stringify(state);
  const peer = JSON.parse(value.snapshot.rows[1].raw);
  peer.messages[0].content = sentinel;
  value.snapshot.rows[1].raw = JSON.stringify(peer);
  const manifest = JSON.parse(value.snapshot.manifestRaw);
  manifest.entries[1].bytes = Buffer.byteLength(value.snapshot.rows[1].raw);
  value.snapshot.manifestRaw = JSON.stringify(manifest);
  const fixture = selectCacheStorageFixture(value.snapshot, value.options);
  const payload = buildTranscriptCorruptionPayload(fixture.target.raw, "invalid-json");
  const peerChanged = structuredClone(value.snapshot);
  peerChanged.rows[0].raw = payload.raw;
  peerChanged.rows[1].raw += " ";
  const draftChanged = structuredClone(value.snapshot);
  draftChanged.rows[0].raw = payload.raw;
  draftChanged.workspaceStates[0].raw += " ";
  for (const operation of [
    () => assertCorruptionIsolation(fixture, peerChanged, payload),
    () => assertCorruptionIsolation(fixture, draftChanged, payload),
    () => selectCacheStorageFixture(value.snapshot, { ...value.options, draft: "different expected draft" }),
    () => buildTranscriptCorruptionPayload(`!${sentinel}`, "unsupported-schema"),
  ]) {
    assert.throws(operation, error => {
      assert.ok(!`${error.message}\n${error.stack}\n${inspect(error)}`.includes(sentinel),
        "failure evidence and top-level runner errors must carry only digests/fixed categories");
      return true;
    });
  }
});
