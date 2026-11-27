import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseGroupSuites } from "./harness/release-plan.mjs";
import { selectSuites, suiteEnvironmentNames } from "./harness/runner-options.mjs";
import { artifactSourceRoot, e2eDayRoot, isolatedEnvironment } from "./harness/run-context.mjs";
import { runVariantId } from "./harness/run-variant.mjs";
import { canonicalSuiteId } from "./harness/suite-sources.mjs";
import { modelIndependentSuites, realModelSuites, registeredSuites, smokeSuites } from "./suite-registry.mjs";
import {
  processTreeAlive,
  processTreeIdentity,
  signalProcessTree,
  spawnWindowsSupervised,
} from "./harness/owned-process.mjs";

const e2eRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
class SuiteNotStartedError extends Error {
  constructor() { super("E2E_SUITE_NOT_STARTED"); }
}
const usage = `Usage: node apps/kcoder-studio/e2e/run-all.mjs [options]

Options:
  --suite <selector>       Run one registered suite
  --kind <integration|e2e> Limit suites by kind
  --model-independent      Exclude real-model suites
  --real-model             Require KCODER_E2E_REAL_MODEL=1
  --full-integration       Run all model-independent suites
  --release-group <group>  Run a release qualification group
  --keep-going             Continue after a failed suite`;

export async function runCli(args, options = {}) {
  const output = options.output || console.log;
  if (args.includes("--help") || args.includes("-h")) {
    output(usage);
    return 0;
  }

  const prepare = options.prepare || prepareSuiteArtifacts;
  const executeSuites = options.executeSuites || runSuites;
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
  await prepare(requested);
  const results = await executeSuites(requested, {
    keepGoing: args.includes("--keep-going"),
    shouldRetry: suiteFailedFromNetworkChange,
  });
  const ok = results.length === requested.length && results.every(item => item.code === 0);
  output(JSON.stringify({ ok, results }, null, 2));
  return ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}

export async function prepareSuiteArtifacts(requested, options = {}) {
  requested = requested.map(canonicalSuiteId);
  const environment = options.environment || process.env;
  if (requested.length && requested.every(source => source === '../integration/gateway/windows-subagent-stream-rate.integration.mjs')) return;
  if (requested.length && requested.every(source => ['../integration/storage-installation-dialog.integration.mjs',
    '../integration/storage-account-paths.integration.mjs',
    '../integration/storage-cross-filesystem.integration.mjs',
    'suites/browser/desktop-storage-upgrade.e2e.mjs'].includes(source))) return;
  const pinnedStorage = environment.KCODER_E2E_KCODER_BIN && requested.length && requested.every(source =>
    ['suites/browser/desktop-storage-legacy-startup.e2e.mjs', 'suites/browser/desktop-storage-first-launch.e2e.mjs',
      '../integration/storage-handoff-native-boundaries.integration.mjs'].includes(source) ||
    source === 'suites/browser/desktop-storage-relocation.e2e.mjs' &&
      (environment.KCODER_E2E_STORAGE_RENDERER_MODE === 'vite' || environment.KCODER_E2E_RENDERER_ROOT));
  if (pinnedStorage) return;
  const authCostOnly = requested.length > 0 && requested.every(source => source === '../integration/gateway/browser-session-read-cost.integration.mjs');
  if (authCostOnly && (options.environment || process.env).KCODER_E2E_KCODER_BIN) return;
  const pinnedDesktopPerformance = requested.length > 0 && requested.every(source =>
    ['suites/browser/desktop-request-cost.e2e.mjs', 'suites/browser/subagent-stream-rate.e2e.mjs'].includes(source)) &&
    (options.environment || process.env).KCODER_E2E_KCODER_BIN && (options.environment || process.env).KCODER_E2E_RENDERER_ROOT;
  if (pinnedDesktopPerformance) return;
  if (requested.length && requested.every(source => source === "../integration/gateway/linux-headless-credentials.integration.mjs")) return;
  if (requested.length && requested.every(source => source === "../integration/gateway/windows-private-keyring.integration.mjs")) return;
  if (requested.length && requested.every(source => source === "../integration/gateway/windows-private-credentials.integration.mjs")) return;
  if (requested.length && requested.every(source => ["../integration/gateway/windows-keyring-logon.integration.mjs", "../integration/gateway/windows-keyring-account.integration.mjs", "../integration/gateway/windows-keyring-core.integration.mjs", "../integration/gateway/windows-keyring-host.integration.mjs"].includes(source))) return;
  if (requested.length && requested.every(source => source === "../integration/gateway/windows-archive-retention.integration.mjs")) return;
  if (requested.length && requested.every(source => source === "../integration/gateway/windows-source-transfer.integration.mjs")) return;
  if (requested.length && requested.every(source => source === "../integration/gateway/windows-cross-host-source.integration.mjs")) return;
  if (requested.length && requested.every(source => source === "../integration/gateway/windows-plugin-migration.integration.mjs")) return;
  if (requested.length && requested.every(source => source === "suites/browser/migration-large-history.e2e.mjs")) return;
  if (requested.length && requested.every(source => source === "suites/browser/packaged-desktop-smoke.e2e.mjs" || source === "suites/browser/packaged-renderer-boot.e2e.mjs" || source === "../integration/gateway/windows-wine-resources.integration.mjs" || source === "suites/browser/electron-widget-controller.e2e.mjs" || source === "../integration/gateway/windows-migration.integration.mjs" || source === "../integration/gateway/windows-migration-security.integration.mjs" || source === "../integration/gateway/windows-historical-undo.integration.mjs" || source === "../integration/gateway/windows-terminal-lifecycle.integration.mjs" || source === "../integration/gateway/windows-local-attachment.integration.mjs" || source === "../integration/gateway/windows-local-attachment-lock.integration.mjs" || source === "../integration/gateway/windows-snapshot-paths.integration.mjs" || source === "../integration/gateway/windows-profile-settings-lock.integration.mjs" || source === "../integration/gateway/windows-peer-authorization.integration.mjs")) return;
  const run = options.run || runPreparation;
  const caSuite = "../integration/gateway/plugin-target-ca.integration.mjs";
  if (requested.includes(caSuite)) {
    if (!(options.environment || process.env).KCODER_E2E_PLUGIN_CA_PROBE_BIN) {
      await run("cargo", ["build", "-p", "kcoder_plugins", "--example", "plugin_target_ca_probe"], resolve(e2eRoot, "../../.."));
    }
    if (requested.every(source => source === caSuite)) return;
  }
  await run("cargo", ["build", "-p", "kcoder_cli", "--bin", "kcoder"], resolve(e2eRoot, "../../.."));
  if (authCostOnly) return;
  const modelStdioSuite = "../integration/gateway/model-stream-stdio.integration.mjs";
  if (requested.includes(modelStdioSuite)) {
    await run("cargo", ["build", "--locked", "-p", "kcoder_cli", "--bin", "kcoder-e2e-stdio-driver", "--features", "e2e-http-transport"], resolve(e2eRoot, "../../.."));
    if (requested.every(source => source === modelStdioSuite)) return;
  }
  if (requested.every(source => source === "../integration/gateway/migration-terminal-transfer.integration.mjs")) return;
  if (requested.includes("suites/browser/migration.e2e.mjs") && !(options.environment || process.env).KCODER_MIGRATION_FIXTURE_BINARY) {
    await run("cargo", ["build", "-p", "kcoder_migration", "--example", "history_reinterpretation_fixture"], resolve(e2eRoot, "../../.."));
  }
  if (requested.includes("suites/browser/memory-native-management.e2e.mjs") && !(options.environment || process.env).KCODER_E2E_KNOWLEDGE_FIXTURE_BIN) {
    await run("cargo", ["build", "-p", "kcoder_knowledge", "--example", "native_wiki_publication_fixture"], resolve(e2eRoot, "../../.."));
  }
  const rendererRoot = resolve(e2eRoot, "../renderer");
  // Use installed build tools without triggering a package-manager dependency reinstall.
  await run(process.execPath, ["node_modules/typescript/bin/tsc", "-b"], rendererRoot);
  await run(process.execPath, ["node_modules/vite/bin/vite.js", "build"], rendererRoot);
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
  const signals = options.signalTarget || process;
  let interrupted = false;
  const stop = () => { interrupted = true; };
  signals.on("SIGINT", stop);
  signals.on("SIGTERM", stop);
  try {
    for (const source of requested) {
      if (interrupted) break;
      const startedAt = Date.now();
      const execute = async () => {
        try { return { code: await run(source) }; }
        catch (error) {
          return { code: 1, failure: error instanceof SuiteNotStartedError ? "not_started" : "ownership_unconfirmed" };
        }
      };
      let outcome = await execute();
      let attempts = 1;
      if (outcome.code !== 0 && !outcome.failure && !interrupted && options.shouldRetry) {
        let retry = false;
        try { retry = await options.shouldRetry(source, startedAt); }
        catch { outcome = { code: 1, failure: "retry_check_failed" }; }
        if (retry && !interrupted) {
          console.warn(`[e2e] ${source} 遇到 ERR_NETWORK_CHANGED，使用全新隔离环境重试一次`);
          attempts += 1;
          outcome = await execute();
        }
      }
      results.push({ source, ...outcome, durationMs: Date.now() - startedAt, ...(attempts > 1 ? { attempts } : {}) });
      if (interrupted || outcome.failure === "ownership_unconfirmed" || (outcome.code !== 0 && !options.keepGoing)) break;
    }
    return results;
  } finally {
    signals.removeListener("SIGINT", stop);
    signals.removeListener("SIGTERM", stop);
  }
}

export async function suiteFailedFromNetworkChange(suiteId, startedAt, variant = process.env.KCODER_E2E_VARIANT_ID) {
  const variantId = runVariantId(variant);
  const candidates = [];
  const source = resolve(e2eRoot, suiteId);
  const sourceRoots = new Set([artifactSourceRoot(source, new Date(startedAt)), artifactSourceRoot(source)]);
  const suiteRoots = [...sourceRoots].flatMap(root => variantId === "default" ? [resolve(root, variantId), root] : [resolve(root, variantId)]);
  for (const suiteRoot of suiteRoots) {
    const entries = await readdir(suiteRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runRoot = resolve(suiteRoot, entry.name);
      const manifest = await readFile(resolve(runRoot, "manifest.json"), "utf8").then(JSON.parse).catch(() => null);
      if (!manifest || runVariantId(manifest.variantId) !== variantId) continue;
      const info = await stat(runRoot).catch(() => null);
      if (info && info.mtimeMs >= startedAt - 1_000) candidates.push(runRoot);
    }
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
  suiteId = canonicalSuiteId(suiteId);
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
    if (suiteId === "../integration/gateway/plugin-target-ca.integration.mjs") {
      childEnv.KCODER_E2E_PLUGIN_CA_PROBE_BIN ??= resolve(e2eRoot, "../../../target/debug/examples", process.platform === "win32" ? "plugin_target_ca_probe.exe" : "plugin_target_ca_probe");
    }
    const spawnOptions = {
      cwd: resolve(e2eRoot, "../../.."),
      env: childEnv,
      detached: process.platform !== "win32",
      stdio: "inherit",
    };
    const spawnChild = options.spawnChild || spawn;
    if (process.platform === "win32" && !options.spawnChild &&
        (!process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN || !isAbsolute(process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN))) {
      throw new SuiteNotStartedError();
    }
    const supervised = process.platform === "win32" && !options.spawnChild
      ? spawnWindowsSupervised(
        process.execPath,
        [source],
        spawnOptions,
        resolve(e2eDayRoot(), "supervisors"),
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
    child.once("error", () => {
      if (stopping) return;
      if (Number.isSafeInteger(child.pid) && child.pid > 0) void stop();
      else finish(reject)(new SuiteNotStartedError());
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
