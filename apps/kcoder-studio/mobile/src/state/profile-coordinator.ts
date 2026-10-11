import type { GatewayProfile } from "@/gateway/types";

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

type PersistProfiles = (profiles: GatewayProfile[], activeId: string | null) => Promise<void>;

/** Stable through short access rotation; changes when authorization/route is replaced. */
export function profileAuthorizationScopeKey(profile: GatewayProfile): string {
  return JSON.stringify([profile.id, profile.baseUrl, profile.authorizationGeneration, profile.deviceId]);
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
  constructor(private readonly storage?: { reload(): Promise<ProfileSnapshot>; serialize<T>(operation: () => Promise<T>): Promise<T> }) {}
  private snapshot: ProfileSnapshot = { profiles: [], activeId: null };
  private hydrationRevision = 0;
  private latestConnectionIntent = 0;
  private connectionIntentByBaseUrl = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

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
    return this.enqueue(async () => {
      if (signal?.aborted)
        return { snapshot: this.copySnapshot(), committed: false, activated: false };
      const latestForBaseUrl = this.connectionIntentByBaseUrl.get(profile.baseUrl) ?? 0;
      if (intent <= latestForBaseUrl) {
        return { snapshot: this.copySnapshot(), committed: false, activated: false };
      }
      const existing = this.snapshot.profiles.find((item) => item.baseUrl === profile.baseUrl);
      const committedProfile = existing ? { ...profile, id: existing.id } : profile;
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
      await persist(profiles, activeId);
      if (signal?.aborted) {
        await persist(this.snapshot.profiles, this.snapshot.activeId);
        return { snapshot: this.copySnapshot(), committed: false, activated: false };
      }
      // Removal or a newer same-host intent can begin while persistence is
      // pending. Repair the just-written snapshot before publishing stale state.
      const removalCutoff = this.connectionIntentByBaseUrl.get(profile.baseUrl) ?? 0;
      if (intent <= removalCutoff) {
        await persist(this.snapshot.profiles, this.snapshot.activeId);
        return { snapshot: this.copySnapshot(), committed: false, activated: false };
      }

      let committedActiveId = activeId;
      let committedActivation = activated;
      if (activated && !this.isLatestConnectionIntent(intent)) {
        committedActiveId = profiles.some((item) => item.id === this.snapshot.activeId)
          ? this.snapshot.activeId
          : null;
        if (committedActiveId !== activeId)
          await persist(profiles, committedActiveId);
        committedActivation = false;
      }

      // A removal may also begin during the corrective write.
      if (signal?.aborted) {
        await persist(this.snapshot.profiles, this.snapshot.activeId);
        return { snapshot: this.copySnapshot(), committed: false, activated: false };
      }
      if (intent <= (this.connectionIntentByBaseUrl.get(profile.baseUrl) ?? 0)) {
        await persist(this.snapshot.profiles, this.snapshot.activeId);
        return { snapshot: this.copySnapshot(), committed: false, activated: false };
      }
      this.connectionIntentByBaseUrl.set(profile.baseUrl, intent);
      this.snapshot = { profiles, activeId: committedActiveId };
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

  updateCredentials(expected: GatewayProfile, next: GatewayProfile, persist: PersistProfiles): Promise<GatewayProfile | null> {
    return this.enqueue(async () => {
      const current = this.snapshot.profiles.find(profile => profile.id === expected.id);
      if (!current || current.baseUrl !== expected.baseUrl || current.authorizationGeneration !== expected.authorizationGeneration || current.accessToken !== expected.accessToken || current.refreshToken !== expected.refreshToken) return null;
      const updated = { ...next, id: current.id };
      const profiles = this.snapshot.profiles.map(profile => profile.id === current.id ? updated : profile);
      await persist(profiles, this.snapshot.activeId);
      // Existing runtime reconnect contexts retain this object; routine token
      // rotation must update credentials without closing their active sockets.
      Object.assign(current, updated);
      this.snapshot = { profiles: this.snapshot.profiles, activeId: this.snapshot.activeId };
      return current;
    });
  }

  activate(id: string, persist: PersistProfiles): Promise<ProfileSnapshot> {
    this.invalidateConnections();
    return this.enqueue(async () => {
      if (!this.snapshot.profiles.some((profile) => profile.id === id)) return this.copySnapshot();
      await persist(this.snapshot.profiles, id);
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
    beforeRemovalPersist?: (profile: GatewayProfile) => Promise<void>,
  ): Promise<ProfileRemovalResult> {
    return this.enqueue(async () => {
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
      await beforeRemovalPersist?.(profile);
      await persist(profiles, activeId);
      this.snapshot = { profiles, activeId };
      const result = { snapshot: this.copySnapshot(), removed: true, wasActive };
      // Apply caller-owned UI/runtime effects before another queued operation can
      // publish a newer profile snapshot.
      onRemove?.(result);
      return result;
    });
  }

  synchronize(): Promise<ProfileSnapshot> { return this.enqueue(async () => this.copySnapshot()); }

  private async reloadSharedSnapshot(): Promise<void> {
    if (!this.storage) return;
    const hydrationRevision = this.hydrationRevision;
    const stored = await this.storage.reload();
    // Hydration is the only snapshot publication outside this queue. A storage
    // read begun before it cannot replace the newer restored snapshot.
    if (hydrationRevision !== this.hydrationRevision) return;
    const profiles = stored.profiles.map(next => {
      const current = this.snapshot.profiles.find(profile => profile.id === next.id && profile.baseUrl === next.baseUrl && profile.authorizationGeneration === next.authorizationGeneration);
      if (!current) return next;
      Object.assign(current, next); return current;
    });
    const activeId = profiles.some(profile => profile.id === this.snapshot.activeId) ? this.snapshot.activeId : stored.activeId;
    this.snapshot = { profiles, activeId };
  }

  private copySnapshot(): ProfileSnapshot {
    return { profiles: [...this.snapshot.profiles], activeId: this.snapshot.activeId };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const transaction = async () => { await this.reloadSharedSnapshot(); return operation(); };
    const execute = () => this.storage ? this.storage.serialize(transaction) : transaction();
    const result = this.queue.then(execute, execute);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
