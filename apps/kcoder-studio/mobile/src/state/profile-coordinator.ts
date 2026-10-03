import type { GatewayProfile } from "@/gateway/types";

export interface ProfileSnapshot {
  profiles: GatewayProfile[];
  activeId: string | null;
}

type PersistProfiles = (profiles: GatewayProfile[], activeId: string | null) => Promise<void>;

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
  private snapshot: ProfileSnapshot = { profiles: [], activeId: null };
  private latestConnectionIntent = 0;
  private committedIntentByBaseUrl = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  hydrate(snapshot: ProfileSnapshot): void {
    this.snapshot = { profiles: [...snapshot.profiles], activeId: snapshot.activeId };
    this.committedIntentByBaseUrl.clear();
  }

  isActive(id: string): boolean {
    return this.snapshot.activeId === id;
  }

  beginConnection(): number {
    this.latestConnectionIntent += 1;
    return this.latestConnectionIntent;
  }

  invalidateConnections(): void {
    this.latestConnectionIntent += 1;
  }

  commitConnection(intent: number, profile: GatewayProfile, persist: PersistProfiles): Promise<ProfileSnapshot> {
    return this.enqueue(async () => {
      const committedIntent = this.committedIntentByBaseUrl.get(profile.baseUrl) ?? 0;
      if (intent < committedIntent) return this.copySnapshot();
      const existing = this.snapshot.profiles.find((item) => item.baseUrl === profile.baseUrl);
      const committedProfile = existing ? { ...profile, id: existing.id } : profile;
      const profiles = [
        ...this.snapshot.profiles.filter((item) => item.baseUrl !== profile.baseUrl),
        committedProfile,
      ];
      const requestedActiveId = intent === this.latestConnectionIntent ? committedProfile.id : this.snapshot.activeId;
      const activeId = requestedActiveId === null
        ? null
        : profiles.some((item) => item.id === requestedActiveId)
          ? requestedActiveId
          : committedProfile.id;
      await persist(profiles, activeId);
      this.committedIntentByBaseUrl.set(profile.baseUrl, intent);
      this.snapshot = { profiles, activeId };
      return this.copySnapshot();
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

  remove(id: string, persist: PersistProfiles): Promise<ProfileSnapshot> {
    this.invalidateConnections();
    return this.enqueue(async () => {
      const profiles = this.snapshot.profiles.filter((profile) => profile.id !== id);
      const activeId = this.snapshot.activeId === id ? profiles[0]?.id ?? null : this.snapshot.activeId;
      await persist(profiles, activeId);
      this.snapshot = { profiles, activeId };
      return this.copySnapshot();
    });
  }

  private copySnapshot(): ProfileSnapshot {
    return { profiles: [...this.snapshot.profiles], activeId: this.snapshot.activeId };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
