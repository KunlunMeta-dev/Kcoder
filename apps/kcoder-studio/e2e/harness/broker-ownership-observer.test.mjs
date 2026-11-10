import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { BROKER_OWNERSHIP_TAG, brokerOwnershipDiagnosticGatewayOptions, installBrokerOwnershipObserver, isOwnedGatewayObserverProcess, parseBrokerOwnershipObserverLog } from "./broker-ownership-observer.mjs";

const restart = force => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "gateway/app-server/restart", params: { confirm: true, force } });
const secret = "PAYLOAD_TOKEN_WORKSPACE_CLIENT_LABEL_MUST_NEVER_APPEAR";

function fixture(t, options = {}) {
  class Broker {
    clients = new Set(); pending = new Map(); liveTerminals = new Set(); threadDrains = new Map();
    resourceOwners = new Map(); activeTurns = new Map(); activeAutomationThreads = new Set();
    restartRequest = null; projectAutomationPendingCount = 0; nextId = 1;
    onRestart() {}
    calls = [];
    attach(...args) { this.calls.push(["attach", this, args]); this.clients.add(args[0]); return this.result; }
    detach(...args) {
      this.calls.push(["detach", this, args]);
      this.clients.delete(args[0]);
      if (this.cleanupMethod) this.cleanupId = this.sendInternalRequest(this.cleanupMethod, { secret });
      return this.result;
    }
    receive(...args) {
      this.calls.push(["receive", this, args]);
      if (this.failure) throw this.failure;
      return this.result;
    }
    sendInternalRequest(...args) {
      this.calls.push(["sendInternalRequest", this, args]);
      const id = this.nextId++;
      this.pending.set(id, { method: args[0], params: args[1], internalRequest: true, client: null });
      return id;
    }
    routeServerMessage(...args) { this.calls.push(["routeServerMessage", this, args]); this.pending.delete(args[0].id); return this.result; }
  }
  const chunks = [], scheduled = [];
  const original = Object.getOwnPropertyDescriptor(Broker.prototype, "receive");
  const observer = installBrokerOwnershipObserver(Broker, {
    write: chunk => chunks.push(chunk), schedule: callback => scheduled.push(callback), ...options,
  });
  t.after(() => observer.uninstall());
  const flush = () => { while (scheduled.length) scheduled.shift()(); };
  const records = () => chunks.join("").split("\n").filter(Boolean).map(line => {
    assert.ok(line.startsWith(BROKER_OWNERSHIP_TAG));
    return JSON.parse(line.slice(BROKER_OWNERSHIP_TAG.length));
  });
  return { Broker, broker: new Broker(), chunks, scheduled, observer, flush, records, original };
}

test("preload scope requires explicit owner, exact Gateway entry and main process", () => {
  const scope = {
    env: { KCODER_E2E_BROKER_OWNERSHIP_OBSERVER: "1", KCODER_E2E_BROKER_OWNERSHIP_OBSERVER_OWNER_PID: "42" },
    argv: ["node", fileURLToPath(new URL("../../dev-server.mjs", import.meta.url))], parentPid: 42, mainThread: true,
  };
  assert.equal(isOwnedGatewayObserverProcess(scope), true);
  assert.equal(isOwnedGatewayObserverProcess({ ...scope, env: {} }), false);
  assert.equal(isOwnedGatewayObserverProcess({ ...scope, argv: ["node", "other/dev-server.mjs"] }), false);
  assert.equal(isOwnedGatewayObserverProcess({ ...scope, parentPid: 43 }), false);
  assert.equal(isOwnedGatewayObserverProcess({ ...scope, mainThread: false }), false);
  assert.equal(isOwnedGatewayObserverProcess({ ...scope, env: { ...scope.env, KCODER_E2E_BROKER_OWNERSHIP_OBSERVER_OWNER_PID: "42-secret" } }), false);
});

test("diagnostic configuration defaults off and does not inherit host NODE_OPTIONS", () => {
  assert.equal(brokerOwnershipDiagnosticGatewayOptions({ env: {} }), null);
  assert.equal(brokerOwnershipDiagnosticGatewayOptions({ env: { KCODER_E2E_SETTINGS_BROKER_DIAGNOSTICS: "true" } }), null);
  const configured = brokerOwnershipDiagnosticGatewayOptions({
    env: { KCODER_E2E_SETTINGS_BROKER_DIAGNOSTICS: "1", NODE_OPTIONS: "--require=HOST_ONLY" }, ownerPid: 42,
  });
  assert.equal(configured.env.KCODER_E2E_BROKER_OWNERSHIP_OBSERVER, "1");
  assert.equal(configured.env.KCODER_E2E_BROKER_OWNERSHIP_OBSERVER_OWNER_PID, "42");
  assert.ok(configured.env.NODE_OPTIONS.startsWith("--import=file:"));
  assert.equal(configured.env.NODE_OPTIONS.includes("HOST_ONLY"), false);
  assert.equal(configured.redactedStderrDiagnostics.artifactName, "broker-ownership-stderr.json");
});

test("wrappers preserve receiver, argument references, result and Promise identity without synchronous ordinary writes", t => {
  const { broker, chunks, flush } = fixture(t);
  const client = { channel: "runtime", initialized: true };
  const extra = { secret };
  const result = Promise.resolve(extra);
  broker.result = result;
  assert.equal(broker.attach(client, extra), result);
  assert.equal(broker.receive(client, "unrelated", extra), result);
  assert.equal(broker.detach(client, extra), result);
  assert.equal(chunks.length, 0);
  for (const [, receiver, args] of broker.calls) {
    assert.equal(receiver, broker);
    assert.equal(args[0], client);
    assert.equal(args.at(-1), extra);
  }
  flush();
  assert.ok(chunks.length > 0);
});

test("original synchronous throw survives observer read, writer and scheduler failures", t => {
  const { broker, observer } = fixture(t, {
    write() { throw new Error(secret); }, schedule() { throw new Error(secret); },
  });
  const failure = { secret };
  broker.failure = failure;
  Object.defineProperty(broker, "resourceOwners", { get() { throw new Error(secret); } });
  assert.throws(() => broker.receive({ initialized: true }, restart(false)), error => error === failure);
  assert.ok(observer.getStats().errors > 0);
});

test("a failed diagnostic write cannot replace a successful result or the original thrown object", t => {
  const { broker, observer } = fixture(t, { write() { throw new Error(secret); } });
  const client = { initialized: true };
  const result = Promise.resolve({ secret });
  broker.result = result;
  assert.equal(broker.receive(client, restart(false)), result);
  const failure = { secret };
  broker.failure = failure;
  assert.throws(() => broker.receive(client, restart(false)), error => error === failure);
  assert.ok(observer.getStats().errors >= 2);
});

test("priority restart snapshot carries every guard count and excludes payloads and arbitrary labels", t => {
  const { broker, flush, records, chunks } = fixture(t);
  const client = { channel: "runtime", initialized: true, name: secret, url: secret, authorization: secret };
  const peer = { channel: secret, label: secret };
  broker.attach(client); broker.attach(peer);
  broker.pending.set(secret, { method: secret, params: { secret }, client: peer });
  broker.liveTerminals.add(secret); broker.threadDrains.set(secret, { secret });
  broker.resourceOwners.set(`browser\0${secret}`, peer);
  broker.resourceOwners.set(`attachment\0${secret}`, peer);
  broker.activeTurns.set(secret, { owner: peer }); broker.activeAutomationThreads.add(secret);
  broker.projectAutomationPendingCount = 2; broker.restartRequest = { client: peer, id: secret };
  broker.receive(client, restart(false));
  const observed = records().find(record => record.event === "restart-pre-receive");
  assert.ok(observed, "critical snapshot must be written without waiting for the ordinary queue");
  assert.deepEqual(observed.counts, {
    restartRequest: 1, clients: 2, pending: 1, liveTerminals: 1, threadDrains: 1,
    browserOwners: 1, projectAutomationPending: 2, activeTurns: 1, activeAutomationThreads: 1,
  });
  assert.equal(observed.allCountsKnown, true);
  assert.deepEqual(observed.context, { validRestartRequest: true, force: false, initialized: true, restartAvailable: true });
  assert.equal(observed.pending[0].method, "other");
  assert.equal(observed.pending[0].ownerAttached, true);
  assert.equal(observed.attachedClients[1].channel, "other");
  flush();
  assert.equal(chunks.join("").includes(secret), false);
});

test("malformed restart context emits no guard snapshot and missing counts stay unknown", t => {
  const { broker, flush, records } = fixture(t);
  const client = { initialized: true };
  for (const raw of ["{", restart("false"), JSON.stringify({ jsonrpc: "2.0", id: 1, method: "gateway/app-server/restart", params: { confirm: true, force: false, token: secret } })]) {
    broker.receive(client, raw);
  }
  flush();
  assert.equal(records().some(record => record.event === "restart-pre-receive"), false);
  broker.projectAutomationPendingCount = undefined;
  Object.defineProperty(broker, "resourceOwners", { get() { throw new Error(secret); } });
  broker.receive(client, restart(true));
  const observed = records().find(record => record.event === "restart-pre-receive");
  assert.equal(observed.counts.projectAutomationPending, null);
  assert.equal(observed.counts.browserOwners, null);
  assert.equal(observed.allCountsKnown, false);
  assert.equal(observed.context.force, true);
});

test("detach cleanup response is correlated anonymously, while timeout disappearance is explicitly uncertain", t => {
  const { broker, flush, records, chunks } = fixture(t);
  const client = { initialized: true, channel: "runtime" };
  broker.cleanupMethod = "thread/automation/suspend";
  broker.attach(client); broker.detach(client);
  const response = { id: broker.cleanupId, result: { token: secret } };
  const result = Promise.resolve(response);
  broker.result = result;
  assert.equal(broker.routeServerMessage(response), result);
  broker.attach(client); broker.detach(client);
  broker.pending.delete(broker.cleanupId);
  broker.receive(client, restart(false));
  flush();
  const created = records().filter(record => record.event === "detach-internal-request");
  const settled = records().find(record => record.event === "detach-internal-settled");
  const removed = records().find(record => record.event === "detach-internal-removed");
  assert.equal(created.length, 2);
  assert.equal(settled.request, created[0].request);
  assert.equal(settled.resultKind, "result");
  assert.equal(removed.request, created[1].request);
  assert.equal(removed.cause, "observed-absent");
  assert.equal(chunks.join("").includes(secret), false);
});

test("bounded ordinary records and overflow preserve reserved restart evidence", t => {
  const { broker, flush, records, observer } = fixture(t, { maxRecords: 2, maxQueuedRecords: 2 });
  const client = { initialized: true };
  for (let i = 0; i < 20; i++) broker.attach(client);
  assert.ok(observer.getStats().dropped > 0);
  broker.receive(client, restart(false));
  flush();
  const installed = records().find(record => record.event === "observer-installed");
  assert.equal(installed.ordinaryQueueLimit, 2);
  assert.equal(installed.queueLimit, 3);
  assert.equal(records().filter(record => record.event === "observer-overflow").length, 1);
  assert.equal(records().filter(record => record.event === "restart-pre-receive").length, 1);
  assert.ok(records().length <= 4);
  assert.ok(records().find(record => record.event === "restart-pre-receive").observer.dropped > 0);
});

test("installation does not double wrap and uninstall restores original descriptors", t => {
  const { Broker, observer, original } = fixture(t);
  assert.equal(installBrokerOwnershipObserver(Broker).installed, false);
  observer.uninstall();
  assert.deepEqual(Object.getOwnPropertyDescriptor(Broker.prototype, "receive"), original);
  const replacement = installBrokerOwnershipObserver(Broker, { write() {}, schedule() {} });
  t.after(() => replacement.uninstall());
  observer.uninstall();
  assert.equal(installBrokerOwnershipObserver(Broker).installed, false, "a stale uninstaller must not remove another observer's ownership marker");
  replacement.uninstall();
  assert.deepEqual(Object.getOwnPropertyDescriptor(Broker.prototype, "receive"), original);
  assert.equal(installBrokerOwnershipObserver(class {}).installed, false);
});

function diagnosticRecords() {
  const envelope = (event, sequence, detail = {}) => ({
    schemaVersion: 1, evidenceClass: "instrumented-broker-ownership-diagnostic", event, sequence, ...detail,
  });
  return [envelope("observer-installed", 1), envelope("restart-pre-receive", 3, {
    snapshotPoint: "before-original-receive", allCountsKnown: true,
    counts: { restartRequest: 0, clients: 1, pending: 0, liveTerminals: 0, threadDrains: 0,
      browserOwners: 0, projectAutomationPending: 0, activeTurns: 0, activeAutomationThreads: 0 },
    context: { validRestartRequest: true, force: false, initialized: true, restartAvailable: true },
    observer: { records: 2, criticalRecords: 1, dropped: 0, errors: 0 },
  }), envelope("attach", 2)];
}
const diagnosticLog = records => records.map(record => `${BROKER_OWNERSHIP_TAG}${JSON.stringify(record)}\n`).join("");

test("parser restores event sequence when the critical snapshot precedes ordinary batches", () => {
  const records = diagnosticRecords();
  const parsed = parseBrokerOwnershipObserverLog(`unrelated Gateway log\n${diagnosticLog([records[1], records[2], records[0]])}`);
  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.records.map(record => record.sequence), [1, 2, 3]);
  assert.equal(parsed.restartSnapshot.counts.clients, 1);
  assert.equal(parsed.restartSnapshotCount, 1);
});

test("parser refuses completeness for missing, null, invalid or declared-unknown guard counts", () => {
  const cases = [
    record => { delete record.counts.pending; },
    record => { record.counts.pending = null; },
    record => { record.counts.pending = "0"; },
    record => { record.counts.pending = -1; },
    record => { record.allCountsKnown = false; },
  ];
  for (const mutate of cases) {
    const records = diagnosticRecords();
    mutate(records[1]);
    const parsed = parseBrokerOwnershipObserverLog(diagnosticLog(records));
    assert.equal(parsed.complete, false);
    assert.ok(parsed.incompleteReasons.includes("restart-guard-counts-incomplete"));
  }
});

test("parser preserves incomplete evidence for missing snapshots, overflow, parse failure and observer faults", () => {
  const cases = [
    { change: records => records.splice(1, 1), reason: "restart-snapshot-count-not-one" },
    { change: records => records.shift(), reason: "observer-install-not-observed" },
    { change: records => records.push({ ...records[0], event: "observer-overflow", sequence: 4 }), reason: "observer-overflow-observed" },
    { change: records => { records[1].observer.dropped = 1; }, reason: "observer-records-dropped-before-restart" },
    { change: records => { records[1].observer.errors = 1; }, reason: "observer-errors-before-restart" },
    { change: records => { delete records[1].observer.errors; }, reason: "observer-counters-incomplete" },
    { suffix: `${BROKER_OWNERSHIP_TAG}{invalid JSON\n`, reason: "tagged-record-parse-failure" },
    { readError: "owned-log-read-failed", reason: "gateway-log-read-failed" },
  ];
  for (const { change, suffix = "", readError = null, reason } of cases) {
    const records = diagnosticRecords();
    change?.(records);
    const parsed = parseBrokerOwnershipObserverLog(diagnosticLog(records) + suffix, readError);
    assert.equal(parsed.complete, false);
    assert.ok(parsed.incompleteReasons.includes(reason), reason);
    if (suffix) assert.equal(parsed.parseFailures, 1);
  }
});
