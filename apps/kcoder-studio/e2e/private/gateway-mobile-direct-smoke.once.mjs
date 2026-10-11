import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const NODE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const CHROME = "/opt/cft/chrome-linux64/chrome";
const impl = resolve(repoRoot, "target/private-phone-ux-implementation");
const runtimeSource = resolve(impl, "render-profile-gateway-runtime-c22-20261009");
const candidate = resolve(impl, "gateway-hosted-mobile-web-20261009/candidate-static04");
const mobileRoot = resolve(impl, "gateway-hosted-mobile-web-20261009/deployment-web-export-02");
const candidateManifestSha = "5455d0ef0f4aceb82e6d0ee74cdf15df354d7e8704e696b4ea8f747db84a7a2d";
const runtimeManifestSha = "474ea99288424030dddcba6a63f47689e8dd7f24c18ca5a9e21bb78c6262c39b";
const mobileManifestSha = "6de07d010e0c61956a0cfb4e30d337841f341ccfc5c2bb212017d7bf7eb5b37a";
const productFiles = [
  ["apps/kcoder-studio/dev-server.mjs", "0e08d5d2d4dc450673550c5256c53a07bfff9cd4669e8b02ed7276555d9d9b52"],
  ["apps/kcoder-studio/src/mobile-web-static.js", "b52c71913c346f8072a921a237a6f9f547af85fd8ca88aeeea01a73e5eeb710b"],
];

const sha256 = async path => createHash("sha256").update(await readFile(path)).digest("hex");

async function makeOwnedDirectoriesWritable(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeOwnedDirectoriesWritable(resolve(directory, entry.name));
  }
}

await runE2E(import.meta.url, {
  testId: "gateway-mobile-direct-static-smoke-once",
  tier: "model-independent",
  modelPolicy: "real Mobile Web export and owned authenticated mock Gateway; no pairing, Rust app-server, Provider, or turn",
}, async context => {
  assert.equal(process.execPath, NODE, "run this smoke with the pinned Node executable");
  const candidateManifest = resolve(candidate, "manifest.json");
  const mobileManifest = resolve(mobileRoot, "kcoder-mobile-web.json");
  assert.equal(await sha256(candidateManifest), candidateManifestSha, "candidate source manifest pin");
  assert.equal(await sha256(resolve(runtimeSource, "gateway-runtime-freeze.json")), runtimeManifestSha,
    "Gateway runtime freeze pin");
  assert.equal(await sha256(mobileManifest), mobileManifestSha, "read-only Mobile Web export manifest pin");

  const gatewayRoot = context.pathInState("gateway-runtime");
  await cp(runtimeSource, gatewayRoot, { recursive: true, verbatimSymlinks: true });
  context.registerTemporaryDirectory("owned Gateway runtime copy", gatewayRoot);
  await makeOwnedDirectoriesWritable(gatewayRoot);
  for (const [sourceRelative, expected] of productFiles) {
    const source = resolve(candidate, "source", sourceRelative);
    const runtimeRelative = sourceRelative.slice("apps/kcoder-studio/".length);
    const destination = resolve(gatewayRoot, runtimeRelative);
    assert.equal(await sha256(source), expected, `${sourceRelative} candidate file pin`);
    await chmod(destination, 0o600).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    await writeFile(destination, await readFile(source), { mode: 0o600 });
    assert.equal(await sha256(destination), expected, `${runtimeRelative} owned runtime copy`);
  }

  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const serversFile = await context.writeStateJson("registry/servers.json", [{
    id: "mobile-smoke", label: "Mobile smoke", runtime: "kcoder", transport: "local",
    command: process.execPath, workspace,
  }]);
  const gateway = await startGateway(context, {
    auth: true,
    label: "gateway-mobile-direct-smoke",
    gatewayRoot,
    cwd: gatewayRoot,
    workspace,
    serversFile,
    kcoderBin: process.execPath,
    env: { KCODER_STUDIO_MOCK: "1", KCODER_STUDIO_MOBILE_WEB_ROOT: mobileRoot },
  });

  const entryResponse = await fetch(`${gateway.baseUrl}/mobile-entry`);
  assert.equal(entryResponse.status, 200, "public mobile-entry response");
  const entry = await entryResponse.json();
  assert.equal(entry.available, true, "Gateway reports the static Mobile Web build available");
  assert.equal(entry.mobileUrl, `${gateway.baseUrl}/mobile/`, "mobileUrl must resolve to this Gateway mount");
  const apiResponse = await fetch(`${gateway.baseUrl}/api/servers`);
  assert.equal(apiResponse.status, 401, "an unpaired API request must remain unauthorized");

  const chromium = await startChromium(context, {
    label: "gateway-mobile-direct-smoke-chromium",
    executablePath: CHROME,
    noSandbox: true,
  });
  const page = await chromium.newPage({ viewport: { width: 390, height: 844 }, locale: "en-US" });
  const pageErrors = [];
  const cspViolations = [];
  const requestsTo4175 = [];
  const assets = [];
  page.on("pageerror", error => pageErrors.push(error.name || "Error"));
  page.on("console", message => {
    if (/(content security policy|violat\w*.*policy|refused to)/i.test(message.text())) cspViolations.push("CSP");
  });
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.port === "4175") requestsTo4175.push(url.pathname);
  });
  page.on("response", response => {
    const type = response.request().resourceType();
    if (type === "script" || type === "stylesheet") {
      assets.push({ type, path: new URL(response.url()).pathname, status: response.status() });
    }
  });

  const home = await page.goto(entry.mobileUrl, { waitUntil: "load", timeout: 30_000 });
  assert.equal(home?.status(), 200, "browser must GET the Gateway hosted Mobile Web page");
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 20_000 });
  const initialAssets = [...assets];
  assert.ok(initialAssets.some(asset => asset.type === "script"), "Mobile Web JavaScript must load");
  assert.ok(initialAssets.some(asset => asset.type === "stylesheet"), "Mobile Web CSS must load");
  assert.ok(initialAssets.every(asset => asset.status === 200), "initial Mobile Web JavaScript and CSS responses must be 200");

  await page.reload({ waitUntil: "load", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 20_000 });
  const welcome = await page.goto(new URL("welcome", entry.mobileUrl).href, { waitUntil: "load", timeout: 30_000 });
  assert.equal(welcome?.status(), 200, "welcome deep link must be served by the Gateway");
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 20_000 });
  assert.deepEqual(pageErrors, [], "Mobile Web must not raise browser page errors");
  assert.deepEqual(cspViolations, [], "Mobile Web must not report CSP violations");
  assert.deepEqual(requestsTo4175, [], "Gateway hosted Mobile Web must not request the Expo dev port");

  const evidence = {
    candidateManifestSha256: candidateManifestSha,
    runtimeFreezeSha256: runtimeManifestSha,
    mobileManifestSha256: mobileManifestSha,
    mobileEntryStatus: entryResponse.status,
    mobileAvailable: entry.available,
    unauthenticatedApiStatus: apiResponse.status,
    browserHomeStatus: home.status(),
    welcomeDeepLinkStatus: welcome.status(),
    initialScriptCss: initialAssets,
    pageErrorCount: pageErrors.length,
    cspViolationCount: cspViolations.length,
    requestsTo4175,
  };
  await context.writeArtifactJson("gateway-mobile-direct-smoke.json", evidence);
  return evidence;
});
