import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createMobileLatencyHelpers } from "../harness/mobile-latency-helpers.mjs";
import { appRoot, repoRoot, runE2E } from "../harness/run-context.mjs";

const EXPECTED_NODE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const EXPECTED_MOBILE_WEB_STATIC_SHA256 = "1c57090fb35ac007620021a365e805f14d16a12a5b39f192bb7bd5f0a1bc1f66";
const EXPECTED_SOURCE_FILE_COUNT = 74;
const EXPECTED_DEPENDENCY_FILE_COUNT = 1034;
const EXPECTED_KCODER_BINARY = resolve(repoRoot, "target/private-b6-device-revoke-20261009/build-03/owned-kcoder-copy");
const EXPECTED_KCODER_BINARY_SHA256 = "bc985854134edffc02415a5d9e72f8905fdc23e7e2263e84f9554e53619dec29";

assert.equal(process.execPath, EXPECTED_NODE, "Gateway freeze must use the pinned Node 22.17.0 executable");
assert.equal(process.version, "v22.17.0", "Gateway freeze must use Node 22.17.0");

await runE2E(import.meta.url, {
  testId: "mobile-gateway-runtime-freeze-after-dotted-route-fix",
  tier: "local-input-freeze",
  modelPolicy: "copy and verify the current Gateway source/dependency inputs only; no Gateway, Browser, network, provider, or Mobile export",
  retainSuccessLogs: true,
}, async context => {
  const latencyHelpers = createMobileLatencyHelpers({
    sha256: bytes => createHash("sha256").update(bytes).digest("hex"),
  });
  const gatewayRuntime = await latencyHelpers.prepareGatewayRuntimeSnapshot(context, null, EXPECTED_KCODER_BINARY, EXPECTED_KCODER_BINARY_SHA256);
  const manifest = gatewayRuntime.manifest;
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.sourceFiles.length, EXPECTED_SOURCE_FILE_COUNT);
  assert.equal(manifest.dependencyFiles.length, EXPECTED_DEPENDENCY_FILE_COUNT);
  const mobileWebStatic = manifest.sourceFiles.find(file => file.path === "src/mobile-web-static.js");
  assert.ok(mobileWebStatic, "Gateway freeze must include the Mobile static handler");
  assert.equal(mobileWebStatic.sha256, EXPECTED_MOBILE_WEB_STATIC_SHA256);

  const result = {
    status: "PASS",
    scope: "Gateway-only immutable source/dependency snapshot; no Mobile export or runtime launch",
    gatewayRoot: gatewayRuntime.root,
    gatewayManifestPath: gatewayRuntime.manifestPath,
    gatewayManifestSha256: gatewayRuntime.manifestSha256,
    sourceTreeSha256: manifest.sourceTreeSha256,
    sourceFileCount: manifest.sourceFiles.length,
    mobileWebStaticSha256: mobileWebStatic.sha256,
    dependencyTreeSha256: manifest.dependencyTreeSha256,
    dependencyFileCount: manifest.dependencyFiles.length,
    nodeExecutable: manifest.nodeExecutable,
    nodeVersion: manifest.nodeVersion,
    kcoderBinaryPath: manifest.runtimeInputs.kcoderBinaryPath,
    kcoderBinarySha256: manifest.runtimeInputs.kcoderBinarySha256,
    copiedSourceMatchesWorkspace: manifest.sourceTreeSha256 === manifest.workspaceSourceTreeSha256,
    copiedDependenciesMatchWorkspace: manifest.dependencyTreeSha256 === manifest.workspaceDependencyTreeSha256,
    appRootRelative: appRoot.replace(`${repoRoot}/`, ""),
    noGatewayOrBrowserStarted: true,
  };
  assert.equal(result.copiedSourceMatchesWorkspace, true);
  assert.equal(result.copiedDependenciesMatchWorkspace, true);
  await context.writeArtifactJson("gateway-runtime-freeze-receipt.json", result);
  return result;
});
