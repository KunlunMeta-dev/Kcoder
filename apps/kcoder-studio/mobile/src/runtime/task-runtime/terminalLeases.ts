import {
  TerminalTranscriptBuffer,
  terminalTranscriptCharacterLimit,
} from "@/components/terminal-transcript-buffer";
import { type RpcMessage } from "@/gateway/rpc";
import { TaskRuntime } from "./core";
import { record } from "./normalizers";
import { type Listener } from "./types";

export interface TaskTerminalSnapshot {
  panelId: string;
  sessionId: string | null;
  cwd: string;
  status: "idle" | "starting" | "running" | "reconnecting" | "exited" | "error";
  error: string | null;
  sequence: number;
}

export interface TaskTerminalOutputEvent {
  kind: "append" | "replace";
  data: string;
  sequence: number;
}

export interface BufferedTerminalProtocolEvent {
  sequence: number;
  kind: "output" | "exit";
  data?: string;
  exitCode?: string;
}

export class TaskTerminalSession {
  private readonly listeners = new Set<Listener>();
  private readonly outputListeners = new Set<
    (event: TaskTerminalOutputEvent) => void
  >();
  private readonly transcript = new TerminalTranscriptBuffer();
  private readonly unsubscribeProtocol: () => void;
  private readonly unsubscribeTask: () => void;
  private startPromise: Promise<void> | null = null;
  private generation = 0;
  private disposed = false;
  private reconnectQueued = false;
  private lastProtocolSequence = 0;
  private readonly pendingProtocolEvents: BufferedTerminalProtocolEvent[] = [];
  private scrollbackLines = 10_000;
  private terminalSize = { rows: 28, cols: 100 };
  private snapshot: TaskTerminalSnapshot;

  constructor(
    private readonly task: TaskRuntime,
    panelId: string,
    cwd: string,
    initialSessionId?: string,
  ) {
    this.snapshot = {
      panelId,
      sessionId: initialSessionId ?? null,
      cwd,
      status: "idle",
      error: null,
      sequence: 0,
    };
    this.unsubscribeProtocol = task.subscribeProtocol((message) =>
      this.handleProtocol(message),
    );
    this.unsubscribeTask = task.subscribe(() => this.handleTaskState());
  }

  getSnapshot = (): TaskTerminalSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeOutput(
    listener: (event: TaskTerminalOutputEvent) => void,
  ): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  getTranscript(): string {
    return this.transcript.toString();
  }

  setScrollbackLines(lines: number): void {
    this.scrollbackLines = Math.max(
      1_000,
      Math.min(100_000, Math.round(lines)),
    );
    const maxCharacters = terminalTranscriptCharacterLimit(
      this.scrollbackLines,
    );
    this.transcript.setLimits(maxCharacters, this.scrollbackLines);
  }

  async start(): Promise<void> {
    if (this.disposed || this.snapshot.status === "running") return;
    if (this.startPromise) return this.startPromise;
    if (!this.task.getSnapshot().connected) {
      this.patch({
        status: "reconnecting",
        error: this.snapshot.sessionId
          ? "主连接恢复后将重新附着原终端"
          : "主连接恢复后将创建终端会话",
      });
      return;
    }
    const generation = ++this.generation;
    const startSize = { ...this.terminalSize };
    const previousSessionId = this.snapshot.sessionId;
    let createdSessionId: string | null = null;
    this.patch({ status: "starting", error: null });
    this.pendingProtocolEvents.length = 0;
    this.startPromise = (async () => {
      let sessionId = previousSessionId;
      let cwd = this.snapshot.cwd;
      let created = false;
      if (!sessionId) {
        const result = await this.task.request<{
          session_id?: string;
          cwd?: string;
        }>("terminal/start", {
          cwd,
          rows: startSize.rows,
          cols: startSize.cols,
        });
        if (!result.session_id)
          throw new Error("app-server 未返回 terminal session id");
        sessionId = result.session_id;
        createdSessionId = sessionId;
        cwd = result.cwd ?? cwd;
        created = true;
        if (this.disposed || generation !== this.generation) {
          void this.task
            .request("terminal/close", { session_id: sessionId })
            .catch(() => {});
          return;
        }
        this.patch({ sessionId, cwd });
      }
      const attached = await this.task.request<{
        session_id?: string;
        cwd?: string;
        transcript?: string;
        through_sequence?: number;
      }>("terminal/attach", {
        session_id: sessionId,
        rows: startSize.rows,
        cols: startSize.cols,
      });
      if (!attached.session_id)
        throw new Error("app-server 未返回 terminal attach session id");
      if (this.disposed || generation !== this.generation) {
        if (created)
          void this.task
            .request("terminal/close", { session_id: sessionId })
            .catch(() => {});
        return;
      }
      cwd = attached.cwd ?? cwd;
      this.lastProtocolSequence = Math.max(
        0,
        Number(attached.through_sequence ?? 0),
      );
      this.replace(
        `\u001b[1;32mKCoder Terminal\u001b[0m · ${cwd}\r\n${attached.transcript ?? ""}`,
      );
      this.patch({ sessionId, cwd, status: "running", error: null });
      const buffered = this.pendingProtocolEvents
        .splice(0)
        .sort((left, right) => left.sequence - right.sequence);
      for (const event of buffered) this.applyProtocolEvent(event);
      if (
        this.terminalSize.rows !== startSize.rows ||
        this.terminalSize.cols !== startSize.cols
      ) {
        this.sendResize(
          sessionId,
          this.terminalSize.rows,
          this.terminalSize.cols,
        );
      }
    })()
      .catch((value) => {
        if (this.disposed || generation !== this.generation) return;
        this.pendingProtocolEvents.length = 0;
        const reconnectFailed = Boolean(previousSessionId);
        if (createdSessionId && this.task.getSnapshot().connected) {
          void this.task
            .request("terminal/close", { session_id: createdSessionId })
            .catch(() => {});
        }
        this.patch({
          sessionId: null,
          status: "error",
          error: reconnectFailed
            ? `原终端已不可用：${value instanceof Error ? value.message : String(value)}`
            : value instanceof Error
              ? value.message
              : String(value),
        });
      })
      .finally(() => {
        if (generation === this.generation) this.startPromise = null;
      });
    return this.startPromise;
  }

  async restart(): Promise<void> {
    const previous = this.snapshot.sessionId;
    this.generation += 1;
    this.startPromise = null;
    this.pendingProtocolEvents.length = 0;
    this.lastProtocolSequence = 0;
    this.patch({ sessionId: null, status: "idle", error: null });
    if (previous && this.task.getSnapshot().connected) {
      await this.task
        .request("terminal/close", { session_id: previous })
        .catch(() => {});
    }
    await this.start();
  }

  write(data: string): void {
    const sessionId = this.snapshot.sessionId;
    if (!sessionId || !data) return;
    void this.task
      .request("terminal/write", { session_id: sessionId, data })
      .catch((value) => {
        this.patch({
          error: value instanceof Error ? value.message : String(value),
        });
      });
  }

  resize(rows: number, cols: number): void {
    if (
      !Number.isFinite(rows) ||
      !Number.isFinite(cols) ||
      rows < 1 ||
      cols < 1
    )
      return;
    this.terminalSize = { rows: Math.floor(rows), cols: Math.floor(cols) };
    const sessionId = this.snapshot.sessionId;
    if (!sessionId) return;
    this.sendResize(sessionId, this.terminalSize.rows, this.terminalSize.cols);
  }

  private sendResize(sessionId: string, rows: number, cols: number): void {
    void this.task
      .request("terminal/resize", {
        session_id: sessionId,
        rows,
        cols,
      })
      .catch(() => {});
  }

  captureSnapshot(data: string, sequence: number): void {
    if (sequence !== this.snapshot.sequence) return;
    this.transcript.replace(data);
  }

  dispose(closeRemote: boolean): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.unsubscribeProtocol();
    this.unsubscribeTask();
    const sessionId = this.snapshot.sessionId;
    this.outputListeners.clear();
    this.listeners.clear();
    if (closeRemote && sessionId && this.task.getSnapshot().connected) {
      void this.task
        .request("terminal/close", { session_id: sessionId })
        .catch(() => {});
    }
  }

  private handleTaskState(): void {
    if (this.disposed) return;
    if (!this.task.getSnapshot().connected) {
      if (
        this.snapshot.status === "running" ||
        this.snapshot.status === "starting"
      ) {
        this.generation += 1;
        this.startPromise = null;
        this.pendingProtocolEvents.length = 0;
        this.patch({
          status: "reconnecting",
          error: "连接中断，恢复后将重新附着原终端",
        });
      }
      return;
    }
    if (this.snapshot.status !== "reconnecting" || this.reconnectQueued) return;
    this.reconnectQueued = true;
    queueMicrotask(() => {
      this.reconnectQueued = false;
      if (!this.disposed && this.snapshot.status === "reconnecting")
        void this.start();
    });
  }

  private handleProtocol(message: RpcMessage): void {
    const params = record(message.params);
    if (message.method === "terminal/output") {
      const eventSession = String(params.session_id ?? "");
      const data = String(params.data ?? "");
      const sequence = Number(params.sequence ?? this.lastProtocolSequence + 1);
      if (
        eventSession !== this.snapshot.sessionId ||
        !Number.isFinite(sequence)
      )
        return;
      const event: BufferedTerminalProtocolEvent = {
        sequence,
        kind: "output",
        data,
      };
      if (
        this.snapshot.status === "starting" ||
        this.snapshot.status === "reconnecting"
      )
        this.pendingProtocolEvents.push(event);
      else this.applyProtocolEvent(event);
      return;
    }
    if (message.method === "terminal/exit") {
      const eventSession = String(params.session_id ?? "");
      const exit = String(params.exit_code ?? 0);
      const sequence = Number(params.sequence ?? this.lastProtocolSequence + 1);
      if (
        eventSession !== this.snapshot.sessionId ||
        !Number.isFinite(sequence)
      )
        return;
      const event: BufferedTerminalProtocolEvent = {
        sequence,
        kind: "exit",
        exitCode: exit,
      };
      if (
        this.snapshot.status === "starting" ||
        this.snapshot.status === "reconnecting"
      )
        this.pendingProtocolEvents.push(event);
      else this.applyProtocolEvent(event);
    }
  }

  private applyProtocolEvent(event: BufferedTerminalProtocolEvent): void {
    if (event.sequence <= this.lastProtocolSequence) return;
    if (event.sequence !== this.lastProtocolSequence + 1) {
      this.patch({
        status: "reconnecting",
        error: "终端输出出现缺口，正在重新同步…",
      });
      if (!this.reconnectQueued) {
        this.reconnectQueued = true;
        setTimeout(() => {
          this.reconnectQueued = false;
          if (!this.disposed && this.snapshot.status === "reconnecting")
            void this.start();
        }, 0);
      }
      return;
    }
    this.lastProtocolSequence = event.sequence;
    if (event.kind === "output") {
      this.append(event.data ?? "");
      return;
    }
    this.append(
      `\r\n\u001b[33m[进程已退出：${event.exitCode ?? "0"}]\u001b[0m\r\n`,
    );
    this.patch({
      sessionId: null,
      status: "exited",
      error: "终端进程已退出，可点击重新启动",
    });
  }

  private append(data: string): void {
    if (!data) return;
    this.transcript.append(data);
    const sequence = this.snapshot.sequence + 1;
    this.snapshot = { ...this.snapshot, sequence };
    for (const listener of this.outputListeners)
      listener({ kind: "append", data, sequence });
  }

  private replace(data: string): void {
    this.transcript.replace(data);
    const sequence = this.snapshot.sequence + 1;
    this.snapshot = { ...this.snapshot, sequence };
    for (const listener of this.outputListeners)
      listener({ kind: "replace", data: this.transcript.toString(), sequence });
  }

  private patch(update: Partial<TaskTerminalSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
}
