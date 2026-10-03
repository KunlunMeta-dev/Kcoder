import { TaskRuntime } from "./core";

export class TaskRuntimeRegistry {
  private readonly runtimes = new Map<string, TaskRuntime>();
  private readonly maxHotRuntimes = 8;

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

  put(profileId: string, serverId: string, runtime: TaskRuntime): void {
    const key = this.key(profileId, serverId, runtime.getSnapshot().threadId);
    const previous = this.runtimes.get(key);
    if (previous && previous !== runtime) previous.close();
    this.runtimes.delete(key);
    this.runtimes.set(key, runtime);
    while (this.runtimes.size > this.maxHotRuntimes) {
      const idle = [...this.runtimes.entries()].find(([, candidate]) => {
        if (candidate === runtime) return false;
        const snapshot = candidate.getSnapshot();
        return (
          !snapshot.running &&
          !snapshot.interaction &&
          !candidate.hasLiveTerminalSessions()
        );
      });
      // Active turns and tasks awaiting user responses must never be cancelled silently because of UI cache limits.
      if (!idle) break;
      this.runtimes.delete(idle[0]);
      idle[1].close();
    }
  }

  remove(profileId: string, serverId: string, threadId: string): void {
    const key = this.key(profileId, serverId, threadId);
    const runtime = this.runtimes.get(key);
    this.runtimes.delete(key);
    runtime?.close();
  }

  removeProfile(profileId: string): void {
    const prefix = `${profileId}\0`;
    for (const [key, runtime] of this.runtimes) {
      if (!key.startsWith(prefix)) continue;
      this.runtimes.delete(key);
      runtime.close();
    }
  }

  removeServer(profileId: string, serverId: string): void {
    const prefix = `${profileId}\0${serverId}\0`;
    for (const [key, runtime] of this.runtimes) {
      if (!key.startsWith(prefix)) continue;
      this.runtimes.delete(key);
      runtime.close();
    }
  }
}

export const taskRuntimeRegistry = new TaskRuntimeRegistry();
