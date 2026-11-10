import type { GatewayProfile } from "@/gateway/types";
import { withWorkspaceProfileMetadata, WorkspaceProfileFenceError, type WorkspaceProfileIdentity } from "./workspace-profile-fence";
import { metadataSecure, type MetadataAuthority } from "./metadata-authority";
import { PROFILE_INDEX_KEY } from "./profile-store";
import { captureWorkspaceProfileIdentity } from "./workspace-profile-fence";
import { withLocalMetadata } from "./context-lock";
import { isProfileStateRemovalPending } from "./profile-state-removal";
import { decodeSessionTranscriptScope, sessionTranscriptScopeKey, sessionTranscriptWorkspaceScopeKey, sessionTranscriptIdentityDigest as digest, type SessionTranscriptScope } from "./session-transcript-scope";
import { decodeConfirmedTranscript, transcriptUtf8Size, TRANSCRIPT_CACHE_LIMITS, TRANSCRIPT_CACHE_MAX_IDLE_MS, type ConfirmedTranscript } from "./session-transcript-projection";
import { TranscriptCacheCorruptionError, type SessionTranscriptBackend, type TranscriptCacheChange } from "./session-transcript-backend-contract";

type Profile = WorkspaceProfileIdentity & { authMode: "device" | "legacy" };
type Fence = <T>(profile: Profile, operation: (authority?: MetadataAuthority) => Promise<T>) => Promise<T>;
interface Entry { key: string; profileId: string; profileKey: string; slot: number; dataRevision: number; bytes: number; used: number; workspaceKey?: string; lastAccessedAt?: number }
interface WorkspaceGeneration { key: string; generation: number }
interface Manifest { schemaVersion: 1; revision: number; epoch: string; clock: number; invalidations: { key: string; revision: number }[]; workspaceGenerations: WorkspaceGeneration[]; entries: Entry[]; lastKey: string | null }
type CommitIntent = { kind: "save"; scopeKey: string; workspaceKey: string } | { kind: "lru-touch" } | { kind: "delete" };
export interface SessionTranscriptLease { readonly scope: SessionTranscriptScope; readonly epoch: string; readonly revision: number; readonly isCurrent: () => boolean }
export interface SessionTranscriptRecordVersion { readonly epoch: string; readonly dataRevision: number }
export interface SessionTranscriptWorkspacePrefixVersion { readonly epoch: string; readonly revision: number; readonly workspaceKey: string; readonly generation: number; readonly prefixDigest: string }
export interface SessionTranscriptWorkspaceWitness { readonly lease: SessionTranscriptLease; readonly version: SessionTranscriptWorkspacePrefixVersion }
export interface SessionTranscriptWorkspacePublisherFence { readonly workspaceKey: string; readonly epoch: string; readonly revision: number }
let epochSequence = 0;
// Shared across store/backend instances in this JS realm only. It blocks same-realm reads
// after compensation and cache-only reset both fail; Web Locks serialize writers but do not
// propagate this flag to another tab/module realm. With persistent-media failure, another
// realm may still read the published manifest, and a process restart loses this flag too.
// The cache is a display projection, not durable authority.
let resetRequired = false;
// A cache incarnation identifier, never an authentication token or authority proof.
const empty = (): Manifest => ({ schemaVersion: 1, revision: 0,
  epoch: digest(JSON.stringify([Date.now(), ++epochSequence, Math.random(), Math.random(), Math.random()])),
  clock: 0, invalidations: [], workspaceGenerations: [], entries: [], lastKey: null });
const assertCurrent = (isCurrent: () => boolean) => { if (!isCurrent()) throw new WorkspaceProfileFenceError(); };
const isWorkspacePublisherFence = (value: unknown): value is SessionTranscriptWorkspacePublisherFence => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fence = value as Record<string, unknown>;
  return Object.keys(fence).length === 3 && Object.keys(fence).every(key => ["workspaceKey", "epoch", "revision"].includes(key)) &&
    typeof fence.workspaceKey === "string" && /^[a-f0-9]{64}$/.test(fence.workspaceKey) &&
    typeof fence.epoch === "string" && /^[a-f0-9]{64}$/.test(fence.epoch) &&
    Number.isSafeInteger(fence.revision) && (fence.revision as number) >= 0;
};

const profileKey = (profile: Profile) => digest(JSON.stringify([profile.id, profile.baseUrl, profile.authMode, profile.authorizationGeneration, profile.deviceId ?? null]));
function parseManifest(raw: string | null): Manifest {
  if (raw === null) return empty();
  if (raw.length > TRANSCRIPT_CACHE_LIMITS.manifestBytes || transcriptUtf8Size(raw) > TRANSCRIPT_CACHE_LIMITS.manifestBytes) throw new Error("Transcript manifest exceeds budget");
  const value = JSON.parse(raw) as Omit<Manifest, "workspaceGenerations"> & { workspaceGenerations?: WorkspaceGeneration[] };
  const integer = (number: unknown): number is number => Number.isSafeInteger(number) && (number as number) >= 0;
  if (!value || value.schemaVersion !== 1 || !integer(value.revision) || !/^[a-f0-9]{64}$/.test(value.epoch) || !integer(value.clock) ||
      value.clock > value.revision || !Array.isArray(value.entries) || value.entries.length > TRANSCRIPT_CACHE_LIMITS.entries ||
      Object.keys(value).some(key => !["schemaVersion", "revision", "epoch", "clock", "invalidations", "workspaceGenerations", "entries", "lastKey"].includes(key))) throw new Error("Invalid transcript manifest");
  if (!("workspaceGenerations" in value)) value.workspaceGenerations = [];
  if (!Array.isArray(value.workspaceGenerations) || value.workspaceGenerations.length > 32) throw new Error("Invalid transcript workspace generations");
  const generated = new Set<string>();
  for (const item of value.workspaceGenerations) {
    if (!item || !/^[a-f0-9]{64}$/.test(item.key) || !integer(item.generation) || item.generation === 0 || generated.has(item.key) ||
        Object.keys(item).some(key => !["key", "generation"].includes(key))) throw new Error("Invalid transcript workspace generation");
    generated.add(item.key);
  }
  if (!Array.isArray(value.invalidations) || value.invalidations.length > 32) throw new Error("Invalid transcript invalidations");
  const invalidated = new Set<string>();
  for (const item of value.invalidations) {
    if (!item || !/^[ptw]:[a-f0-9]{64}$/.test(item.key) || !integer(item.revision) || item.revision > value.revision ||
        invalidated.has(item.key) || Object.keys(item).some(key => !["key", "revision"].includes(key))) throw new Error("Invalid transcript invalidation");
    invalidated.add(item.key);
  }
  let bytes = 0; const keys = new Set<string>(); const slots = new Set<number>();
  for (const entry of value.entries) {
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.key) || !/^[a-f0-9]{64}$/.test(entry.profileKey) ||
        typeof entry.profileId !== "string" || !entry.profileId || entry.profileId.length > 4096 || !integer(entry.slot) || entry.slot >= 32 ||
        !integer(entry.dataRevision) || entry.dataRevision > value.revision || !integer(entry.bytes) || entry.bytes > TRANSCRIPT_CACHE_LIMITS.entryBytes ||
        !integer(entry.used) || entry.used > value.clock || keys.has(entry.key) || slots.has(entry.slot) ||
        (entry.workspaceKey !== undefined && !/^[a-f0-9]{64}$/.test(entry.workspaceKey)) ||
        (entry.lastAccessedAt !== undefined && !integer(entry.lastAccessedAt)) ||
        Object.keys(entry).some(key => !["key", "profileId", "profileKey", "slot", "dataRevision", "bytes", "used", "workspaceKey", "lastAccessedAt"].includes(key))) throw new Error("Invalid transcript manifest row");
    keys.add(entry.key); slots.add(entry.slot); bytes += entry.bytes;
  }
  if (bytes > TRANSCRIPT_CACHE_LIMITS.totalBytes || (value.lastKey !== null && !keys.has(value.lastKey))) throw new Error("Invalid transcript manifest budget or route");
  return value as Manifest;
}

/** Complements the existing shared fence with authMode, without modifying legacy draft semantics. */
const cacheFence: Fence = (profile, operation) => withWorkspaceProfileMetadata(profile, async authority => {
  const raw = await metadataSecure(authority).getSecureValue(PROFILE_INDEX_KEY);
  const index = raw ? JSON.parse(raw) as { profiles?: GatewayProfile[] } : null;
  const matches = index?.profiles?.filter(value => value.id === profile.id) ?? [];
  const current = matches[0];
  if (matches.length !== 1 || !current || profileKey({ ...captureWorkspaceProfileIdentity(current), authMode: current.authMode ?? "legacy" }) !== profileKey(profile)) throw new WorkspaceProfileFenceError();
  return operation(authority);
});

export function createSessionTranscriptStore(backend: SessionTranscriptBackend, fence: Fence = cacheFence) {
  const resetCache = async (isCurrent: () => boolean, manifest = empty(), authority?: MetadataAuthority) => {
    authority?.assert();
    resetRequired = true;
    await backend.reset(JSON.stringify(manifest), isCurrent, authority);
    assertCurrent(isCurrent);
    resetRequired = false;
    return manifest;
  };
  const read = async (isCurrent: () => boolean, authority?: MetadataAuthority) => {
    authority?.assert();
    assertCurrent(isCurrent);
    if (resetRequired) return resetCache(isCurrent, undefined, authority);
    let raw: string | null;
    try { raw = await backend.readManifest(); }
    catch (error) { if (!(error instanceof TranscriptCacheCorruptionError)) throw error; raw = ""; }
    assertCurrent(isCurrent);
    if (raw === null) return resetCache(isCurrent, undefined, authority);
    let manifest: Manifest;
    try { manifest = parseManifest(raw); }
    catch { return resetCache(isCurrent, undefined, authority); }
    const now = Date.now();
    const expired = manifest.entries.filter(entry => entry.lastAccessedAt !== undefined && now - entry.lastAccessedAt >= TRANSCRIPT_CACHE_MAX_IDLE_MS);
    const legacy = manifest.entries.filter(entry => entry.lastAccessedAt === undefined);
    if (expired.length || legacy.length) {
      // Older cache rows have no access clock: begin their grace period once,
      // without interpreting a server message timestamp as a phone visit.
      for (const entry of legacy) entry.lastAccessedAt = now;
      manifest.entries = manifest.entries.filter(entry => !expired.includes(entry));
      if (!manifest.entries.some(entry => entry.key === manifest.lastKey)) manifest.lastKey = null;
      manifest.revision++;
      if (expired.some(entry => entry.workspaceKey === undefined)) compactEpoch(manifest);
      bumpWorkspaceGenerations(manifest, expired.flatMap(entry => entry.workspaceKey ? [entry.workspaceKey] : []));
      await commit(manifest, isCurrent, { kind: "delete" }, undefined, authority);
    }
    return manifest;
  };
  const compensatePublishedSave = async (publishedRaw: string, scopeKey: string, workspaceKey: string, authority?: MetadataAuthority) => {
    authority?.assert();
    let currentRaw: string | null;
    try {
      currentRaw = await backend.readManifest();
      if (currentRaw !== publishedRaw) {
        // A valid different manifest means the attempted write never became current.
        if (currentRaw !== null) parseManifest(currentRaw);
        return;
      }
    } catch {
      // If publication cannot be determined or the current manifest is corrupt, fail closed.
      await resetCache(() => true, empty(), authority);
      return;
    }
    let raw: string;
    let keep: Set<number>;
    try {
      const current = parseManifest(currentRaw);
      if (!current.entries.some(entry => entry.key === scopeKey)) throw new Error("Published transcript save is missing its entry");

      // Keep the published state as the base. In particular, do not revive any rows the
      // save's LRU decision already removed or restore a previous last-route marker.
      current.entries = current.entries.filter(entry => entry.key !== scopeKey);
      if (current.lastKey === scopeKey) current.lastKey = null;
      invalidate(current, `t:${scopeKey}`);
      bumpWorkspaceGenerations(current, [workspaceKey]);
      raw = JSON.stringify(current);
      parseManifest(raw);
      keep = new Set(current.entries.map(entry => entry.slot));
    } catch {
      // An exact replacement cannot be formed from the current manifest.
      await resetCache(() => true, empty(), authority);
      return;
    }
    resetRequired = true;
    try {
      await backend.commit({ manifest: raw, removeSlots: Array.from({ length: 32 }, (_, slot) => slot).filter(slot => !keep.has(slot)) }, () => true, authority);
      if (await backend.readManifest() !== raw) throw new Error("Transcript save compensation was not published");
      resetRequired = false;
    } catch {
      // A failed exact compensation leaves the cache unreadable until a cache-only reset.
      await resetCache(() => true, empty(), authority);
    }
  };
  const commit = async (manifest: Manifest, isCurrent: () => boolean, intent: CommitIntent, put?: TranscriptCacheChange["put"], authority?: MetadataAuthority) => {
    authority?.assert();
    assertCurrent(isCurrent);
    const raw = JSON.stringify(manifest);
    if (transcriptUtf8Size(raw) > TRANSCRIPT_CACHE_LIMITS.manifestBytes) throw new Error("Transcript manifest exceeds budget");
    parseManifest(raw);
    const keep = new Set(manifest.entries.map(entry => entry.slot));
    try {
      await backend.commit({ manifest: raw, put, removeSlots: Array.from({ length: 32 }, (_, slot) => slot).filter(slot => !keep.has(slot)) }, isCurrent, authority);
      assertCurrent(isCurrent);
      authority?.assert();
    } catch (error) {
      // The shared profile gate is still held. Only a published save needs compensation;
      // a touch is optional, and published deletions must remain deleted for ticket retries.
      if (!isCurrent() && intent.kind === "save") {
        try { authority?.assert(); } catch (revoked) { resetRequired = true; throw revoked; }
        await compensatePublishedSave(raw, intent.scopeKey, intent.workspaceKey, authority);
      }
      throw error;
    }
  };
  const entryValue = async (entry: Entry, scope: SessionTranscriptScope, isCurrent: () => boolean) => {
    assertCurrent(isCurrent); const raw = await backend.readEntry(entry.slot, entry.dataRevision); assertCurrent(isCurrent);
    if (raw === null || transcriptUtf8Size(raw) !== entry.bytes) return null;
    return decodeConfirmedTranscript(raw, scope);
  };
  const assertLease = (manifest: Manifest, lease: SessionTranscriptLease) => {
    const keys = new Set([`t:${digest(sessionTranscriptScopeKey(lease.scope))}`, `p:${profileKey(lease.scope.profile)}`,
      `w:${digest(sessionTranscriptWorkspaceScopeKey(lease.scope))}`]);
    if (manifest.epoch !== lease.epoch || manifest.invalidations.some(item => keys.has(item.key) && item.revision > lease.revision)) throw new WorkspaceProfileFenceError();
  };
  const compactEpoch = (manifest: Manifest) => {
    manifest.epoch = empty().epoch;
    manifest.invalidations = [];
    manifest.workspaceGenerations = [];
  };
  const workspaceGeneration = (manifest: Manifest, key: string) => manifest.workspaceGenerations.find(item => item.key === key)?.generation ?? 0;
  const bumpWorkspaceGenerations = (manifest: Manifest, workspaceKeys: Iterable<string>) => {
    const keys = Array.from(new Set(workspaceKeys));
    if (keys.length > 32 || keys.some(key => !/^[a-f0-9]{64}$/.test(key))) throw new Error("Invalid transcript workspace generation key");
    const existing = new Map(manifest.workspaceGenerations.map(item => [item.key, item.generation]));
    const missing = keys.filter(key => !existing.has(key)).length;
    const rollover = manifest.workspaceGenerations.length + missing > 32 || keys.some(key => existing.get(key) === Number.MAX_SAFE_INTEGER);
    if (rollover) compactEpoch(manifest);
    for (const key of keys) {
      const current = manifest.workspaceGenerations.find(item => item.key === key);
      if (current) current.generation++;
      else manifest.workspaceGenerations.push({ key, generation: 1 });
    }
  };
  const verifiedEntryWorkspaceKey = async (entry: Entry, expectedProfileId: string, expectedProfileKey: string, isCurrent: () => boolean) => {
    if (entry.workspaceKey !== undefined) return entry.workspaceKey;
    // A peer's legacy row has no trustworthy prefix metadata. Do not inspect its transcript
    // to infer a workspace; the caller must fence all older witnesses with an epoch rollover.
    if (entry.profileId !== expectedProfileId || entry.profileKey !== expectedProfileKey) return null;
    assertCurrent(isCurrent);
    const raw = await backend.readEntry(entry.slot, entry.dataRevision);
    assertCurrent(isCurrent);
    if (raw === null || transcriptUtf8Size(raw) !== entry.bytes) throw new Error("Cannot verify evicted transcript workspace");
    let scope: SessionTranscriptScope | null = null;
    try { scope = decodeSessionTranscriptScope((JSON.parse(raw) as { scope?: unknown })?.scope); } catch { /* fail closed below */ }
    if (!scope || entry.profileId !== scope.profile.id || entry.profileKey !== profileKey(scope.profile) ||
        digest(sessionTranscriptScopeKey(scope)) !== entry.key || !decodeConfirmedTranscript(raw, scope)) {
      throw new Error("Cannot verify evicted transcript workspace");
    }
    return digest(sessionTranscriptWorkspaceScopeKey(scope));
  };
  const readWorkspacePrefix = async (manifest: Manifest, scope: SessionTranscriptScope, isCurrent: () => boolean) => {
    const expectedProfileKey = profileKey(scope.profile);
    const expectedWorkspaceKey = digest(sessionTranscriptWorkspaceScopeKey(scope));
    const matching: Entry[] = [];
    for (const entry of manifest.entries) {
      // The manifest is bounded to 16 rows; filter identity before touching another profile's payload.
      if (entry.profileKey !== expectedProfileKey) continue;
      assertCurrent(isCurrent);
      const raw = await backend.readEntry(entry.slot, entry.dataRevision);
      assertCurrent(isCurrent);
      if (raw === null || transcriptUtf8Size(raw) !== entry.bytes) throw new Error("Cannot verify transcript workspace prefix");
      let entryScope: SessionTranscriptScope | null = null;
      try { entryScope = decodeSessionTranscriptScope((JSON.parse(raw) as { scope?: unknown })?.scope); } catch { /* fail closed below */ }
      if (!entryScope || entry.profileId !== entryScope.profile.id || profileKey(entryScope.profile) !== entry.profileKey ||
          digest(sessionTranscriptScopeKey(entryScope)) !== entry.key || !decodeConfirmedTranscript(raw, entryScope)) {
        throw new Error("Cannot verify transcript workspace prefix");
      }
      const entryWorkspaceKey = digest(sessionTranscriptWorkspaceScopeKey(entryScope));
      if (entry.workspaceKey !== undefined && entry.workspaceKey !== entryWorkspaceKey) throw new Error("Cannot verify transcript workspace prefix");
      if (entryWorkspaceKey === expectedWorkspaceKey) matching.push(entry);
    }
    return matching;
  };
  const workspacePrefixDigest = (workspaceKey: string, entries: Entry[]) => digest(JSON.stringify([
    workspaceKey,
    entries.map(entry => [entry.key, entry.dataRevision]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  ]));
  const loadEntry = async (lease: SessionTranscriptLease, touch: boolean) => {
    assertCurrent(lease.isCurrent);
    return fence(lease.scope.profile, async authority => {
      const manifest = await read(lease.isCurrent, authority);
      assertLease(manifest, lease);
      const entry = manifest.entries.find(value => value.key === digest(sessionTranscriptScopeKey(lease.scope)));
      if (!entry) return null;
      const value = await entryValue(entry, lease.scope, lease.isCurrent);
      if (!value) return null;
      const version = { epoch: manifest.epoch, dataRevision: entry.dataRevision };
      if (touch) {
        manifest.clock++; manifest.revision++; entry.used = manifest.clock; entry.lastAccessedAt = Date.now();
        // Cache read remains usable if an optional LRU touch cannot be written.
        try { await commit(manifest, lease.isCurrent, { kind: "lru-touch" }, undefined, authority); } catch { assertCurrent(lease.isCurrent); }
      }
      return { value, version };
    });
  };
  const loadVersioned = (lease: SessionTranscriptLease) => loadEntry(lease, false);
  const invalidate = (manifest: Manifest, key: string) => {
    manifest.revision++;
    manifest.invalidations = manifest.invalidations.filter(item => item.key !== key);
    if (manifest.invalidations.length === 32) {
      // Bounded tombstone compaction deliberately fences all older cache leases.
      compactEpoch(manifest);
    }
    manifest.invalidations.push({ key, revision: manifest.revision });
  };
  const invalidateWorkspace = (manifest: Manifest, workspaceKey: string) => {
    const key = `w:${workspaceKey}`;
    invalidate(manifest, key);
    const tombstoneEpoch = manifest.epoch;
    bumpWorkspaceGenerations(manifest, [workspaceKey]);
    // A generation-table rollover fences old witnesses by epoch; re-publish this operation's w tombstone in the new epoch.
    if (manifest.epoch !== tombstoneEpoch) invalidate(manifest, key);
  };
  return {
    async capture(scope: SessionTranscriptScope, isCurrent: () => boolean): Promise<SessionTranscriptLease> {
      const captured = decodeSessionTranscriptScope(JSON.parse(JSON.stringify(scope)));
      if (!captured) throw new Error("Invalid transcript display scope");
      assertCurrent(isCurrent);
      return fence(captured.profile, async authority => { const manifest = await read(isCurrent, authority); return { scope: captured, epoch: manifest.epoch, revision: manifest.revision, isCurrent }; });
    },
    async captureWorkspacePublisherFence(scope: SessionTranscriptScope, isCurrent: () => boolean): Promise<SessionTranscriptWorkspacePublisherFence> {
      const captured = decodeSessionTranscriptScope(JSON.parse(JSON.stringify(scope)));
      if (!captured) throw new Error("Invalid transcript display scope");
      assertCurrent(isCurrent);
      return fence(captured.profile, async authority => {
        const manifest = await read(isCurrent, authority);
        return Object.freeze({ workspaceKey: digest(sessionTranscriptWorkspaceScopeKey(captured)), epoch: manifest.epoch, revision: manifest.revision });
      });
    },
    async capturePublisherLease(scope: SessionTranscriptScope, fixed: SessionTranscriptWorkspacePublisherFence, isCurrent: () => boolean): Promise<SessionTranscriptLease> {
      const captured = decodeSessionTranscriptScope(JSON.parse(JSON.stringify(scope)));
      if (!captured || !isWorkspacePublisherFence(fixed)) throw new WorkspaceProfileFenceError();
      const workspaceKey = digest(sessionTranscriptWorkspaceScopeKey(captured));
      const expectedWorkspaceKey = `w:${workspaceKey}`;
      const expectedProfileKey = `p:${profileKey(captured.profile)}`;
      const expectedThreadKey = `t:${digest(sessionTranscriptScopeKey(captured))}`;
      if (fixed.workspaceKey !== workspaceKey) throw new WorkspaceProfileFenceError();
      assertCurrent(isCurrent);
      return fence(captured.profile, async authority => {
        const manifest = await read(isCurrent, authority);
        if (fixed.epoch !== manifest.epoch || fixed.revision > manifest.revision ||
            manifest.invalidations.some(item => item.revision > fixed.revision &&
              (item.key === expectedWorkspaceKey || item.key === expectedProfileKey || item.key === expectedThreadKey))) {
          throw new WorkspaceProfileFenceError();
        }
        return { scope: captured, epoch: manifest.epoch, revision: manifest.revision, isCurrent };
      });
    },
    async captureWorkspaceWitness(scope: SessionTranscriptScope, isCurrent: () => boolean): Promise<SessionTranscriptWorkspaceWitness> {
      const captured = decodeSessionTranscriptScope(JSON.parse(JSON.stringify(scope)));
      if (!captured) throw new Error("Invalid transcript display scope");
      assertCurrent(isCurrent);
      return fence(captured.profile, async authority => {
        const manifest = await read(isCurrent, authority);
        const lease: SessionTranscriptLease = { scope: captured, epoch: manifest.epoch, revision: manifest.revision, isCurrent };
        const workspaceKey = digest(sessionTranscriptWorkspaceScopeKey(captured));
        const entries = await readWorkspacePrefix(manifest, captured, isCurrent);
        return { lease, version: { epoch: manifest.epoch, revision: manifest.revision, workspaceKey,
          generation: workspaceGeneration(manifest, workspaceKey),
          prefixDigest: workspacePrefixDigest(workspaceKey, entries) } };
      });
    },
    async invalidateWorkspaceIfVersion(lease: SessionTranscriptLease, expected: SessionTranscriptWorkspacePrefixVersion) {
      assertCurrent(lease.isCurrent);
      const workspaceKey = digest(sessionTranscriptWorkspaceScopeKey(lease.scope));
      if (lease.epoch !== expected.epoch || lease.revision !== expected.revision || workspaceKey !== expected.workspaceKey ||
          !Number.isSafeInteger(expected.generation) || expected.generation < 0 || !/^[a-f0-9]{64}$/.test(expected.prefixDigest)) return false;
      return fence(lease.scope.profile, async authority => {
        const manifest = await read(lease.isCurrent, authority);
        assertLease(manifest, lease);
        if (manifest.epoch !== expected.epoch) return false;
        if (workspaceGeneration(manifest, workspaceKey) !== expected.generation) return false;
        const entries = await readWorkspacePrefix(manifest, lease.scope, lease.isCurrent);
        if (workspacePrefixDigest(workspaceKey, entries) !== expected.prefixDigest) return false;
        const removedKeys = new Set(entries.map(entry => entry.key));
        manifest.entries = manifest.entries.filter(entry => !removedKeys.has(entry.key));
        if (manifest.lastKey !== null && removedKeys.has(manifest.lastKey)) manifest.lastKey = null;
        invalidateWorkspace(manifest, workspaceKey);
        await commit(manifest, lease.isCurrent, { kind: "delete" }, undefined, authority);
        return true;
      });
    },
    loadVersioned,
    async load(lease: SessionTranscriptLease) { return (await loadEntry(lease, true))?.value ?? null; },
    async save(lease: SessionTranscriptLease, value: ConfirmedTranscript, lastRoute = false) {
      assertCurrent(lease.isCurrent);
      const raw = JSON.stringify(value);
      if (!decodeConfirmedTranscript(raw, lease.scope)) throw new Error("Invalid confirmed transcript");
      return fence(lease.scope.profile, async authority => {
        const manifest = await read(lease.isCurrent, authority);
        assertLease(manifest, lease);
        const key = digest(sessionTranscriptScopeKey(lease.scope)); const previous = manifest.entries.find(entry => entry.key === key);
        const previousEntries = manifest.entries.slice();
        const workspaceKey = digest(sessionTranscriptWorkspaceScopeKey(lease.scope));
        const occupied = new Set(manifest.entries.map(entry => entry.slot));
        const slot = Array.from({ length: 32 }, (_, index) => index).find(index => !occupied.has(index))!;
        manifest.revision++; manifest.clock++;
        const entries = manifest.entries.filter(entry => entry !== previous).sort((a, b) => b.used - a.used);
        entries.unshift({ key, profileId: lease.scope.profile.id, profileKey: profileKey(lease.scope.profile), slot, workspaceKey,
          dataRevision: manifest.revision, bytes: transcriptUtf8Size(raw), used: manifest.clock, lastAccessedAt: Date.now() });
        let bytes = 0;
        const nextEntries = entries.filter((entry, index) => { bytes += entry.bytes; return index < TRANSCRIPT_CACHE_LIMITS.entries && bytes <= TRANSCRIPT_CACHE_LIMITS.totalBytes; });
        const touchedWorkspaces = new Set([workspaceKey]);
        let unknownPeerLegacyVictim = false;
        const evicted = previousEntries.filter(entry => !nextEntries.some(next => next.key === entry.key));
        for (const entry of evicted) if (entry.key !== key) {
          const evictedWorkspaceKey = await verifiedEntryWorkspaceKey(entry, lease.scope.profile.id, profileKey(lease.scope.profile), lease.isCurrent);
          if (evictedWorkspaceKey === null) unknownPeerLegacyVictim = true;
          else touchedWorkspaces.add(evictedWorkspaceKey);
        }
        // Rollover once before applying every known generation bump. This fences old leases
        // and witnesses without guessing the unknown peer prefix, while retaining all rows
        // that the LRU decision did not evict.
        if (unknownPeerLegacyVictim) compactEpoch(manifest);
        bumpWorkspaceGenerations(manifest, touchedWorkspaces);
        manifest.entries = nextEntries;
        if (lastRoute) manifest.lastKey = key;
        else if (manifest.lastKey && !manifest.entries.some(entry => entry.key === manifest.lastKey)) manifest.lastKey = null;
        await commit(manifest, lease.isCurrent, { kind: "save", scopeKey: key, workspaceKey }, { slot, revision: manifest.revision, raw }, authority);
      });
    },
    async last(profile: GatewayProfile, isCurrent: () => boolean) {
      const identity: Profile = { ...captureWorkspaceProfileIdentity(profile), authMode: profile.authMode ?? "legacy" };
      assertCurrent(isCurrent);
      return fence(identity, async authority => {
        const manifest = await read(isCurrent, authority);
        const entry = manifest.entries.find(value => value.key === manifest.lastKey && value.profileKey === profileKey(identity));
        if (!entry) return null;
        const raw = await backend.readEntry(entry.slot, entry.dataRevision); assertCurrent(isCurrent);
        if (raw === null || raw.length > TRANSCRIPT_CACHE_LIMITS.entryBytes || transcriptUtf8Size(raw) !== entry.bytes) return null;
        try {
          const scope = decodeSessionTranscriptScope((JSON.parse(raw) as ConfirmedTranscript).scope);
          if (!scope || profileKey(scope.profile) !== profileKey(identity) || digest(sessionTranscriptScopeKey(scope)) !== entry.key) return null;
          return decodeConfirmedTranscript(raw, scope);
        } catch { return null; }
      });
    },
    async invalidateThread(lease: SessionTranscriptLease) {
      assertCurrent(lease.isCurrent);
      return fence(lease.scope.profile, async authority => {
        const manifest = await read(lease.isCurrent, authority); const key = digest(sessionTranscriptScopeKey(lease.scope));
        manifest.entries = manifest.entries.filter(entry => entry.key !== key);
        if (manifest.lastKey === key) manifest.lastKey = null;
        invalidate(manifest, `t:${key}`);
        bumpWorkspaceGenerations(manifest, [digest(sessionTranscriptWorkspaceScopeKey(lease.scope))]);
        await commit(manifest, lease.isCurrent, { kind: "delete" }, undefined, authority);
      });
    },
    async invalidateThreadIfVersion(lease: SessionTranscriptLease, expected: SessionTranscriptRecordVersion) {
      assertCurrent(lease.isCurrent);
      return fence(lease.scope.profile, async authority => {
        const manifest = await read(lease.isCurrent, authority); const key = digest(sessionTranscriptScopeKey(lease.scope));
        if (lease.epoch !== expected.epoch || manifest.epoch !== expected.epoch) return false;
        const entry = manifest.entries.find(value => value.key === key);
        if (!entry || entry.dataRevision !== expected.dataRevision) return false;
        manifest.entries = manifest.entries.filter(value => value.key !== key);
        if (manifest.lastKey === key) manifest.lastKey = null;
        invalidate(manifest, `t:${key}`);
        bumpWorkspaceGenerations(manifest, [digest(sessionTranscriptWorkspaceScopeKey(lease.scope))]);
        await commit(manifest, lease.isCurrent, { kind: "delete" }, undefined, authority);
        return true;
      });
    },
    async invalidateProfile(profile: GatewayProfile, isCurrent: () => boolean) {
      const identity: Profile = { ...captureWorkspaceProfileIdentity(profile), authMode: profile.authMode ?? "legacy" };
      assertCurrent(isCurrent);
      return fence(identity, async authority => {
        const manifest = await read(isCurrent, authority);
        manifest.entries = manifest.entries.filter(entry => entry.profileId !== profile.id);
        if (!manifest.entries.some(entry => entry.key === manifest.lastKey)) manifest.lastKey = null;
        invalidate(manifest, `p:${profileKey(identity)}`);
        await commit(manifest, isCurrent, { kind: "delete" }, undefined, authority);
      });
    },
    /** Run after committed profile removal, outside the profile coordinator's metadata gate. */
    async clearRemovedProfile(profile: GatewayProfile, removalGeneration: number, isCurrent: () => boolean) {
      const identity: Profile = { ...captureWorkspaceProfileIdentity(profile), authMode: profile.authMode ?? "legacy" };
      const cleanupCurrent = () => isCurrent() && isProfileStateRemovalPending(profile.id, removalGeneration);
      assertCurrent(cleanupCurrent);
      return withLocalMetadata("gateway-profile-index", async authority => {
        assertCurrent(cleanupCurrent);
        if (!isProfileStateRemovalPending(profile.id, removalGeneration)) throw new WorkspaceProfileFenceError();
        const raw = await metadataSecure(authority).getSecureValue(PROFILE_INDEX_KEY); assertCurrent(cleanupCurrent);
        const index = raw ? JSON.parse(raw) as { profiles?: GatewayProfile[] } : null;
        if (!Array.isArray(index?.profiles) || index.profiles.some(value => !value || typeof value.id !== "string" || typeof value.baseUrl !== "string")) throw new WorkspaceProfileFenceError();
        if (index.profiles.some(value => profileKey({ ...captureWorkspaceProfileIdentity(value), authMode: value.authMode ?? "legacy" }) === profileKey(identity))) throw new WorkspaceProfileFenceError();
        const manifest = await read(cleanupCurrent, authority); const key = profileKey(identity);
        // A concurrently paired replacement identity is retained, even with the same profile ID.
        manifest.entries = manifest.entries.filter(entry => entry.profileKey !== key);
        if (!manifest.entries.some(entry => entry.key === manifest.lastKey)) manifest.lastKey = null;
        invalidate(manifest, `p:${profileKey(identity)}`);
        await commit(manifest, cleanupCurrent, { kind: "delete" }, undefined, authority);
      });
    },
  };
}
