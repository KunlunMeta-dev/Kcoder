import assert from "node:assert/strict";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startGateway } from "./gateway-process.mjs";

const studioRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("desktop host starts a private authenticated gateway on an OS-assigned port", async (t) => {
  const gateway = await startGateway({
    env: { KCODER_STUDIO_MOCK: "1" },
    token: "desktop-test-token",
    timeoutMs: 5_000,
  });
  t.after(() => gateway.stop());

  assert.match(gateway.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(new URL(gateway.baseUrl).port, "0");
  assert.ok(gateway.pid > 0);
  assert.ok(gateway.cookieValue.length > 20);

  const response = await fetch(`${gateway.baseUrl}/api/servers`, {
    headers: { cookie: `kcoder_studio_session=${encodeURIComponent(gateway.cookieValue)}` },
  });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray((await response.json()).servers));

  const exited = gateway.exit;
  await gateway.stop();
  await expectGatewayExit(exited);
});

async function expectGatewayExit(exited) {
  const result = await exited;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
}

test("desktop session renewal preserves a live identity and restores an expired session", async t => {
  const gateway = await startGateway({ env: { KCODER_STUDIO_MOCK: "1", KCODER_STUDIO_AUTH_SESSION_TTL_MS: "1200" }, timeoutMs: 5000 });
  t.after(() => gateway.stop());
  const initial = gateway.cookieValue;
  await gateway.renewSession();
  assert.equal(gateway.cookieValue, initial);
  await new Promise(resolve => setTimeout(resolve, 1400));
  const expired = await fetch(`${gateway.baseUrl}/api/servers`, { headers: { cookie: `kcoder_studio_session=${initial}` } });
  assert.equal(expired.status, 401);
  await Promise.all([gateway.renewSession(), gateway.renewSession()]);
  assert.notEqual(gateway.cookieValue, initial);
  const restored = await fetch(`${gateway.baseUrl}/api/servers`, { headers: { cookie: `kcoder_studio_session=${gateway.cookieValue}` } });
  assert.equal(restored.status, 200);
});

test("desktop host rejects a gateway that exits before announcing readiness", async () => {
  const missing = resolve(studioRoot, "desktop", "missing-gateway.mjs");
  await assert.rejects(
    startGateway({ gatewayScript: missing, timeoutMs: 2_000 }),
    /exited before startup/,
  );
  await assert.rejects(access(missing));
});

test("desktop host times out when the gateway login never responds", async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), "kcoder-studio-hanging-login-"));
  const fixture = join(fixtureDir, "gateway.mjs");
  await writeFile(
    fixture,
    `import { createServer } from "node:http";
const server = createServer(() => {});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(\`KCoder Studio: http://127.0.0.1:\${address.port}\`);
});
`,
  );

  await assert.rejects(
    startGateway({ gatewayScript: fixture, timeoutMs: 2_000, loginTimeoutMs: 100 }),
    /desktop login timed out after 100ms/,
  );
});

test("desktop host can bind a stable origin for persistent renderer storage", async (t) => {
  const reservation = await import("node:net").then(({ createServer }) => createServer());
  await new Promise((resolveListen) => reservation.listen(0, "127.0.0.1", resolveListen));
  const address = reservation.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose) => reservation.close(resolveClose));
  const gateway = await startGateway({
    env: { KCODER_STUDIO_MOCK: "1" },
    token: "stable-origin-token",
    port,
    timeoutMs: 5_000,
  });
  t.after(() => gateway.stop());

  assert.equal(gateway.baseUrl, `http://127.0.0.1:${port}`);
});
