#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const nodeExecutable = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const runnerPath = resolve(repoRoot, "apps/kcoder-studio/e2e/harness/mobile-render-profile-pair-runner.mjs");
const suitePath = resolve(repoRoot, "apps/kcoder-studio/e2e/suites/mobile/mobile-render-profile.e2e.mjs");
const runtimeRoot = resolve(repoRoot, "target/private-phone-ux-implementation/nav-gateway-runtime-restored");
const sourceInputs = {
  before: {
    provenance: resolve(repoRoot, "target/private-phone-ux-implementation/before-render-export-pinned/phone-ux-provenance.json"),
    manifest: resolve(repoRoot, "target/private-phone-ux-implementation/before-render-export-pinned/mobile-web-export-mobile-high-latency-before-manifest.json"),
    bundle: resolve(repoRoot, "target/private-phone-ux-implementation/navigation-before-201311-preserved/artifacts/mobile-web-export"),
  },
  after: {
    provenance: resolve(repoRoot, "target/private-phone-ux-implementation/mobile-web-export-212651-provenance.json"),
    manifest: resolve(repoRoot, "target/private-phone-ux-implementation/mobile-web-export-212651-manifest.json"),
    bundle: resolve(repoRoot, "target/private-phone-ux-implementation/mobile-web-export-212651"),
  },
};
const pinned = {
  runnerSourceSha256: "00627dc43355cd991db9a10c5b8840e882ba9f89da3d99be6e11f14bee153f6b",
  suiteSourceSha256: "294273277f21ab76fa782cbf3650376ab15e93184806d09fb1afb5fbfc372f9d",
  runtimeManifestSha256: "f026430f4b28b9da31f33140ec5892bcf19f54ada97f77744ed6f0144a6b06eb",
  gatewaySourceTreeSha256: "d16bfd1ebb61e516e418e67d0a982860e6980fca4fa9df900fefcb71db9fa135",
  gatewayDependencyTreeSha256: "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954",
  gatewayBinaryPath: resolve(repoRoot, "target/packages/kcoder-studio-gateway/20261007T110812Z-641626d-dirty/kcoder"),
  gatewayBinarySha256: "d1c98e33084e6dc8692d0e710d22affb01ebfd79a8d60a4b37965a6d841cbcf6",
  sourceArgs: {
    before: {
      "--before-source-tree-sha256": "c2dd305c2b3dffd30285e3e4ce934b7480df4cfdf9bd3cb227d2c170d3ec2166",
      "--before-shared-input-sha256": "e3036f5495d394ce2e0fbe31fb2715d93a49533ac129ab1bd551be7b1f58905c",
      "--before-source-freeze-digest": "acf9347b8112f03af60ce4e9bb91977cceda9570e20a5ef98531c5dac0cb453d",
      "--before-dependency-source-tree-sha256": "d91f89f1237d2139ef31ee75565230105014536dc5c9a8c34bf436d0bcc7340c",
      "--before-source-provenance-sha256": "b8ab9dc8d9e58f296511869772b970517ba1b040ece3debbb86e9473df5364d1",
      "--before-export-manifest-sha256": "e2f0771adfc3fb00261a9ab277686dc24c2b44b402f0b459811fa58cfbcea261",
      "--before-source-complement-sha256": "c46ec848f89fae5f2f8528007aa746b441e5d1cf2a929be3378a87e953b38a61",
      "--before-relocation-sidecar-sha256": "07bdc9af883cbce2e5d2c017f1ea957b115b4ccc121c1ade7b3c69d4a2e77394",
    },
    after: {
      "--after-source-tree-sha256": "5a2288a059e8a6cf676ab8cbaa9833a9d0ca224fde483b20bacb4ee7bfe74515",
      "--after-shared-input-sha256": "41fce298550f98e79969c43dcf437c138b761743b0aa66df4016bef266e48f1e",
      "--after-source-freeze-digest": "5b6c54a14ae1442941b7719a53026d0825b37850fc3e1efd9aa626e96dc7806f",
      "--after-dependency-source-tree-sha256": "d91f89f1237d2139ef31ee75565230105014536dc5c9a8c34bf436d0bcc7340c",
      "--after-source-provenance-sha256": "6786e8db61db45cb4836b08a15318516fc3173f88cde47457e90fb55add5554c",
      "--after-export-manifest-sha256": "37b3114a3d609032e175af0268f2579b9381541f708ef36df8bfd9bdd3ef43cd",
    },
  },
};

assert.equal(process.execPath, nodeExecutable, "run this wrapper with the pinned Node 22.17 executable");
assert.equal(process.version, "v22.17.0", "the frozen runtime requires Node v22.17.0");
assert.equal(await hashFile(runnerPath), pinned.runnerSourceSha256, "pair runner source changed after pinning");
assert.equal(await hashFile(suitePath), pinned.suiteSourceSha256, "render profile suite source changed after pinning");
await verifyRuntimeManifest();

const fixedInputs = [
  "--before-source-provenance", sourceInputs.before.provenance,
  "--before-export-manifest", sourceInputs.before.manifest,
  "--before-bundle-root", sourceInputs.before.bundle,
  "--after-source-provenance", sourceInputs.after.provenance,
  "--after-export-manifest", sourceInputs.after.manifest,
  "--after-bundle-root", sourceInputs.after.bundle,
  "--gateway-runtime-root", runtimeRoot,
];
const preview = spawnSync(nodeExecutable, [runnerPath, ...fixedInputs], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
});
assert.equal(preview.error, undefined, `pair-runner preview failed to launch: ${preview.error?.message ?? ""}`);
assert.equal(preview.status, 0, `pair-runner preview failed: ${preview.stderr.slice(0, 1600)}`);
const preflight = JSON.parse(preview.stdout);
assert.equal(preflight.status, "PREFLIGHT_READY");
assert.equal(preflight.mode, "argv-preview-only");
assert.equal(preflight.runnerSourceSha256, pinned.runnerSourceSha256);
assert.equal(preflight.suiteSourceSha256, pinned.suiteSourceSha256);
assert.equal(preflight.coreProfiler, false);
assert.equal(preflight.browserRunsWhenExecuted, true);
assert.equal(preflight.runtime.root, runtimeRoot);
assert.equal(preflight.runtime.nodeVersion, "v22.17.0");
assert.equal(preflight.runtime.binaryPath, pinned.gatewayBinaryPath);
assert.equal(preflight.inputs.before.bundleRoot, sourceInputs.before.bundle);
assert.equal(preflight.inputs.before.exportManifestPath, sourceInputs.before.manifest);
assert.equal(preflight.inputs.before.sourceProvenancePath, sourceInputs.before.provenance);
assert.equal(preflight.inputs.before.bundleFileCount, 37);
assert.equal(preflight.inputs.before.individuallyHashedBundleFiles, 37);
assert.equal(preflight.inputs.after.bundleRoot, sourceInputs.after.bundle);
assert.equal(preflight.inputs.after.exportManifestPath, sourceInputs.after.manifest);
assert.equal(preflight.inputs.after.sourceProvenancePath, sourceInputs.after.provenance);
assert.equal(preflight.inputs.after.bundleFileCount, 37);
assert.equal(preflight.inputs.after.individuallyHashedBundleFiles, 37);
assert.ok(preflight.inputs.after.bundleSha256.startsWith("3b024c03e928"), "after Mobile Web bundle digest differs from the pinned 212651 export");
for (const [name, args] of Object.entries(pinned.sourceArgs)) {
  for (const [flag, digest] of Object.entries(args)) assertExactArg(preflight.argv, flag, digest);
  assertExactArg(preflight.argv, `--${name}-manifest`, sourceInputs[name].manifest);
  assertExactArg(preflight.argv, `--${name}-source-provenance`, sourceInputs[name].provenance);
  assertExactArg(preflight.argv, `--${name}-bundle-root`, sourceInputs[name].bundle);
}
assertExactArg(preflight.argv, "--gateway-runtime-root", runtimeRoot);
assertExactArg(preflight.argv, "--gateway-binary", pinned.gatewayBinaryPath);
assertExactArg(preflight.argv, "--gateway-binary-sha256", pinned.gatewayBinarySha256);
assertExactArg(preflight.argv, "--gateway-source-tree-sha256", pinned.gatewaySourceTreeSha256);
assertExactArg(preflight.argv, "--gateway-dependency-tree-sha256", pinned.gatewayDependencyTreeSha256);
assertExactArg(preflight.argv, "--gateway-runtime-manifest-sha256", pinned.runtimeManifestSha256);

const suiteArgv = [...preflight.argv];
replaceExactArg(suiteArgv, "--samples", "30", "1");
replaceExactArg(suiteArgv, "--sources", "before,after", "after");
replaceExactArg(suiteArgv, "--messages", "50,500,2000", "50");
replaceExactArg(suiteArgv, "--capture-stack-diagnostic", "false", "false");
assertExactArg(suiteArgv, "--samples", "1");
assertExactArg(suiteArgv, "--sources", "after");
assertExactArg(suiteArgv, "--messages", "50");
assertExactArg(suiteArgv, "--capture-stack-diagnostic", "false");

const execute = process.argv.slice(2).filter((argument) => argument === "--execute").length;
assert.ok(process.argv.slice(2).every((argument) => argument === "--execute"), "the only accepted wrapper argument is --execute");
assert.ok(execute <= 1, "--execute may appear at most once");
const report = {
  status: execute === 1 ? "PREFLIGHT_READY_TO_EXECUTE" : "PREFLIGHT_READY",
  mode: execute === 1 ? "after-50-one-sample-two-panel-debug-diagnostic" : "argv-preview-only",
  runnerSourceSha256: preflight.runnerSourceSha256,
  suiteSourceSha256: preflight.suiteSourceSha256,
  nodeVersion: process.version,
  coreProfiler: false,
  sources: ["after"],
  messages: [50],
  samplesPerPanel: 1,
  panelStates: ["unmounted", "mounted-hidden"],
  runtime: preflight.runtime,
  afterInput: preflight.inputs.after,
  exactSuiteArgv: suiteArgv,
  browserStarted: false,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (execute !== 1) process.exit(0);

report.browserStarted = true;
const child = spawn(nodeExecutable, [suitePath, ...suiteArgv], {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});
process.stdout.write(`${JSON.stringify({ phase: "suite-process-started", wrapperPid: process.pid, suitePid: child.pid, suiteSha256: pinned.suiteSourceSha256 })}\n`);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
const exit = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolveExit({ code, signal }));
});
process.exitCode = exit.code ?? 1;

async function verifyRuntimeManifest() {
  const manifestPath = resolve(runtimeRoot, "gateway-runtime-freeze.json");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.status, "complete");
  assert.equal(hashBytes(manifestBytes), pinned.runtimeManifestSha256);
  assert.equal(manifest.nodeVersion, "v22.17.0");
  assert.equal(manifest.sourceTreeSha256, pinned.gatewaySourceTreeSha256);
  assert.equal(manifest.dependencyTreeSha256, pinned.gatewayDependencyTreeSha256);
  assert.equal(manifest.runtimeInputs?.kcoderBinaryPath ?? manifest.kcoderBinaryPath, pinned.gatewayBinaryPath);
  assert.equal(manifest.runtimeInputs?.kcoderBinarySha256 ?? manifest.kcoderBinarySha256, pinned.gatewayBinarySha256);
}

function assertExactArg(argv, name, expected) {
  const matches = argv.filter((argument) => argument.startsWith(`${name}=`));
  assert.equal(matches.length, 1, `${name} must appear exactly once in validated suite argv`);
  assert.equal(matches[0], `${name}=${expected}`, `${name} differs from its pinned value`);
}

function replaceExactArg(argv, name, priorValue, nextValue) {
  const prior = `${name}=${priorValue}`;
  const indexes = argv.flatMap((argument, index) => argument === prior ? [index] : []);
  assert.equal(indexes.length, 1, `${prior} must appear exactly once before smoke narrowing`);
  argv[indexes[0]] = `${name}=${nextValue}`;
}

async function hashFile(path) {
  return hashBytes(await readFile(path));
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
