import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ingressSourcePath = fileURLToPath(new URL("./remote-relay-ingress.once.mjs", import.meta.url));

test("current Relay ingress selector permits only selected Gateway and scoped Relay routes", async () => {
  const source = await readFile(ingressSourcePath, "utf8");
  const validRequestTarget = source.match(/function validRequestTarget\([\s\S]*?\n}\n/)?.[0];
  const selectPort = source.match(/function selectPort\([\s\S]*?\n}\n/)?.[0];
  assert.ok(validRequestTarget && selectPort, "current ingress route selector and target validator must be present");

  const vm = { URL, URLSearchParams };
  runInNewContext(`${validRequestTarget}\n${selectPort}\nglobalThis.pickPort = selectPort;`, vm, { timeout: 1000 });

  const gatewayId = "0123456789abcdef0123456789abcdef";
  const otherGatewayId = "abcdef0123456789abcdef0123456789";
  const serverId = "relay-fixture";
  const workspacePath = "/owned/workspace";
  const controlPort = 31001;
  const proxyPort = 31002;
  const prefix = `/g/${gatewayId}`;
  const pick = (path, method = "GET", upgrade = false) =>
    vm.pickPort(path, method, upgrade, gatewayId, serverId, workspacePath, controlPort, proxyPort);

  assert.equal(pick("/_relay/register", "POST"), controlPort);
  assert.equal(pick("/_relay/control", "GET", true), controlPort);
  assert.equal(pick(`/_relay/data?id=${"f".repeat(48)}`, "GET", true), controlPort);
  assert.equal(pick(`${prefix}/api/mobile/session`, "POST"), proxyPort);
  assert.equal(pick(`${prefix}/api/mobile/session`, "DELETE"), proxyPort);
  assert.equal(pick(`${prefix}/api/servers`), proxyPort);
  assert.equal(pick(`${prefix}/api/servers/status`), proxyPort);
  const rpcQuery = new URLSearchParams({ token: "fixture-token", server: serverId, channel: "runtime", workspace: workspacePath });
  assert.equal(pick(`${prefix}/rpc?${rpcQuery}`, "GET", true), proxyPort);

  for (const [path, method, upgrade] of [
    ["/_relay/register?destination=http%3A%2F%2Fforeign", "POST", false],
    ["/_relay/register", "GET", false],
    ["/_relay/data?id=short", "GET", true],
    [`${prefix}/api/servers?target=foreign`, "GET", false],
    [`${prefix}/api/servers`, "POST", false],
    [`/g/${otherGatewayId}/api/servers`, "GET", false],
    [`${prefix}/mobile/`, "GET", false],
    [`${prefix}/rpc?${rpcQuery}&token=duplicate`, "GET", true],
    ["//foreign.invalid/", "GET", false],
  ]) assert.equal(pick(path, method, upgrade), null, `unexpected route: ${path}`);
});
