import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { isMainThread } from "node:worker_threads";

export const BROKER_OWNERSHIP_TAG = "[kcoder-e2e-broker-ownership] ";
const gatewayEntry = fileURLToPath(new URL("../../dev-server.mjs", import.meta.url));
const installations = new WeakMap();
const methods = ["attach", "detach", "receive", "sendInternalRequest", "routeServerMessage"];
const knownMethods = new Set([
  "initialize", "server/resources/read", "gateway/app-server/restart",
  "runtime.context.get", "runtime.context.update", "runtime.providers.probe",
  "settings/execution-defaults/read", "settings/execution-defaults/save",
  "mcp/apps/revoke", "computerUse/revoke", "thread/automation/suspend",
  "thread/start", "thread/resume", "thread/read", "thread/dispose", "thread/delete",
  "turn/start", "turn/interrupt", "terminal/start", "terminal/close",
  "browser/start", "browser/close", "attachment/delete", "attachment/upload/cancel",
]);
const knownChannels = new Set(["runtime", "terminal", "browser", "files", "git", "mcp"]);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const methodName = value => knownMethods.has(value) ? value : "other";

/** Ordinary acceptance uses no preload or collector; this environment flag explicitly opts into diagnostics. */
export function brokerOwnershipDiagnosticGatewayOptions({ env = process.env, ownerPid = process.pid } = {}) {
  if (env.KCODER_E2E_SETTINGS_BROKER_DIAGNOSTICS !== "1") return null;
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) throw new Error("broker diagnostic owner PID must be positive");
  return {
    env: {
      KCODER_E2E_BROKER_OWNERSHIP_OBSERVER: "1",
      KCODER_E2E_BROKER_OWNERSHIP_OBSERVER_OWNER_PID: String(ownerPid),
      NODE_OPTIONS: `--import=${import.meta.url}`,
    },
    redactedStderrDiagnostics: { artifactName: "broker-ownership-stderr.json", maxBytes: 256 * 1024 },
  };
}

/** Inherited NODE_OPTIONS must not install this observer in child Node processes or workers. */
export function isOwnedGatewayObserverProcess({
  env = process.env, argv = process.argv, parentPid = process.ppid, mainThread = isMainThread,
} = {}) {
  const owner = env.KCODER_E2E_BROKER_OWNERSHIP_OBSERVER_OWNER_PID;
  return mainThread && env.KCODER_E2E_BROKER_OWNERSHIP_OBSERVER === "1"
    && typeof owner === "string" && /^[1-9]\d*$/.test(owner)
    && Number.isSafeInteger(Number(owner)) && Number(owner) === parentPid
    && typeof argv[1] === "string" && resolve(argv[1]) === gatewayEntry;
}

function restartContext(raw) {
  if (typeof raw !== "string" || raw.length > 64 * 1024) return null;
  let request;
  try { request = JSON.parse(raw); } catch { return null; }
  if (request?.method !== "gateway/app-server/restart" || request.jsonrpc !== "2.0"
      || !(typeof request.id === "string" || (Number.isSafeInteger(request.id) && request.id >= 0))) return null;
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params) || params.confirm !== true
      || Object.keys(params).some(key => key !== "confirm" && key !== "force")
      || (params.force !== undefined && typeof params.force !== "boolean")) return null;
  return { validRestartRequest: true, force: params.force === true };
}

/** Instrumented diagnostics only: never await, transform results, or change broker decisions. */
export function installBrokerOwnershipObserver(Broker, {
  write = chunk => process.stderr.write(chunk), schedule = callback => setImmediate(callback),
  maxRecords = 512, maxQueuedRecords = 64,
} = {}) {
  const prototype = Broker?.prototype;
  if (!prototype || installations.has(prototype)) return { installed: false };
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 2048
      || !Number.isSafeInteger(maxQueuedRecords) || maxQueuedRecords < 1 || maxQueuedRecords > 128) return { installed: false };
  const originals = methods.map(name => [name, Object.getOwnPropertyDescriptor(prototype, name)]);
  if (originals.some(([, descriptor]) => typeof descriptor?.value !== "function" || !descriptor.configurable)) return { installed: false };
  const brokers = new WeakMap();
  const clients = new WeakMap();
  const requests = new WeakMap();
  const queue = [];
  const stats = { records: 0, criticalRecords: 0, dropped: 0, errors: 0 };
  let brokerSequence = 0, clientSequence = 0, requestSequence = 0, sequence = 0;
  let scheduled = false, overflowReported = false;
  const safe = action => { try { return action(); } catch { stats.errors++; return undefined; } };
  const clientId = client => {
    if (!client || (typeof client !== "object" && typeof client !== "function")) return null;
    if (!clients.has(client)) clients.set(client, ++clientSequence);
    return clients.get(client);
  };
  const requestId = pending => {
    if (!requests.has(pending)) requests.set(pending, ++requestSequence);
    return requests.get(pending);
  };
  const stateFor = broker => {
    if (!brokers.has(broker)) brokers.set(broker, { id: ++brokerSequence, detachDepth: 0, tracked: new Map() });
    return brokers.get(broker);
  };
  const envelope = record => ({
    schemaVersion: 1, evidenceClass: "instrumented-broker-ownership-diagnostic", sequence: ++sequence, ...record,
  });
  const writeRecords = records => safe(() => {
    const lines = records.map(record => {
      const line = `${BROKER_OWNERSHIP_TAG}${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(line) > 8192) { stats.dropped++; return ""; }
      return line;
    }).join("");
    if (lines) write(lines);
  });
  const requestFlush = () => {
    if (scheduled || !queue.length) return;
    scheduled = true;
    const handle = safe(() => schedule(() => {
      scheduled = false;
      writeRecords(queue.splice(0, 8));
      requestFlush();
    }));
    safe(() => handle?.unref?.());
  };
  const emit = (record, critical = false) => {
    if (critical) {
      if (stats.criticalRecords >= 8) { stats.dropped++; return; }
      stats.criticalRecords++;
      // Priority snapshots go directly to the existing nonblocking stderr pipe, without awaiting flush.
      writeRecords([envelope({ ...record, observer: { ...stats } })]);
      return;
    }
    if (stats.records >= maxRecords || queue.length >= maxQueuedRecords) {
      stats.dropped++;
      if (!overflowReported) {
        overflowReported = true;
        queue.push(envelope({ event: "observer-overflow", furtherRecordsMayBeSuppressed: true }));
        requestFlush();
      }
      return;
    }
    stats.records++;
    queue.push(envelope(record));
    requestFlush();
  };
  const pendingDetail = (broker, pending) => ({
    request: requestId(pending), method: methodName(pending.method), internalRequest: pending.internalRequest === true,
    ownerClient: clientId(pending.client), ownerAttached: broker.clients.has(pending.client),
  });
  const reconcile = (broker, state) => {
    for (const [id, detail] of state.tracked) {
      if (broker.pending.has(id)) continue;
      state.tracked.delete(id);
      emit({ event: "detach-internal-removed", broker: state.id, ...detail, cause: "observed-absent" });
    }
  };
  const snapshot = (broker, client, context, state) => {
    const readCount = reader => count(safe(reader));
    const browserOwners = readCount(() => {
      let value = 0;
      for (const key of broker.resourceOwners.keys()) {
        if (typeof key !== "string") return null;
        if (key.startsWith("browser\0")) value++;
      }
      return value;
    });
    const counts = {
      restartRequest: readCount(() => typeof broker.restartRequest === "object" ? Number(broker.restartRequest !== null) : null),
      clients: readCount(() => broker.clients.size), pending: readCount(() => broker.pending.size),
      liveTerminals: readCount(() => broker.liveTerminals.size), threadDrains: readCount(() => broker.threadDrains.size),
      browserOwners, projectAutomationPending: readCount(() => broker.projectAutomationPendingCount),
      activeTurns: readCount(() => broker.activeTurns.size), activeAutomationThreads: readCount(() => broker.activeAutomationThreads.size),
    };
    const pending = [];
    for (const value of broker.pending.values()) {
      if (pending.length === 24) break;
      pending.push(pendingDetail(broker, value));
    }
    const attachedClients = [];
    for (const owner of broker.clients) {
      if (attachedClients.length === 16) break;
      attachedClients.push({ client: clientId(owner), channel: knownChannels.has(owner.channel) ? owner.channel : "other" });
    }
    return {
      event: "restart-pre-receive", snapshotPoint: "before-original-receive", broker: state.id, client: clientId(client),
      context: { ...context, initialized: client.initialized === true, restartAvailable: typeof broker.onRestart === "function" },
      counts, allCountsKnown: Object.values(counts).every(value => value !== null), pending, attachedClients,
      pendingDetailsTruncated: counts.pending === null || counts.pending > pending.length,
      clientDetailsTruncated: counts.clients === null || counts.clients > attachedClients.length,
    };
  };
  const before = (name, broker, args) => {
    const state = stateFor(broker);
    if (name === "detach") { state.detachDepth++; return state; }
    if (name === "receive") {
      const context = restartContext(args[1]);
      if (context) { reconcile(broker, state); emit(snapshot(broker, args[0], context, state), true); }
    }
    if (name === "routeServerMessage" && args[0] && !args[0].method) {
      const detail = state.tracked.get(args[0].id);
      return detail ? { state, id: args[0].id, detail } : null;
    }
    return state;
  };
  const after = (name, broker, args, context, returned, result) => {
    const state = stateFor(broker);
    if (name === "detach") {
      if (context) context.detachDepth--;
      reconcile(broker, state);
      emit({ event: "detach", broker: state.id, client: clientId(args[0]), clients: count(broker.clients.size), returned });
    } else if (name === "attach") {
      emit({ event: "attach", broker: state.id, client: clientId(args[0]), clients: count(broker.clients.size), returned });
    } else if (name === "sendInternalRequest" && state.detachDepth > 0 && returned) {
      const pending = broker.pending.get(result);
      if (!pending) return;
      if (state.tracked.size >= 128) { stats.dropped++; return; }
      const detail = pendingDetail(broker, pending);
      state.tracked.set(result, detail);
      emit({ event: "detach-internal-request", broker: state.id, ...detail });
    } else if (name === "routeServerMessage" && context?.detail && !broker.pending.has(context.id)) {
      state.tracked.delete(context.id);
      emit({ event: "detach-internal-settled", broker: state.id, ...context.detail,
        resultKind: Object.hasOwn(args[0], "error") ? "error" : Object.hasOwn(args[0], "result") ? "result" : "other", returned });
    }
  };
  const patches = originals.map(([name, descriptor]) => [name, descriptor, function (...args) {
    const context = safe(() => before(name, this, args));
    let returned = false, result;
    try {
      result = Reflect.apply(descriptor.value, this, args);
      returned = true;
      return result;
    } finally {
      safe(() => after(name, this, args, context, returned, result));
    }
  }]);
  for (const [name, descriptor, wrapper] of patches) Object.defineProperty(prototype, name, { ...descriptor, value: wrapper });
  const installation = {
    installed: true,
    getStats: () => ({ ...stats, queued: queue.length }),
    uninstall() {
      if (installations.get(prototype) !== installation) return;
      for (const [name, descriptor, wrapper] of patches) {
        if (Object.getOwnPropertyDescriptor(prototype, name)?.value === wrapper) Object.defineProperty(prototype, name, descriptor);
      }
      installations.delete(prototype);
    },
  };
  installations.set(prototype, installation);
  // One reserved overflow marker may be queued beyond the ordinary record capacity.
  emit({ event: "observer-installed", recordLimit: maxRecords, queueLimit: maxQueuedRecords + 1, ordinaryQueueLimit: maxQueuedRecords,
    criticalRecordLimit: 8, pendingDetailLimit: 24, clientDetailLimit: 16 });
  return installation;
}

/** Parse retained, already-redacted diagnostics without lifecycle or file I/O. */
export function parseBrokerOwnershipObserverLog(logText, gatewayLogReadError = null) {
  const taggedLines = logText.split(/\r?\n/)
    .filter(line => line.includes(BROKER_OWNERSHIP_TAG))
    .map(line => line.slice(line.indexOf(BROKER_OWNERSHIP_TAG)));
  const records = [];
  let parseFailures = 0;
  for (const line of taggedLines) {
    try {
      const record = JSON.parse(line.slice(BROKER_OWNERSHIP_TAG.length));
      if (record?.schemaVersion !== 1
          || record?.evidenceClass !== "instrumented-broker-ownership-diagnostic"
          || typeof record?.event !== "string"
          || (record.event !== "observer-install-error" && !Number.isSafeInteger(record.sequence))) {
        parseFailures++;
      } else {
        records.push(record);
      }
    } catch {
      parseFailures++;
    }
  }
  records.sort((left, right) => {
    const leftSequence = Number.isSafeInteger(left.sequence) ? left.sequence : -1;
    const rightSequence = Number.isSafeInteger(right.sequence) ? right.sequence : -1;
    return leftSequence - rightSequence;
  });

  const restartSnapshots = records.filter(record => record.event === "restart-pre-receive"
    && record.snapshotPoint === "before-original-receive");
  const observerInstalled = records.some(record => record.event === "observer-installed");
  const observerInstallErrors = records.filter(record => record.event === "observer-install-error").length;
  const overflowEvents = records.filter(record => record.event === "observer-overflow").length;
  const reasons = [];
  if (gatewayLogReadError) reasons.push("gateway-log-read-failed");
  if (!observerInstalled) reasons.push("observer-install-not-observed");
  if (observerInstallErrors > 0) reasons.push("observer-install-error-observed");
  if (parseFailures > 0) reasons.push("tagged-record-parse-failure");
  if (overflowEvents > 0) reasons.push("observer-overflow-observed");
  if (restartSnapshots.length !== 1) reasons.push("restart-snapshot-count-not-one");
  const restartSnapshot = restartSnapshots.length === 1 ? restartSnapshots[0] : null;
  const guardCountKeys = ["restartRequest", "clients", "pending", "liveTerminals", "threadDrains",
    "browserOwners", "projectAutomationPending", "activeTurns", "activeAutomationThreads"];
  if (restartSnapshot && (restartSnapshot.allCountsKnown !== true || !guardCountKeys.every(key =>
    Number.isSafeInteger(restartSnapshot.counts?.[key]) && restartSnapshot.counts[key] >= 0))) {
    reasons.push("restart-guard-counts-incomplete");
  }
  if (restartSnapshot && (restartSnapshot.context?.validRestartRequest !== true
      || restartSnapshot.context?.force !== false
      || restartSnapshot.context?.initialized !== true
      || restartSnapshot.context?.restartAvailable !== true)) reasons.push("restart-snapshot-context-incomplete");
  if (restartSnapshot && !["records", "criticalRecords", "dropped", "errors"].every(key =>
    Number.isSafeInteger(restartSnapshot.observer?.[key]) && restartSnapshot.observer[key] >= 0)) {
    reasons.push("observer-counters-incomplete");
  }
  if (restartSnapshot?.observer?.dropped > 0) reasons.push("observer-records-dropped-before-restart");
  if (restartSnapshot?.observer?.errors > 0) reasons.push("observer-errors-before-restart");

  return {
    schemaVersion: 1,
    evidenceClass: "instrumented-broker-ownership-diagnostic",
    taggedLineCount: taggedLines.length,
    validRecordCount: records.length,
    parseFailures,
    gatewayLogReadError,
    observerInstalled,
    observerInstallErrors,
    overflowEvents,
    restartSnapshotCount: restartSnapshots.length,
    allGuardCountsKnown: restartSnapshot?.allCountsKnown ?? null,
    observerCountersAtRestart: restartSnapshot?.observer ?? null,
    restartSnapshot,
    complete: reasons.length === 0,
    incompleteReasons: reasons,
    records,
  };
}

if (isOwnedGatewayObserverProcess()) {
  try {
    const { WorkspaceAppServerBroker } = await import("../../src/workspace-app-server-broker.js");
    installBrokerOwnershipObserver(WorkspaceAppServerBroker);
  } catch {
    // Observer failures cannot replace the original Gateway startup outcome or disclose exception text.
    try { process.stderr.write(`${BROKER_OWNERSHIP_TAG}{"schemaVersion":1,"event":"observer-install-error","evidenceClass":"instrumented-broker-ownership-diagnostic"}\n`); } catch {}
  }
}
