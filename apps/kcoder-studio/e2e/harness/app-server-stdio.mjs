import { createInterface } from "node:readline";

/** JSONL client for a RunContext-owned KCoder app-server child process. */
export class AppServerStdioClient {
  constructor(label, child, options = {}) {
    this.label = label;
    this.child = child;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
    this.sequence = 0;
    this.pending = new Map();
    this.unmatched = new Map();
    this.discardWaiters = new Map();
    this.notificationHistory = [];
    this.notificationHistoryLimit = options.notificationHistoryLimit ?? 32;
    this.notificationWaiters = new Set();
    this.methodsSent = [];
    this.discardedResponseIds = [];
    this.protocolFailure = null;
    this.exit = null;
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on("line", line => this.onLine(line));
    child.once("error", error => this.failPending(error));
    child.once("close", (code, signal) => {
      this.exit = { code, signal };
      this.failPending(new Error(`${label} exited before its JSON-RPC response arrived (code=${code}, signal=${signal})`));
    });
  }

  onLine(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      this.protocolFailure = new Error(`${this.label} wrote a non-JSON frame to stdout`);
      this.failPending(this.protocolFailure);
      return;
    }
    const pending = this.pending.get(frame?.id);
    if (pending) {
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      pending.resolve(frame);
      return;
    }
    if (frame?.id === undefined) {
      if (typeof frame?.method !== "string") return;
      this.notificationHistory.push(frame);
      if (this.notificationHistory.length > this.notificationHistoryLimit) this.notificationHistory.shift();
      for (const waiter of [...this.notificationWaiters]) {
        let matches = false;
        try {
          matches = waiter.predicate(frame) === true;
        } catch (error) {
          this.notificationWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.reject(error);
          continue;
        }
        if (!matches) continue;
        this.notificationWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
      return;
    }

    this.discardedResponseIds.push(frame.id);
    this.unmatched.set(frame.id, frame);
    const waiters = this.discardWaiters.get(frame.id);
    if (waiters) {
      this.discardWaiters.delete(frame.id);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
    }
  }

  request(method, params = {}, timeoutMs = this.defaultTimeoutMs) {
    if (this.protocolFailure) return Promise.reject(this.protocolFailure);
    if (this.exit) return Promise.reject(new Error(`${this.label} is already closed`));
    const id = this.nextId(method);
    return new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error(`${this.label} ${method} response timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
      this.write(id, method, params, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  /** Send a request without registering a response promise for its caller. */
  sendWithoutWaitingForResponse(method, params = {}) {
    if (this.protocolFailure) return Promise.reject(this.protocolFailure);
    if (this.exit) return Promise.reject(new Error(`${this.label} is already closed`));
    const id = this.nextId(method);
    return new Promise((resolveWrite, rejectWrite) => {
      this.write(id, method, params, error => {
        if (error) rejectWrite(error);
        else resolveWrite(id);
      });
    });
  }

  waitForDiscardedResponse(id, timeoutMs = this.defaultTimeoutMs) {
    if (this.unmatched.has(id)) return Promise.resolve(this.unmatched.get(id));
    if (this.protocolFailure) return Promise.reject(this.protocolFailure);
    if (this.exit) return Promise.reject(new Error(`${this.label} exited before response ${id} arrived`));
    return new Promise((resolveResponse, rejectResponse) => {
      const waiter = {
        resolve: resolveResponse,
        reject: rejectResponse,
        timer: setTimeout(() => {
          this.removeDiscardWaiter(id, waiter);
          rejectResponse(new Error(`${this.label} discarded response ${id} timed out after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      const waiters = this.discardWaiters.get(id) || [];
      waiters.push(waiter);
      this.discardWaiters.set(id, waiters);
    });
  }

  waitForNotification(predicate, timeoutMs = this.defaultTimeoutMs, label = "app-server notification") {
    if (typeof predicate !== "function") return Promise.reject(new TypeError("notification predicate must be a function"));
    const existing = this.notificationHistory.find(frame => {
      try { return predicate(frame) === true; } catch { return false; }
    });
    if (existing) return Promise.resolve(existing);
    if (this.protocolFailure) return Promise.reject(this.protocolFailure);
    if (this.exit) return Promise.reject(new Error(`${this.label} exited before ${label}`));
    return new Promise((resolveNotification, rejectNotification) => {
      const waiter = {
        predicate,
        resolve: resolveNotification,
        reject: rejectNotification,
        timer: setTimeout(() => {
          this.notificationWaiters.delete(waiter);
          rejectNotification(new Error(`${this.label} ${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      this.notificationWaiters.add(waiter);
    });
  }

  failPending(error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const [id, waiters] of this.discardWaiters) {
      this.discardWaiters.delete(id);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.notificationWaiters.clear();
  }

  closeReader() {
    this.reader.close();
  }

  nextId(method) {
    const id = `${this.label}-${++this.sequence}`;
    this.methodsSent.push(method);
    return id;
  }

  write(id, method, params, callback) {
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    this.child.stdin.write(frame, callback);
  }

  removeDiscardWaiter(id, waiter) {
    const waiters = this.discardWaiters.get(id);
    if (!waiters) return;
    const remaining = waiters.filter(candidate => candidate !== waiter);
    if (remaining.length) this.discardWaiters.set(id, remaining);
    else this.discardWaiters.delete(id);
  }
}

export function waitForStdioChildClose(child, timeoutMs, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveClose, rejectClose) => {
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      rejectClose(new Error(`${label} did not close within ${timeoutMs}ms`));
    }, timeoutMs);
    const onClose = (code, signal) => {
      clearTimeout(timer);
      resolveClose({ code, signal });
    };
    child.once("close", onClose);
  });
}
