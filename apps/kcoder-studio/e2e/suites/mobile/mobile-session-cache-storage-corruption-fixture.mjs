import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { matchesExactResumeResponse } from "./mobile-session-cache-event-continuity.protocol.mjs";

export const TRANSCRIPT_DATABASE = "kcoder-confirmed-transcripts-v1";
const hash = value => createHash("sha256").update(value).digest("hex");
const sorted = rows => [...rows].sort((left, right) => left.slot - right.slot);
const parseJson = (raw, label) => {
  try { return JSON.parse(raw); } catch { throw new Error(`${label} is not valid JSON`); }
};

/** Reconstruct only the Mobile client's numeric RPC ID from the bridge's string record. */
export function matchesBridgeRecordedResumeResponse(request, response, { socketOrdinal, threadId }) {
  if (typeof request?.id !== "string" || !/^[1-9]\d*$/.test(request.id) ||
      !Number.isSafeInteger(Number(request.id)) || !Number.isSafeInteger(socketOrdinal) || socketOrdinal <= 0 ||
      request.socketOrdinal !== socketOrdinal) return false;
  return matchesExactResumeResponse({
    socketId: socketOrdinal,
    expectedSocketId: request.socketOrdinal,
    request: { id: Number(request.id), method: request.method, params: { threadId: request.threadId } },
    response,
    threadId,
  });
}

/** Read only this run's cache and workspace drafts; credentials are never enumerated. */
export async function readCacheStorageSnapshot(page) {
  return page.evaluate(async databaseName => {
    const bounded = (promise, label) => {
      let timer;
      return Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 2000);
      })]).finally(() => clearTimeout(timer));
    };
    const databases = await bounded(indexedDB.databases(), "cache inventory");
    if (!databases.some(database => database.name === databaseName)) throw new Error("UI-seeded cache is missing");
    const db = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { settled = true; reject(new Error("cache open timed out")); }, 2000);
      const request = indexedDB.open(databaseName);
      request.onupgradeneeded = () => request.transaction.abort();
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true; clearTimeout(timer); resolve(request.result);
      };
      request.onerror = request.onblocked = () => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error("cache open failed")); }
      };
    });
    let manifestRaw;
    let values;
    let slots;
    try {
      await bounded(new Promise((resolve, reject) => {
        const transaction = db.transaction(["manifest", "entries"], "readonly");
        const manifest = transaction.objectStore("manifest").get("current");
        const entries = transaction.objectStore("entries");
        const all = entries.getAll();
        const keys = entries.getAllKeys();
        manifest.onsuccess = () => { manifestRaw = manifest.result; };
        all.onsuccess = () => { values = all.result; };
        keys.onsuccess = () => { slots = keys.result; };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(new Error("cache read aborted"));
        transaction.onerror = () => {};
      }), "cache read");
    } finally { db.close(); }
    if (typeof manifestRaw !== "string" || new Blob([manifestRaw]).size > 65536 ||
        !Array.isArray(values) || values.length > 32 || slots.length !== values.length) {
      throw new Error("cache inventory exceeds fixture budget");
    }
    let bytes = 0;
    const rows = [];
    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      if (!(value?.blob instanceof Blob) || value.blob.size > 524288 ||
          (bytes += value.blob.size) > 8 * 1024 * 1024) throw new Error("cache blob exceeds fixture budget");
      rows.push({ slot: slots[index], revision: value.revision, type: value.blob.type,
        raw: await bounded(value.blob.text(), "cache blob read") });
    }
    const workspaceStates = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith("kcoder-studio:mobile-workspace-state:v3:")) continue;
      const raw = localStorage.getItem(key);
      if (workspaceStates.length >= 32 || typeof raw !== "string" || raw.length > 65536) {
        throw new Error("workspace draft exceeds fixture budget");
      }
      workspaceStates.push({ key, raw });
    }
    let profileIndex;
    try { profileIndex = JSON.parse(localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2")); }
    catch { throw new Error("public profile index is not valid JSON"); }
    if (!Array.isArray(profileIndex?.profiles) || profileIndex.profiles.length > 16) throw new Error("profile index missing");
    return { origin: location.origin, manifestRaw, rows, workspaceStates,
      activeId: profileIndex.activeId,
      profiles: profileIndex.profiles.map(profile => ({ id: profile.id, baseUrl: profile.baseUrl,
        authorizationGeneration: profile.authorizationGeneration ?? `legacy:${profile.id}`,
        authMode: profile.authMode ?? "legacy", deviceId: profile.deviceId ?? null })) };
  }, TRANSCRIPT_DATABASE);
}

/** Validate the exact record identity before constructing a test-only fault. */
export function selectCacheStorageFixture(snapshot, { expectedScope, targetThreadId, peerThreadId, marker, draft }) {
  assert.equal(snapshot.origin, new URL(expectedScope.gatewayBaseUrl).origin, "cache origin must be the owned Gateway");
  const manifest = parseJson(snapshot.manifestRaw, "seed manifest");
  assert.equal(manifest.schemaVersion, 1, "manifest schema must remain supported");
  assert.ok(Number.isSafeInteger(manifest.revision) && manifest.entries.length >= 2 && manifest.entries.length <= 16);
  const profiles = snapshot.profiles.filter(row => row.id === expectedScope.routeProfileId);
  assert.equal(profiles.length, 1, "the expected public profile must be unique");
  const profile = profiles[0];
  assert.ok(profile && snapshot.activeId === profile.id, "the active profile must own the UI-created target");
  assert.equal(profile.baseUrl, expectedScope.gatewayBaseUrl);
  assert.equal(expectedScope.serverDescriptor.id, expectedScope.routeServerId);
  const read = threadId => {
    const matches = snapshot.rows.flatMap(row => {
      const record = parseJson(row.raw, "seed transcript");
      return record.scope?.threadId === threadId ? [{ row, record }] : [];
    });
    assert.equal(matches.length, 1, "each fixture thread must have one real cached record");
    const { row, record } = matches[0];
    const entry = manifest.entries.find(value => value.slot === row.slot);
    assert.ok(entry, "the cached slot must be referenced by the manifest");
    assert.equal(record.schemaVersion, 1, "the UI must seed a supported record schema");
    assert.equal(record.scope.version, 1, "display scope schema is independent from record schema");
    assert.equal(entry.key, hash(JSON.stringify(record.scope)), "entry key must digest the exact complete display scope");
    assert.equal(entry.profileKey, hash(JSON.stringify([profile.id, profile.baseUrl, profile.authMode,
      profile.authorizationGeneration, profile.deviceId])), "entry profileKey must match current authorization");
    assert.deepEqual(record.scope.profile, { id: profile.id, baseUrl: profile.baseUrl,
      authorizationGeneration: profile.authorizationGeneration, ...(profile.deviceId ? { deviceId: profile.deviceId } : {}),
      authMode: profile.authMode }, "cached profile must match the current public authorization identity");
    assert.equal(record.scope.target.id, expectedScope.routeServerId);
    assert.equal(record.scope.cwd, expectedScope.routeCwd);
    assert.equal(record.scope.target.transport, expectedScope.serverDescriptor.transport);
    assert.equal(record.scope.target.workspacePath, expectedScope.serverDescriptor.workspacePath);
    assert.equal(expectedScope.serverDescriptor.runtime, "kcoder");
    assert.equal(record.scope.target.principalId, expectedScope.serverDescriptor.principalId ?? null);
    assert.equal(record.scope.target.role, expectedScope.serverDescriptor.role ?? null);
    assert.match(record.scope.target.connectionFingerprint, /^[a-f0-9]{64}$/, "fingerprint is shape-checked, not independently proven");
    assert.equal(row.revision, entry.dataRevision, "slot wrapper revision must match manifest dataRevision");
    assert.equal(Buffer.byteLength(row.raw), entry.bytes, "UTF8 bytes guard must succeed before fault injection");
    assert.equal(row.type, "application/json");
    assert.equal(record.coverage.complete, false);
    assert.equal(record.coverage.sparse, true);
    return { entry, record, raw: row.raw, sha256: hash(row.raw) };
  };
  const target = read(targetThreadId);
  const peer = read(peerThreadId);
  assert.notEqual(target.entry.key, peer.entry.key);
  assert.notEqual(target.entry.slot, peer.entry.slot);
  assert.equal(manifest.lastKey, target.entry.key, "the corruption target must be the actual last-route record");
  assert.deepEqual({ ...target.record.scope, threadId: peerThreadId }, peer.record.scope,
    "peer must share the exact profile, target and workspace");
  assert.equal(target.record.messages.filter(row => row.role === "user" && row.content.includes(marker)).length, 1);
  const prefix = `kcoder-studio:mobile-workspace-state:v3:${encodeURIComponent(profile.id)}:` +
    `${encodeURIComponent(expectedScope.routeServerId)}:${encodeURIComponent(targetThreadId)}:scope:`;
  const states = snapshot.workspaceStates.filter(row => row.key.startsWith(prefix)).filter(row => {
    const scope = parseJson(decodeURIComponent(row.key.slice(prefix.length)), "workspace scope");
    return Array.isArray(scope) && scope.length === 13 && scope[0] === profile.baseUrl &&
      scope[1] === profile.authorizationGeneration && scope[2] === expectedScope.routeServerId &&
      scope[3] === expectedScope.serverDescriptor.workspacePath && scope[4] === expectedScope.serverDescriptor.transport &&
      (scope[11] ?? null) === target.record.scope.target.principalId && (scope[12] ?? null) === target.record.scope.target.role;
  });
  assert.equal(states.length, 1, "one exact authorization-scoped workspace state must retain the real unsent draft");
  const workspace = parseJson(states[0].raw, "workspace state");
  assert.equal(workspace.composerDraft === draft, true, "unsent draft must be created by the real composer before the fault");
  assert.equal((workspace.queuedMessages ?? []).length, 0, "this gate must not create a queued operation");
  assert.equal((workspace.failedSubmissions ?? []).length, 0, "this gate makes no unknown/accepted receipt claim");
  return { snapshot, manifest, target, peer, draft: { key: states[0].key, raw: states[0].raw, value: draft } };
}

export function buildTranscriptCorruptionPayload(raw, kind) {
  assert.ok(typeof raw === "string" && Buffer.byteLength(raw) <= 524288);
  const record = parseJson(raw, "fault input record");
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.scope.version, 1);
  assert.ok(raw.startsWith('{"schemaVersion":1,'), "the real producer must serialize the record version first");
  let changed;
  if (kind === "invalid-json") changed = `!${raw.slice(1)}`;
  else if (kind === "unsupported-schema") changed = '{"schemaVersion":2,' + raw.slice('{"schemaVersion":1,'.length);
  else throw new Error("unsupported cache fault variant");
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(raw), "fault must preserve the manifest UTF8 bytes guard");
  if (kind === "invalid-json") assert.throws(() => JSON.parse(changed), SyntaxError);
  else {
    const decoded = JSON.parse(changed);
    assert.equal(decoded.schemaVersion, 2);
    assert.equal(hash(JSON.stringify({ ...decoded, schemaVersion: 1 })), hash(JSON.stringify(record)),
      "only the record version token may change");
  }
  return { raw: changed, sha256: hash(changed), bytes: Buffer.byteLength(changed), classification: kind,
    jsonParseable: kind === "unsupported-schema", schemaVersion: kind === "unsupported-schema" ? 2 : null,
    equalUtf8Length: true, productChecksumClaim: false };
}

/** One guarded transaction mutates only the target Blob, never manifest or peer state. */
export async function writeTranscriptCorruption(page, fixture, kind) {
  const payload = buildTranscriptCorruptionPayload(fixture.target.raw, kind);
  await page.evaluate(async ({ databaseName, manifestRaw, entry, raw }) => {
    const db = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { settled = true; reject(new Error("fault cache open timed out")); }, 2000);
      const request = indexedDB.open(databaseName);
      request.onupgradeneeded = () => request.transaction.abort();
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true; clearTimeout(timer); resolve(request.result);
      };
      request.onerror = request.onblocked = () => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error("fault cache open failed")); }
      };
    });
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(["manifest", "entries"], "readwrite");
        let primary;
        const fail = message => { primary = new Error(message); transaction.abort(); };
        const timer = setTimeout(() => fail("fault transaction timed out"), 2000);
        transaction.oncomplete = () => { clearTimeout(timer); resolve(); };
        transaction.onabort = () => { clearTimeout(timer); reject(primary ?? new Error("fault transaction aborted")); };
        transaction.onerror = () => {};
        const manifest = transaction.objectStore("manifest").get("current");
        manifest.onsuccess = () => {
          if (manifest.result !== manifestRaw) { fail("fault owner manifest changed"); return; }
          const store = transaction.objectStore("entries");
          const target = store.get(entry.slot);
          target.onsuccess = () => {
            const value = target.result;
            if (value?.revision !== entry.dataRevision || !(value.blob instanceof Blob) ||
                value.blob.size !== entry.bytes || value.blob.type !== "application/json") {
              fail("fault slot metadata changed"); return;
            }
            store.put({ ...value, blob: new Blob([raw], { type: "application/json" }) }, entry.slot);
          };
        };
      });
    } finally { db.close(); }
  }, { databaseName: TRANSCRIPT_DATABASE, manifestRaw: fixture.snapshot.manifestRaw,
    entry: fixture.target.entry, raw: payload.raw });
  const after = await readCacheStorageSnapshot(page);
  assertCorruptionIsolation(fixture, after, payload);
  return payload;
}

export function assertCorruptionIsolation(fixture, after, payload) {
  assert.equal(hash(after.manifestRaw), hash(fixture.snapshot.manifestRaw), "fault must preserve manifest and lastKey byte-for-byte");
  const expected = sorted(fixture.snapshot.rows).map(row => row.slot === fixture.target.entry.slot ? { ...row, raw: payload.raw } : row);
  const safeRows = rows => sorted(rows).map(({ raw, ...metadata }) => ({ ...metadata, sha256: hash(raw) }));
  assert.deepEqual(safeRows(after.rows), safeRows(expected), "only one exact target Blob may change; peer slot/revision/content must remain");
  const safeStates = rows => rows.map(({ key, raw }) => ({ keySha256: hash(key), stateSha256: hash(raw) }));
  assert.deepEqual(safeStates(after.workspaceStates), safeStates(fixture.snapshot.workspaceStates), "fault must not change any workspace draft");
  assert.deepEqual(after.profiles, fixture.snapshot.profiles);
  assert.equal(after.activeId, fixture.snapshot.activeId);
}

/** Observe native get success without substituting, delaying or changing the product's IDB result. */
export async function installTranscriptCorruptionReadProbe(page, fixture, payload) {
  await page.addInitScript(({ databaseName, slot, revision, bytes, sha256, expectedScope }) => {
    const rows = [];
    Object.defineProperty(globalThis, "__mobileTranscriptCorruptionReadsV1", { value: rows });
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      const request = get.call(this, key);
      if (this.name !== "entries" || this.transaction.db.name !== databaseName || key !== slot) return request;
      request.addEventListener("success", () => {
        const value = request.result;
        if (value?.revision !== revision || !(value.blob instanceof Blob) || value.blob.size !== bytes) return;
        void value.blob.text().then(async raw => {
          const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))]
            .map(byte => byte.toString(16).padStart(2, "0")).join("");
          if (digest !== sha256) return;
          let classification = "invalid-json";
          let schemaVersion = null;
          let scopeMatches = null;
          try {
            const parsed = JSON.parse(raw);
            schemaVersion = parsed.schemaVersion;
            scopeMatches = JSON.stringify(parsed.scope) === JSON.stringify(expectedScope);
            classification = schemaVersion === 2 ? "unsupported-schema" : "other-json";
          } catch {}
          rows.push({ slot, revision, bytes, sha256: digest, classification, schemaVersion, scopeMatches });
          if (rows.length > 8) rows.shift();
        }).catch(() => {});
      }, { once: true });
      return request;
    };
  }, { databaseName: TRANSCRIPT_DATABASE, slot: fixture.target.entry.slot, revision: fixture.target.entry.dataRevision,
    bytes: payload.bytes, sha256: payload.sha256, expectedScope: fixture.target.record.scope });
}

export function projectCacheStorageFixture(fixture) {
  const row = value => ({ key: value.entry.key, profileKey: value.entry.profileKey, slot: value.entry.slot,
    dataRevision: value.entry.dataRevision, bytes: value.entry.bytes, payloadSha256: value.sha256 });
  return { manifestSha256: hash(fixture.snapshot.manifestRaw), manifestRevision: fixture.manifest.revision,
    lastKey: fixture.manifest.lastKey, target: row(fixture.target), peer: row(fixture.peer),
    draft: { keySha256: hash(fixture.draft.key), stateSha256: hash(fixture.draft.raw),
      unsentComposerDraft: true, queuedMessageCount: 0, failedSubmissionCount: 0 } };
}
