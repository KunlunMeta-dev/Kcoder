import type { TaskRuntime } from "./core";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { workspaceStateAuthorizationScope } from "@/storage/workspace-preferences";
import { interactionServerIdentity, workspaceThreadScopeIdentity } from "@/gateway/target-identity";
import type { InteractionInboxRow, InteractionOwnerBinding, PendingInteraction } from "./types";

export interface TaskCreationRegistration {
  readonly registry: TaskRuntimeRegistry;
  put(profileId: string, serverId: string, runtime: TaskRuntime, onRegistered: () => void): void;
  release(): void;
}

export interface InteractionInboxOverflowDisclosure {
  /** Exact number of observed rows omitted for the requested authorization scope. */
  readonly omittedRows: number;
  /** A bounded realm-wide fallback; some rows may be unavailable when local identity budgets saturate. */
  readonly mayContainUntrackedRows: boolean;
}

interface OmittedInteractionRows {
  readonly readonly: number;
  readonly live: number;
}

export class TaskRuntimeRegistry {
  private readonly runtimes = new Map<string, TaskRuntime>();
  private readonly runtimeOwners = new Map<TaskRuntime, { profileId: string; serverId: string; threadId: string }>();
  private readonly listeners = new Set<() => void>();
  private readonly interactionRows = new Map<string, InteractionInboxRow>();
  private readonly resolvedInteractionKeys = new Set<string>();
  private readonly interactionEpochRequests = new Map<string, Map<string, Set<number>>>();
  private observedInteractionRequestCount = 0;
  private readonly saturatedInteractionScopes = new Set<string>();
  private untrackedInteractionScopesSaturated = false;
  private readonly omittedInteractionRows = new Map<string, OmittedInteractionRows>();
  private mayContainUntrackedOmittedRows = false;
  private readonly maxHotRuntimes = 8;
  private readonly maxInteractionRows = 256;
  private readonly maxInteractionIdentityScopes = 64;
  private readonly maxInteractionEpochsPerScope = 256;
  private readonly maxObservedInteractionRequests = 4096;
  private readonly pendingCleanup = new Map<TaskRuntime, "previous" | "eviction">();
  private readonly maxPendingCleanup = 32;
  private cleanupReservations = 0;

  /** Reserve before creation can reach the wire; committed results never fail due to this budget. */
  reserveCreation(): TaskCreationRegistration {
    this.retryCleanup();
    if (this.pendingCleanup.size + this.cleanupReservations >= this.maxPendingCleanup) throw new Error("本机任务资源清理尚未完成，请稍后重试");
    this.cleanupReservations += 1;
    let released = false;
    const release = () => { if (!released) { released = true; this.cleanupReservations -= 1; } };
    return {
      registry: this,
      release,
      put: (profileId, serverId, runtime, onRegistered) => {
        if (released) throw new Error("任务登记预留已释放");
        this.putRuntime(profileId, serverId, runtime, () => { release(); onRegistered(); }, true);
      },
    };
  }

  getPendingCleanupCount(): number { return this.pendingCleanup.size; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  entries(): Array<{ profileId: string; serverId: string; threadId: string; runtime: TaskRuntime }> {
    return [...this.runtimes.entries()].flatMap(([key, runtime]) => {
      const [profileId, serverId, threadId] = key.split("\0");
      return profileId && serverId && threadId ? [{ profileId, serverId, threadId, runtime }] : [];
    });
  }

  interactionInboxRows(profileAuthorizationScope: string): InteractionInboxRow[] {
    return [...this.interactionRows.values()].filter((row) =>
      row.profileAuthorizationScopeKey === profileAuthorizationScope,
    ).map((row) => ({ ...row }));
  }

  interactionInboxOverflow(profileAuthorizationScope: string): InteractionInboxOverflowDisclosure {
    const omitted = this.omittedInteractionRows.get(profileAuthorizationScope);
    return {
      omittedRows: (omitted?.readonly ?? 0) + (omitted?.live ?? 0),
      mayContainUntrackedRows: this.mayContainUntrackedOmittedRows ||
        this.saturatedInteractionScopes.has(profileAuthorizationScope) ||
        (this.untrackedInteractionScopesSaturated &&
          !this.interactionEpochRequests.has(profileAuthorizationScope)),
    };
  }

  clearReadonlyInteractionRows(profileAuthorizationScope: string): void {
    for (const [key, row] of this.interactionRows) {
      if (row.profileAuthorizationScopeKey === profileAuthorizationScope && !row.liveActionable)
        this.interactionRows.delete(key);
    }
    const omitted = this.omittedInteractionRows.get(profileAuthorizationScope);
    if (omitted?.live) {
      this.omittedInteractionRows.delete(profileAuthorizationScope);
      this.omittedInteractionRows.set(profileAuthorizationScope, { readonly: 0, live: omitted.live });
    } else {
      this.omittedInteractionRows.delete(profileAuthorizationScope);
    }
    this.publish();
  }

  private interactionRowKey(row: InteractionInboxRow): string {
    return JSON.stringify([
      row.profileAuthorizationScopeKey,
      row.serverConfigIdentity,
      row.appServerId,
      row.threadId,
      row.turnId,
      row.appServerEpoch,
      row.kind,
      row.requestId,
      row.interactionId,
    ]);
  }

  private interactionRowFor(
    profileId: string,
    interaction: PendingInteraction,
    liveActionable = false,
  ): InteractionInboxRow {
    const owner = interaction.owner;
    return {
      profileId,
      profileAuthorizationScopeKey: owner.profileAuthorizationScopeKey,
      serverId: owner.serverId,
      appServerId: owner.appServerId,
      serverConfigIdentity: owner.serverConfigIdentity,
      threadId: owner.threadId,
      title: "",
      cwd: "",
      kind: interaction.kind,
      requestId: interaction.requestId,
      interactionId: interaction.kind === "approval" ? interaction.approvalId : interaction.questionId,
      ...(interaction.kind === "question" && interaction.sourceAgent
        ? { sourceAgent: { parentSessionId: interaction.sourceAgent.parentSessionId, agentId: interaction.sourceAgent.agentId } }
        : {}),
      turnId: owner.turnId,
      appServerEpoch: owner.appServerEpoch,
      runtimeInstanceNonce: owner.runtimeInstanceNonce,
      profileActivationEpoch: owner.profileActivationEpoch,
      originClientGeneration: owner.originClientGeneration,
      status: owner.status,
      liveActionable,
    };
  }

  private ownerForInteraction(
    profileId: string,
    interaction: PendingInteraction,
  ): InteractionOwnerBinding | undefined {
    const row = this.interactionRowFor(profileId, interaction);
    const key = this.interactionRowKey(row);
    if (this.resolvedInteractionKeys.has(key)) return undefined;
    const previous = this.interactionRows.get(key);
    if (previous) return this.ownerFromRow(previous);
    const owner = interaction.owner;
    if (!owner.appServerEpoch || !owner.turnId) return { ...owner, status: "unsupported" };
    let scopeRequests = this.interactionEpochRequests.get(owner.profileAuthorizationScopeKey);
    if (!scopeRequests) {
      if (this.untrackedInteractionScopesSaturated ||
          this.interactionEpochRequests.size >= this.maxInteractionIdentityScopes) {
        this.untrackedInteractionScopesSaturated = true;
        return { ...owner, runtimeInstanceNonce: -1, profileActivationEpoch: -1, originClientGeneration: -1, status: "unknown" };
      }
      scopeRequests = new Map<string, Set<number>>();
      this.interactionEpochRequests.set(owner.profileAuthorizationScopeKey, scopeRequests);
    }
    const epochKey = JSON.stringify([owner.serverConfigIdentity, owner.appServerId, owner.appServerEpoch]);
    let seenRequests = scopeRequests.get(epochKey);
    if (this.saturatedInteractionScopes.has(owner.profileAuthorizationScopeKey) &&
        seenRequests === undefined) {
      return { ...owner, runtimeInstanceNonce: -1, profileActivationEpoch: -1, originClientGeneration: -1, status: "unknown" };
    }
    // Allocation order across threads is not delivery order. Only an already
    // observed ID is a replay; the full tuple row above retains its original owner.
    if (seenRequests?.has(interaction.requestId)) {
      return {
        ...owner,
        runtimeInstanceNonce: -1,
        profileActivationEpoch: -1,
        originClientGeneration: -1,
        status: "unknown",
      };
    }
    if ((!seenRequests && scopeRequests.size >= this.maxInteractionEpochsPerScope) ||
        this.observedInteractionRequestCount >= this.maxObservedInteractionRequests) {
      this.saturatedInteractionScopes.add(owner.profileAuthorizationScopeKey);
      return {
        ...owner,
        runtimeInstanceNonce: -1,
        profileActivationEpoch: -1,
        originClientGeneration: -1,
        status: "unknown",
      };
    }
    if (!seenRequests) {
      seenRequests = new Set<number>();
      scopeRequests.set(epochKey, seenRequests);
    }
    // Never evict replay identities to make a new request actionable. On budget
    // exhaustion, new identities stay read-only and the Inbox discloses the limit.
    seenRequests.add(interaction.requestId);
    this.observedInteractionRequestCount += 1;
    return undefined;
  }

  private ownerFromRow(row: InteractionInboxRow): InteractionOwnerBinding {
    return {
      profileId: row.profileId,
      profileAuthorizationScopeKey: row.profileAuthorizationScopeKey,
      serverId: row.serverId,
      appServerId: row.appServerId,
      serverConfigIdentity: row.serverConfigIdentity,
      threadId: row.threadId,
      turnId: row.turnId,
      appServerEpoch: row.appServerEpoch,
      runtimeInstanceNonce: row.runtimeInstanceNonce,
      profileActivationEpoch: row.profileActivationEpoch,
      originClientGeneration: row.originClientGeneration,
      status: row.status,
    };
  }

  private interactionWasResolved(profileId: string, interaction: PendingInteraction): boolean {
    return this.resolvedInteractionKeys.has(this.interactionRowKey(
      this.interactionRowFor(profileId, interaction),
    ));
  }

  private recordOmittedRow(scope: string, liveActionable = false): void {
    const previous = this.omittedInteractionRows.get(scope) ?? { readonly: 0, live: 0 };
    this.omittedInteractionRows.delete(scope);
    this.omittedInteractionRows.set(scope, {
      readonly: previous.readonly + (liveActionable ? 0 : 1),
      live: previous.live + (liveActionable ? 1 : 0),
    });
    while (this.omittedInteractionRows.size > 64) {
      this.omittedInteractionRows.delete(this.omittedInteractionRows.keys().next().value!);
      this.mayContainUntrackedOmittedRows = true;
    }
  }

  private retainInteractionRow(
    profileId: string,
    serverId: string,
    runtime: TaskRuntime,
    interaction: PendingInteraction,
    liveActionable: boolean,
  ): void {
    const snapshot = runtime.getSnapshot();
    const row: InteractionInboxRow = {
      profileId,
      profileAuthorizationScopeKey: interaction.owner.profileAuthorizationScopeKey,
      serverId: interaction.owner.serverId || serverId,
      appServerId: interaction.owner.appServerId,
      serverConfigIdentity: interaction.owner.serverConfigIdentity,
      threadId: interaction.owner.threadId,
      title: snapshot.title,
      cwd: snapshot.cwd,
      kind: interaction.kind,
      requestId: interaction.requestId,
      interactionId: interaction.kind === "approval" ? interaction.approvalId : interaction.questionId,
      ...(interaction.kind === "question" && interaction.sourceAgent
        ? { sourceAgent: { parentSessionId: interaction.sourceAgent.parentSessionId, agentId: interaction.sourceAgent.agentId } }
        : {}),
      turnId: interaction.owner.turnId,
      appServerEpoch: interaction.owner.appServerEpoch,
      runtimeInstanceNonce: interaction.owner.runtimeInstanceNonce,
      profileActivationEpoch: interaction.owner.profileActivationEpoch,
      originClientGeneration: interaction.owner.originClientGeneration,
      status: interaction.owner.status,
      liveActionable,
    };
    const key = this.interactionRowKey(row);
    if (this.resolvedInteractionKeys.has(key)) return;
    if (this.interactionRows.has(key)) {
      const previous = this.interactionRows.get(key)!;
      const sameSourceAgent = previous.sourceAgent?.parentSessionId === row.sourceAgent?.parentSessionId &&
        previous.sourceAgent?.agentId === row.sourceAgent?.agentId;
      this.interactionRows.delete(key);
      this.interactionRows.set(key, {
        ...row,
        sourceAgent: previous.sourceAgent,
        runtimeInstanceNonce: previous.runtimeInstanceNonce,
        profileActivationEpoch: previous.profileActivationEpoch,
        originClientGeneration: previous.originClientGeneration,
        status: sameSourceAgent ? row.status : "unknown",
        liveActionable: sameSourceAgent && previous.liveActionable && liveActionable,
      });
      this.publish();
      return;
    }
    if (this.interactionRows.size >= this.maxInteractionRows) {
      const readonly = [...this.interactionRows.entries()].find(([, value]) => !value.liveActionable);
      if (!readonly) {
        this.recordOmittedRow(row.profileAuthorizationScopeKey, liveActionable);
        this.publish();
        return;
      }
      const [oldKey, oldRow] = readonly;
      this.interactionRows.delete(oldKey);
      this.recordOmittedRow(oldRow.profileAuthorizationScopeKey);
    }
    this.interactionRows.set(key, row);
    this.publish();
  }

  private removeInteractionRow(profileId: string, interaction: PendingInteraction): void {
    const key = this.interactionRowKey(this.interactionRowFor(profileId, interaction));
    this.interactionRows.delete(key);
    this.resolvedInteractionKeys.add(key);
    while (this.resolvedInteractionKeys.size > 512)
      this.resolvedInteractionKeys.delete(this.resolvedInteractionKeys.values().next().value!);
    this.publish();
  }

  private bindRuntime(profileId: string, serverId: string, runtime: TaskRuntime): void {
    const context = runtime.reconnectContext;
    if (!context) return;
    this.runtimeOwners.set(runtime, { profileId, serverId, threadId: runtime.getSnapshot().threadId });
    runtime.setInteractionLedgerObserver({
      ownerFor: (interaction) => this.ownerForInteraction(profileId, interaction),
      wasResolved: (interaction) => this.interactionWasResolved(profileId, interaction),
      changed: (interaction, actionable) => this.retainInteractionRow(profileId, serverId, runtime, interaction, actionable),
      resolved: (interaction) => this.removeInteractionRow(profileId, interaction),
    });
  }

  private detachRuntime(runtime: TaskRuntime, preserveReadonlyRows: boolean): void {
    const owner = this.runtimeOwners.get(runtime);
    if (preserveReadonlyRows) runtime.markInteractionsDisconnected();
    runtime.setInteractionLedgerObserver(null);
    for (const [key, row] of this.interactionRows) {
      if (row.runtimeInstanceNonce === runtime.runtimeInstanceNonce) {
        this.interactionRows.set(key, {
          ...row,
          liveActionable: false,
          status: row.status === "unsupported" ? "unsupported" : "unknown",
        });
      }
    }
    if (!preserveReadonlyRows && owner)
      this.removeInteractionRows(owner.profileId, owner.serverId, owner.threadId);
    this.runtimeOwners.delete(runtime);
    this.publish();
  }

  private removeInteractionRows(profileId: string, serverId: string, threadId: string): void {
    for (const [key, row] of this.interactionRows) {
      if (row.profileId === profileId && row.serverId === serverId && row.threadId === threadId)
        this.interactionRows.delete(key);
    }
  }

  private publish(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); }
      catch { /* A projection listener cannot turn a runtime registration into a failure. */ }
    }
  }

  /** Explicit bounded retry; failures retain exact resource references and fixed diagnostics. */
  retryCleanup(limit = 1): void {
    for (const [runtime, phase] of [...this.pendingCleanup].slice(0, Math.min(32, Math.max(0, limit)))) {
      try { runtime.close(); this.pendingCleanup.delete(runtime); }
      catch {
        this.pendingCleanup.delete(runtime); this.pendingCleanup.set(runtime, phase);
        console.warn(`task_registry_cleanup_pending:${phase}`);
      }
    }
  }

  private cleanupCommitted(runtime: TaskRuntime, phase: "previous" | "eviction"): void {
    this.detachRuntime(runtime, true);
    try { runtime.close(); }
    catch {
      this.pendingCleanup.set(runtime, phase);
      console.warn(`task_registry_cleanup_pending:${phase}`);
    }
  }

  key(profileId: string, serverId: string, threadId: string): string {
    return `${profileId}\0${serverId}\0${threadId}`;
  }

  get(
    profileId: string,
    serverId: string,
    threadId: string,
  ): TaskRuntime | undefined {
    const key = this.key(profileId, serverId, threadId);
    const runtime = this.runtimes.get(key);
    if (runtime) {
      this.runtimes.delete(key);
      this.runtimes.set(key, runtime);
    }
    return runtime;
  }

  /** Reuse only the resident connection for this exact authorization and workspace. */
  getForTarget(profile: GatewayProfile, server: KCoderServer, threadId: string, cwd?: string): TaskRuntime | undefined {
    const runtime = this.get(profile.id, server.id, threadId);
    const context = runtime?.reconnectContext;
    if (!runtime || runtime.isDisposed() || !runtime.client || !context ||
      context.profile.id !== profile.id || context.profile.deviceId !== profile.deviceId ||
      runtime.getSnapshot().threadId !== threadId) return undefined;
    if (profileAuthorizationScopeKey(context.profile) !== profileAuthorizationScopeKey(profile) ||
      interactionServerIdentity(context.server) !== interactionServerIdentity(server)) return undefined;
    const source = { ...context.server, workspacePath: workspaceThreadScopeIdentity(runtime.getSnapshot().cwd) };
    const target = { ...server, workspacePath: workspaceThreadScopeIdentity(cwd ?? server.workspacePath) };
    return workspaceStateAuthorizationScope(context.profile, source) === workspaceStateAuthorizationScope(profile, target)
      ? runtime : undefined;
  }

  put(profileId: string, serverId: string, runtime: TaskRuntime, onRegistered?: () => void): void {
    this.putRuntime(profileId, serverId, runtime, onRegistered, false);
  }

  private putRuntime(profileId: string, serverId: string, runtime: TaskRuntime, onRegistered: (() => void) | undefined, reserved: boolean): void {
    if (runtime.isDisposed()) throw new Error("无法登记已关闭的任务");
    if (onRegistered && !reserved) {
      this.retryCleanup();
      if (this.pendingCleanup.size + this.cleanupReservations >= this.maxPendingCleanup) throw new Error("本机任务资源清理尚未完成，请稍后重试");
    }
    const key = this.key(profileId, serverId, runtime.getSnapshot().threadId);
    const previous = this.runtimes.get(key);
    if (!onRegistered && previous && previous !== runtime) {
      this.detachRuntime(previous, true);
      previous.close();
    }
    this.runtimes.delete(key);
    this.runtimes.set(key, runtime);
    this.bindRuntime(profileId, serverId, runtime);
    this.publish();
    onRegistered?.();
    if (onRegistered && previous && previous !== runtime) this.cleanupCommitted(previous, "previous");
    while (this.runtimes.size > this.maxHotRuntimes) {
      // Retain registry references when cleanup capacity is exhausted; never drop a failed resource.
      if (onRegistered && this.pendingCleanup.size + this.cleanupReservations >= this.maxPendingCleanup) break;
      const idle = [...this.runtimes.entries()].find(([, candidate]) => {
        if (candidate === runtime) return false;
        const snapshot = candidate.getSnapshot();
        return (
          !snapshot.running &&
          !(snapshot.interactionCount && snapshot.interactionCount > 0) &&
          !candidate.hasLiveTerminalSessions()
        );
      });
      // Active turns and tasks awaiting user responses must never be cancelled silently because of UI cache limits.
      if (!idle) break;
      this.runtimes.delete(idle[0]);
      if (onRegistered) this.cleanupCommitted(idle[1], "eviction");
      else { this.detachRuntime(idle[1], true); idle[1].close(); }
    }
    this.publish();
  }

  remove(profileId: string, serverId: string, threadId: string): void {
    const key = this.key(profileId, serverId, threadId);
    const runtime = this.runtimes.get(key);
    this.runtimes.delete(key);
    if (runtime) this.detachRuntime(runtime, false);
    this.removeInteractionRows(profileId, serverId, threadId);
    this.publish();
    runtime?.close();
  }

  removeProfile(profileId: string): void {
    const prefix = `${profileId}\0`;
    for (const [key, runtime] of this.runtimes) {
      if (!key.startsWith(prefix)) continue;
      this.runtimes.delete(key);
      this.detachRuntime(runtime, false);
      this.removeInteractionRows(profileId, runtime.reconnectContext?.server.id ?? "", runtime.getSnapshot().threadId);
      this.publish();
      runtime.close();
    }
    for (const [key, row] of this.interactionRows) {
      if (row.profileId === profileId) this.interactionRows.delete(key);
    }
    this.publish();
  }

  removeServer(profileId: string, serverId: string): void {
    const prefix = `${profileId}\0${serverId}\0`;
    for (const [key, runtime] of this.runtimes) {
      if (!key.startsWith(prefix)) continue;
      this.runtimes.delete(key);
      this.detachRuntime(runtime, false);
      this.removeInteractionRows(profileId, serverId, runtime.getSnapshot().threadId);
      this.publish();
      runtime.close();
    }
    for (const [key, row] of this.interactionRows) {
      if (row.profileId === profileId && row.serverId === serverId)
        this.interactionRows.delete(key);
    }
    this.publish();
  }
}

export const taskRuntimeRegistry = new TaskRuntimeRegistry();
