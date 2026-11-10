import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startGateway as startOwnedGateway } from "./gateway-process.mjs";
import { createDesktopGatewayConfig } from "./gateway-env.mjs";

const studioRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function startGateway(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-desktop-startup-'));
  try {
    const gateway = await startOwnedGateway({ ...options,
      privateEnvironment: options.privateEnvironment ?? {
        KCODER_NATIVE_CONNECTIVITY_BINDING_V1: Buffer.from('{}').toString('base64url'),
      },
      env: { HOME: directory, XDG_CONFIG_HOME: directory,
        KCODER_HOME: join(directory, 'profile'), KCODER_CONFIG_DIR: join(directory, 'profile'),
        KCODER_STUDIO_DATA_DIR: options.env?.KCODER_STUDIO_SERVERS_STORE ? dirname(resolve(options.cwd ?? studioRoot, options.env.KCODER_STUDIO_SERVERS_STORE)) : join(directory, 'gateway'),
        KCODER_STUDIO_SERVERS_STORE: join(directory, 'servers.json'),
        KCODER_STUDIO_WORKSPACE: directory, ...options.env },
    });
    void gateway.exit.finally(() => rm(directory, { recursive: true, force: true }));
    return gateway;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test('explicit Gateway data directory holds private state separately from the server registry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-gateway-data-root-'));
  let gateway;
  t.after(async () => { await gateway?.stop(); await rm(directory, { recursive: true, force: true }); });
  const data = join(directory, 'gateway'), registry = join(directory, 'registry');
  const profile = join(directory, 'profile'), web = join(directory, 'web');
  await mkdir(registry); await mkdir(web); await mkdir(data);
  const originalSettings = JSON.stringify({ meta: { config_version: 1 }, channels: { mirror_client_turns: true }, extra: { note: 'keep' } }) + '\n';
  await writeFile(join(data, 'settings.json'), originalSettings, { mode: 0o600 });
  await writeFile(join(web, 'index.html'), '<html><head></head><body>Owned storage fixture</body></html>');
  const servers = JSON.stringify([{ id: 'local', label: 'Owned target', transport: 'local' }]);
  const store = join(registry, 'servers.json'); await writeFile(store, servers);
  // Exercise ordinary private storage with the optional legacy component explicitly unavailable.
  gateway = await startGateway({ timeoutMs: 10000,
    privateEnvironment: { KCODER_NATIVE_CONNECTIVITY_BINDING_V1: Buffer.from('{}').toString('base64url') }, env: {
    NODE_ENV: 'test', TMPDIR: directory, HOME: directory, KCODER_HOME: profile, KCODER_CONFIG_DIR: profile,
    KCODER_STUDIO_DATA_DIR: data, KCODER_STUDIO_SERVERS_STORE: store,
    KCODER_STUDIO_WORKSPACE: directory, KCODER_STUDIO_MOCK: '1',
    KCODER_STUDIO_RENDERER_MODE: 'static', KCODER_STUDIO_WEB_ROOT: web,
  } });
  const headers = { Cookie: `kcoder_studio_session=${gateway.cookieValue}`, Origin: gateway.baseUrl, 'content-type': 'application/json' };
  const before = await fetch(`${gateway.baseUrl}/api/channels`, { headers });
  assert.equal(before.status, 200);
  assert.equal((await before.json()).settings.mirrorClientTurns, true);
  assert.equal(await readFile(join(data, 'settings.json'), 'utf8'), originalSettings);
  const response = await fetch(`${gateway.baseUrl}/api/channels`, { method: 'POST',
    headers,
    body: JSON.stringify({ action: 'settings', settings: { mirrorClientTurns: false } }),
  });
  assert.equal(response.status, 200);
  const upgraded = JSON.parse(await readFile(join(data, 'settings.json'), 'utf8'));
  assert.equal(upgraded.channels.mirror_client_turns, false);
  assert.equal(upgraded.meta.config_version, 2);
  assert.deepEqual(upgraded.extra, { note: 'keep' });
  const backups = (await readdir(data)).filter(name => name.startsWith('settings.json.v1-'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(data, backups[0]), 'utf8'), originalSettings);
  await access(join(data, 'mobile-device-auth', 'devices.json'));
  await access(join(data, 'channels', 'channels.sqlite3'));
  assert.equal(await readFile(store, 'utf8'), servers);
  await assert.rejects(access(join(registry, 'mobile-device-auth')), { code: 'ENOENT' });
  await assert.rejects(access(join(registry, 'channels')), { code: 'ENOENT' });
  await assert.rejects(access(join(profile, 'settings.json')), { code: 'ENOENT' });
  await gateway.stop(); await expectGatewayExit(gateway.exit);
});

test("desktop host starts a private authenticated gateway on an OS-assigned port", async (t) => {
  const gateway = await startGateway({
    env: { KCODER_STUDIO_MOCK: "1" },
    token: "desktop-test-token-0123456789abcdef0123456789",
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

test('desktop host recognizes private storage rejection without exposing child stderr', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-storage-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gatewayScript = join(directory, 'gateway.mjs');
  await writeFile(gatewayScript, `process.stderr.write('private-value\\nError: Private Windows mobile device storage unavailable (owner_mismatch)\\n'); process.exit(1);`);
  let diagnostic = '';
  await assert.rejects(startGateway({ gatewayScript, timeoutMs: 2_000, cwd: directory,
    env: { KCODER_STUDIO_SERVERS_STORE: 'data/servers.json' },
    onStderr: value => { diagnostic += value; } }), error => {
    assert.equal(error.code, 'MOBILE_DEVICE_STORAGE_UNAVAILABLE');
    assert.equal(error.reason, 'owner_mismatch');
    assert.doesNotMatch(error.message, /private-value/);
    assert.equal(error.storageDataDirectory, join(directory, 'data'));
    return true;
  });
  assert.doesNotMatch(diagnostic, /private-value/);
  assert.match(diagnostic, /owner_mismatch/);
});

test('storage recovery reports the explicit Gateway directory instead of the registry directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-storage-explicit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gatewayScript = join(directory, 'gateway.mjs'), data = join(directory, 'state');
  await writeFile(gatewayScript, "process.stderr.write('KCODER_MOBILE_STORAGE_ERROR:owner_mismatch'); process.exit(1);");
  await assert.rejects(startGateway({ gatewayScript, cwd: directory, timeoutMs: 2000, env: {
    KCODER_STUDIO_DATA_DIR: data, KCODER_STUDIO_SERVERS_STORE: 'registry/servers.json',
  } }), error => {
    assert.equal(error.code, 'MOBILE_DEVICE_STORAGE_UNAVAILABLE');
    assert.equal(error.storageDataDirectory, data);
    return true;
  });
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
    token: "stable-origin-token-0123456789abcdef0123456789",
    port,
    timeoutMs: 5_000,
  });
  t.after(() => gateway.stop());

  assert.equal(gateway.baseUrl, `http://127.0.0.1:${port}`);
});

async function createGatewayProbe(t) {
  const directory = await mkdtemp(join(tmpdir(), "kcoder-studio-gateway-token-probe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gatewayScript = join(directory, "gateway.mjs");
  await writeFile(gatewayScript, `import { createHash } from "node:crypto";
import { createServer } from "node:http";

const expectedToken = process.env.KCODER_STUDIO_AUTH_TOKEN || "";
const tokenHash = createHash("sha256").update(expectedToken).digest("hex");
console.log("AUTH_TOKEN_SHA256=" + tokenHash);
console.log("RELAY_ENV_PRESENT=" + String(Object.keys(process.env).some(key => key.startsWith("KCODER_RELAY_"))));
const server = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/login") {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    if (new URLSearchParams(body).get("token") !== expectedToken) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(303, {
      location: "/",
      "set-cookie": "kcoder_studio_session=probe; Path=/; HttpOnly",
    }).end();
  });
});
server.listen(Number(process.env.KCODER_STUDIO_PORT), "127.0.0.1", () => {
  console.log("KCoder Studio: http://127.0.0.1:" + server.address().port);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);
  return gatewayScript;
}

async function startGatewayProbe(gatewayScript, options = {}) {
  let stdout = "";
  const gateway = await startGateway({
    gatewayScript,
    timeoutMs: 2_000,
    loginTimeoutMs: 2_000,
    onStdout: chunk => { stdout += chunk; },
    ...options,
  });
  const tokenHash = stdout.match(/AUTH_TOKEN_SHA256=([a-f0-9]{64})/)?.[1];
  const relayEnvPresent = stdout.match(/RELAY_ENV_PRESENT=(true|false)/)?.[1] === "true";
  return { gateway, tokenHash, relayEnvPresent };
}

test('default desktop startup accepts readiness after the former twenty-second deadline', { timeout: 35_000 }, async t => {
  const gatewayScript = await createGatewayProbe(t);
  const source = await readFile(gatewayScript, 'utf8');
  await writeFile(gatewayScript, `await new Promise(resolve => setTimeout(resolve, 21_000));\n${source}`);
  const gateway = await startGateway({ gatewayScript, loginTimeoutMs: 5_000 });
  t.after(() => gateway.stop());
  assert.match(gateway.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(gateway.cookieValue, 'probe');
});

test("Desktop Gateway reuses an explicit stable auth token across restarts and takes options.token first", async t => {
  const gatewayScript = await createGatewayProbe(t);
  const stableToken = "desktop-restart-token-0123456789abcdef0123456789";
  const ignoredEnvToken = "desktop-env-token-0123456789abcdef0123456789abc";
  const expectedHash = createHash("sha256").update(stableToken).digest("hex");
  const first = await startGatewayProbe(gatewayScript, {
    token: stableToken,
    env: {
      KCODER_STUDIO_DESKTOP_AUTH_TOKEN: ignoredEnvToken,
      KCODER_RELAY_SECRET: "relay-secret-that-must-not-reach-gateway",
      KCODER_RELAY_REGISTRATION_KEY: "registration-key-that-must-not-reach-gateway",
    },
  });
  t.after(() => first.gateway.stop());
  assert.equal(first.tokenHash, expectedHash);
  assert.equal(first.relayEnvPresent, false);
  await first.gateway.stop();

  const restarted = await startGatewayProbe(gatewayScript, { token: stableToken });
  t.after(() => restarted.gateway.stop());
  assert.equal(restarted.tokenHash, expectedHash);
});

test("Desktop Gateway uses a fresh random auth token by default and rejects an invalid explicit token", async t => {
  const gatewayScript = await createGatewayProbe(t);
  const first = await startGatewayProbe(gatewayScript);
  t.after(() => first.gateway.stop());
  const second = await startGatewayProbe(gatewayScript);
  t.after(() => second.gateway.stop());

  assert.match(first.tokenHash || "", /^[a-f0-9]{64}$/);
  assert.match(second.tokenHash || "", /^[a-f0-9]{64}$/);
  assert.notEqual(first.tokenHash, second.tokenHash);
  assert.equal(first.relayEnvPresent, false);
  assert.equal(second.relayEnvPresent, false);
  await assert.rejects(
    startGateway({ token: "short" }),
    /32 to 512 character URL-safe value/,
  );
});

test('one Desktop owner preserves live Cookie authority across Gateway restart while a new owner revokes it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-desktop-owner-restart-'));
  const owned = [];
  t.after(async () => { for (const gateway of owned) await gateway.stop(); await rm(directory,{recursive:true,force:true}); });
  const env = { KCODER_STUDIO_MOCK:'1', KCODER_STUDIO_SERVERS_STORE:join(directory,'servers.jsonc'),
    KCODER_STUDIO_AUTH_SESSION_TTL_MS:'60000' };
  const owner = await createDesktopGatewayConfig(env);
  const start = async config => {
    const gateway = await startGateway({env:config.env,token:config.token,timeoutMs:10000,
      gatewayScript:resolve(studioRoot,'dev-server.mjs'),cwd:studioRoot});
    owned.push(gateway); return gateway;
  };
  const status = (gateway,cookie) => fetch(`${gateway.baseUrl}/api/servers`,{
    headers:{cookie:`kcoder_studio_session=${encodeURIComponent(cookie)}`}}).then(response=>response.status);
  const original = await start(owner), cookie = original.cookieValue;
  assert.equal(await status(original,cookie),200);
  const hash = createHash('sha256').update(cookie).digest('hex');
  const originalRow = JSON.parse(await readFile(join(directory,'mobile-device-auth','devices.json'),'utf8'))
    .browserSessions.find(row=>row.idHash===hash);
  assert.ok(originalRow);
  await original.stop();
  const replacement = await start(owner);
  assert.equal(await status(replacement,cookie),200,'same-owner restart must retain original unexpired Cookie authority');
  assert.ok(replacement.cookieValue!==cookie,'each Gateway start still issues its own new Cookie');
  const retained = JSON.parse(await readFile(join(directory,'mobile-device-auth','devices.json'),'utf8'))
    .browserSessions.find(row=>row.idHash===hash);
  assert.ok(retained && retained.expiresAt===originalRow.expiresAt,'restart cannot extend original expiry');
  assert.ok(JSON.stringify(retained.allowedServerIds)===JSON.stringify(originalRow.allowedServerIds),'restart cannot broaden original ACL');
  await replacement.stop();
  const nextOwner = await createDesktopGatewayConfig(env);
  assert.ok(nextOwner.token!==owner.token,'independent Desktop owners need distinct default secrets');
  const independent = await start(nextOwner);
  assert.equal(await status(independent,cookie),401,'new owner must invalidate original Cookie authority');
  assert.equal(await status(independent,replacement.cookieValue),401);
});

test('browser and desktop share authenticated Relay management without a renderer IPC activation bridge', async t => {
  const gateway = await startGateway({ env: { KCODER_STUDIO_MOCK: '1' } });
  t.after(() => gateway.stop());
  const url = gateway.baseUrl + '/api/relay';
  assert.equal((await fetch(url)).status, 401);
  const headers = { cookie: `kcoder_studio_session=${encodeURIComponent(gateway.cookieValue)}` };
  const response = await fetch(url, { headers }); assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.needsLogin, true);
  assert.equal(state.hasPendingIdentity, false);
  assert.equal(state.configured, false);
  assert.equal(state.publicBaseUrl, null);
  assert.equal(state.restartRequired, false);
  assert.equal(state.restartSupported, false);
  assert.equal(state.liveApplySupported, true);
  assert.equal(state.switchSupported, false);
  assert.equal((await fetch(url + '/activation', { method: 'POST', headers: { ...headers, 'content-type': 'application/json', origin: 'https://foreign.example' }, body: JSON.stringify({ activationLink: 'a'.repeat(43) }) })).status, 403);
  assert.equal((await fetch(url + '/restart', { method: 'POST', headers: { ...headers, 'content-type': 'application/json', origin: gateway.baseUrl }, body: '{}' })).status, 409);
  assert.equal((await fetch(url, { headers })).status, 200, 'the same browser session still reaches the Gateway');
});
