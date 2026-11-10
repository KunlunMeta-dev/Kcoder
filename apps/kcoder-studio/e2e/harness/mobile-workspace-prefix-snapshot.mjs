import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const TRANSCRIPT_DATABASE = "kcoder-confirmed-transcripts-v1";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

/** Same non-secret identity tuple used by the Mobile transcript store. */
export function mobileWorkspaceProfileKey(identity) {
  validateProfileIdentity(identity);
  return createHash("sha256")
    .update(JSON.stringify([
      identity.profileId,
      identity.baseUrl,
      identity.authMode,
      identity.authorizationGeneration,
      identity.deviceId ?? null,
    ]))
    .digest("hex");
}

/** Read only this profile's manifest rows and transcript scopes from the production IDB. */
export async function captureMobileWorkspacePrefixSnapshot(page, {
  identity,
  expectedServerId = "local",
  expectedTargetWorkspacePath,
} = {}) {
  validateProfileIdentity(identity);
  assert.ok(typeof expectedServerId === "string" && expectedServerId.length > 0,
    "an exact Gateway server id is required");
  assert.ok(typeof expectedTargetWorkspacePath === "string" && expectedTargetWorkspacePath.length > 0,
    "the actual Gateway parent workspace path is required");
  const profileKey = mobileWorkspaceProfileKey(identity);
  return page.evaluate(async ({ expectedIdentity, expectedProfileKey, expectedServerId, expectedTargetWorkspacePath, databaseName,
    maxManifestBytes, maxEntryBytes }) => {
    async function digestHex(value) {
      const bytes = new TextEncoder().encode(value);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    }
    const unavailable = reason => ({ ready: false, reason });
    if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function")
      return unavailable("indexeddb_enumeration_unavailable");
    const databases = await indexedDB.databases();
    if (!databases.some(database => database.name === databaseName && database.version === 1))
      return unavailable("database_missing");

    const db = await new Promise((resolve, reject) => {
      let request;
      try { request = indexedDB.open(databaseName, 1); }
      catch { reject(new Error("transcript cache open failed")); return; }
      request.onupgradeneeded = () => {
        try { request.transaction?.abort(); } catch { /* A readonly audit never creates stores. */ }
        reject(new Error("transcript cache schema changed during readonly audit"));
      };
      request.onerror = () => reject(new Error("transcript cache open failed"));
      request.onblocked = () => reject(new Error("transcript cache open was blocked"));
      request.onsuccess = () => resolve(request.result);
    });

    try {
      return await new Promise((resolve, reject) => {
        let manifest = null;
        let selectedRows = [];
        let physicalRows = [];
        let fatal = null;
        const transaction = db.transaction(["manifest", "entries"], "readonly");
        const manifestRequest = transaction.objectStore("manifest").get("current");
        manifestRequest.onerror = () => { fatal = new Error("transcript manifest read failed"); };
        manifestRequest.onsuccess = () => {
          try {
            const raw = manifestRequest.result;
            if (typeof raw !== "string" || raw.length === 0 || raw.length > maxManifestBytes ||
                new TextEncoder().encode(raw).length > maxManifestBytes)
              throw new Error("transcript manifest missing or outside its read bound");
            manifest = JSON.parse(raw);
            if (!manifest || manifest.schemaVersion !== 1 || !Number.isSafeInteger(manifest.revision) ||
                manifest.revision < 0 || !/^[a-f0-9]{64}$/.test(manifest.epoch) ||
                !Array.isArray(manifest.entries) || manifest.entries.length > 16 ||
                !Array.isArray(manifest.invalidations) || manifest.invalidations.length > 32 ||
                !Array.isArray(manifest.workspaceGenerations) || manifest.workspaceGenerations.length > 32 ||
                !(manifest.lastKey === null || (typeof manifest.lastKey === "string" && /^[a-f0-9]{64}$/.test(manifest.lastKey))))
              throw new Error("transcript manifest has an invalid readonly snapshot shape");
            selectedRows = manifest.entries.filter(row => row?.profileId === expectedIdentity.profileId &&
              row?.profileKey === expectedProfileKey);
            for (const row of selectedRows) {
              if (!/^[a-f0-9]{64}$/.test(row.key) || !Number.isSafeInteger(row.slot) || row.slot < 0 || row.slot >= 32 ||
                  !Number.isSafeInteger(row.dataRevision) || row.dataRevision < 0 || row.dataRevision > manifest.revision ||
                  (row.workspaceKey !== undefined && !/^[a-f0-9]{64}$/.test(row.workspaceKey)))
                throw new Error("transcript manifest contains an invalid same-profile entry row");
              const entryRequest = transaction.objectStore("entries").get(row.slot);
              const physical = { row, value: undefined };
              physicalRows.push(physical);
              entryRequest.onerror = () => { fatal = new Error("same-profile transcript slot read failed"); };
              entryRequest.onsuccess = () => { physical.value = entryRequest.result; };
            }
          } catch (error) { fatal = error instanceof Error ? error : new Error(String(error)); }
        };
        transaction.onabort = () => reject(fatal || new Error("transcript readonly transaction aborted"));
        transaction.onerror = () => {};
        transaction.oncomplete = () => {
          void (async () => {
            if (fatal) throw fatal;
            const entries = [];
            for (const { row, value } of physicalRows) {
              if (!value || value.revision !== row.dataRevision || !(value.blob instanceof Blob) ||
                  value.blob.size > maxEntryBytes) throw new Error("same-profile transcript slot is missing or corrupt");
              const record = JSON.parse(await value.blob.text());
              const scope = record?.scope;
              if (record?.schemaVersion !== 1 || !scope || scope.version !== 1 ||
                  !scope.profile || !scope.target || typeof scope.cwd !== "string" ||
                  typeof scope.threadId !== "string" || !scope.threadId ||
                  scope.profile.id !== expectedIdentity.profileId || scope.profile.baseUrl !== expectedIdentity.baseUrl ||
                  scope.profile.authMode !== expectedIdentity.authMode ||
                  scope.profile.authorizationGeneration !== expectedIdentity.authorizationGeneration ||
                  (scope.profile.deviceId ?? null) !== (expectedIdentity.deviceId ?? null) ||
                  scope.target.id !== expectedServerId || scope.target.transport !== "local" ||
                  scope.target.workspacePath !== expectedTargetWorkspacePath ||
                  !/^[a-f0-9]{64}$/.test(scope.target.connectionFingerprint))
                throw new Error("same-profile transcript scope does not match the live Mobile identity");
              const profile = {
                id: scope.profile.id,
                baseUrl: scope.profile.baseUrl,
                authorizationGeneration: scope.profile.authorizationGeneration,
                ...(scope.profile.deviceId === undefined ? {} : { deviceId: scope.profile.deviceId }),
                authMode: scope.profile.authMode,
              };
              const target = {
                id: scope.target.id,
                transport: scope.target.transport,
                connectionFingerprint: scope.target.connectionFingerprint,
                principalId: scope.target.principalId,
                role: scope.target.role,
                workspacePath: scope.target.workspacePath,
              };
              const workspaceKey = await digestHex(JSON.stringify([scope.version, profile, target, scope.cwd]));
              if (row.workspaceKey !== undefined && row.workspaceKey !== workspaceKey)
                throw new Error("same-profile transcript workspace key differs from its stored scope");
              entries.push({ key: row.key, slot: row.slot, dataRevision: row.dataRevision,
                workspaceKey, threadId: scope.threadId, cwd: scope.cwd, targetId: scope.target.id,
                targetWorkspacePath: scope.target.workspacePath });
            }
            const invalidations = manifest.invalidations.map(item => ({ key: item.key, revision: item.revision }));
            const workspaceGenerations = manifest.workspaceGenerations.map(item => ({ key: item.key, generation: item.generation }));
            resolve({ ready: true, manifest: { schemaVersion: manifest.schemaVersion, revision: manifest.revision,
              epoch: manifest.epoch, lastKey: manifest.lastKey, invalidations, workspaceGenerations,
              entries: selectedRows.map(row => ({ key: row.key, slot: row.slot, dataRevision: row.dataRevision,
                workspaceKey: entries.find(entry => entry.key === row.key)?.workspaceKey ?? null })) }, entries });
          })().catch(reject);
        };
      });
    } finally { db.close(); }
  }, { expectedIdentity: identity, expectedProfileKey: profileKey, expectedServerId, expectedTargetWorkspacePath,
    databaseName: TRANSCRIPT_DATABASE, maxManifestBytes: MAX_MANIFEST_BYTES, maxEntryBytes: MAX_ENTRY_BYTES });
}

/**
 * Assert a real workspace-prefix CAS while permitting unrelated recency metadata to change.
 * The current single-tab E2E seeds the target as lastKey immediately before cleanup;
 * this does not define how concurrent tabs' route markers should be reconciled.
 */
export function assertMobileWorkspacePrefixInvalidated(before, after, {
  workspaceKey,
  targetCwd,
  peerCwd,
  expectedTargetCount = 2,
} = {}) {
  assertSnapshot(before, "before");
  assertSnapshot(after, "after");
  assert.match(workspaceKey ?? "", SHA256, "expected workspace key must be an SHA-256 digest");
  assert.ok(typeof targetCwd === "string" && targetCwd.length > 0, "exact target cwd is required");
  assert.ok(typeof peerCwd === "string" && peerCwd.length > 0 && peerCwd !== targetCwd,
    "a distinct retained peer cwd is required");
  assert.equal(after.manifest.epoch, before.manifest.epoch,
    "a bounded fresh-profile absence cleanup must not roll the cache epoch");
  assert.ok(after.manifest.revision > before.manifest.revision,
    "workspace invalidation must publish a newer manifest revision");

  const targets = before.entries.filter(entry => entry.workspaceKey === workspaceKey);
  assert.equal(targets.length, expectedTargetCount, "the exact target prefix must be seeded before absence");
  assert.ok(targets.every(entry => entry.cwd === targetCwd), "target prefix rows must share the exact child cwd");
  const targetKeys = new Set(targets.map(entry => entry.key));
  assert.equal(targetKeys.size, expectedTargetCount, "target prefix must contain distinct transcript keys");
  assert.ok(targetKeys.has(before.manifest.lastKey),
    "the pre-cleanup last-route marker must point into the workspace prefix being invalidated");
  const peers = before.entries.filter(entry => entry.cwd === peerCwd && entry.workspaceKey !== workspaceKey);
  assert.equal(peers.length, 1, "one distinct same-profile peer workspace entry must be seeded");
  const peer = peers[0];

  assert.ok(after.entries.every(entry => entry.workspaceKey !== workspaceKey && !targetKeys.has(entry.key)),
    "the exact child workspace prefix must be absent after confirmed workspace cleanup");
  const oldTargets = new Set(targets.map(entry => `${entry.slot}:${entry.dataRevision}`));
  assert.ok(after.entries.every(entry => !oldTargets.has(`${entry.slot}:${entry.dataRevision}`)),
    "no prior target slot revision may remain published in the same-profile manifest");
  assert.equal(after.manifest.lastKey, null,
    "invalidating the workspace prefix that owned the last route must clear that route marker");

  const invalidationKey = `w:${workspaceKey}`;
  const prefixInvalidations = after.manifest.invalidations.filter(item => item.key === invalidationKey);
  assert.equal(prefixInvalidations.length, 1, "one exact workspace invalidation tombstone must remain published");
  assert.ok(prefixInvalidations[0].revision > before.manifest.revision &&
    prefixInvalidations[0].revision <= after.manifest.revision,
  "the exact workspace tombstone must be newer than the captured prefix revision");
  const generation = key => after.manifest.workspaceGenerations.find(item => item.key === key)?.generation ?? 0;
  const beforeGeneration = before.manifest.workspaceGenerations.find(item => item.key === workspaceKey)?.generation ?? 0;
  assert.ok(generation(workspaceKey) > beforeGeneration, "target workspace generation must advance");
  const peerWorkspaceKey = peer.workspaceKey;
  const beforePeerGeneration = before.manifest.workspaceGenerations.find(item => item.key === peerWorkspaceKey)?.generation ?? 0;
  assert.equal(generation(peerWorkspaceKey), beforePeerGeneration,
    "unrelated peer workspace generation must remain unchanged");
  const retainedPeer = after.entries.find(entry => entry.key === peer.key);
  assert.ok(retainedPeer, "the unrelated peer workspace entry must remain readable");
  assert.deepEqual({ key: retainedPeer.key, slot: retainedPeer.slot, dataRevision: retainedPeer.dataRevision,
    workspaceKey: retainedPeer.workspaceKey, cwd: retainedPeer.cwd, threadId: retainedPeer.threadId },
  { key: peer.key, slot: peer.slot, dataRevision: peer.dataRevision,
    workspaceKey: peer.workspaceKey, cwd: peer.cwd, threadId: peer.threadId },
  "the retained peer cache row must keep its identity and stored slot");
  return { workspaceKey, invalidationRevision: prefixInvalidations[0].revision,
    beforeRevision: before.manifest.revision, afterRevision: after.manifest.revision,
    targetEntryCountBefore: targets.length, targetEntryCountAfter: 0,
    peerRetained: true, epochStable: true };
}

function validateProfileIdentity(identity) {
  assert.ok(identity && typeof identity === "object", "live Mobile profile identity is required");
  for (const name of ["profileId", "baseUrl", "authorizationGeneration", "deviceId"])
    assert.ok(typeof identity[name] === "string" && identity[name].length > 0,
      `live Mobile profile identity ${name} is required`);
  assert.equal(identity.authMode, "device", "workspace absence requires a refreshed device-auth profile");
  const baseUrl = new URL(identity.baseUrl);
  assert.ok(["http:", "https:"].includes(baseUrl.protocol) && !baseUrl.username && !baseUrl.password &&
    !baseUrl.search && !baseUrl.hash, "live Mobile Gateway URL must be canonical and credential-free");
}

function assertSnapshot(snapshot, label) {
  assert.ok(snapshot?.ready === true && snapshot.manifest && Array.isArray(snapshot.entries),
    `${label} readonly transcript snapshot must be ready`);
  assert.match(snapshot.manifest.epoch ?? "", SHA256, `${label} cache epoch is invalid`);
  assert.ok(Number.isSafeInteger(snapshot.manifest.revision) && snapshot.manifest.revision >= 0,
    `${label} cache revision is invalid`);
}
