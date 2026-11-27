import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RunContext, waitFor } from "./run-context.mjs";
import { runWindowsMigrationSecurity } from "./windows-migration-security.mjs";

// These are local protocol/lifecycle tests; no Windows vault, SSH, supervisor binary, or native UI is used.
const fixture = fileURLToPath(new URL("./fixtures/wrapper-fault-child.mjs", import.meta.url));
const wrapper = fileURLToPath(new URL("./windows-ui-probe-wrapper.mjs", import.meta.url));
const rejectValue = promise => promise.then(() => assert.fail("expected rejection"), error => error);
async function owned(t, operation) {
  const run = await RunContext.create(import.meta.url, { testId: t.name, tier: "harness-unit", offline: true, processSignalTimeoutMs: 1500, streamCloseTimeoutMs: 1500 });
  const rescue = () => { void run.requestAbort(new Error("Owned wrapper fault test aborted")).catch(() => {}); };
  t.signal.addEventListener("abort", rescue, { once: true });
  t.after(async () => {
    if (!run.finished) {
      await run.requestAbort(new Error("Owned wrapper fault test rescue"));
      await run.finish("failed", { boundary: "local Node fixture rescue" });
    }
  });
  let failure;
  try { await operation(run); }
  catch (error) { failure = error; throw error; }
  finally {
    try {
      await run.finish(failure ? "failed" : "passed", { boundary: "complete module source with synthetic Windows boundaries; local Node pipes/exits" }, failure);
      await assert.rejects(access(run.stateDir), { code: "ENOENT" });
      const manifest = JSON.parse(await readFile(join(run.runRoot, "manifest.json"), "utf8"));
      assert.ok(manifest.processes.every(record => record.stopped));
      assert.ok(manifest.cleanupSteps.every(step => step.status === "completed"));
    } finally {
      t.signal.removeEventListener("abort", rescue);
      console.log(`Owned wrapper fault evidence: ${run.runRoot}`);
    }
  }
}
function localChild(run, label, mode, ...args) {
  return run.spawnOwned(label, process.execPath, ["--experimental-vm-modules", fixture, mode, ...args], { stdin: "pipe" });
}

for (const fault of ["epipe", "callback", "event", "synchronous", "exit", "signal", "success"]) {
  test(`model-independent migration security exported entry ${fault} has one owned terminal without replay`, { timeout: 10000 }, t => owned(t, async run => {
    const helper = run.pathInState("helper.exe"), helperBytes = Buffer.from("local helper fixture bytes");
    await writeFile(helper, helperBytes);
    const baselineSource = "b".repeat(40), parent = "D:\\virtual";
    const options = { consent: "1", target: "owned@127.0.0.1", parent, helper,
      helperSha256: createHash("sha256").update(helperBytes).digest("hex"), baselineSource };
    const peer = localChild(run, "security-peer", "hold");
    const stops = [], spawned = [], remoteCleanups = [];
    let commandChild, commandLabel, originalWriteError, writes = 0;
    const overrides = {
      spawnOwned(label, _command, args, settings) {
        const index = args.indexOf("-EncodedCommand"), script = index >= 0 ? Buffer.from(args[index + 1], "base64").toString("utf16le") : "";
        let mode = "output", output = "";
        if (script.includes("Owned path collision")) {
          const owner = script.match(/kcoder-package-([a-f0-9-]{36})/)[1];
          output = JSON.stringify(parent + "\\kcoder-package-" + owner) + "\n";
        } else if (settings.stdin === "pipe") {
          commandLabel = label;
          mode = fault === "epipe" ? "closed-stdin" : ["exit", "signal"].includes(fault) ? fault : fault === "success" ? "output" : "hold";
          if (fault === "success") output = JSON.stringify({ evidenceClass: "synthetic local Node protocol fixture", baselineSource,
            paths: { status: "passed" }, osVault: { status: "passed", fileBackendUsed: false, cleanup: { systemEntryAbsenceVerified: true } } });
        }
        const child = localChild(run, label, mode, output); spawned.push(label);
        if (settings.stdin === "pipe") {
          commandChild = child;
          const write = child.stdin.write.bind(child.stdin);
          child.stdin.write = (input, callback) => {
            writes++;
            if (fault === "epipe") { child.stdout.once("data", () => write(input, callback)); return false; }
            if (["callback", "event", "synchronous"].includes(fault)) {
              originalWriteError ??= Object.assign(new Error(`synthetic ${fault} security write failure`), { code: "EPIPE" });
              if (fault === "synchronous") throw originalWriteError;
              queueMicrotask(() => fault === "event" ? child.stdin.emit("error", originalWriteError) : callback(originalWriteError));
              return false;
            }
            return write(input, callback);
          };
        }
        return child;
      },
      async stopOwned(label) { stops.push(label); await run.stopOwned(label); },
      addCleanup(label, callback) {
        // Transport mapping allocates no remote credential or directory to clean.
        remoteCleanups.push({ label, callback });
      },
    };
    const context = new Proxy(run, { get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
    } });
    const operation = runWindowsMigrationSecurity(context, options);
    if (fault === "success") {
      const result = await operation;
      assert.equal(result.evidenceClass, "synthetic local Node protocol fixture");
      assert.equal(commandChild.exitCode, 0); assert.deepEqual(stops, []);
    } else {
      const error = await rejectValue(operation);
      assert.equal(error.outcome, "UNKNOWN"); assert.equal(error.ownedProcessLabel, commandLabel);
      assert.equal(run.processes.get(commandLabel).stopped, true);
      assert.deepEqual(stops, [commandLabel]);
      if (["epipe", "callback", "event", "synchronous"].includes(fault)) assert.equal(error.code, "EPIPE");
      if (originalWriteError) assert.equal(error, originalWriteError);
      if (fault === "exit") assert.equal(error.exitCode, 23);
      if (fault === "signal") assert.equal(error.signalCode, "SIGTERM");
    }
    assert.equal(writes, 1); assert.equal(spawned.filter(label => label === commandLabel).length, 1);
    assert.equal(remoteCleanups.length, 1); assert.equal(peer.exitCode, null); assert.equal(peer.signalCode, null);
  }));
}

async function uiFixture(run, { workerMode = "zero-after-eof", leaseClose = false } = {}) {
  const owner = randomUUID(), inputFile = run.pathInState("input.json");
  await writeFile(inputFile, JSON.stringify({ owner, directory: "C:\\owned", installation: "C:\\installed", node: "C:\\node.exe", mode: "migration", fixtureWorkerMode: workerMode }));
  await writeFile(run.pathInState(".owner.json"), JSON.stringify({ owner }));
  const child = localChild(run, "ui-wrapper-module", leaseClose ? "ui-driver-lease-close" : "ui-driver", wrapper, inputFile);
  const events = []; let pending = "";
  child.stdin.on("error", error => events.push({ fixtureEvent: "owner-write-error", code: error.code }));
  child.stdout.on("data", data => {
    pending += data;
    for (;;) {
      const end = pending.indexOf("\n"); if (end < 0) break;
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      events.push(JSON.parse(line));
    }
  });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  return { child, owner, events, closed };
}

test("model-independent complete UI wrapper source keeps zero for a connected owner and confirmed zero child", { timeout: 10000 }, t => owned(t, async run => {
  const fixture = await uiFixture(run, { workerMode: "normal-zero" });
  fixture.child.stdin.write(JSON.stringify({ owner: fixture.owner }) + "\n");
  assert.deepEqual(await fixture.closed, { code: 0, signal: null });
  assert.equal(fixture.events.find(row => row.fixtureEvent === "supervisor-closed").code, 0);
  assert.equal(fixture.events.find(row => row.fixtureEvent === "module-evaluated").wrapperExitCode, 0);
}));

test("model-independent complete UI wrapper source retains owner EOF failure after the actual child exits zero", { timeout: 10000 }, t => owned(t, async run => {
  const fixture = await uiFixture(run);
  fixture.child.stdin.write(JSON.stringify({ owner: fixture.owner }) + "\n");
  await waitFor(() => fixture.events.find(row => row.fixtureEvent === "worker-ready"), 2000, "owned UI worker readiness");
  fixture.child.stdin.end();
  assert.deepEqual(await fixture.closed, { code: 2, signal: null });
  assert.equal(fixture.events.find(row => row.fixtureEvent === "supervisor-closed").code, 0);
  assert.equal(fixture.events.find(row => row.fixtureEvent === "module-evaluated").wrapperExitCode, 2);
}));

test("model-independent complete UI wrapper source starts no supervisor after EOF before the owner lease", { timeout: 10000 }, t => owned(t, async run => {
  const fixture = await uiFixture(run);
  fixture.child.stdin.end();
  assert.notEqual((await fixture.closed).code, 0);
  assert.equal(fixture.events.find(row => row.fixtureEvent === "module-failed").supervisorStarts, 0);
  assert.equal(fixture.events.filter(row => row.fixtureEvent === "supervisor-spawned").length, 0);
}));

test("model-independent complete UI wrapper source starts no supervisor when lease and EOF share a read turn", { timeout: 10000 }, t => owned(t, async run => {
  const fixture = await uiFixture(run, { leaseClose: true });
  fixture.child.stdin.write(JSON.stringify({ owner: fixture.owner }) + "\n");
  assert.deepEqual(await fixture.closed, { code: 2, signal: null });
  assert.equal(fixture.events.find(row => row.fixtureEvent === "module-evaluated").supervisorStarts, 0);
  assert.equal(fixture.events.filter(row => row.fixtureEvent === "supervisor-spawned").length, 0);
}));
