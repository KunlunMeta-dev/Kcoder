// Logical background identities survive reconnects. This bounded UI cache never
// owns model delivery; failed forwarding releases its optimistic replay claim.
type RunState = {
  current: string;
  terminal: boolean;
  paused: boolean;
  statusSequence: number;
  lastEventId?: string;
};
const terminalTypes = new Set([
  "background_job_completed",
  "background_job_failed",
  "background_job_cancelled",
  "background_job_halted",
]);

function identityOf(params: Record<string, unknown>) {
  const identity = params.identity as Record<string, unknown> | undefined;
  const run = identity?.run as Record<string, unknown> | undefined;
  if (
    !identity ||
    !run ||
    ![run.parentSessionId, run.agentId, run.runId, identity.eventId].every(
      (value) =>
        typeof value === "string" && value.length > 0 && value.length <= 256,
    )
  )
    return undefined;
  return {
    parent: run.parentSessionId as string,
    agent: run.agentId as string,
    run: run.runId as string,
    event: identity.eventId as string,
    sequence: identity.runSequence,
  };
}

export class NotificationReplayGuard {
  private readonly seen = new Set<string>();
  private readonly runs = new Map<string, RunState>();
  private readonly retiredRuns = new Set<string>();
  private readonly capacity: number;
  constructor(capacity = 65536) {
    this.capacity = capacity;
  }

  canSeedBackgroundRun(
    run: Record<string, unknown>,
    status: string,
    target?: string,
  ): boolean {
    const current = this.runs.get(
      JSON.stringify([target ?? "", run.parentSessionId, run.agentId]),
    );
    if (current && current.current !== run.runId) {
      return (
        current.terminal &&
        !this.retiredRuns.has(
          JSON.stringify([
            JSON.stringify([target ?? "", run.parentSessionId, run.agentId]),
            run.runId,
          ]),
        )
      );
    }
    return (
      !current ||
      (current.current === run.runId &&
        (!current.terminal ||
          ["completed", "failed", "cancelled", "halted"].includes(status)))
    );
  }

  // Call only after the authoritative snapshot has been successfully projected.
  seedBackgroundRun(
    run: Record<string, unknown>,
    status: string,
    target?: string,
  ): boolean {
    if (
      ![run.parentSessionId, run.agentId, run.runId].every(
        (value) =>
          typeof value === "string" && value.length > 0 && value.length <= 256,
      )
    )
      return true;
    const scope = JSON.stringify([
      target ?? "",
      run.parentSessionId,
      run.agentId,
    ]);
    const current = this.runs.get(scope);
    if (!this.canSeedBackgroundRun(run, status, target)) return false;
    if (current && current.current !== run.runId) {
      this.retiredRuns.add(JSON.stringify([scope, current.current]));
      if (this.retiredRuns.size > this.capacity)
        this.retiredRuns.delete(this.retiredRuns.values().next().value!);
    }
    const terminal = ["completed", "failed", "cancelled", "halted"].includes(
      status,
    );
    this.runs.set(scope, {
      current: run.runId as string,
      terminal,
      paused: status === "paused",
      statusSequence: terminal
        ? Number.MAX_SAFE_INTEGER
        : current && current.current === run.runId
          ? current.statusSequence
          : -1,
      lastEventId: current?.lastEventId,
    });
    if (this.runs.size > this.capacity)
      this.runs.delete(this.runs.keys().next().value!);
    return true;
  }

  private key(
    method: string,
    params: Record<string, unknown>,
    target?: string,
  ): string | undefined {
    const identity = identityOf(params);
    if (identity)
      return JSON.stringify([
        target ?? "",
        identity.parent,
        identity.agent,
        identity.run,
        identity.event,
        method,
      ]);
    const { serverId, threadId, sequence } = params;
    if (
      typeof serverId !== "string" ||
      typeof threadId !== "string" ||
      serverId.length > 256 ||
      threadId.length > 256 ||
      method.length > 128 ||
      !Number.isSafeInteger(sequence) ||
      (sequence as number) < 0
    )
      return undefined;
    return `${target ?? ""}\0${serverId}\0${threadId}\0${sequence}\0${method}`;
  }

  accept(
    method: string,
    params: Record<string, unknown>,
    target?: string,
  ): boolean {
    const key = this.key(method, params, target);
    // A replay must never mutate current-run or terminal state.
    if (key && this.seen.has(key)) return false;
    const identity = identityOf(params);
    if (identity) {
      const scope = JSON.stringify([
        target ?? "",
        identity.parent,
        identity.agent,
      ]);
      const payload = params.event as Record<string, unknown> | undefined;
      const type = typeof payload?.type === "string" ? payload.type : "";
      const existing = this.runs.get(scope);
      let state = existing ? { ...existing } : undefined;
      if (state && state.current !== identity.run) {
        if (this.retiredRuns.has(JSON.stringify([scope, identity.run])))
          return false;
        if (
          type !== "background_job_started" &&
          type !== "background_job_associated"
        )
          return false;
        this.retiredRuns.add(JSON.stringify([scope, state.current]));
        if (this.retiredRuns.size > this.capacity)
          this.retiredRuns.delete(this.retiredRuns.values().next().value!);
        state = undefined;
      }
      state ??= {
        current: identity.run,
        terminal: false,
        paused: false,
        statusSequence: -1,
      };
      const terminal = terminalTypes.has(type);
      // A released terminal claim can retry after failed forwarding. A successful
      // copy is stopped by `seen` above, before reaching this state transition.
      if (
        state.terminal &&
        type.startsWith("background_job_") &&
        !(terminal && state.lastEventId === identity.event)
      )
        return false;
      const statusEvent =
        terminal ||
        type === "background_job_progress" ||
        type === "background_job_paused";
      if (statusEvent && Number.isSafeInteger(identity.sequence)) {
        if ((identity.sequence as number) < state.statusSequence) return false;
        state.statusSequence = identity.sequence as number;
      }
      if (
        state.paused &&
        (type === "background_job_progress" ||
          type === "background_job_promoted")
      )
        return false;
      if (type === "background_job_paused") state.paused = true;
      if (terminal) state.terminal = true;
      state.lastEventId = identity.event;
      this.runs.set(scope, state);
      if (this.runs.size > this.capacity)
        this.runs.delete(this.runs.keys().next().value!);
    } else {
      const event = params.event as Record<string, unknown> | undefined;
      if (
        typeof event?.id === "string" &&
        typeof params.threadId === "string" &&
        this.runs.has(JSON.stringify([target ?? "", params.threadId, event.id]))
      )
        return false;
    }
    if (key) {
      this.seen.add(key);
      if (this.seen.size > this.capacity)
        this.seen.delete(this.seen.values().next().value!);
    }
    return true;
  }

  release(
    method: string,
    params: Record<string, unknown>,
    target?: string,
  ): void {
    const key = this.key(method, params, target);
    if (key) this.seen.delete(key);
  }
}
