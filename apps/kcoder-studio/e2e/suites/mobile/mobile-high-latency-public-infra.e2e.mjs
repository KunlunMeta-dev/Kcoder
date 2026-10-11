import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { access, copyFile, lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { startRelay } from "../../../../kcoder-relay/src/server.mjs";
import { startRegisteredClient } from "../../../../kcoder-relay/src/client.mjs";
import { readRegisteredClientIdentity } from "../../../../kcoder-relay/src/client-identity.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const execFileAsync = promisify(execFile);
const cloudHost = process.env.KCODER_E2E_PUBLIC_INFRA_SSH_TARGET || "aliyun";
const publicOrigin = "https://hyf2333.top:8451";
const publicTestOrigin = "https://hyf2333.top";
const allowedTestOrigins = [publicOrigin, publicTestOrigin];
const allowedTestHosts = ["hyf2333.top:8451", "hyf2333.top"];
const expectedCaddySha256 = "05f6cab324663aed662c318ff54b30b67fa7ef36299419be63a8ba1bda71a511";
const frozenMobileRoot = resolve(process.env.KCODER_E2E_FROZEN_MOBILE_WEB_ROOT || resolve(
  repoRoot,
  "target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-ux.e2e.mjs/20261007-180005.682Z/artifacts/mobile-web-export",
));
const expectedMobileBundleSha256 = "44e7916aa3cf104b5f9b95666b50f2c44b74a776cc3a55f817c204011ec63b64";
const sourceGuard = process.env.KCODER_E2E_PUBLIC_INFRA === "1";
assert.ok(sourceGuard, "Set KCODER_E2E_PUBLIC_INFRA=1 only for the authorized manual public-path setup");

await runE2E(import.meta.url, {
  testId: "mobile-high-latency-public-infrastructure",
  tier: "manual-live",
  modelPolicy: "temporary isolated Relay, two registered KCODER_STUDIO_MOCK Gateways, public route preparation only; no model request",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 15_000,
}, async context => {
  const runMarker = context.seed;
  const registrationKey = randomBytes(32).toString("base64url");
  const pairingTokens = {
    alpha: randomBytes(32).toString("base64url"),
    beta: randomBytes(32).toString("base64url"),
  };
  for (const secret of [registrationKey, ...Object.values(pairingTokens)]) context.registerSecret(secret);

  const placeholderRoot = context.pathInState("mobile-web-root");
  const mobileWebBaseline = await copyFrozenMobileWeb(placeholderRoot, frozenMobileRoot);
  const workspaces = {};
  const gateways = {};
  const clients = {};
  const ids = {};

  const relayStore = context.pathInState("relay-registration-store.json");
  const relay = await startRelay({
    gateways: [],
    sharedHosts: allowedTestHosts,
    registrationKey,
    registrationStoreFile: relayStore,
    controlPort: 0,
    proxyPort: 0,
  });
  context.registerPort("isolated-relay-control-loopback", relay.controlPort);
  context.registerPort("isolated-relay-data-loopback", relay.proxyPort);
  context.addCleanup("close isolated test Relay and private registration store", () => relay.close());

  for (const name of ["alpha", "beta"]) {
    workspaces[name] = (await materializeWorkspace(context, "minimal", { instanceId: `phone-public-${name}` })).path;
    const serversFile = await context.writeStateJson(`servers-${name}.json`, [{
      id: `public-fixture-${name}`,
      label: `Public UX fixture ${name}`,
      runtime: "kcoder",
      transport: "local",
      command: process.execPath,
      workspace: workspaces[name],
    }]);
    gateways[name] = await startGateway(context, {
      auth: false,
      label: `phone-public-gateway-${name}`,
      workspace: workspaces[name],
      serversFile,
      env: {
        KCODER_CONFIG_DIR: context.pathInState(`config-${name}`),
        KCODER_STUDIO_MOCK: "1",
        KCODER_STUDIO_PUBLIC_ORIGINS: allowedTestOrigins.join(","),
        KCODER_STUDIO_MOBILE_WEB_ORIGINS: allowedTestOrigins.join(","),
        KCODER_STUDIO_WEB_ROOT: placeholderRoot,
      },
    });
    const identityFile = context.pathInState(`relay-client-${name}.json`);
    let online = false;
    clients[name] = await startRegisteredClient({
      url: `http://127.0.0.1:${relay.controlPort}`,
      registrationKey,
      pairingToken: pairingTokens[name],
      identityFile,
      gateway: gateways[name].baseUrl,
      allowInsecure: true,
      onOnline: () => { online = true; },
    });
    context.addCleanup(`stop registered Relay client ${name}`, () => clients[name].close());
    const registered = await readRegisteredClientIdentity({
      identityFile,
      relayUrl: `http://127.0.0.1:${relay.controlPort}`,
      pairingToken: pairingTokens[name],
    });
    context.registerSecret(registered.secret);
    ids[name] = registered.id;
    gateways[name].relayOnline = () => online;
  }

  await waitFor(
    () => Object.values(gateways).every(gateway => gateway.relayOnline()) ? true : null,
    20_000,
    "both isolated test Gateway control channels",
    100,
    context.abortSignal,
  );

  const remoteDataPort = await chooseCloudLoopbackPort(context, cloudHost);
  const tunnel = context.spawnOwned("cloud-loopback-relay-data-forward", "ssh", [
    "-N", "-T",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=2",
    "-R", `127.0.0.1:${remoteDataPort}:127.0.0.1:${relay.proxyPort}`,
    cloudHost,
  ], { cwd: repoRoot, env: context.isolatedEnvironment() });
  await waitFor(async () => {
    if (tunnel.exitCode !== null) throw new Error("cloud loopback SSH data forward exited during startup");
    const output = await remoteOutput(cloudHost, `ss -H -ltn 'sport = :${remoteDataPort}'`).catch(() => "");
    return output.includes(`:${remoteDataPort}`) ? true : null;
  }, 20_000, "cloud loopback SSH data forward listener", 250, context.abortSignal);
  context.registerPort("cloud-loopback-relay-data-forward", remoteDataPort);

  const relayHealthResponse = await fetch(`http://127.0.0.1:${relay.controlPort}/_relay/health`);
  assert.equal(relayHealthResponse.status, 200);
  const relayHealth = await relayHealthResponse.json();
  assert.equal(relayHealth.online, true);

  const dataRouteProbe = await probeRelayDataRoutes(cloudHost, remoteDataPort, ids);

  const sourceHashes = await readSourceHashes();
  const caddy = await prepareAndValidateCaddyRouteDraft(context, {
    cloudHost,
    cloudPort: remoteDataPort,
    ids,
    marker: runMarker,
    expectedBaseSha256: expectedCaddySha256,
  });

  const privatePairingFile = await context.writeStateJson("private-mobile-pairing-fixtures.json", {
    alpha: { id: ids.alpha, pairingToken: pairingTokens.alpha },
    beta: { id: ids.beta, pairingToken: pairingTokens.beta },
  });
  const stopPath = context.pathInState("stop-public-infra");
  const routePaths = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, `/g/${id}`]));
  await context.writeArtifactJson("public-infra-handle.json", {
    ownerPid: process.pid,
    checkout: repoRoot,
    checkoutHead: context.gitCommit,
    publicOrigin,
    routes: Object.fromEntries(Object.entries(routePaths).map(([name, route]) => [name, `${publicOrigin}${route}/`])),
    gatewayIds: ids,
    relay: {
      controlBind: "127.0.0.1",
      controlPort: relay.controlPort,
      dataBind: "127.0.0.1",
      dataPort: relay.proxyPort,
      registrationStorePath: relayStore,
      healthOnline: relayHealth.online,
      registeredGatewayCount: 2,
    },
    gateways: Object.fromEntries(Object.entries(gateways).map(([name, gateway]) => [name, {
      pid: gateway.child.pid,
      host: gateway.host,
      port: gateway.port,
      workspace: workspaces[name],
      webRoot: placeholderRoot,
      relayControlOnline: gateway.relayOnline(),
      mockMode: true,
    }])),
    sshReverseForward: {
      pid: tunnel.pid,
      target: cloudHost,
      bind: "127.0.0.1",
      cloudPort: remoteDataPort,
      localRelayDataPort: relay.proxyPort,
      path: "Gateway -> Relay control is loopback-only; public Gateway -> Relay control latency is not measured",
    },
    caddy: {
      sourcePath: "/etc/caddy/Caddyfile",
      baseSha256: caddy.baseSha256,
      candidateValidation: caddy.validation,
      rollbackMarker: caddy.marker,
      rollbackHashMatchesBase: caddy.rollbackHashMatchesBase,
      reloadPerformed: false,
      publicRoutesLive: false,
      reviewDiffArtifact: context.pathInArtifacts("caddy-route-diff.patch"),
    },
    sourceHashes,
    mobileWebBaseline,
    dataRouteProbe,
    privatePairingFixturesPath: privatePairingFile,
    mobileWebStaticRootForReplacement: placeholderRoot,
    cleanupTriggerPath: stopPath,
    publicHttpsRoute: "pending Caddy review/reload; no public traffic sent",
  });

  console.log(JSON.stringify({
    runRoot: context.runRoot,
    ownerPid: process.pid,
    cloudHost,
    cloudReverseForwardPort: remoteDataPort,
    relayControlPort: relay.controlPort,
    relayDataPort: relay.proxyPort,
    gatewayPorts: Object.fromEntries(Object.entries(gateways).map(([name, gateway]) => [name, gateway.port])),
    gatewayIds: ids,
    publicTestOrigin,
    publicRoutes: Object.fromEntries(Object.entries(routePaths).map(([name, route]) => [name, `${publicOrigin}${route}/`])),
    caddyBaseSha256: caddy.baseSha256,
    caddyCandidateValid: caddy.valid,
    caddyRollbackHashMatchesBase: caddy.rollbackHashMatchesBase,
    caddyReloaded: false,
    dataRouteProbe,
    privatePairingFixturesPath: privatePairingFile,
    staticRootToReplaceWhenFrozenExportArrives: placeholderRoot,
    mobileWebBundleSha256: mobileWebBaseline.bundleSha256,
    stopTriggerPath: stopPath,
  }));

  await waitFor(async () => {
    try { await access(stopPath); return true; }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }, 24 * 60 * 60_000, "parent stop trigger", 500, context.abortSignal);

  return {
    relayStoppedByParentTrigger: true,
    publicCaddyReloadPerformed: false,
    caddyBaseSha256: caddy.baseSha256,
    caddyRouteDraftValidated: caddy.valid,
    caddyRollbackHashMatchesBase: caddy.rollbackHashMatchesBase,
    registeredGatewayCount: Object.keys(ids).length,
  };
});

async function chooseCloudLoopbackPort(context, host) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = randomInt(30_000, 60_000);
    const output = await remoteOutput(host, `ss -H -ltn 'sport = :${port}'`);
    if (output.trim() === "") return port;
  }
  throw new Error("could not find a free cloud loopback port for the SSH reverse forward");
}

async function remoteOutput(host, command, timeoutMs = 10_000) {
  try {
    const { stdout } = await execFileAsync("ssh", ["-o", "BatchMode=yes", host, command], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
    });
    return stdout;
  } catch (error) {
    const reason = error.killed ? "timed out" : `exit ${error.code ?? error.signal ?? "unknown"}`;
    throw new Error(`remote command on ${host} ${reason}`);
  }
}

async function probeRelayDataRoutes(host, cloudPort, ids) {
  const base = `http://127.0.0.1:${cloudPort}`;
  const origin = "https://hyf2333.top:8451";
  const command = [
    `curl --noproxy '*' -sS -o /dev/null -w 'alpha_root=%{http_code}\\n' -H 'Host: hyf2333.top:8451' '${base}/g/${ids.alpha}/'`,
    `curl --noproxy '*' -sS -o /dev/null -w 'beta_root=%{http_code}\\n' -H 'Host: hyf2333.top:8451' '${base}/g/${ids.beta}/'`,
    `curl --noproxy '*' -sS -o /dev/null -w 'bad_bearer=%{http_code}\\n' -H 'Host: hyf2333.top:8451' -H 'Origin: ${origin}' -H 'Authorization: Bearer invalid-test-credential' '${base}/g/${ids.alpha}/api/servers'`,
    `curl --noproxy '*' -sS -o /dev/null -w 'bad_pairing=%{http_code}\\n' -H 'Host: hyf2333.top:8451' -H 'Origin: ${origin}' -H 'Content-Type: application/json' --data '{\"token\":\"invalid-test-pairing\"}' '${base}/g/${ids.alpha}/api/mobile/session'`,
    `curl --noproxy '*' -sS -o /dev/null -w 'suffix=%{http_code}\\n' -H 'Host: hyf2333.top:8451' '${base}/g/${ids.alpha}-suffix/'`,
  ].join(" && ");
  const output = await remoteOutput(host, command, 30_000);
  const status = Object.fromEntries([...output.matchAll(/^(alpha_root|beta_root|bad_bearer|bad_pairing|suffix)=(\d{3})$/gm)]
    .map(([, name, value]) => [name, Number(value)]));
  assert.deepEqual(status, {
    alpha_root: 200,
    beta_root: 200,
    bad_bearer: 401,
    bad_pairing: 401,
    suffix: 404,
  }, "loopback SSH data path must reach each test Gateway and reject invalid credentials / ID prefix collisions");
  return {
    path: "cloud loopback SSH reverse forward -> isolated Relay data listener -> isolated Gateway",
    alphaRootStatus: status.alpha_root,
    betaRootStatus: status.beta_root,
    invalidBearerStatus: status.bad_bearer,
    invalidPairingStatus: status.bad_pairing,
    idSuffixStatus: status.suffix,
    publicHttpsVisited: false,
  };
}

async function readSourceHashes() {
  const files = [
    "apps/kcoder-relay/src/server.mjs",
    "apps/kcoder-relay/src/server-routing.mjs",
    "apps/kcoder-relay/src/registration-store.mjs",
    "apps/kcoder-relay/src/client.mjs",
    "apps/kcoder-studio/dev-server.mjs",
  ];
  const hashes = {};
  for (const file of files) {
    const bytes = await readFile(resolve(repoRoot, file));
    hashes[file] = createHash("sha256").update(bytes).digest("hex");
  }
  return hashes;
}

async function copyFrozenMobileWeb(destination, source) {
  const manifestPath = resolve(dirname(source), "mobile-web-export-mobile-high-latency-before-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.status, "complete", "frozen Mobile Web export must be complete");
  assert.equal(manifest.sourceUnchanged, true, "frozen Mobile Web source must not have changed during export");
  assert.equal(manifest.snapshotCopyMatchesSource, true, "frozen Mobile Web source snapshot must match its source");
  assert.equal(manifest.snapshotUnchangedDuringExport, true, "frozen Mobile Web snapshot must be stable during export");
  assert.equal(manifest.terminalHookChangesOnlyGeneratedHtml, true, "frozen terminal hook must only change generated HTML");
  assert.equal(manifest.bundleSha256, expectedMobileBundleSha256, "frozen Mobile Web bundle must match the baseline export approved for this run");
  const sourceFiles = await collectBundleFiles(source);
  assert.deepEqual(sourceFiles, manifest.bundleFiles, "frozen export files must match their recorded manifest");
  assert.equal(hashJson(sourceFiles), manifest.bundleSha256);

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await copyRegularTree(source, destination);
  const copiedFiles = await collectBundleFiles(destination);
  assert.deepEqual(copiedFiles, manifest.bundleFiles, "isolated Gateway static root must match the frozen Mobile Web export");
  return {
    source: source,
    manifestPath,
    bundleSha256: manifest.bundleSha256,
    fileCount: manifest.bundleFileCount,
    sourceTreeSha256: manifest.sourceTreeSha256,
    sourceStatus: "before-baseline; after-export unavailable",
    copiedBundleSha256: hashJson(copiedFiles),
  };
}

async function copyRegularTree(source, destination) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = resolve(source, entry.name);
    const to = resolve(destination, entry.name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error(`frozen Mobile Web export contains a symlink: ${entry.name}`);
    if (info.isDirectory()) {
      await mkdir(to, { recursive: false, mode: 0o700 });
      await copyRegularTree(from, to);
    } else if (info.isFile()) {
      await copyFile(from, to);
    } else {
      throw new Error(`frozen Mobile Web export contains a non-regular file: ${entry.name}`);
    }
  }
}

async function collectBundleFiles(root) {
  const entries = [];
  async function visit(directory) {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, child.name);
      const relativePath = path.slice(root.length + 1).split("\\").join("/");
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Mobile Web bundle contains a symlink: ${relativePath}`);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) {
        const bytes = await readFile(path);
        entries.push({
          path: relativePath,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } else {
        throw new Error(`Mobile Web bundle contains a non-regular file: ${relativePath}`);
      }
    }
  }
  await visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

function hashJson(value) {
  return createHash("sha256").update(Buffer.from(JSON.stringify(value))).digest("hex");
}

async function prepareAndValidateCaddyRouteDraft(context, { cloudHost, cloudPort, ids, marker, expectedBaseSha256 }) {
  assert.match(ids.alpha, /^[a-f0-9]{32}$/);
  assert.match(ids.beta, /^[a-f0-9]{32}$/);
  assert.notEqual(ids.alpha, ids.beta);
  assert.ok(!ids.alpha.startsWith(ids.beta) && !ids.beta.startsWith(ids.alpha), "random Gateway IDs must not overlap by prefix");

  const markerLabel = `kc-ux-${marker}`;
  const matcherA = `phone_ux_${marker}_alpha`;
  const matcherB = `phone_ux_${marker}_beta`;
  const snippet = [
    `    # BEGIN ${markerLabel}`,
    `    @${matcherA} {`,
    `        host {$KCODER_RELAY_DOMAIN}`,
    `        path /g/${ids.alpha} /g/${ids.alpha}/*`,
    "    }",
    `    handle @${matcherA} {`,
    `        reverse_proxy 127.0.0.1:${cloudPort} {`,
    "            flush_interval -1",
    "        }",
    "    }",
    `    @${matcherB} {`,
    `        host {$KCODER_RELAY_DOMAIN}`,
    `        path /g/${ids.beta} /g/${ids.beta}/*`,
    "    }",
    `    handle @${matcherB} {`,
    `        reverse_proxy 127.0.0.1:${cloudPort} {`,
    "            flush_interval -1",
    "        }",
    "    }",
    `    # END ${markerLabel}`,
    "",
  ].join("\n");

  const localDiff = [
    `--- /etc/caddy/Caddyfile (sha256 ${expectedBaseSha256})`,
    `+++ /etc/caddy/Caddyfile (+ ${markerLabel}; no reload)`,
    "@@ before the existing @kcoder_relay_gateway matcher @@",
    ...snippet.trimEnd().split("\n").map(line => `+${line}`),
    "",
    `# Exact matcher boundary checks: /g/${ids.alpha} and /g/${ids.alpha}/... match; /g/${ids.alpha}-suffix does not.`,
    `# Exact matcher boundary checks: /g/${ids.beta} and /g/${ids.beta}/... match; /g/${ids.beta}-suffix does not.`,
  ].join("\n");

  const draftPath = `/tmp/kcoder-cyx-caddy-${marker}.Caddyfile`;
  const py = [
    "from pathlib import Path",
    "import hashlib, json, os",
    "base_path = Path('/etc/caddy/Caddyfile')",
    "base = base_path.read_bytes()",
    `expected = '${expectedBaseSha256}'`,
    "actual = hashlib.sha256(base).hexdigest()",
    "if actual != expected: raise SystemExit('Caddy baseline SHA changed; refusing to draft')",
    "text = base.decode('utf-8')",
    "anchor = '    @kcoder_relay_gateway {'",
    "if text.count(anchor) != 1: raise SystemExit('Caddy route insertion anchor is not unique')",
    `snippet = ${JSON.stringify(snippet)}`,
    "candidate = text.replace(anchor, snippet + anchor, 1).encode('utf-8')",
    `draft = Path('${draftPath}')`,
    "fd = os.open(draft, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)",
    "with os.fdopen(fd, 'wb') as handle: handle.write(candidate); handle.flush(); os.fsync(handle.fileno())",
    `print(json.dumps({'baseSha256': actual, 'candidateSha256': hashlib.sha256(candidate).hexdigest(), 'draftPath': str(draft), 'routeCount': 2}))`,
  ].join("\n");
  const encoded = Buffer.from(py).toString("base64");
  const generated = await remoteOutput(cloudHost, `sudo python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`);
  const generation = JSON.parse(generated.trim().split("\n").at(-1));
  assert.equal(generation.baseSha256, expectedBaseSha256, "Caddy source changed before route draft generation");
  assert.equal(generation.routeCount, 2);

  let validationOutput = "";
  let valid = false;
  let rollbackHashMatchesBase = false;
  try {
    const validationCommand = `sudo bash -c 'set -a; . /etc/kcoder-relay-caddy.env; set +a; caddy validate --config ${draftPath} --adapter caddyfile'`;
    validationOutput = await remoteOutput(cloudHost, validationCommand, 45_000);
    valid = /Valid configuration/.test(validationOutput);
    assert.ok(valid, "candidate Caddy configuration must validate before review");

    const rollbackPy = [
      "from pathlib import Path",
      "import hashlib, json",
      `base = Path('/etc/caddy/Caddyfile').read_bytes()`,
      `candidate = Path('${draftPath}').read_bytes()`,
      "lines = candidate.decode('utf-8').splitlines(keepends=True)",
      `begin = '    # BEGIN ${markerLabel}'`,
      `end = '    # END ${markerLabel}'`,
      "starts = [i for i, line in enumerate(lines) if line.rstrip('\\r\\n') == begin]",
      "ends = [i for i, line in enumerate(lines) if line.rstrip('\\r\\n') == end]",
      "if len(starts) != 1 or len(ends) != 1 or ends[0] < starts[0]: raise SystemExit('temporary Caddy marker is missing or duplicated')",
      "restored = ''.join(lines[:starts[0]] + lines[ends[0] + 1:]).encode('utf-8')",
      "base_hash = hashlib.sha256(base).hexdigest()",
      "restored_hash = hashlib.sha256(restored).hexdigest()",
      "print(json.dumps({'baseSha256': base_hash, 'restoredSha256': restored_hash, 'rollbackHashMatchesBase': base_hash == restored_hash}))",
    ].join("\n");
    const rollback = await remoteOutput(cloudHost, `sudo python3 -c "import base64;exec(base64.b64decode('${Buffer.from(rollbackPy).toString("base64")}'))"`, 30_000);
    const check = JSON.parse(rollback.trim().split("\n").at(-1));
    rollbackHashMatchesBase = check.rollbackHashMatchesBase === true && check.baseSha256 === expectedBaseSha256;
    assert.ok(rollbackHashMatchesBase, "removing only the marked test route must restore the exact Caddy baseline hash");
  } finally {
    await remoteOutput(cloudHost, `sudo rm -f -- ${draftPath}`).catch(() => {});
  }

  const diffFile = await open(context.pathInArtifacts("caddy-route-diff.patch"), "wx", 0o600);
  try {
    await diffFile.writeFile(localDiff, "utf8");
    await diffFile.sync();
  } finally {
    await diffFile.close();
  }
  return {
    baseSha256: generation.baseSha256,
    candidateSha256: generation.candidateSha256,
    marker: markerLabel,
    validation: valid ? "Valid configuration" : "invalid",
    valid,
    rollbackHashMatchesBase,
    diff: localDiff,
  };
}
