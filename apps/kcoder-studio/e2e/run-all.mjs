import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseGroupSuites } from "./harness/release-plan.mjs";
import { selectSuites, suiteEnvironmentNames } from "./harness/runner-options.mjs";
import { isolatedEnvironment } from "./harness/run-context.mjs";
import { modelIndependentSuites, realModelSuites, registeredSuites, smokeSuites } from "./suite-registry.mjs";
import {
  processTreeAlive,
  processTreeIdentity,
  signalProcessTree,
  spawnWindowsSupervised,
} from "./harness/owned-process.mjs";

const e2eRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const suiteSelected = args.includes("--suite");
  const fullIntegration = args.includes("--full-integration");
  const realModel = args.includes("--real-model");
  const releaseIndex = args.indexOf("--release-group");
  if (releaseIndex >= 0 && (suiteSelected || fullIntegration)) throw new Error("--release-group cannot be narrowed with --suite or --full-integration");
  const pool = releaseIndex >= 0 ? releaseGroupSuites(args[releaseIndex + 1]) : suiteSelected
    ? registeredSuites
    : realModel
      ? [...modelIndependentSuites, ...realModelSuites]
      : fullIntegration
        ? modelIndependentSuites
        : smokeSuites;
  const requested = selectSuites(pool, args);
  if (releaseIndex >= 0 && requested.length !== pool.length) throw new Error("Release group requires explicit real-model consent; it cannot silently omit required suites");
  await prepareSuiteArtifacts(requested);
  const results = await runSuites(requested, {
    keepGoing: process.argv.includes("--keep-going"),
    shouldRetry: suiteFailedFromNetworkChange,
  });
  console.log(JSON.stringify({ ok: results.length === requested.length && results.every(item => item.code === 0), results }, null, 2));
  if (results.length !== requested.length || results.some(item => item.code !== 0)) process.exitCode = 1;
}

export async function prepareSuiteArtifacts(requested, options = {}) {
  if (requested.length && requested.every(source => source === "suites/browser/packaged-desktop-smoke.e2e.mjs")) return;
  const run = options.run || runPreparation;
  const caSuite = "suites/gateway/plugin-target-ca.e2e.mjs";
  if (requested.includes(caSuite)) {
    if (!(options.environment || process.env).KCODER_E2E_PLUGIN_CA_PROBE_BIN) {
      await run("cargo", ["build", "-p", "kcoder_plugins", "--example", "plugin_target_ca_probe"], resolve(e2eRoot, "../../.."));
    }
    if (requested.every(source => source === caSuite)) return;
  }
  await run("cargo", ["build", "-p", "kcoder_cli", "--bin", "kcoder"], resolve(e2eRoot, "../../.."));
  const rendererRoot = resolve(e2eRoot, "../renderer");
  // Use installed build tools without triggering a package-manager dependency reinstall.
  await run(process.execPath, ["node_modules/typescript/bin/tsc", "-b"], rendererRoot);
  await run(process.execPath, ["node_modules/vite/bin/vite.js", "build"], rendererRoot);
  if (requested.some(source => source.startsWith("suites/mobile/"))) {
    await run("npm", ["run", "build:web"], resolve(e2eRoot, "../mobile"));
  }
}

function runPreparation(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: isolatedEnvironment({}, ["HOME", "CARGO_HOME", "RUSTUP_HOME", "NPM_CONFIG_CACHE"]),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} preparation failed with ${signal || `exit code ${code}`}`));
    });
  });
}

export async function runSuites(requested, options = {}) {
  const run = options.run || runNode;
  const results = [];
  for (const source of requested) {
    const startedAt = Date.now();
    let code = await run(source);
    let attempts = 1;
    if (code !== 0 && options.shouldRetry && await options.shouldRetry(source, startedAt)) {
      console.warn(`[e2e] ${source} 遇到 ERR_NETWORK_CHANGED，使用全新隔离环境重试一次`);
      code = await run(source);
      attempts += 1;
    }
    results.push({ source, code, durationMs: Date.now() - startedAt, ...(attempts > 1 ? { attempts } : {}) });
    if (code !== 0 && !options.keepGoing) break;
  }
  return results;
}

export async function suiteFailedFromNetworkChange(suiteId, startedAt) {
  const suiteRoot = resolve(
    e2eRoot,
    "../../../target/test/apps/kcoder-studio/e2e",
    suiteId,
  );
  let entries;
  try {
    entries = await readdir(suiteRoot, { withFileTypes: true });
  } catch {
    return false;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runRoot = resolve(suiteRoot, entry.name);
    const info = await stat(runRoot).catch(() => null);
    if (info && info.mtimeMs >= startedAt - 1_000) candidates.push(runRoot);
  }
  for (const runRoot of candidates) {
    const artifactsRoot = resolve(runRoot, "artifacts");
    const artifacts = await readdir(artifactsRoot, { withFileTypes: true }).catch(() => []);
    for (const artifact of artifacts) {
      if (!artifact.isFile() || !artifact.name.endsWith(".json")) continue;
      const content = await readFile(resolve(artifactsRoot, artifact.name), "utf8").catch(() => "");
      if (content.includes("ERR_NETWORK_CHANGED")) return true;
    }
  }
  return false;
}

export function runNode(suiteId, options = {}) {
  return new Promise((resolveExit, reject) => {
    const source = resolve(e2eRoot, suiteId);
    const environment = options.environment || process.env;
    const passNames = suiteEnvironmentNames(suiteId, environment);
    const childEnv = options.buildEnvironment
      ? options.buildEnvironment(passNames)
      : isolatedEnvironment({}, passNames);
    const credentialName = childEnv.KCODER_E2E_MODEL_CREDENTIAL_ENV;
    const credentialValue = childEnv.KCODER_E2E_MODEL_CREDENTIAL_VALUE;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialName || "") && credentialValue) {
      childEnv[credentialName] = credentialValue;
    }
    delete childEnv.KCODER_E2E_MODEL_CREDENTIAL_VALUE;
    childEnv.KCODER_E2E_KCODER_BIN ??= resolve(e2eRoot, "../../../target/debug", process.platform === "win32" ? "kcoder.exe" : "kcoder");
    if (suiteId === "suites/gateway/plugin-target-ca.e2e.mjs") {
      childEnv.KCODER_E2E_PLUGIN_CA_PROBE_BIN ??= resolve(e2eRoot, "../../../target/debug/examples", process.platform === "win32" ? "plugin_target_ca_probe.exe" : "plugin_target_ca_probe");
    }
    const spawnOptions = {
      cwd: resolve(e2eRoot, "../../.."),
      env: childEnv,
      detached: process.platform !== "win32",
      stdio: "inherit",
    };
    const spawnChild = options.spawnChild || spawn;
    const supervised = process.platform === "win32" && !options.spawnChild
      ? spawnWindowsSupervised(
        process.execPath,
        [source],
        spawnOptions,
        resolve(e2eRoot, "../../../target/test/apps/kcoder-studio/e2e/supervisors"),
      )
      : null;
    const child = supervised?.child || spawnChild(process.execPath, [source], spawnOptions);
    const identity = supervised?.identity || (options.identityFactory || processTreeIdentity)(child);
    const timeoutMs = Number.parseInt(environment.KCODER_E2E_SUITE_TIMEOUT_MS || "1200000", 10);
    const signalTarget = options.signalTarget || process;
    const stopTree = options.stopTree || stopSuiteTree;
    const treeAlive = options.treeAlive || processTreeAlive;
    let settled = false;
    let forcedFailure = false;
    let stopping = false;
    let leaderExit = null;
    let stopPromise = null;
    const finish = callback => (...values) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signalTarget.removeListener("SIGINT", onSigint);
      signalTarget.removeListener("SIGTERM", onSigterm);
      callback(...values);
    };
    const stop = () => {
      if (stopPromise) return stopPromise;
      stopping = true;
      forcedFailure = true;
      stopPromise = Promise.resolve().then(() => stopTree(child, identity)).then(
        finish(() => resolveExit(1)),
        finish(reject),
      );
      return stopPromise;
    };
    const onSigint = () => stop();
    const onSigterm = () => stop();
    signalTarget.once("SIGINT", onSigint);
    signalTarget.once("SIGTERM", onSigterm);
    const timeout = setTimeout(stop, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1_200_000);
    child.once("error", error => {
      if (!stopping) finish(reject)(error);
    });
    child.once("exit", (code, signal) => {
      leaderExit = { code, signal };
      if (stopping) return;
      void bounded(treeAlive(child, identity), 5_000, "suite survivor check").then(alive => {
        if (stopping) return;
        if (alive) {
          void stop();
          return;
        }
        finish(() => resolveExit(forcedFailure ? 1 : (code ?? (signal ? 1 : 0))))();
      }, () => {
        if (!stopping) void stop();
      });
    });
  });
}

async function stopSuiteTree(child, identity) {
  const failures = [];
  await bounded(signalProcessTree(child, identity, "SIGTERM"), 5_000, "suite SIGTERM")
    .catch(error => failures.push(error));
  await waitUntil(async () => !(await processTreeAlive(child, identity)), 5_000).catch(() => undefined);
  const survivedTerm = await bounded(processTreeAlive(child, identity), 5_000, "suite survivor check")
    .catch(error => { failures.push(error); return true; });
  if (survivedTerm) {
    await bounded(signalProcessTree(child, identity, "SIGKILL"), 5_000, "suite SIGKILL")
      .catch(error => failures.push(error));
  }
  const stopped = await waitUntil(async () => !(await processTreeAlive(child, identity)), 3_000)
    .then(() => true, error => { failures.push(error); return false; });
  if (!stopped || failures.length) {
    throw new AggregateError(failures, `suite process tree ${identity.pid || "unknown"} cleanup failed`);
  }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await bounded(predicate(), Math.min(1_000, timeoutMs), "suite cleanup predicate")) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`suite process tree did not stop within ${timeoutMs}ms`);
}

function bounded(promise, timeoutMs, label) {
  return new Promise((resolveBounded, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not finish within ${timeoutMs}ms`)), timeoutMs);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolveBounded(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}
