import test from "node:test";
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { McpOAuthCallbackRegistry } from "../src/mcp-oauth-callback-registry.js";

test("public callback route binds HTTPS origin and state without carrying login cookies", async t => {
  const registry = new McpOAuthCallbackRegistry();
  const server = createServer((request, response) => {
    if (!registry.handle(request, response)) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    registry.close();
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const receiver = await registry.create("https://studio.example.test");
  const authorization = new URL("https://auth.example.test/authorize");
  authorization.searchParams.set("state", "bound-state");
  authorization.searchParams.set("redirect_uri", receiver.redirectUri);
  receiver.bindAuthorizationUrl(authorization.href);
  const callback = new URL(receiver.redirectUri);
  callback.searchParams.set("state", "bound-state");
  callback.searchParams.set("code", "private-code");
  const request = host => new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port: server.address().port, path: callback.pathname + callback.search, headers: { host } }, response => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    }).on("error", reject);
  });
  assert.equal(await request("different.example.test"), 421);
  assert.equal(await request("studio.example.test"), 200);
  assert.deepEqual(await receiver.result, { status: "received", callbackUrl: callback.href });
  assert.equal(registry.receivers.size, 0);
  assert.equal(await request("studio.example.test"), 410);
  await assert.rejects(registry.create("http://10.0.0.1"), /HTTPS/);
});

test("registry bounds concurrent creation and closes all pending receivers", async () => {
  const registry = new McpOAuthCallbackRegistry();
  try {
    const results = await Promise.allSettled(Array.from({ length: 257 }, () => registry.create("https://studio.example.test")));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 256);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    registry.close();
    for (const result of results) if (result.status === "fulfilled") {
      assert.deepEqual(await result.value.result, { status: "cancelled" });
    }
    assert.equal(registry.receivers.size, 0);
  } finally { registry.close(); }
});


test("closing during receiver creation cannot publish a late callback", async () => {
  const registry = new McpOAuthCallbackRegistry();
  const creation = registry.create("https://studio.example.test");
  registry.close();
  await assert.rejects(creation, /closed/);
  assert.equal(registry.receivers.size, 0);
  await assert.rejects(registry.create("https://studio.example.test"), /closed/);
});

test("manual clients use a stable callback while state isolates concurrent authorizations", async () => {
  const registry = new McpOAuthCallbackRegistry();
  try {
    const first = await registry.create("https://studio.example.test", { stablePath: true });
    const second = await registry.create("https://studio.example.test", { stablePath: true });
    assert.equal(first.redirectUri, "https://studio.example.test/oauth/mcp/callback");
    assert.equal(second.redirectUri, first.redirectUri);
    for (const [receiver, state] of [[first, "first-state"], [second, "second-state"]]) {
      const url = new URL("https://auth.example.test/authorize");
      url.searchParams.set("redirect_uri", receiver.redirectUri);
      url.searchParams.set("state", state);
      receiver.bindAuthorizationUrl(url.href);
    }
    const statuses = [];
    const response = { writeHead(code) { statuses.push(code); }, end() {} };
    registry.handle({ method: "GET", headers: { host: "studio.example.test" },
      url: "/oauth/mcp/callback?state=second-state&code=second-code" }, response);
    assert.equal((await second.result).status, "received");
    assert.equal(registry.states.has("first-state"), true);
    assert.equal(registry.states.has("second-state"), false);
    registry.handle({ method: "GET", headers: { host: "studio.example.test" },
      url: "/oauth/mcp/callback?state=first-state&state=second-state&code=invalid" }, response);
    assert.deepEqual(statuses, [200, 410]);
    first.close();
    assert.equal((await first.result).status, "cancelled");
  } finally { registry.close(); }
});
