import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHostedMobileIngressCandidate } from "./remote-relay-lifecycle-static03.once.mjs";

const privateDir = dirname(fileURLToPath(import.meta.url));
const sharedEntryPath = resolve(privateDir, "../harness/remote-relay-ingress.once.mjs");
const hostedEntryPath = resolve(privateDir, "remote-relay-ingress-hosted.once.mjs");
const sharedEntry = await readFile(sharedEntryPath, "utf8");
const hostedEntry = await readFile(hostedEntryPath, "utf8");
const lifecycleSource = await readFile(resolve(privateDir, "remote-relay-lifecycle-static03.once.mjs"), "utf8");
const sha256 = value => createHash("sha256").update(value).digest("hex");

assert.equal(sha256(sharedEntry), "2184c60b986ea1de3823d6c8096d20b9fd2c49d37511ebc015dec5131bd61b23");
assert.equal(sha256(hostedEntry), "5ee38518c1e1f0e8432d51cea9f27eafd589aab6d336dc87bece549a6d2232bb");
assert.equal(hostedEntry, buildHostedMobileIngressCandidate(sharedEntry),
  "private hosted ingress must be exactly the pinned shared source plus its Mobile route branch");
assert.match(lifecycleSource, /const HOSTED_ENTRY_SOURCE_FILE = "remote-relay-ingress-hosted\.once\.mjs";/);
assert.match(lifecycleSource, /const REMOTE_ENTRY_FILE = "remote-relay-ingress\.once\.mjs";/);
assert.match(lifecycleSource, /stagedEntryPath = context\.pathInState\(REMOTE_ENTRY_FILE\)/);
assert.match(lifecycleSource, /createRuntimeArchive\(context, archivePath, relayRoot, stagedEntryPath, runtimeFiles\)/);
const rootStopSource = lifecycleSource.slice(lifecycleSource.indexOf("const ROOT_STOP = `"));
assert.ok(rootStopSource.includes("remote-relay-ingress.once.mjs"), "cleanup must retain the original staged argv basename");
assert.ok(!rootStopSource.includes("remote-relay-ingress-hosted.once.mjs"), "local private source name must not leak into remote argv");

const validRequestTarget = hostedEntry.match(/function validRequestTarget\([\s\S]*?\n}\n/)?.[0];
const selectPort = hostedEntry.match(/function selectPort\([\s\S]*?\n}\n/)?.[0];
assert.ok(validRequestTarget && selectPort, "the production route selector and target validator must be extractable");
const vm = { URL, URLSearchParams };
runInNewContext(`${validRequestTarget}\n${selectPort}\nglobalThis.pickPort = selectPort;`, vm, { timeout: 1000 });

const gatewayId = "0123456789abcdef0123456789abcdef";
const otherGatewayId = "abcdef0123456789abcdef0123456789";
const serverId = "mobile-real-rust";
const workspacePath = "/tmp/mobile-once-workspace";
const controlPort = 31001;
const proxyPort = 31002;
const prefix = `/g/${gatewayId}`;
const pick = (path, method = "GET", upgrade = false) =>
  vm.pickPort(path, method, upgrade, gatewayId, serverId, workspacePath, controlPort, proxyPort);

for (const path of [
  `${prefix}/mobile-entry`,
  `${prefix}/mobile`,
  `${prefix}/mobile/`,
  `${prefix}/mobile/assets/index.css`,
  `${prefix}/mobile/_expo/static/js/web/entry.js`,
  `${prefix}/mobile/connect`,
]) {
  assert.equal(pick(path, "GET"), proxyPort, `selected Mobile GET must route: ${path.split("/g/")[1]?.replace(gatewayId, "<selected>")}`);
  assert.equal(pick(path, "HEAD"), proxyPort, "selected Mobile HEAD must route");
}

for (const path of [
  `${prefix}/mobile-entry/extra`,
  `${prefix}/mobilex`,
  `${prefix}/api/ssh-connections`,
  `${prefix}/api/mobile/session/refresh`,
  `/g/${otherGatewayId}/mobile`,
]) assert.equal(pick(path), null, "unselected or non-Mobile routes must stay denied");

assert.equal(pick(`${prefix}/mobile/assets/index.css?v=1`), null, "static routes do not accept arbitrary query strings");
assert.equal(pick(`${prefix}/mobile/connect?gateway=https%3A%2F%2Ffixture.invalid%2Fg%2F${gatewayId}&gatewayId=${gatewayId}`), null,
  "this hosted once-run does not widen ingress to pairing-query URLs");
assert.equal(pick(`${prefix}/mobile`, "POST"), null, "Mobile routes only allow GET and HEAD");
assert.equal(pick(`${prefix}/mobile/assets/index.css`, "GET", true), null, "Mobile routes cannot upgrade to WebSocket");

assert.equal(pick(`${prefix}/api/mobile/session`, "POST"), proxyPort, "existing exact pairing API route remains available");
assert.equal(pick(`${prefix}/api/servers`), proxyPort, "existing exact servers read route remains available");
const rpcQuery = new URLSearchParams({ token: "fixture-token", server: serverId, channel: "runtime", workspace: workspacePath });
assert.equal(pick(`${prefix}/rpc?${rpcQuery}`, "GET", true), proxyPort, "existing scoped RPC upgrade route remains available");
assert.equal(pick("/_relay/register", "POST"), controlPort, "existing Relay registration route remains available");

process.stdout.write("PASS: exact hosted Mobile GET/HEAD routes, denied query/method/upgrade/other Gateway paths, existing API and Relay routes preserved\n");
