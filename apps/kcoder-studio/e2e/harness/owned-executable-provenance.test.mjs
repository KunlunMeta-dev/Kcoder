import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { RunContext, waitFor } from "./run-context.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "./owned-executable-provenance.mjs";

test("owned executable provenance is limited to the requested process group and path", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "owned-executable-provenance-process-group-boundary",
  });
  let status = "passed";
  try {
    const fixtureRoot = context.pathInState("proc-fixture");
    const procRoot = resolve(fixtureRoot, "proc");
    const executablePath = resolve(fixtureRoot, "bin/kcoder");
    const unrelatedExecutablePath = resolve(fixtureRoot, "bin/node");
    await mkdir(procRoot, { recursive: true });
    await mkdir(resolve(fixtureRoot, "bin"), { recursive: true });
    await writeFile(executablePath, Buffer.from("owned backend bytes\n"));
    await writeFile(unrelatedExecutablePath, Buffer.from("unrelated executable bytes\n"));
    await addProcess(procRoot, 4001, 4001, executablePath);
    await addProcess(procRoot, 4002, 4001, unrelatedExecutablePath);
    await addProcess(procRoot, 4003, 9000, executablePath);

    const configuredBinary = await hashExecutableFile(executablePath);
    assert.equal(
      configuredBinary.sha256,
      createHash("sha256").update("owned backend bytes\n").digest("hex"),
    );
    assert.equal(configuredBinary.path, executablePath);
    assert.equal(configuredBinary.size, Buffer.byteLength("owned backend bytes\n"));
    assert.ok(configuredBinary.mtime);

    const processes = await findOwnedExecutableProcesses({
      pgid: 4001,
      executablePath,
      procRoot,
    });
    assert.deepEqual(processes, [{
      pid: 4001,
      executablePath,
      sha256: configuredBinary.sha256,
    }]);
    assert.deepEqual(Object.keys(processes[0]).sort(), ["executablePath", "pid", "sha256"]);
    assert.equal(await exists(resolve(procRoot, "4001/cmdline")), false);
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await context.finish(status, { scopedToOwnedProcessGroup: status === "passed" });
  }

  const manifest = JSON.parse(await readFile(resolve(context.runRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "passed");
  assert.equal(await exists(resolve(context.runRoot, "state")), false);
});

test("owned executable provenance reads the executable of a live RunContext child", {
  skip: process.platform !== "linux",
}, async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "owned-executable-provenance-live-process",
  });
  let status = "passed";
  try {
    const child = context.spawnOwned(
      "owned-node-fixture",
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
    );
    const expected = await hashExecutableFile(process.execPath);
    const observed = await waitFor(async () => {
      const processes = await findOwnedExecutableProcesses({
        pgid: child.pid,
        executablePath: expected.path,
      });
      return processes.length ? processes : null;
    }, 5_000, "owned executable provenance");
    assert.ok(observed.some(process => process.sha256 === expected.sha256));
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await context.finish(status, { liveOwnedExecutableObserved: status === "passed" });
  }

  const manifest = JSON.parse(await readFile(resolve(context.runRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "passed");
  assert.ok(manifest.processes.some(process =>
    process.label === "owned-node-fixture" && process.stopped === true,
  ));
  assert.ok(manifest.cleanupSteps.some(step =>
    step.label === "stop process owned-node-fixture" && step.status === "completed",
  ));
  assert.equal(await exists(resolve(context.runRoot, "state")), false);
});

async function addProcess(procRoot, pid, pgid, executablePath) {
  const processRoot = resolve(procRoot, String(pid));
  await mkdir(processRoot, { recursive: true });
  await writeFile(resolve(processRoot, "stat"), processStat(pid, pgid));
  await symlink(executablePath, resolve(processRoot, "exe"));
}

function processStat(pid, pgid) {
  const fields = ["S", "1", String(pgid)];
  while (fields.length < 19) fields.push("0");
  fields.push("123456");
  return String(pid) + " (test process with ) in name) " + fields.join(" ") + "\n";
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
