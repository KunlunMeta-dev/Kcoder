import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runE2E, waitFor } from "./run-context.mjs";
import { runWindowsMigrationSecurity } from "./windows-migration-security.mjs";
import { startWindowsRemoteStudio } from "./windows-remote-studio.mjs";
import { awaitOwnedDesktopActor } from "./windows-desktop-action-entry.cjs";

function artifactScope(context, prefix) {
  return {
    writeArtifactJson: (name, value) => context.writeArtifactJson(`${prefix}-${name}`, value),
    pathInArtifacts: name => context.pathInArtifacts(`${prefix}-${name}`),
  };
}
function createCaseRecorder(context) {
  const cases = [];
  return { cases, runCase: async (id, body) => {
    try { cases.push({ id, status: "PASS", ...await body() }); }
    catch (error) { cases.push({ id, status: "FAIL", error: context.redactText(error.stack ?? String(error)) }); }
    await context.writeArtifactJson(`windows-protocol-case-progress-${String(cases.length).padStart(2, "0")}.json`, { cases: cases.slice() });
  } };
}
if (process.argv.includes("--self-test-local-recording")) {
  await runE2E(import.meta.url, { testId: "windows-protocol-append-only-case-recorder", tier: "harness-unit",
    modelPolicy: "Local append-only artifact and per-call namespace tests only; no Windows, SSH, Job, CLI or vault." }, async context => {
    const { cases, runCase } = createCaseRecorder(context);
    await runCase("first", async () => ({ value: 1 }));
    await runCase("second", async () => ({ value: 2 }));
    await runCase("failed-case", async () => { throw new Error("Synthetic recorded failure"); });
    assert.deepEqual(cases.map(row => row.status), ["PASS", "PASS", "FAIL"]);
    for (let count = 1; count <= 3; count++) {
      const saved = JSON.parse(await readFile(context.pathInArtifacts(`windows-protocol-case-progress-${String(count).padStart(2, "0")}.json`), "utf8"));
      assert.equal(saved.cases.length, count);
    }
    const first = artifactScope(context, "first-call"), second = artifactScope(context, "second-call");
    await first.writeArtifactJson("producer-input.json", { call: 1 });
    await second.writeArtifactJson("producer-input.json", { call: 2 });
    assert.equal(JSON.parse(await readFile(first.pathInArtifacts("producer-input.json"), "utf8")).call, 1);
    assert.equal(JSON.parse(await readFile(second.pathInArtifacts("producer-input.json"), "utf8")).call, 2);
    return { appendOnlyCheckpoints: 3, isolatedProducerArtifactCalls: 2 };
  });
  process.exit(0);
}
assert.equal(process.platform, "win32");
assert.equal(process.env.KCODER_E2E_WINDOWS_PROTOCOL_CONSENT, "1");
const root = resolve(process.env.KCODER_PROTOCOL_ROOT ?? "");
const descriptor = JSON.parse(await readFile(join(root, "protocol-input.json"), "utf8"));
assert.equal(JSON.parse(await readFile(join(root, ".owner.json"), "utf8")).owner, descriptor.owner);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
assert.equal(digest(await readFile(process.execPath)), descriptor.nodeSha256);
assert.equal(digest(await readFile(process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN)), descriptor.supervisorSha256);
for (const row of descriptor.sources) assert.equal(digest(await readFile(join(root, row.path))), row.sha256);
const worker = fileURLToPath(new URL("./fixtures/windows-protocol-worker.cjs", import.meta.url));
const rejected = promise => promise.then(() => assert.fail("Expected an owned failure"), error => error);

await runE2E(import.meta.url, { testId: "actual-windows-headless-protocol-owner-acceptance", tier: "native-platform",
  modelPolicy: "User-authorized synthetic Windows Node/Job protocol only; no CLI, vault, desktop, external model or account changes." }, async context => {
  const { cases, runCase } = createCaseRecorder(context);
  const raw = new Map();
  let sequence = 0;
  async function stopRaw(record) {
    if (record.closed) return;
    record.child.stdin?.destroy();
    if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill();
    await Promise.race([record.closedPromise, new Promise((_, reject) => {
      record.stopTimer = setTimeout(() => reject(new Error("Original raw fixture close unconfirmed")), 5000);
    })]).finally(() => clearTimeout(record.stopTimer));
  }
  function rawChild(label, mode, output = "", { executable = process.execPath, args, env } = {}) {
    assert.equal(raw.has(label), false);
    const child = spawn(executable, args ?? [worker, mode, output], { cwd: context.stateDir,
      env: env ?? context.isolatedEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const record = { label, child, closed: false, firstError: null, stdout: "", stderr: "" };
    record.closedPromise = new Promise(resolveClose => child.once("close", (code, signal) => {
      record.closed = true; record.exitCode = code; record.signalCode = signal; resolveClose({ code, signal });
    }));
    // This exact child is inside the outer native Job and is registered before awaited work.
    context.addCleanup(`close held raw fixture ${label}`, () => stopRaw(record));
    raw.set(label, record);
    child.on("error", error => { record.firstError ??= error; });
    child.stdin.on("error", error => { record.firstError ??= error; });
    child.stdout.on("data", data => { record.stdout = (record.stdout + data).slice(-131072); });
    child.stderr.on("data", data => { record.stderr = (record.stderr + data).slice(-8192); });
    return record;
  }
  function transportContext(mode) {
    const state = { writes: 0, label: null, originalError: null, remoteCleanupNotAllocated: true, stops: [] };
    const overrides = {
      ...artifactScope(context, `protocol-case-${cases.length + 1}-${mode}`),
      spawnOwned(label, _command, args, options) {
        const index = args.indexOf("-EncodedCommand");
        const script = index >= 0 ? Buffer.from(args[index + 1], "base64").toString("utf16le") : "";
        let childMode = "output", output = "";
        if (script.includes("Owned path collision")) {
          output = JSON.stringify("D:\\synthetic\\kcoder-package-" + script.match(/kcoder-package-([a-f0-9-]{36})/)[1]);
        } else if (script.includes("Test-Path -LiteralPath")) output = "False";
        else if (options.stdin === "pipe") { childMode = mode === "epipe" ? "closed-stdin" : "hold"; state.label = label; }
        const record = rawChild(label + "-" + (++sequence), childMode, output);
        state.lastRecord = record;
        if (options.stdin === "pipe") {
          state.commandRecord = record;
          const write = record.child.stdin.write.bind(record.child.stdin);
          record.child.stdin.write = (input, callback) => {
            state.writes++;
            if (mode === "epipe") { record.child.stdout.once("data", () => write(input, callback)); return false; }
            state.originalError ??= Object.assign(new Error("Injected Windows write callback failure"), { code: "EPIPE" });
            queueMicrotask(() => callback(state.originalError)); return false;
          };
        }
        return record.child;
      },
      async stopOwned(label) {
        state.stops.push(label);
        assert.equal(label, state.label);
        await stopRaw(state.commandRecord);
      },
      // Mapped transport commands create no remote directory or credential authority.
      addCleanup() {},
    };
    state.context = new Proxy(context, { get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
    } });
    return state;
  }
  await runCase("actual-job-desktop-error-and-peer", async () => {
    const child = context.spawnOwned("native-desktop-original", process.execPath, [worker, "hold"], { env: context.isolatedEnvironment() });
    const peer = context.spawnOwned("native-desktop-peer", process.execPath, [worker, "hold"], { env: context.isolatedEnvironment() });
    const original = context.processes.get("native-desktop-original");
    const peerRecord = context.processes.get("native-desktop-peer");
    let originalOutput = "", peerOutput = "";
    child.stdout.on("data", data => { originalOutput += data; });
    peer.stdout.on("data", data => { peerOutput += data; });
    await Promise.all([original.identity.readyPromise, peerRecord.identity.readyPromise]);
    await waitFor(() => originalOutput.includes("OWNED_PROTOCOL_WORKER_READY") && peerOutput.includes("OWNED_PROTOCOL_WORKER_READY"), 10000, "both actual Windows Job workers");
    const primary = new Error("Injected nonterminal Windows supervisor ChildProcess error");
    const pending = awaitOwnedDesktopActor(child, original.identity, { exitTimeoutMs: 1500 });
    child.emit("error", primary);
    assert.equal(await rejected(pending), primary);
    assert.equal(original.identity.closed, true); assert.equal(peer.exitCode, null);
    assert.equal(peer.signalCode, null);
    await context.stopOwned("native-desktop-original");
    await context.stopOwned("native-desktop-peer");
    return { primaryErrorPreserved: true, originalSupervisorCloseConfirmed: true, peerSurvivedUntilOwnCleanup: true,
      internalCloseIsNotOuterJobEmptyReceipt: true };
  });
  for (const mode of ["epipe", "callback"]) await runCase(`migration-security-${mode}`, async () => {
    const helper = context.pathInState(`synthetic-helper-${mode}.exe`), bytes = Buffer.from("not an executable: synthetic protocol fixture");
    await writeFile(helper, bytes);
    const transport = transportContext(mode);
    const error = await rejected(runWindowsMigrationSecurity(transport.context, { consent: "1", target: "synthetic@127.0.0.1",
      parent: "D:\\synthetic", helper, helperSha256: digest(bytes), baselineSource: "b".repeat(40) }));
    assert.equal(error.code, "EPIPE"); assert.equal(error.outcome, "UNKNOWN");
    assert.equal(transport.writes, 1); assert.equal(transport.commandRecord.closed, true);
    if (transport.originalError) assert.equal(error, transport.originalError);
    return { platform: process.platform, actualOsPipe: mode === "epipe", writeCount: 1, originalOwnerClosed: true,
      realSshOrVaultUsed: false, unknownOutcomePreserved: true };
  });
  await runCase("remote-studio-os-epipe", async () => {
    const transport = transportContext("epipe");
    const studio = await startWindowsRemoteStudio(transport.context, { target: "synthetic@127.0.0.1", windowsBinary: "C:\\synthetic\\never-started.exe",
      installation: "C:\\synthetic", node: "C:\\synthetic\\node.exe", localOnly: true, parent: "D:\\synthetic" });
    const error = await rejected(studio.run("remote-oauth", {}));
    assert.equal(error.code, "EPIPE"); assert.equal(error.outcome, "UNKNOWN");
    assert.equal(transport.writes, 1); assert.equal(transport.commandRecord.closed, true);
    return { platform: process.platform, actualOsPipe: true, writeCount: 1, originalOwnerClosed: true, realSshOrOAuthUsed: false };
  });
  for (const lostOwner of [false, true]) await runCase(`actual-ui-wrapper-owner-${lostOwner ? "eof" : "connected"}`, async () => {
    const directory = context.pathInState(`ui-${lostOwner ? "eof" : "normal"}`), owner = randomUUID();
    await mkdir(directory);
    await writeFile(join(directory, ".owner.json"), JSON.stringify({ owner }));
    await copyFile(worker, join(directory, "probe.cjs"));
    const input = join(directory, "input.json");
    await writeFile(input, JSON.stringify({ owner, directory, node: process.execPath, installation: root, mode: "migration" }));
    const environment = context.isolatedEnvironment({ KCODER_PROTOCOL_UI_MODE: lostOwner ? "ui-hold" : "ui-zero" });
    const record = rawChild(`actual-ui-${lostOwner ? "eof" : "normal"}`, "", "", { args: [fileURLToPath(new URL("./windows-ui-probe-wrapper.mjs", import.meta.url)), input], env: environment });
    record.child.stdin.write(JSON.stringify({ owner }) + "\n");
    await waitFor(() => record.stdout.includes("OWNED_PROTOCOL_WORKER_READY") || record.closed && (() => { throw new Error(record.stderr); })(), 10000, "actual Windows UI synthetic worker");
    if (lostOwner) record.child.stdin.end();
    const closed = await Promise.race([record.closedPromise, new Promise((_, reject) => {
      record.caseTimer = setTimeout(() => reject(new Error("Actual Windows wrapper close unconfirmed")), 15000);
    })]).finally(() => clearTimeout(record.caseTimer));
    assert.equal(closed.code, lostOwner ? 2 : 0);
    const birth = JSON.parse(await readFile(join(directory, "probe-owner.json"), "utf8"));
    assert.equal(birth.owner, owner); assert.equal(birth.pid, record.child.pid); assert.match(birth.creationTicks, /^\d+$/);
    return { wrapperExitCode: closed.code, ownerEof: lostOwner, originalWrapperCloseConfirmed: true,
      actualCreationTicks: birth.creationTicks, actualInnerWindowsSupervisorUsed: true, realUiOrCliUsed: false,
      childZeroAfterOwnerEofLogicalCase: "covered by prior complete-source VM test; native EOF may terminate the Job with nonzero" };
  });
  const result = { platform: process.platform, owner: descriptor.owner, cases, allPassed: cases.every(row => row.status === "PASS"),
    nodeSha256: descriptor.nodeSha256, supervisorSha256: descriptor.supervisorSha256,
    boundary: "actual headless Windows Node/Job only; raw protocol fixtures are descendants of the outer native Job",
    physicalWidgetSshEntry: "NOT_APPLICABLE: POSIX local SSH path requirements; not reinterpreted as Windows host support",
    rawChildReceipts: [...raw.values()].map(record => ({ label: record.label, pid: record.child.pid, closed: record.closed,
      exitCode: record.exitCode ?? null, signalCode: record.signalCode ?? null, firstErrorCode: record.firstError?.code ?? null,
      authority: "original held ChildProcess close inside the outer native Job; numeric PID is evidence only" })),
    rootJobEmptyReceiptRequiredFromLocalOwner: true };
  await context.writeArtifactJson("windows-protocol-native-result.json", result);
  await writeFile(join(root, "native-result.json"), JSON.stringify(context.redactValue(result), null, 2));
  assert.equal(result.allPassed, true, "One or more Windows headless protocol cases failed");
  return result;
});
