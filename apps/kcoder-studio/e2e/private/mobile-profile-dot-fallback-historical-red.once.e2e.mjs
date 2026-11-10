import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const HISTORICAL_SOURCE = {
  path: "target/private-phone-ux-implementation/p1a-r1-request-diagnostic-20261009/reproduce-mobile-profile-dot-fallback.mjs",
  sha256: "b11dc779c8da872349060ee8d95e096d9413587616f60a8a9a20f65bef5bc4c2",
};
const HISTORICAL_RESULT = {
  path: "target/private-phone-ux-implementation/p1a-r1-request-diagnostic-20261009/reproduce-mobile-profile-dot-fallback.result.json",
  sha256: "bed24c6ef2584402c1459c3938c7d5a13ab7be6958babe3df7a01af3019ba98b",
};
const FROZEN_GATEWAY_SOURCE = {
  path: "target/test/apps/kcoder-studio/e2e/private/mobile-sessions-current-dist-touch-control.once.e2e.mjs/20261009-185033.033Z/artifacts/gateway-runtime-frozen/src/mobile-web-static.js",
  sha256: "b52c71913c346f8072a921a237a6f9f547af85fd8ca88aeeea01a73e5eeb710b",
};
const OFFICIAL_MOBILE_MANIFEST = {
  path: "target/test/apps/kcoder-studio/e2e/private/mobile-web-export-9925461c.once.e2e.mjs/20261009-181452.098Z/artifacts/official-mobile-dist-9925461c/kcoder-mobile-web.json",
  sha256: "7ce760cfc9aabc14dd8fee65043c6ded400bb2f0eccf6d3f04930f8403b23d13",
};

await runE2E(import.meta.url, {
  testId: "mobile-profile-dot-fallback-historical-red-reproduction",
  tier: "local-diagnostic",
  modelPolicy: "offline direct-handler reproduction against the retained pre-fix Gateway snapshot; not current-product validation",
  retainSuccessLogs: true,
}, async context => {
  const gatewaySourcePath = resolve(repoRoot, FROZEN_GATEWAY_SOURCE.path);
  const mobileManifestPath = resolve(repoRoot, OFFICIAL_MOBILE_MANIFEST.path);
  const gatewaySourceBytes = await readFile(gatewaySourcePath);
  const mobileManifestBytes = await readFile(mobileManifestPath);
  assert.equal(sha256(gatewaySourceBytes), FROZEN_GATEWAY_SOURCE.sha256, "historical Gateway source pin changed");
  assert.equal(sha256(mobileManifestBytes), OFFICIAL_MOBILE_MANIFEST.sha256, "historical official Mobile manifest pin changed");

  const { createMobileWebStatic } = await import(pathToFileURL(gatewaySourcePath).href);
  const distRoot = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e/private/mobile-web-export-9925461c.once.e2e.mjs/20261009-181452.098Z/artifacts/official-mobile-dist-9925461c");
  const pairingToken = "diagnostic-only-not-a-real-token";
  const publicOrigin = "https://gateway.example.test";
  const canonicalHost = "gateway.example.test";
  const prefix = "/g/p1a-diagnostic";
  const mountProof = createHmac("sha256", pairingToken)
    .update(JSON.stringify(["kcoder-mobile-mount-v1", canonicalHost, prefix]))
    .digest("hex");
  const handler = createMobileWebStatic({
    root: distRoot,
    publicOrigins: [publicOrigin],
    pairingToken,
    directPort: () => 43127,
    contentSecurityPolicy: "default-src 'self'",
  });

  const request = async pathname => {
    let status = null;
    let headers = null;
    let bodyBytes = 0;
    const response = {
      writeHead(code, value) { status = code; headers = value; },
      end(value) { if (value !== undefined) bodyBytes = Buffer.byteLength(value); },
    };
    const req = {
      url: pathname,
      method: "GET",
      headers: {
        host: canonicalHost,
        "x-kcoder-mobile-mount": prefix,
        "x-kcoder-mobile-mount-proof": mountProof,
      },
      socket: { encrypted: true },
    };
    const handled = await handler(req, response, pathname);
    return {
      handled,
      status,
      contentType: headers?.["content-type"] ?? null,
      contentLength: Number(headers?.["content-length"] ?? 0),
      bodyBytes,
    };
  };

  // This mirrors the Git992 profile-id construction: dots from the normalized
  // loopback origin and dot-joined path codepoints are valid identifier bytes.
  const syntheticProfileId = "http---127.0.0.1-42823-2f-mock-1";
  assert.ok(syntheticProfileId.includes("."));
  const dottedProfile = await request(`/mobile/h/${syntheticProfileId}`);
  const noDotControl = await request("/mobile/h/profile-control");
  assert.equal(dottedProfile.handled, true);
  assert.equal(noDotControl.handled, true);
  assert.equal(dottedProfile.status, 404);
  assert.equal(noDotControl.status, 200);

  const evidence = {
    classification: "historical-red-reproduction; expected to reproduce the pre-fix 404",
    sourceMigration: {
      oldStandaloneSourcePath: HISTORICAL_SOURCE.path,
      oldStandaloneSourceSha256: HISTORICAL_SOURCE.sha256,
      oldStandaloneResultPath: HISTORICAL_RESULT.path,
      oldStandaloneResultSha256: HISTORICAL_RESULT.sha256,
      canonicalSourceWasExecuted: false,
    },
    inputPins: {
      frozenGatewaySourcePath: FROZEN_GATEWAY_SOURCE.path,
      frozenGatewaySourceSha256: FROZEN_GATEWAY_SOURCE.sha256,
      officialMobileManifestPath: OFFICIAL_MOBILE_MANIFEST.path,
      officialMobileManifestSha256: OFFICIAL_MOBILE_MANIFEST.sha256,
    },
    signedMount: true,
    profileIdShapeMatchesSource: true,
    dottedProfile,
    noDotControl,
    scope: "direct handler invocation only; no server, browser, network, credential, or current-product claim",
  };
  await context.writeArtifactJson("historical-mobile-profile-dot-fallback-red.json", evidence);
  return evidence;
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
