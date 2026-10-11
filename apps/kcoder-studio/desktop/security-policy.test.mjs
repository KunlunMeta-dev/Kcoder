import assert from "node:assert/strict";
import test from "node:test";
import { allowRendererPermission, isTrustedGatewayUrl } from "./security-policy.mjs";

test("trusts only the exact loopback gateway origin", () => {
  const origin = "http://127.0.0.1:43123";
  assert.equal(isTrustedGatewayUrl(`${origin}/settings`, origin), true);
  assert.equal(isTrustedGatewayUrl("http://127.0.0.1:43124/", origin), false);
  assert.equal(isTrustedGatewayUrl("https://example.test/", origin), false);
  assert.equal(isTrustedGatewayUrl("not a URL", origin), false);
});

test("allows only clipboard writes from the expected renderer", () => {
  const base = {
    gatewayOrigin: "http://127.0.0.1:43123",
    requestingUrl: "http://127.0.0.1:43123/",
    webContentsId: 7,
    expectedWebContentsId: 7,
  };
  assert.equal(allowRendererPermission({ ...base, permission: "clipboard-sanitized-write" }), true);
  assert.equal(allowRendererPermission({ ...base, permission: "notifications" }), false);
  assert.equal(allowRendererPermission({ ...base, permission: "media" }), false);
  assert.equal(allowRendererPermission({ ...base, webContentsId: 8, permission: "clipboard-sanitized-write" }), false);
  assert.equal(allowRendererPermission({ ...base, requestingUrl: "https://evil.test/", permission: "clipboard-sanitized-write" }), false);
});
