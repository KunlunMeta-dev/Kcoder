import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import type { TaskRuntime } from "@/runtime/task-runtime";
import { captureRuntimeTranscriptLease } from "@/runtime/task-runtime/cache-publication";
import { transcriptReadIdentityMatches } from "@/runtime/task-runtime/history";
import type { ThreadReadPage } from "@/runtime/task-runtime/types";
import { workspaceThreadScopeIdentity } from "@/runtime/task-runtime/workspaces";
import { sessionTranscriptCache, loadLastSessionTranscript } from "@/storage/session-transcript-cache";
import { captureSessionTranscriptScope, sessionTranscriptScopeKey, type SessionTranscriptScope } from "@/storage/session-transcript-scope";
import { projectConfirmedTranscript, type ConfirmedTranscript, type TranscriptReadAnchor } from "@/storage/session-transcript-projection";
import type { SessionTranscriptLease, SessionTranscriptRecordVersion } from "@/storage/session-transcript-store";
import { confirmedSessionAnchor, displayedSessionAnchor } from "./session-cache-anchor";
import type { ThreadPresenceObservation } from "@/runtime/task-runtime/thread-presence";
import type { WorkspacePresenceObservation } from "@/runtime/task-runtime/workspace-presence";
import { workspaceObservationPath } from "@/gateway/workspace-cwd-observation";
import { WorkspaceProfileFenceError } from "@/storage/workspace-profile-fence";

type Cache = typeof sessionTranscriptCache;
export type CachedSession = NonNullable<Awaited<ReturnType<Cache["last"]>>>;
export type LoadedCachedSession = { value: CachedSession; version: SessionTranscriptRecordVersion | null };
export interface CacheRoute { profile: GatewayProfile; serverId: string; threadId: string; cwd?: string }
export function cacheProfileReadDeadline(profile: GatewayProfile): number {
  const access = Number.isFinite(profile.expiresAt) ? profile.expiresAt : 0;
  const refresh = profile.authMode === "device" && profile.refreshToken && Number.isFinite(profile.refreshExpiresAt)
    ? profile.refreshExpiresAt! : 0;
  return Math.max(access, refresh);
}
export function cacheProfileReadable(profile: GatewayProfile, reauthorizationRequired: boolean): boolean {
  return !reauthorizationRequired && profile.reauthorizationRequiredScope !== profileAuthorizationScopeKey(profile) &&
    cacheProfileReadDeadline(profile) > Date.now();
}
export function cachedSessionMatches(value: CachedSession, route: CacheRoute, server?: KCoderServer): boolean {
  const scope = value.record.scope;
  if (scope.target.id !== route.serverId || scope.threadId !== route.threadId ||
      (route.cwd && workspaceThreadScopeIdentity(route.cwd) !== scope.cwd)) return false;
  if (!server) return true; // Absence from an unavailable list is not deletion authority.
  try { return sessionTranscriptScopeKey(scope) === sessionTranscriptScopeKey(captureSessionTranscriptScope(route.profile, server, scope.cwd, route.threadId)); }
  catch { return false; }
}

/** UI-route ownership only. Never shares or replays a runtime resume or a write RPC. */
export class SessionCacheCoordinator {
  readonly displayOwner = {};
  anchor: TranscriptReadAnchor | undefined;
  private closed = false;
  private watchGeneration = 0;
  private authoritative = false;
  private cacheOnlyWritesBlocked = false;
  private anchorTouched = false;
  private terminalRead: { runtime: TaskRuntime; revision: number; promise: Promise<unknown> } | null = null;
  private lease: SessionTranscriptLease | null = null;
  private record: ConfirmedTranscript | null = null;
  private unsubscribe: (() => void) | undefined;
  private anchorTimer: ReturnType<typeof setTimeout> | undefined;
  private anchorWriteFlight: Promise<void> | null = null;
  private anchorWritePending = false;
  private anchorWriteRequested = false;
  private watchedRuntime: TaskRuntime | null = null;
  private watchedServer: KCoderServer | undefined;
  private recordAuthority: TaskRuntime["confirmedTranscriptPage"] = null;
  private anchorBinding: { runtime: TaskRuntime | null; authority: TaskRuntime["confirmedTranscriptPage"]; generation: number;
    rows: TaskRuntime["snapshot"]["messages"] | ConfirmedTranscript["messages"] } | null = null;
  private loadedAnchorRecord: ConfirmedTranscript | null = null;
  constructor(readonly route: CacheRoute, private readonly ownsRoute: () => boolean, private readonly cache: Cache = sessionTranscriptCache) {}
  current = () => !this.closed && this.ownsRoute();
  async load(server?: KCoderServer): Promise<CachedSession | null> {
    if (!this.current()) return null;
    if (server && this.route.cwd) return (await this.loadWithVersion(server))?.value ?? null;
    const last = await (this.cache === sessionTranscriptCache ? loadLastSessionTranscript(this.route.profile, this.current) : this.cache.last(this.route.profile, this.current));
    if (!this.current()) return null;
    let value = last && cachedSessionMatches(last, this.route, server) ? last : null;
    if (!value && server && this.route.cwd) {
      const scope = captureSessionTranscriptScope(this.route.profile, server, this.route.cwd, this.route.threadId);
      const lease = await this.cache.capture(scope, this.current);
      value = await this.cache.load(lease);
      if (value && this.cache === sessionTranscriptCache) {
        const { isSessionTranscriptDeletionPending } = await import("@/storage/thread-deletion-cleanup");
        if (await isSessionTranscriptDeletionPending(scope)) value = null;
      }
    }
    if (!this.current()) return null;
    await this.acceptLoaded(value);
    if (!this.current()) return null;
    return value;
  }
  async loadWithVersion(server?: KCoderServer): Promise<LoadedCachedSession | null> {
    if (!this.current()) return null;
    if (!server || !this.route.cwd) {
      const value = await this.load(server);
      return value ? { value, version: null } : null;
    }
    const scope = captureSessionTranscriptScope(this.route.profile, server, this.route.cwd, this.route.threadId);
    const lease = await this.cache.capture(scope, this.current);
    const loaded = await this.cache.loadVersioned(lease);
    if (!this.current()) return null;
    let value = loaded && cachedSessionMatches(loaded.value, this.route, server) ? loaded.value : null;
    let version = value ? loaded!.version : null;
    if (value && this.cache === sessionTranscriptCache) {
      const { isSessionTranscriptDeletionPending } = await import("@/storage/thread-deletion-cleanup");
      if (await isSessionTranscriptDeletionPending(scope)) { value = null; version = null; }
    }
    if (!this.current()) return null;
    await this.acceptLoaded(value, lease);
    if (!this.current()) return null;
    return value ? { value, version } : null;
  }
  private async acceptLoaded(value: CachedSession | null, lease?: SessionTranscriptLease): Promise<void> {
    if (value && !this.anchorTouched) {
      this.anchor = value.record.anchor;
      this.anchorBinding = null;
      this.loadedAnchorRecord = value.record;
    }
    if (value && !this.authoritative) {
      if (this.current() && !this.authoritative) {
        // last() has no atomic read lease. It remains readable but cannot renew an anchor publisher.
        this.lease = lease ?? null; this.record = value.record; this.recordAuthority = null;
        this.flushPendingAnchorWrite();
      }
    }
  }
  /** Confirms only the current route's bound server absence; it never authorizes storage deletion. */
  matchesConfirmedAbsentRoute(observation: ThreadPresenceObservation, server?: KCoderServer): boolean {
    if (!server || !this.route.cwd || !observation.scope || !this.current() || this.authoritative ||
        observation.result.status !== "absent" || observation.result.reason !== "boundDeletedPrimarySource" ||
        observation.result.threadId !== this.route.threadId || observation.scope.threadId !== this.route.threadId ||
        server.id !== this.route.serverId) return false;
    try {
      const expectedScope = captureSessionTranscriptScope(this.route.profile, server, this.route.cwd, this.route.threadId);
      return sessionTranscriptScopeKey(expectedScope) === sessionTranscriptScopeKey(observation.scope);
    } catch { return false; }
  }
  /** Stops cache-only publication for a route-bound absence without claiming a storage delete. */
  suppressCacheOnlyWritesForConfirmedAbsent(observation: ThreadPresenceObservation, server?: KCoderServer): boolean {
    if (observation.version || !this.matchesConfirmedAbsentRoute(observation, server)) return false;
    this.blockCacheOnlyWrites();
    return true;
  }
  async revokeConfirmedAbsent(observation: ThreadPresenceObservation, server?: KCoderServer,
    getCurrentServer: () => KCoderServer | undefined = () => server): Promise<boolean | "persistence-failed"> {
    if (!observation.version || !observation.scope || !this.matchesConfirmedAbsentRoute(observation, server)) return false;
    // Live Runtime authority and this advisory delete share a scope but not intent.
    // Once watch() starts, a queued absence CAS must lose before it can publish.
    const revokeCurrent = () => this.matchesConfirmedAbsentRoute(observation, getCurrentServer());
    let lease: SessionTranscriptLease;
    try { lease = await this.cache.capture(observation.scope, revokeCurrent); }
    catch {
      if (!revokeCurrent()) return false;
      this.blockCacheOnlyWrites();
      return "persistence-failed";
    }
    if (!revokeCurrent()) return false;
    let revoked = false;
    try { revoked = await this.cache.invalidateThreadIfVersion(lease, observation.version); }
    catch {
      if (!revokeCurrent()) return false;
      this.blockCacheOnlyWrites();
      return "persistence-failed";
    }
    if (!revoked || !revokeCurrent()) return false;
    if (this.anchorTimer) clearTimeout(this.anchorTimer);
    this.anchorTimer = undefined;
    this.anchorWriteRequested = false;
    this.anchorWritePending = false;
    this.anchor = undefined;
    this.anchorBinding = null;
    this.loadedAnchorRecord = null;
    this.lease = null;
    this.record = null;
    this.recordAuthority = null;
    return true;
  }
  matchesConfirmedWorkspaceAbsentRoute(observation: WorkspacePresenceObservation, server?: KCoderServer): boolean {
    if (!server || !this.route.cwd || !this.current() || this.authoritative ||
        observation.result.status !== "absent" || observation.result.version !== 1 ||
        !server.observationTargetIdentity || observation.result.targetSignature !== server.observationTargetIdentity ||
        observation.result.targetId !== this.route.serverId || server.id !== this.route.serverId ||
        observation.result.workspacePath !== workspaceObservationPath(this.route.cwd)) return false;
    try {
      if (!observation.isCurrent()) return false;
      const expected = captureSessionTranscriptScope(this.route.profile, server, this.route.cwd, this.route.threadId);
      const key = sessionTranscriptScopeKey(expected);
      return key === sessionTranscriptScopeKey(observation.scope) && (!observation.witness ||
        (observation.witness.lease.isCurrent() && key === sessionTranscriptScopeKey(observation.witness.lease.scope)));
    } catch { return false; }
  }
  async revokeConfirmedWorkspaceAbsent(observation: WorkspacePresenceObservation, server?: KCoderServer,
    getCurrentServer: () => KCoderServer | undefined = () => server): Promise<boolean | "persistence-failed"> {
    const revokeCurrent = () => this.matchesConfirmedWorkspaceAbsentRoute(observation, getCurrentServer());
    if (!revokeCurrent()) return false;
    if (!observation.witness) {
      this.blockCacheOnlyWrites();
      return "persistence-failed";
    }
    const witness = observation.witness;
    // Keep the original prefix revision. A peer workspace save does not renew this witness.
    const lease = { ...witness.lease, isCurrent: () => witness.lease.isCurrent() && revokeCurrent() };
    let revoked: boolean;
    try { revoked = await this.cache.invalidateWorkspaceIfVersion(lease, witness.version); }
    catch (error) {
      if (!revokeCurrent() || error instanceof WorkspaceProfileFenceError) return false;
      this.blockCacheOnlyWrites();
      return "persistence-failed";
    }
    if (!revoked || !revokeCurrent()) return false;
    this.blockCacheOnlyWrites();
    this.anchor = undefined; this.anchorBinding = null; this.loadedAnchorRecord = null;
    this.lease = null; this.record = null; this.recordAuthority = null;
    return true;
  }
  readAnchor = (anchor: TranscriptReadAnchor, userDecision = false) => {
    if (!this.current()) return;
    this.anchorTouched ||= userDecision;
    this.anchor = anchor;
    this.anchorBinding = { runtime: this.watchedRuntime, authority: this.watchedRuntime?.confirmedTranscriptPage ?? null,
      generation: this.watchGeneration, rows: this.watchedRuntime?.getSnapshot().messages ?? this.record?.messages ?? [] };
    this.loadedAnchorRecord = null;
    if (userDecision && anchor.followsLatest && this.watchedRuntime) {
      const runtime = this.watchedRuntime, generation = this.watchGeneration;
      runtime.applyDeferredConfirmedTranscriptPage(() => this.current() && generation === this.watchGeneration &&
        this.watchedRuntime === runtime && !runtime.disposed && runtime.getSnapshot().threadId === this.route.threadId);
      if (!this.current()) return;
    }
    if (this.anchorTimer) clearTimeout(this.anchorTimer);
    this.anchorTimer = setTimeout(() => {
      this.anchorTimer = undefined;
      this.requestAnchorWrite();
    }, 250);
  };

  private blockCacheOnlyWrites() {
    this.cacheOnlyWritesBlocked = true;
    if (this.anchorTimer) clearTimeout(this.anchorTimer);
    this.anchorTimer = undefined;
    this.anchorWriteRequested = false;
    this.anchorWritePending = false;
  }

  private flushPendingAnchorWrite() {
    if (this.anchorWriteRequested) this.requestAnchorWrite();
  }

  private requestAnchorWrite() {
    if (this.cacheOnlyWritesBlocked) { this.anchorWriteRequested = false; return; }
    this.anchorWriteRequested = true;
    const binding = this.anchorBinding;
    if (!this.current() || !binding || !this.bindingCurrent(binding) || (binding.runtime && !binding.authority)) {
      this.anchorWriteRequested = false;
      return;
    }
    if (!this.record || this.recordAuthority !== binding.authority) return;
    this.anchorWriteRequested = false;
    if (this.anchorWriteFlight) {
      this.anchorWritePending = true;
      return;
    }
    const flight = (async () => {
      do {
        this.anchorWritePending = false;
        try { await this.persistAnchorSnapshot(); } catch { /* A later marker or authority can retry. */ }
      } while (this.anchorWritePending);
    })();
    this.anchorWriteFlight = flight;
    void flight.finally(() => {
      if (this.anchorWriteFlight === flight) this.anchorWriteFlight = null;
      if (this.anchorWritePending) {
        this.anchorWritePending = false;
        this.anchorWriteRequested = true;
      }
      if (this.anchorWriteRequested) this.requestAnchorWrite();
    }).catch(() => {});
  }

  private async persistAnchorSnapshot() {
    const record = this.record, binding = this.anchorBinding;
    if (this.cacheOnlyWritesBlocked || !record || !this.current() || !binding || (binding.runtime && !binding.authority) ||
        !this.bindingCurrent(binding) || this.recordAuthority !== binding.authority) return;
    const { anchor: _oldAnchor, ...body } = record;
    const canonical = this.confirmedAnchor(record, binding.authority);
    const ownsAuthority = () => !this.cacheOnlyWritesBlocked && this.current() && this.bindingCurrent(binding) && this.record === record &&
      this.recordAuthority === binding.authority;
    // A marker change is not an owner change: finish this write, then coalesce the latest marker.
    // Route, Runtime, authority-page, and lease checks still fence every storage commit.
    const lease = binding.runtime
      ? await captureRuntimeTranscriptLease(binding.runtime, record.scope, ownsAuthority, this.cache, this.watchedServer)
      : this.lease;
    if (!lease || !ownsAuthority()) return;
    const isCurrent = () => lease.isCurrent() && ownsAuthority();
    await this.cache.save({ ...lease, isCurrent }, { ...body, ...(canonical ? { anchor: canonical } : {}) }, true);
    if (isCurrent() && !binding.runtime) this.lease = lease;
  }

  private bindingCurrent(binding: NonNullable<SessionCacheCoordinator["anchorBinding"]>): boolean {
    return binding.generation === this.watchGeneration && binding.runtime === this.watchedRuntime &&
      (!binding.runtime || (!binding.runtime.disposed && binding.runtime.getSnapshot().threadId === this.route.threadId && binding.runtime.confirmedTranscriptPage === binding.authority));
  }
  private confirmedAnchor(record: ConfirmedTranscript, authority: TaskRuntime["confirmedTranscriptPage"]): TranscriptReadAnchor | undefined {
    if (!this.anchor || (this.watchedRuntime && !authority)) return undefined;
    const rows = authority?.page.messages ?? record.messages;
    if (!this.anchorBinding) {
      // A loaded canonical marker may survive only by its exact history ID.
      return displayedSessionAnchor(this.anchor, record.messages, rows, this.loadedAnchorRecord?.messages ?? record.messages);
    }
    if (!this.bindingCurrent(this.anchorBinding) || this.anchorBinding.authority !== authority) return undefined;
    const original = confirmedSessionAnchor(this.anchor, this.anchorBinding.rows, rows, record.messages);
    const latest = confirmedSessionAnchor(this.anchor, this.watchedRuntime?.getSnapshot().messages ?? record.messages, rows, record.messages);
    return original && latest?.messageId === original.messageId ? latest : undefined;
  }
  displayAnchor(runtime: TaskRuntime | null): TranscriptReadAnchor | undefined {
    if (!this.anchor || !this.current()) return undefined;
    if (runtime && (runtime.disposed || runtime.getSnapshot().threadId !== this.route.threadId)) return undefined;
    if (this.anchorBinding) {
      if (this.bindingCurrent(this.anchorBinding) && this.anchorBinding.runtime === runtime) return this.anchor;
      // The first live render precedes its watch effect. Translate a verified cache-only marker now.
      if (!this.anchorBinding.runtime && this.bindingCurrent(this.anchorBinding) && this.record && !this.recordAuthority && runtime?.confirmedTranscriptPage) {
        const canonical = this.confirmedAnchor(this.record, null);
        if (canonical) return displayedSessionAnchor(canonical, runtime.getSnapshot().messages,
          runtime.confirmedTranscriptPage.page.messages ?? [], this.record.messages);
      }
      return undefined;
    }
    const retained = this.loadedAnchorRecord ?? this.record;
    if (!retained) return undefined;
    if (!runtime) return displayedSessionAnchor(this.anchor, retained.messages, retained.messages, retained.messages);
    const authority = runtime.confirmedTranscriptPage;
    const mapped = authority && displayedSessionAnchor(this.anchor, runtime.getSnapshot().messages, authority.page.messages ?? [], retained.messages);
    // Missing/cropped source keeps only in-memory reading intent, not a precise restored position.
    return mapped || (!this.anchor.followsLatest && !runtime.getSnapshot().messages.some(row => row.id === this.anchor!.messageId) ? this.anchor : undefined);
  }
  watch(runtime: TaskRuntime, server: KCoderServer): () => void {
    // Retain canonical cache identity across the cache-only -> live ownership transition.
    // Never carry a previous Runtime's display binding into a new generation.
    if (this.current() && this.anchorBinding && !this.anchorBinding.runtime && this.bindingCurrent(this.anchorBinding) && this.record && !this.recordAuthority) {
      const canonical = this.confirmedAnchor(this.record, null);
      if (canonical) { this.anchor = canonical; this.loadedAnchorRecord = this.record; this.anchorBinding = null; }
    }
    this.unsubscribe?.();
    this.anchorWriteRequested = false;
    this.anchorWritePending = false;
    const generation = ++this.watchGeneration;
    this.cacheOnlyWritesBlocked = false;
    this.watchedRuntime = runtime;
    this.watchedServer = server;
    this.authoritative = true;
    let reading = false;
    let savedPage: unknown;
    let savingPage: unknown;
    let savedRevision = -1;
    const current = () => generation === this.watchGeneration && this.current() && !runtime.disposed && runtime.getSnapshot().threadId === this.route.threadId;
    const saveAuthority = async () => {
      const authority = runtime.confirmedTranscriptPage;
      if (!authority || authority === savedPage || authority === savingPage || !current()) return;
      savingPage = authority;
      try {
        const snapshot = runtime.getSnapshot();
        const scope = captureSessionTranscriptScope(this.route.profile, server, snapshot.cwd, snapshot.threadId);
        if (this.route.cwd && scope.cwd !== workspaceThreadScopeIdentity(this.route.cwd)) return;
        const authorityCurrent = () => current() && runtime.confirmedTranscriptPage === authority;
        const lease = await captureRuntimeTranscriptLease(runtime, scope, authorityCurrent, this.cache, server);
        if (!lease || !authorityCurrent()) return;
        const record = projectConfirmedTranscript(scope, authority.page, { title: snapshot.title,
          updatedAt: authority.confirmedAt, activeTurnId: snapshot.activeTurnId });
        const canonical = this.confirmedAnchor(record, authority);
        if (canonical) record.anchor = canonical;
        // A confirmed empty projection replaces older rows; it is not thread deletion authority.
        await this.cache.save(lease, record, true);
        if (authorityCurrent()) {
          savedPage = authority;
          this.lease = lease; this.record = record; this.recordAuthority = authority;
          this.flushPendingAnchorWrite();
        }
      } finally { if (savingPage === authority) savingPage = undefined; }
    };
    const observe = () => {
      if (!current()) return;
      void saveAuthority().catch(() => {});
      const revision = runtime.completedTranscriptRevision;
      if (revision <= runtime.confirmedTranscriptRevision || revision === savedRevision || reading) return;
      reading = true;
      // Distinct accepted terminal notification, including buffered completion before UI mount.
      // Initial idle/disconnect never enters this path; resume's inline page needs no extra RPC.
      let pending = this.terminalRead;
      if (!pending || pending.runtime !== runtime) {
        const routeCurrent = () => this.current() && !runtime.disposed && runtime.getSnapshot().threadId === this.route.threadId;
        const mayReconcileUi = (page: ThreadReadPage) => {
          if (!this.current() || generation !== this.watchGeneration || this.watchedRuntime !== runtime) return false;
          const snapshot = runtime.getSnapshot();
          if (transcriptReadIdentityMatches(snapshot, page)) return true;
          const marker = this.displayAnchor(runtime) ?? this.anchor;
          if (!marker || marker.followsLatest) return true;
          const rows = page.messages ?? [];
          const mapped = confirmedSessionAnchor(marker, snapshot.messages, rows, rows);
          // Geometry restores the displayed row ID; a canonical replacement waits for latest.
          return mapped?.messageId === marker.messageId;
        };
        pending = { runtime, revision, promise: runtime.readConfirmedTranscriptPage(routeCurrent, mayReconcileUi) };
        this.terminalRead = pending;
        const captured = pending;
        void pending.promise.finally(() => { if (this.terminalRead === captured) this.terminalRead = null; }).catch(() => {});
      }
      savedRevision = pending.revision;
      void pending.promise.then(() => saveAuthority()).catch(() => {}).finally(() => {
        reading = false;
        if (current() && runtime.completedTranscriptRevision > savedRevision) observe();
      });
    };
    this.unsubscribe = runtime.subscribe(observe);
    observe();
    return () => {
      if (generation === this.watchGeneration) {
        this.watchGeneration++; this.unsubscribe?.(); this.watchedRuntime = null;
        this.recordAuthority = null; this.lease = null;
        this.anchorWriteRequested = false;
        this.anchorWritePending = false;
      }
    };
  }
  close() {
    this.closed = true;
    this.unsubscribe?.();
    if (this.anchorTimer) clearTimeout(this.anchorTimer);
    this.anchorWriteRequested = false;
    this.anchorWritePending = false;
  }
}
