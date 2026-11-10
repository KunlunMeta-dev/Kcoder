import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import vm from "node:vm";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const BASE_COMMIT = "25a137ab";
const SERVER_PATH = "apps/kcoder-relay/src/server.mjs";
const BASE_SHA256 = "00b67c45f48fd3759c744bc8ab38d0980b3c31765c279d71b0f81557991ce499";
const BASE_BYTES = 54_992;
const CRYPTO_IMPORT = "import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';";
const PATCHED_CRYPTO_IMPORT = "import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';";
const ORIGINAL_FORWARD_HEADERS = [
  "    const headers = hopHeaders(request.headers);",
  "    headers.host = request.headers.host;",
  "    headers.connection = 'close';",
  "    if (bufferedBody) {",
].join("\n");
const PATCHED_FORWARD_HEADERS = [
  "    const headers = hopHeaders(request.headers);",
  "    headers.host = request.headers.host;",
  "    headers.connection = 'close';",
  "    // Presentation proof only; never forwarded as an API/RPC credential.",
  "    // Pairing users know this key. It attests a mount at pairing authority,",
  "    // not possession of the Relay's private registration/control secret.",
  "    delete headers['x-kcoder-mobile-mount'];",
  "    delete headers['x-kcoder-mobile-mount-proof'];",
  "    if (route.shared && gateway.pairingToken &&",
  "        (path === '/mobile-entry' || path === '/mobile' || path.startsWith('/mobile/'))) {",
  "      const prefix = `/g/${gateway.id}`;",
  "      const canonicalHost = new URL(`http://${authority}`).host;",
  "      headers['x-kcoder-mobile-mount'] = prefix;",
  "      headers['x-kcoder-mobile-mount-proof'] = createHmac('sha256', gateway.pairingToken)",
  "        .update(JSON.stringify(['kcoder-mobile-mount-v1', canonicalHost, prefix])).digest('hex');",
  "    }",
  "    if (bufferedBody) {",
].join("\n");

assert.equal(process.argv.length, 2, "This local backport verifier accepts no arguments");

await runE2E(import.meta.url, {
  testId: "mobile-relay-mount-proof-backport-local-once",
  tier: "local-contract",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 10_000,
  modelPolicy: "offline source-pinned Relay mount-header contract only; no registration, provider, public request, or production service",
}, async context => {
  const sha256 = value => createHash("sha256").update(value).digest("hex");
  const baseline = execFileSync("git", ["show", `${BASE_COMMIT}:${SERVER_PATH}`], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(Buffer.byteLength(baseline), BASE_BYTES, "pinned historical server size matches the remote source receipt");
  assert.equal(sha256(baseline), BASE_SHA256, "pinned historical server matches the exact remote source receipt");

  const patched = patchServerSource(baseline);
  const baselinePath = context.pathInState("backport-input", "server.mjs");
  const candidatePath = context.pathInArtifacts("backport", "server.mjs");
  const patchPath = context.pathInArtifacts("backport", "server.mount-proof.patch");
  await writePrivateFile(baselinePath, baseline);
  await writePrivateFile(candidatePath, patched);

  const diff = spawnSync("diff", [
    "-u", "--label", `a/${SERVER_PATH}`, "--label", `b/${SERVER_PATH}`, baselinePath, candidatePath,
  ], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  assert.equal(diff.status, 1, "the source-pinned backport produces one non-empty unified diff");
  assert.equal(diff.stderr, "", "diff completed without diagnostics");
  await writePrivateFile(patchPath, diff.stdout);

  const contract = verifyForwardHeaderContract(patched);
  const health = readHealthProjection(baseline);
  const manifest = {
    schemaVersion: 1,
    state: "PASS",
    source: { gitCommit: BASE_COMMIT, path: SERVER_PATH, sha256: BASE_SHA256, bytes: BASE_BYTES,
      matchesRemoteReceipt: true },
    package: { files: ["src/server.mjs"], dependenciesChanged: [], serverSha256: sha256(patched),
      serverBytes: Buffer.byteLength(patched), patchSha256: sha256(diff.stdout), patchBytes: Buffer.byteLength(diff.stdout) },
    change: { cryptoImportOnlyAddsBuiltinCreateHmac: true, stripsUntrustedPresentationHeaders: true,
      signsOnlySharedMobileStaticRoutes: true, configRegistryStoreCaddyUnchanged: true },
    localContract: contract,
    unauthenticatedHealthProjection: health,
    deployment: { attempted: false, productionServiceStarted: false, productionServiceRestarted: false },
  };
  await context.writeArtifactJson("backport-manifest.json", manifest);
  await context.writeArtifactJson("local-contract-evidence.json", contract);
  await context.writeArtifactJson("health-source-projection.json", health);
  return { state: "PASS", packageSha256: manifest.package.serverSha256, patchSha256: manifest.package.patchSha256 };
});

function patchServerSource(source) {
  assert.equal(count(source, CRYPTO_IMPORT), 1, "expected exactly one pinned node:crypto import");
  assert.equal(count(source, ORIGINAL_FORWARD_HEADERS), 1, "expected exactly one pinned route-forwarding block");
  assert.equal(source.includes("x-kcoder-mobile-mount"), false, "pinned source must not already contain this feature");
  return source
    .replace(CRYPTO_IMPORT, PATCHED_CRYPTO_IMPORT)
    .replace(ORIGINAL_FORWARD_HEADERS, PATCHED_FORWARD_HEADERS);
}

function verifyForwardHeaderContract(source) {
  const block = extractForwardHeadersBlock(source);
  const testSecret = randomBytes(32).toString("hex");
  const gatewayId = "local-mount-contract";
  const requestHost = "Relay.Example:8451";
  const canonicalHost = new URL(`http://${requestHost}`).host;
  const expectedMount = `/g/${gatewayId}`;
  const evidence = { state: "PASS", routes: {}, forgedHeadersRemovedEverywhere: true,
    originalOrdinaryHeadersPreserved: true, routeScopeExact: true, signatureMatchesHostIdAndPairingKey: true };

  const run = ({ path, shared = true, pairingToken = testSecret }) => {
    const incoming = {
      host: requestHost,
      connection: "keep-alive",
      accept: "application/json",
      "x-contract-probe": "preserved",
      "x-kcoder-mobile-mount": "/g/forged",
      "x-kcoder-mobile-mount-proof": "forged-proof",
    };
    const sandbox = {
      request: { headers: incoming },
      route: { shared },
      gateway: { id: gatewayId, pairingToken },
      path,
      authority: canonicalHost,
      hopHeaders: headers => ({ ...headers }),
      createHmac,
      URL,
    };
    vm.runInNewContext(`${block}\nglobalThis.__forwardedHeaders = headers;`, sandbox, { timeout: 1_000 });
    return sandbox.__forwardedHeaders;
  };

  const mobilePaths = [
    ["mobile-entry", "/mobile-entry"],
    ["mobile-root", "/mobile"],
    ["mobile-asset", "/mobile/assets/app.js"],
  ];
  for (const [label, path] of mobilePaths) {
    const headers = run({ path });
    const expectedProof = createHmac("sha256", testSecret)
      .update(JSON.stringify(["kcoder-mobile-mount-v1", canonicalHost, expectedMount])).digest("hex");
    const row = {
      mountHeaderPresent: headers["x-kcoder-mobile-mount"] !== undefined,
      mountHeaderIsSelectedGateway: headers["x-kcoder-mobile-mount"] === expectedMount,
      proofHeaderPresent: headers["x-kcoder-mobile-mount-proof"] !== undefined,
      proofMatchesHostGatewayAndPairingKey: headers["x-kcoder-mobile-mount-proof"] === expectedProof,
      forgedMountWasReplaced: headers["x-kcoder-mobile-mount"] !== "/g/forged",
      forgedProofWasReplaced: headers["x-kcoder-mobile-mount-proof"] !== "forged-proof",
      hostPreserved: headers.host === requestHost,
      ordinaryHeaderPreserved: headers["x-contract-probe"] === "preserved",
    };
    assert.equal(row.mountHeaderPresent && row.mountHeaderIsSelectedGateway, true, `${label} injects only the selected Gateway mount`);
    assert.equal(row.proofHeaderPresent && row.proofMatchesHostGatewayAndPairingKey, true, `${label} receives the expected HMAC proof`);
    assert.equal(row.forgedMountWasReplaced && row.forgedProofWasReplaced, true, `${label} cannot forward caller-forged proof headers`);
    assert.equal(row.hostPreserved && row.ordinaryHeaderPreserved, true, `${label} preserves normal routing headers`);
    evidence.routes[label] = row;
  }

  const ordinaryPaths = [
    ["ordinary-api", "/api/servers", true, testSecret],
    ["prefix-lookalike", "/mobileish/app.js", true, testSecret],
    ["legacy-route", "/mobile-entry", false, testSecret],
    ["route-without-pairing-key", "/mobile-entry", true, null],
  ];
  for (const [label, path, shared, pairingToken] of ordinaryPaths) {
    const headers = run({ path, shared, pairingToken });
    const row = {
      mountHeaderAbsent: headers["x-kcoder-mobile-mount"] === undefined,
      proofHeaderAbsent: headers["x-kcoder-mobile-mount-proof"] === undefined,
      forgedMountAbsent: headers["x-kcoder-mobile-mount"] !== "/g/forged",
      forgedProofAbsent: headers["x-kcoder-mobile-mount-proof"] !== "forged-proof",
      hostPreserved: headers.host === requestHost,
      ordinaryHeaderPreserved: headers["x-contract-probe"] === "preserved",
      connectionStillClosed: headers.connection === "close",
    };
    assert.equal(row.mountHeaderAbsent && row.proofHeaderAbsent, true, `${label} does not receive mount proof`);
    assert.equal(row.forgedMountAbsent && row.forgedProofAbsent, true, `${label} cannot forward caller-forged proof headers`);
    assert.equal(row.hostPreserved && row.ordinaryHeaderPreserved && row.connectionStillClosed, true, `${label} preserves ordinary forwarding behavior`);
    evidence.routes[label] = row;
  }
  return evidence;
}

function extractForwardHeadersBlock(source) {
  const start = source.indexOf("    const headers = hopHeaders(request.headers);\n");
  const end = source.indexOf("    if (bufferedBody) {\n", start);
  assert.ok(start >= 0 && end > start, "generated source contains the patched forwarding block");
  return source.slice(start, end).trimEnd();
}

function readHealthProjection(source) {
  const start = source.indexOf("    if (request.url === '/_relay/health') {", source.indexOf("const controlHttp"));
  const end = source.indexOf("    } else { response.writeHead(404", start);
  assert.ok(start >= 0 && end > start, "pinned control server exposes the health branch");
  const block = source.slice(start, end);
  const fields = [...block.matchAll(/^\s{8}([a-zA-Z]+):\s/gm)].map(match => match[1]);
  assert.deepEqual(fields, ["online", "connections", "pending"], "health response exposes only aggregate runtime fields");
  assert.match(block, /online:\s*gateways\.some\(gatewayOnline\)/);
  assert.match(block, /connections:\s*gateways\.reduce\(\(sum, gateway\) => sum \+ gateway\.active\.size, 0\)/);
  assert.match(block, /pending:\s*gateways\.reduce\(\(sum, gateway\) => sum \+ gateway\.pending\.size, 0\)/);
  return {
    endpoint: "/_relay/health",
    authRequiredByHandler: false,
    fields,
    onlineMeansAnyGatewayOnline: true,
    activeConnectionAggregateAvailable: true,
    pendingConnectionAggregateAvailable: true,
    perGatewayControlCountAvailable: false,
    sessionCountAvailable: false,
  };
}

async function writePrivateFile(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}

function count(text, needle) {
  return text.split(needle).length - 1;
}
