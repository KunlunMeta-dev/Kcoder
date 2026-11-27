import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RunContext, waitFor } from "./run-context.mjs";
import { startPhysicalWidgetSsh } from "./physical-widget-ssh.mjs";
import { startWindowsRemoteStudio } from "./windows-remote-studio.mjs";

// The real exported entries use owned local Node children through a test-only transport mapping.
// No SSH account, Windows command, compiler, installation, or remote directory is accessed.
const fixture = fileURLToPath(new URL("./fixtures/transport-fault-child.mjs", import.meta.url));
const rejected = promise => promise.then(() => assert.fail("operation must reject"), error => error);
async function owned(t, operation) {
  const run = await RunContext.create(import.meta.url, { testId: t.name, tier: "harness-unit", offline: true, processSignalTimeoutMs: 1500, streamCloseTimeoutMs: 1500 });
  const onAbort = () => { void run.requestAbort(new Error("Owned transport fault test aborted")).catch(() => {}); };
  t.signal.addEventListener("abort", onAbort, { once: true });
  t.after(async () => {
    if (!run.finished) {
      await run.requestAbort(new Error("Owned transport fault test rescue"));
      await run.finish("failed", { boundary: "local Node transport fixture rescue" });
    }
  });
  let failure;
  try { await operation(run); }
  catch (error) { failure = error; throw error; }
  finally {
    try {
      await run.finish(failure ? "failed" : "passed", { boundary: "local Node protocol/lifecycle mapping; not SSH or Windows acceptance" }, failure);
      await assert.rejects(access(run.stateDir), { code: "ENOENT" });
      const manifest = JSON.parse(await readFile(join(run.runRoot, "manifest.json"), "utf8"));
      assert.ok(manifest.processes.every(record => record.stopped));
      assert.ok(manifest.cleanupSteps.every(step => step.status === "completed"));
    } finally {
      t.signal.removeEventListener("abort", onAbort);
      console.log(`Owned transport fault evidence: ${run.runRoot}`);
    }
  }
}
function mappedContext(run, mapping) {
  const remoteCleanups = new Map(), stops = [], children = new Map();
  const overrides = {
    spawnOwned(label, command, args, options) {
      const mapped = mapping(label, command, args, options);
      const child = run.spawnOwned(label, process.execPath, [fixture, mapped.mode, mapped.output ?? ""], options);
      children.set(label, child);
      mapped.afterSpawn?.(child);
      return child;
    },
    addCleanup(label, callback) {
      // The mapping allocates no remote root; retain its callback for explicit protocol assertions.
      if (label === "release verified physical widget root" || label === "remove owned Windows directory") remoteCleanups.set(label, callback);
      else run.addCleanup(label, callback);
    },
    async stopOwned(label) { stops.push(label); await run.stopOwned(label); },
  };
  const context = new Proxy(run, { get(target, key) {
    if (Object.hasOwn(overrides, key)) return overrides[key];
    const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
  } });
  return { context, remoteCleanups, stops, children };
}
async function physical(run) {
  const adapter = mappedContext(run, label => ({ mode: label === "physical-widget-controller" ? "controller" : label === "physical-widget-provider-forward" ? "forward" : "output" }));
  const knownHosts = run.pathInState("known-hosts"), binary = run.pathInState("binary");
  await writeFile(knownHosts, "owned fixture host\n"); await writeFile(binary, "owned fixture bytes\n");
  const controller = await startPhysicalWidgetSsh(adapter.context, { target: "owned@127.0.0.1", key: run.pathInState("key"), knownHosts, binary, localProviderPort: 49778 });
  return { ...adapter, controller, child: adapter.children.get("physical-widget-controller"), cleanup: adapter.remoteCleanups.get("release verified physical widget root") };
}
const windowsOptions = { target: "owned@127.0.0.1", windowsBinary: "/virtual/kcoder.exe", installation: "C:\\virtual", node: "C:\\virtual\\node.exe", localOnly: true };
async function windows(run, fault, { diagnosticFailure = false } = {}) {
  let failingChild, failingLabel, injectedError;
  const adapter = mappedContext(run, (label, _command, args, options) => {
    const encodedIndex = args.indexOf("-EncodedCommand");
    const script = encodedIndex >= 0 ? Buffer.from(args[encodedIndex + 1], "base64").toString("utf16le") : "";
    if (script.includes("Owned path collision")) {
      const owner = script.match(/kcoder-package-([a-f0-9-]{36})/)[1];
      return { mode: "output", output: JSON.stringify(`C:\\virtual\\kcoder-package-${owner}`) + "\n" };
    }
    if (script.includes("Test-Path -LiteralPath")) return { mode: diagnosticFailure && failingChild ? "exit" : "output", output: "False\n" };
    if (options.stdin === "pipe") {
      failingLabel = label;
      return { mode: fault === "epipe" ? "closed-stdin" : ["exit", "signal", "output-limit"].includes(fault) ? fault : "hold",
        afterSpawn(child) {
          failingChild = child;
          if (fault === "epipe") {
            const write = child.stdin.write.bind(child.stdin);
            child.stdin.write = (input, callback) => { child.stdout.once("data", () => write(input, callback)); return false; };
          } else if (fault === "callback" || fault === "synchronous" || fault === "event") {
            injectedError = Object.assign(new Error(`synthetic ${fault} transport failure`), { code: "EPIPE" });
            child.stdin.write = (_input, callback) => {
              if (fault === "synchronous") throw injectedError;
              queueMicrotask(() => fault === "event" ? child.stdin.emit("error", injectedError) : callback(injectedError));
              return false;
            };
          }
        } };
    }
    return { mode: "output" };
  });
  const studio = await startWindowsRemoteStudio(adapter.context, windowsOptions);
  return { ...adapter, studio, get child() { return failingChild; }, get label() { return failingLabel; }, get injectedError() { return injectedError; } };
}

test("model-independent physical controller normal receipts and cleanup settle through the exported entry", { timeout: 10000 }, t => owned(t, async run => {
  const transport = await physical(run);
  assert.deepEqual(await transport.controller.configure({}), { configured: true });
  await transport.cleanup();
  assert.equal(transport.controller.verifyCleaned(), true);
  assert.equal(transport.child.exitCode, 0);
}));

for (const fault of ["exit", "signal", "invalid-json", "output-close"]) {
  test(`model-independent physical controller ${fault} actively rejects all pending requests without cleanup replay`, { timeout: 10000 }, t => owned(t, async run => {
    const transport = await physical(run);
    const peer = run.spawnOwned("transport-peer", process.execPath, [fixture, "hold"]);
    const writes = [], write = transport.child.stdin.write.bind(transport.child.stdin);
    transport.child.stdin.write = (input, callback) => { writes.push(JSON.parse(input).action); return write(input, callback); };
    const startedAt = performance.now();
    const results = await Promise.allSettled([transport.controller.configure({ transportFault: "defer" }), transport.controller.configure({ transportFault: fault })]);
    assert.ok(performance.now() - startedAt < 1500);
    assert.equal(results[0].status, "rejected"); assert.equal(results[1].status, "rejected");
    const original = results[0].reason;
    assert.equal(results[1].reason, original); assert.equal(original.outcome, "UNKNOWN");
    assert.equal(await rejected(transport.cleanup()), original);
    assert.deepEqual(writes, ["configure", "configure"]);
    assert.equal(transport.controller.verifyCleaned(), false);
    assert.equal(peer.exitCode, null); assert.equal(peer.signalCode, null);
    if (fault === "signal") {
      await waitFor(() => transport.child.signalCode, 1000, "owned controller signal");
      assert.equal(original.signalCode, "SIGTERM");
    }
  }));
}

for (const fault of ["epipe", "callback", "synchronous", "event"]) {
  test(`model-independent physical controller ${fault} preserves the original write error and clears pending timers`, { timeout: 10000 }, t => owned(t, async run => {
    const transport = await physical(run);
    let injectedError;
    if (fault === "epipe") {
      assert.deepEqual(await transport.controller.configure({ transportFault: "closed-stdin" }), { armed: true });
    } else {
      injectedError = Object.assign(new Error(`synthetic ${fault} write failure`), { code: "EPIPE" });
      transport.child.stdin.write = (_input, callback) => {
        if (fault === "synchronous") throw injectedError;
        queueMicrotask(() => fault === "event" ? transport.child.stdin.emit("error", injectedError) : callback(injectedError));
        return false;
      };
    }
    const original = await rejected(transport.controller.configure({}));
    assert.equal(original.code, "EPIPE"); assert.equal(original.outcome, "UNKNOWN");
    if (injectedError) assert.equal(original, injectedError);
    assert.equal(await rejected(transport.cleanup()), original);
    assert.equal(transport.controller.verifyCleaned(), false);
  }));
}

for (const fault of ["epipe", "callback", "synchronous", "event", "exit", "signal", "output-limit"]) {
  test(`model-independent Windows exported entry ${fault} settles the original request and stops only its command owner`, { timeout: 15000 }, t => owned(t, async run => {
    const transport = await windows(run, fault, { diagnosticFailure: fault === "callback" });
    const peer = run.spawnOwned("windows-transport-peer", process.execPath, [fixture, "hold"]);
    const startedAt = performance.now();
    const original = await rejected(transport.studio.run("remote-oauth", {}));
    assert.ok(performance.now() - startedAt < 4000);
    assert.equal(original.outcome, "UNKNOWN"); assert.equal(original.ownedProcessLabel, transport.label);
    assert.ok(transport.stops.includes(transport.label));
    assert.equal(run.processes.get(transport.label).stopped, true);
    assert.equal(peer.exitCode, null); assert.equal(peer.signalCode, null);
    if (["epipe", "callback", "synchronous", "event"].includes(fault)) assert.equal(original.code, "EPIPE");
    if (transport.injectedError) assert.equal(original, transport.injectedError);
    if (fault === "callback") assert.equal(original.diagnosticErrors.length, 1);
    if (fault === "signal") assert.equal(original.signalCode, "SIGTERM");
    if (fault === "exit") assert.equal(original.exitCode, 23);
    if (fault === "output-limit") assert.equal(original.code, "EOUTPUTLIMIT");
    assert.ok(transport.stops.every(label => label !== "windows-transport-peer"));
  }));
}
