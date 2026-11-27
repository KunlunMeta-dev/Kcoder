import assert from "node:assert/strict";
import test from "node:test";
import { inspectGatewayChannelMessage } from "../src/gateway-channel.js";

const request = (method) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} });

test("keeps browser methods on quota-controlled browser channels", () => {
  assert.equal(inspectGatewayChannelMessage("runtime", request("browser/start")).allowed, false);
  assert.equal(inspectGatewayChannelMessage("browser", request("terminal/start")).allowed, false);
  assert.equal(inspectGatewayChannelMessage("browser", request("initialize")).allowed, true);
  assert.equal(inspectGatewayChannelMessage("browser", request("browser/start")).allowed, true);
  assert.equal(
    inspectGatewayChannelMessage("browser", request("browser/start"), { browserStarted: true }).allowed,
    false,
  );
});

test("forwards malformed JSON to app-server for the canonical parse error", () => {
  assert.equal(inspectGatewayChannelMessage("runtime", "{").allowed, true);
  assert.equal(inspectGatewayChannelMessage("browser", "{").allowed, true);
});
