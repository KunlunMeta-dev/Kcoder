import test from "node:test";
import { get } from "node:http";
import assert from "node:assert/strict";
import { createMcpOAuthCallbackReceiver } from "../src/mcp-oauth-callback.js";

function bind(receiver, state = "expected-state") {
  const authorization = new URL("https://auth.example.test/authorize");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("redirect_uri", receiver.redirectUri);
  receiver.bindAuthorizationUrl(authorization.href);
}

test("browser completion waits for the runtime to confirm credential storage", async t => {
  const receiver = await createMcpOAuthCallbackReceiver({ waitForCompletion: true });
  t.after(() => receiver.close());
  bind(receiver);
  const callback = new URL(receiver.redirectUri);
  callback.searchParams.set("state", "expected-state");
  callback.searchParams.set("code", "private-code");
  const response = fetch(callback);
  await receiver.result;
  assert.equal(typeof receiver.completeAuthorization, "function");
  receiver.completeAuthorization({ status: "failed", reason: "token_exchange_failed", errorCode: "invalid_grant", httpStatus: 400, diagnostic: "scope=array" });
  const result = await response;
  assert.equal(result.status, 502);
  const body = await result.text();
  assert.match(body, /token_exchange_failed/);
  assert.match(body, /invalid_grant; HTTP 400/);
  assert.match(body, /scope=array/);
  assert.ok(!body.includes("private-code"));
});

test("completion never renders arbitrary backend error fields", async t => {
  const receiver = await createMcpOAuthCallbackReceiver({ waitForCompletion: true });
  t.after(() => receiver.close());
  bind(receiver);
  const callback = new URL(receiver.redirectUri);
  callback.searchParams.set('state', 'expected-state');
  callback.searchParams.set('error', 'private-provider-error');
  const pending = fetch(callback);
  await receiver.result;
  receiver.completeAuthorization({ status: 'failed', reason: 'private-reason', errorCode: 'private-code', httpStatus: 'private-status', diagnostic: 'access_token=private-token' });
  const body = await (await pending).text();
  assert.match(body, /authorization_failed/);
  assert.ok(!body.includes('private-'));
});

test("real loopback callback rejects invalid requests and accepts one bound result", async t => {
  const receiver = await createMcpOAuthCallbackReceiver();
  t.after(() => receiver.close());
  bind(receiver);
  const callback = new URL(receiver.redirectUri);
  callback.searchParams.set("state", "expected-state");
  callback.searchParams.set("code", "private-code");
  assert.equal((await fetch(callback, { method: "POST" })).status, 405);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    get(callback, { headers: { host: "other.invalid" } }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    }).on("error", reject);
  });
  assert.equal(wrongHostStatus, 421);
  const wrongPath = new URL(callback);
  wrongPath.pathname = "/other-callback";
  assert.equal((await fetch(wrongPath)).status, 404);
  const wrong = new URL(callback);
  wrong.searchParams.set("state", "wrong-state");
  assert.equal((await fetch(wrong)).status, 400);
  wrong.searchParams.set("state", "expected-state");
  wrong.searchParams.append("code", "duplicate");
  assert.equal((await fetch(wrong)).status, 400);
  const response = await fetch(callback);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.ok(!(await response.text()).includes("private-code"));
  assert.deepEqual(await receiver.result, { status: "received", callbackUrl: callback.href });
  await assert.rejects(fetch(callback));
});

test("receiver binding, cancellation and expiry release the listener", async t => {
  const cancelled = await createMcpOAuthCallbackReceiver();
  t.after(() => cancelled.close());
  assert.throws(() => cancelled.bindAuthorizationUrl("https://auth.example.test/?state=x&redirect_uri=http://other.invalid"));
  bind(cancelled);
  assert.throws(() => bind(cancelled));
  cancelled.close();
  assert.deepEqual(await cancelled.result, { status: "cancelled" });
  await assert.rejects(fetch(cancelled.redirectUri));
  const expired = await createMcpOAuthCallbackReceiver({ lifetimeMs: 30 });
  t.after(() => expired.close());
  assert.deepEqual(await expired.result, { status: "expired" });
  await assert.rejects(fetch(expired.redirectUri));
});

test("authorization denial is returned without rendering provider error text", async t => {
  const receiver = await createMcpOAuthCallbackReceiver();
  t.after(() => receiver.close());
  bind(receiver);
  const callback = new URL(receiver.redirectUri);
  callback.searchParams.set("state", "expected-state");
  callback.searchParams.set("error", "access_denied");
  callback.searchParams.set("error_description", "private-error-description");
  const response = await fetch(callback);
  assert.equal(response.status, 200);
  assert.ok(!(await response.text()).includes("private-error-description"));
  assert.equal((await receiver.result).callbackUrl, callback.href);
});
