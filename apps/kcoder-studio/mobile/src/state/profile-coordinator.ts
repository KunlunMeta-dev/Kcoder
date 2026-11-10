import type { MetadataAuthority } from "@/storage/metadata-authority";
import type { GatewayAuthorizationDenialWitness, GatewayProfile } from "@/gateway/types";

export interface ProfileSnapshot {
  profiles: GatewayProfile[];
  activeId: string | null;
}

export interface ConnectionCommitResult {
  snapshot: ProfileSnapshot;
  /** True only when this call persisted its profile snapshot. */
  committed: boolean;
  /** True when this connection intent selected its profile as active. */
  activated: boolean;
}

export interface ProfileRemovalIntent {
  profileId: string;
  baseUrl: string | null;
  intent: number;
  authorizationGeneration?: string;
}

export interface ProfileRemovalResult {
  snapshot: ProfileSnapshot;
  removed: boolean;
  wasActive: boolean;
}

type PersistProfiles = (profiles: GatewayProfile[], activeId: string | null, authority?: MetadataAuthority) => Promise<void>;
export type ProfileCredentialUpdateIntent = "routine" | "rotation-stage" | "validated-refresh";

/** Stable through short access rotation; changes when authorization/route is replaced. */
export function profileAuthorizationScopeKey(profile: GatewayProfile): string {
  return JSON.stringify([profile.id, profile.baseUrl, profile.authMode ?? "legacy", profile.authorizationGeneration, profile.deviceId]);
}

export class ProfileOperationGate {
  private readonly pending = new Map<string, Promise<void>>();

  run(id: string, activate: () => Promise<void>): Promise<void> {
    const existing = this.pending.get(id);
    if (existing) return existing;
    const operation = activate();
    this.pending.set(id, operation);
    const clear = () => {
      if (this.pending.get(id) === operation) this.pending.delete(id);
    };
    void operation.then(clear, clear);
    return operation;
  }
}

export class ProfileCoordinator {
  constructor(private readonly storage?: { reload(authority?: MetadataAuthority): Promise<ProfileSnapshot>; serialize<T>(operation: (authority?: MetadataAuthority) => Promise<T>): Promise<T> }) {}
  private snapshot: ProfileSnapshot = { profiles: [], activeId: null };
  private hydrationRevision = 0;
  private latestConnectionIntent = 0;
  private connectionIntentByBaseUrl = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private readonly provisionalDenials = new Map<string, GatewayAuthorizationDenialWitness[]>();

  hydrate(snapshot: ProfileSnapshot): void {
    this.hydrationRevision += 1;
    this.snapshot = { profiles: [...snapshot.profiles], activeId: snapshot.activeId };
    this.connectionIntentByBaseUrl.clear();
  }

  isActive(id: string): boolean {
    return this.snapshot.activeId === id;
  }

  getSnapshot(): ProfileSnapshot {
    return this.copySnapshot();
  }

  /** Exact in-memory grant check paired with the non-secret persisted scope marker. */
  isAuthorizationDenied(profile: GatewayProfile): boolean {
    if (profile.reauthorizationRequiredScope === profileAuthorizationScopeKey(profile)) return true;
    return (this.provisionalDenials.get(profile.id) ?? []).some(witness => denialWitnessMatchesProfile(witness, profile));
  }

  isCurrentGrant(profile: GatewayProfile): boolean {
    const current = this.snapshot.profiles.find(candidate => candidate.id === profile.id);
    return Boolean(current && profileAuthorizationScopeKey(current) === profileAuthorizationScopeKey(profile) &&
      current.accessToken === profile.accessToken && current.refreshToken === profile.refreshToken);
  }

  isCurrentAuthorizationDenial(witness: GatewayAuthorizationDenialWitness): boolean {
    const current = this.snapshot.profiles.find(profile => profile.id === witness.profileId);
    return Boolean(current && denialWitnessMatchesProfile(witness, current) && this.isAuthorizationDenied(current));
  }

  /** Fences the exact failed grant in this realm, then stores only its non-secret scope marker. */
  recordAuthorizationDenial(witness: GatewayAuthorizationDenialWitness, persist: PersistProfiles): Promise<boolean> {
    const local = this.snapshot.profiles.find(profile => profile.id === witness.profileId);
    if (!local || !denialWitnessMatchesProfile(witness, local)) return Promise.resolve(false);
    this.addProvisionalDenial(witness);
    // Publish the non-secret scope marker on the retained profile object before
    // waiting for the index lock. Cache leases read this object dynamically, so
    // a held persistence write cannot leave an in-flight local save authorized.
    local.reauthorizationRequiredScope = profileAuthorizationScopeKey(local);

    return this.enqueue(async authority => {
      const current = this.snapshot.profiles.find(profile => profile.id === witness.profileId);
      if (!current || !denialWitnessMatchesProfile(witness, current)) {
        this.removeProvisionalDenial(witness);
        return false;
      }
      const updated = { ...current, reauthorizationRequiredScope: profileAuthorizationScopeKey(current) };
      const profiles = this.snapshot.profiles.map(profile => profile === current ? updated : profile);
      await persist(profiles, this.snapshot.activeId, authority);
      authority?.assert();
      Object.assign(current, updated);
      this.snapshot = { profiles: this.snapshot.profiles, activeId: this.snapshot.activeId };
      return this.isAuthorizationDenied(current);
    }).catch(() => {
      // Keep this exact grant blocked locally if persistence fails. The
      // provisional evidence is not promised to another realm or a reload.
      const current = this.snapshot.profiles.find(profile => profile.id === witness.profileId);
      return Boolean(current && this.isAuthorizationDenied(current) && denialWitnessMatchesProfile(witness, current));
    });
  }

  beginConnection(): number {
    this.latestConnectionIntent += 1;
    return this.latestConnectionIntent;
  }

  isLatestConnectionIntent(intent: number): boolean {
    return intent === this.latestConnectionIntent;
  }

  cancelConnectionIntent(intent: number): boolean {
    if (!this.isLatestConnectionIntent(intent)) return false;
    this.latestConnectionIntent += 1;
    return true;
  }

  invalidateConnections(): void {
    this.latestConnectionIntent += 1;
  }

  commitConnection(
    intent: number,
    profile: GatewayProfile,
    persist: PersistProfiles,
    signal?: AbortSignal,
    onCommit?: (result: ConnectionCommitResult) => void,
  ): Promise<ConnectionCommitResult> {
    return this.enqueue(async authority => {
      if (signal?.aborted)
        return { snapshot: this.copySnapshot(), committed: false, activated: false };
      const latestForBaseUrl = this.connectionIntentByBaseUrl.get(profile.baseUrl) ?? 0;
      if (intent <= latestForBaseUrl) {
        return { snapshot: this.copySnapshot(), committed: false, activated: false };
      }
      const existing = this.snapshot.profiles.find((item) => item.baseUrl === profile.baseUrl);
      const committedProfile = existing ? { ...profile, id: existing.id } : profile;
      delete committedProfile.reauthorizationRequiredScope;
      const profiles = [
        ...this.snapshot.profiles.filter((item) => item.baseUrl !== profile.baseUrl),
        committedProfile,
      ];
      const activated = intent === this.latestConnectionIntent;
      const requestedActiveId = activated ? committedProfile.id : this.snapshot.activeId;
      const activeId = requestedActiveId === null
        ? null
        : profiles.some((item) => item.id === requestedActiveId)
          ? requestedActiveId
          : committedProfile.id;
      await persist(profiles, activeId, authority);
      authority?.assert();
      if (signal?.aborted) {
        await persist(this.snapshot.profiles, this.snapshot.activeId, authority);
      authority?.assert();
        return { snapshot: this.copySnapshot(), committed: false, activated: false };
      }
      // Removal or a newer same-host intent can begin while persistence is
      // pending. Repair the just-written snapshot before publishing stale state.
      const removalCutoff = this.connectionIntentByBaseUrl.get(profile.baseUrl) ?? 0;
      if (intent <= removalCutoff) {
        await persist(this.snapshot.profiles, this.snapshot.activeId, authority);
      authority?.assert();
        return { snapshot: this.copySnapshot(), committed: false, activated: false };
      }

      let committedActiveId = activeId;
      let committedActivation = activated;
      if (activated && !this.isLatestConnectionIntent(intent)) {
        committedActiveId = profiles.some((item) => item.id === this.snapshot.activeId)
          ? this.snapshot.activeId
          : null;
        if (committedActiveId !== activeId)
          await persist(profiles, committedActiveId, authority);
      authority?.assert();
        committedActivation = false;
      }

      // A removal may also begin during the corrective write.
      if (signal?.aborted) {
        await persist(this.snapshot.profiles, this.snapshot.activeId, authority);
      authority?.assert();
        return { snapshot: this.copySnapshot(), committed: false, activated: false };
      }
      if (intent <= (this.connectionIntentByBaseUrl.get(profile.baseUrl) ?? 0)) {
        await persist(this.snapshot.profiles, this.snapshot.activeId, authority);
      authority?.assert();
        return { snapshot: this.copySnapshot(), committed: false, activated: false };
      }
      this.connectionIntentByBaseUrl.set(profile.baseUrl, intent);
      this.snapshot = { profiles, activeId: committedActiveId };
      this.provisionalDenials.delete(committedProfile.id);
      const result = {
        snapshot: this.copySnapshot(),
        committed: true,
        activated: committedActivation,
      };
      // The caller applies React/runtime effects synchronously at the commit
      // boundary, before another connection intent can supersede this snapshot.
      onCommit?.(result);
      return result;
    });
  }

  updateCredentials(
    expected: GatewayProfile,
    next: GatewayProfile,
    persist: PersistProfiles,
    intent: ProfileCredentialUpdateIntent = "routine",
  ): Promise<GatewayProfile | null> {
    return this.enqueue(async authority => {
      const current = this.snapshot.profiles.find(profile => profile.id === expected.id);
      if (!current || profileAuthorizationScopeKey(current) !== profileAuthorizationScopeKey(expected) ||
          profileAuthorizationScopeKey({ ...next, id: current.id }) !== profileAuthorizationScopeKey(expected) ||
          (current.accessToken !== expected.accessToken || current.refreshToken !== expected.refreshToken) &&
            !(intent === "validated-refresh" && current.accessToken === next.accessToken && current.refreshToken === next.refreshToken && !current.pendingRotationId)) return null;
      if (intent === "validated-refresh" && current.accessToken === next.accessToken && current.refreshToken === next.refreshToken && !current.pendingRotationId) return current;
      // A peer may already own the durable rotation. Reuse its canonical request,
      // never replace it while the original tokens still identify that rotation.
      if (intent === "rotation-stage" && current.pendingRotationId) return current;
      if (current.pendingRotationId !== expected.pendingRotationId) return null;
      const updated = { ...current, ...next, id: current.id };
      if (intent === "validated-refresh") {
        delete updated.reauthorizationRequiredScope;
      } else if (current.reauthorizationRequiredScope !== undefined) {
        // A stale stage or ordinary write cannot erase a denial committed by a peer.
        updated.reauthorizationRequiredScope = current.reauthorizationRequiredScope;
      } else {
        const deniedByLocalWitness = (this.provisionalDenials.get(current.id) ?? [])
          .some(witness => denialWitnessMatchesProfile(witness, current));
        if (deniedByLocalWitness) updated.reauthorizationRequiredScope = profileAuthorizationScopeKey(current);
        else delete updated.reauthorizationRequiredScope;
      }
      const profiles = this.snapshot.profiles.map(profile => profile.id === current.id ? updated : profile);
      await persist(profiles, this.snapshot.activeId, authority);
      authority?.assert();
      // Existing runtime reconnect contexts retain this object; routine token
      // rotation must update credentials without closing their active sockets.
      Object.assign(current, updated);
      if (intent === "validated-refresh") delete current.reauthorizationRequiredScope;
      this.snapshot = { profiles: this.snapshot.profiles, activeId: this.snapshot.activeId };
      if (intent === "validated-refresh") this.provisionalDenials.delete(current.id);
      return current;
    });
  }

  activate(id: string, persist: PersistProfiles): Promise<ProfileSnapshot> {
    this.invalidateConnections();
    return this.enqueue(async authority => {
      if (!this.snapshot.profiles.some((profile) => profile.id === id)) return this.copySnapshot();
      await persist(this.snapshot.profiles, id, authority);
      authority?.assert();
      this.snapshot = { profiles: this.snapshot.profiles, activeId: id };
      return this.copySnapshot();
    });
  }

  beginRemoval(profileId: string): ProfileRemovalIntent {
    const profile = this.snapshot.profiles.find((item) => item.id === profileId);
    const intent = ++this.latestConnectionIntent;
    if (profile) this.connectionIntentByBaseUrl.set(profile.baseUrl, intent);
    return { profileId, baseUrl: profile?.baseUrl ?? null, authorizationGeneration: profile?.authorizationGeneration, intent };
  }

  remove(
    removal: ProfileRemovalIntent,
    persist: PersistProfiles,
    onRemove?: (result: ProfileRemovalResult) => void,
    beforeRemovalPersist?: (profile: GatewayProfile, authority?: MetadataAuthority) => Promise<void>,
  ): Promise<ProfileRemovalResult> {
    return this.enqueue(async authority => {
      const profile = this.snapshot.profiles.find((item) => item.id === removal.profileId);
      if (!profile || profile.baseUrl !== removal.baseUrl || profile.authorizationGeneration !== removal.authorizationGeneration) return { snapshot: this.copySnapshot(), removed: false, wasActive: false };
      // A deliberate reconnection that committed after this removal began wins.
      if (removal.baseUrl && (this.connectionIntentByBaseUrl.get(removal.baseUrl) ?? 0) > removal.intent) {
        return { snapshot: this.copySnapshot(), removed: false, wasActive: false };
      }
      const wasActive = this.snapshot.activeId === removal.profileId;
      const profiles = this.snapshot.profiles.filter((item) => item.id !== removal.profileId);
      const activeId = this.snapshot.activeId === removal.profileId ? profiles[0]?.id ?? null : this.snapshot.activeId;
      // This callback shares the storage.serialize profile-index gate with send-start.
      // Only bounded local storage work is permitted here, never a remote response.
      await beforeRemovalPersist?.(profile, authority);
      await persist(profiles, activeId, authority);
      authority?.assert();
      this.snapshot = { profiles, activeId };
      this.provisionalDenials.delete(removal.profileId);
      const result = { snapshot: this.copySnapshot(), removed: true, wasActive };
      // Apply caller-owned UI/runtime effects before another queued operation can
      // publish a newer profile snapshot.
      onRemove?.(result);
      return result;
    });
  }

  synchronize(): Promise<ProfileSnapshot> { return this.enqueue(async () => this.copySnapshot()); }

  private async reloadSharedSnapshot(authority?: MetadataAuthority): Promise<void> {
    if (!this.storage) return;
    const hydrationRevision = this.hydrationRevision;
    const stored = await this.storage.reload(authority);
    authority?.assert();
    // Hydration is the only snapshot publication outside this queue. A storage
    // read begun before it cannot replace the newer restored snapshot.
    if (hydrationRevision !== this.hydrationRevision) return;
    const profiles = stored.profiles.map(next => {
      const current = this.snapshot.profiles.find(profile => profileAuthorizationScopeKey(profile) === profileAuthorizationScopeKey(next));
      if (!current) return next;
      Object.assign(current, next);
      // Object.assign leaves optional fields behind when a peer's renewed
      // snapshot omits them. Absence here is the durable clear signal.
      if (next.reauthorizationRequiredScope === undefined) {
        delete current.reauthorizationRequiredScope;
        if ((this.provisionalDenials.get(current.id) ?? []).some(witness => denialWitnessMatchesProfile(witness, current)))
          current.reauthorizationRequiredScope = profileAuthorizationScopeKey(current);
      }
      return current;
    });
    const activeId = profiles.some(profile => profile.id === this.snapshot.activeId) ? this.snapshot.activeId : stored.activeId;
    this.snapshot = { profiles, activeId };
  }

  private copySnapshot(): ProfileSnapshot {
    return { profiles: [...this.snapshot.profiles], activeId: this.snapshot.activeId };
  }

  private addProvisionalDenial(witness: GatewayAuthorizationDenialWitness): void {
    const existing = this.provisionalDenials.get(witness.profileId) ?? [];
    if (existing.some(item => denialWitnessesEqual(item, witness))) return;
    this.provisionalDenials.set(witness.profileId, [...existing.slice(-3), { ...witness }]);
  }

  private removeProvisionalDenial(witness: GatewayAuthorizationDenialWitness): void {
    const existing = this.provisionalDenials.get(witness.profileId);
    if (!existing) return;
    const remaining = existing.filter(item => !denialWitnessesEqual(item, witness));
    if (remaining.length > 0) this.provisionalDenials.set(witness.profileId, remaining);
    else this.provisionalDenials.delete(witness.profileId);
  }

  private enqueue<T>(operation: (authority?: MetadataAuthority) => Promise<T>): Promise<T> {
    const transaction = async (authority?: MetadataAuthority) => { await this.reloadSharedSnapshot(authority); authority?.assert(); return operation(authority); };
    const execute = () => this.storage ? this.storage.serialize(transaction) : transaction();
    const result = this.queue.then(execute, execute);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function denialWitnessesEqual(left: GatewayAuthorizationDenialWitness, right: GatewayAuthorizationDenialWitness): boolean {
  return left.profileId === right.profileId && left.baseUrl === right.baseUrl &&
    (left.authMode ?? "legacy") === (right.authMode ?? "legacy") &&
    left.authorizationGeneration === right.authorizationGeneration && left.deviceId === right.deviceId &&
    left.accessToken === right.accessToken && left.refreshToken === right.refreshToken;
}

function denialWitnessMatchesProfile(witness: GatewayAuthorizationDenialWitness, profile: GatewayProfile): boolean {
  return witness.profileId === profile.id && witness.baseUrl === profile.baseUrl &&
    (witness.authMode ?? "legacy") === (profile.authMode ?? "legacy") &&
    witness.authorizationGeneration === profile.authorizationGeneration && witness.deviceId === profile.deviceId &&
    witness.accessToken === profile.accessToken && witness.refreshToken === profile.refreshToken;
}
