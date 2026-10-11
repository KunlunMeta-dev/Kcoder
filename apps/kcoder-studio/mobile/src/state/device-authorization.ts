import { withLocalIdentityLock } from "@/storage/context-lock";
import { GatewaySessionExpiredError, refreshMobileSession } from "@/gateway/http";
import type { GatewayProfile } from "@/gateway/types";
import { profileAuthorizationScopeKey } from "./profile-coordinator";

export const deviceRefreshLead = (profile: GatewayProfile) => Math.min(60_000, Math.max(25, (profile.accessTtlMs ?? 180_000) / 3));

/** Durable rotation intent precedes the request; successful secret commit precedes publication. */
export class DeviceAuthorizationManager {
  private readonly pending = new Map<string, { promise: Promise<void>; callers: Set<GatewayProfile> }>();
  private readonly failures = new Map<string, { retryAt: number; count: number; error: unknown }>();
  constructor(private readonly getProfile: (id: string) => GatewayProfile | undefined,
    private readonly commit: (expected: GatewayProfile, next: GatewayProfile) => Promise<GatewayProfile | null>,
    private readonly changed: () => void,
    private readonly renew = refreshMobileSession,
    private readonly rotationId = () => `rotation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,
    private readonly synchronize?: () => Promise<void>) {}

  nextAttemptAt(profile: GatewayProfile): number { return this.failures.get(profileAuthorizationScopeKey(profile))?.retryAt ?? 0; }
  authorize(profile: GatewayProfile, force = false): Promise<void> {
    const scope = profileAuthorizationScopeKey(profile);
    const active = this.pending.get(scope);
    if (active) {
      active.callers.add(profile); return active.promise;
    }
    const failure = this.failures.get(scope);
    if (!force && failure && failure.retryAt > Date.now()) return Promise.reject(failure.error);
    const callers = new Set([profile]);
    const execute = () => this.rotate(profile, force, scope);
    const operation = (profile.authMode === "device" ? withLocalIdentityLock(`device-authorization:${JSON.stringify([profile.baseUrl, profile.deviceId, profile.authorizationGeneration])}`, execute) : execute()).then(() => {
      const current = this.getProfile(profile.id);
      if (!current || profileAuthorizationScopeKey(current) !== scope) throw new GatewaySessionExpiredError();
      for (const caller of callers) Object.assign(caller, current);
      this.failures.delete(scope);
    }).catch(error => {
      const current = this.getProfile(profile.id);
      if (!current || profileAuthorizationScopeKey(current) !== scope) {
        this.failures.delete(scope);
        throw error;
      }
      const count = (this.failures.get(scope)?.count ?? 0) + 1;
      this.failures.set(scope, { count, retryAt: Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(count - 1, 5)), error });
      throw error;
    });
    this.pending.set(scope, { promise: operation, callers });
    const finish = () => { if (this.pending.get(scope)?.promise === operation) this.pending.delete(scope); };
    void operation.then(finish, finish);
    return operation;
  }
  private async rotate(input: GatewayProfile, force: boolean, scope: string): Promise<void> {
    const assertScope = () => {
      const current = this.getProfile(input.id);
      if (!current || profileAuthorizationScopeKey(current) !== scope) throw new GatewaySessionExpiredError();
    };
    const originalAccess = input.accessToken;
    const originalRefresh = input.refreshToken;
    await this.synchronize?.();
    let profile = this.getProfile(input.id);
    if (!profile || profileAuthorizationScopeKey(profile) !== scope) throw new GatewaySessionExpiredError();
    if (!profile.refreshToken || profile.authMode !== "device") {
      if (profile.expiresAt <= Date.now()) throw new GatewaySessionExpiredError();
      return;
    }
    if ((profile.refreshExpiresAt ?? 0) <= Date.now()) throw new GatewaySessionExpiredError();
    const synchronizedWinner = profile.accessToken !== originalAccess || profile.refreshToken !== originalRefresh;
    if ((!force || synchronizedWinner) && !profile.pendingRotationId && profile.expiresAt > Date.now() + deviceRefreshLead(profile)) { Object.assign(input, profile); return; }
    // A recovered rotation can return an already-expired access grant. Commit
    // its recovered refresh secret first, then rotate once more with a new ID.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!profile.pendingRotationId) {
        const staged = await this.commit({ ...profile }, { ...profile, pendingRotationId: this.rotationId() });
        if (!staged) throw new GatewaySessionExpiredError();
        profile = staged;
      }
      assertScope();
      const expected = { ...profile };
      const renewed = await this.renew(expected, expected.pendingRotationId!);
      assertScope();
      const committed = await this.commit(expected, renewed);
      if (!committed) throw new GatewaySessionExpiredError();
      assertScope();
      profile = committed; Object.assign(input, committed); this.changed();
      if (committed.expiresAt > Date.now()) return;
    }
    throw new GatewaySessionExpiredError();
  }
}
