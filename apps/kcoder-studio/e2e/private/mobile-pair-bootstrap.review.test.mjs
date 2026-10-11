// Actual Gateway HTTP/session/account-owner paths with a synthetic account-entry
// subprocess. This is not SSH/Rust authentication or public-network evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { RunContext } from "../harness/run-context.mjs";
import { startGateway } from "../harness/gateway.mjs";

test("pair bootstrap uses the newly issued owner, matches device GET and leaves old pairing compatible", { timeout: 30_000 }, async () => {
  const context = await RunContext.create(import.meta.url, { evidenceClass: "Gateway_HTTP_synthetic_account_entry" });
  let failure;
  try {
    const bin = context.pathInState("bin");
    await mkdir(bin, { recursive: true });
    await writeFile(context.pathInState("bin", "package.json"), JSON.stringify({ type: "module" }));
    // launchSpec's owned SSH child is replaced at the executable boundary. The
    // actual account-process validation and loginContexts.publish remain intact.
    const ssh = context.pathInState("bin", "ssh");
    await writeFile(ssh, `#!${process.execPath}
import { createInterface } from 'node:readline';
let authenticated = false;
createInterface({ input: process.stdin }).on('line', line => {
  const input = JSON.parse(line);
  if (!authenticated) {
    authenticated = true;
    process.stdout.write(JSON.stringify({protocol:'kcoder-account-v1',authenticated:true,
      username:input.username,principalId:'11111111-1111-4111-8111-111111111111',uid:2001,role:'user'})+'\\n');
  } else if (input.id !== undefined) {
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:input.id,result:{protocolVersion:'2026-07-27',
      serverInfo:{name:'synthetic-account-entry',version:'1'},capabilities:{experimental:{residentThreads:true}}}})+'\\n');
  }
});
`, { mode: 0o700 });
    await chmod(ssh, 0o700);
    const serversFile = context.pathInState("servers.json");
    await writeFile(serversFile, JSON.stringify([
      { id: "local", label: "Local", transport: "local" },
      { id: "account", label: "Account", transport: "ssh", host: "fixture.invalid", command: "/fixture/kcoder",
        security: { identity: { mode: "kcoder-account" } } },
    ]));
    const gateway = await startGateway(context, { auth: true, serversFile,
      serversStore: context.pathInState("servers-store.json"),
      workspace: context.pathInState("workspace"),
      env: { KCODER_STUDIO_MOCK: "0", PATH: `${bin}:${process.env.PATH}` },
    });
    const call = async (path, { method = "GET", body, token, cookie } = {}) => {
      const response = await fetch(gateway.baseUrl + path, { method,
        signal: AbortSignal.timeout(5_000),
        headers: { origin: gateway.baseUrl, ...(body ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, 200, "synthetic fixture HTTP succeeds");
      return { body: await response.json(), cookie: response.headers.get("set-cookie") };
    };
    const old = await call("/api/mobile/session", { method: "POST", body: { token: gateway.authToken } });
    context.registerSecret(old.body.accessToken);
    assert.equal(old.body.initialServers, undefined);
    assert.equal(old.body.capabilities.mobileInitialServersV1, undefined);
    const cookie = old.cookie.split(";", 1)[0];
    context.registerSecret("synthetic-only-password");
    const login = await call("/api/servers/account/account", { method: "POST", cookie,
      body: { username: "alice", password: "synthetic-only-password" } });
    assert.equal(login.body.authenticated, true);
    const hostInventory = (await call("/api/servers", { cookie })).body.servers;
    assert.equal(hostInventory.find(server => server.id === "account").accountIdentity.username, "alice");

    const paired = await call("/api/mobile/session", { method: "POST", cookie,
      body: { token: gateway.authToken, requestInitialServers: true } });
    context.registerSecret(paired.body.accessToken);
    assert.equal(paired.cookie, null, "independent host cookie is preserved");
    assert.equal(paired.body.capabilities.mobileInitialServersV1, true);
    assert.equal(paired.body.initialServers.version, 1);
    const bearerInventory = (await call("/api/servers", { token: paired.body.accessToken })).body.servers;
    assert.deepEqual(paired.body.initialServers.servers, bearerInventory);
    assert.equal(bearerInventory.find(server => server.id === "account").accountIdentity, undefined,
      "new pairing owner cannot inherit the host cookie principal");
    assert.deepEqual((await call("/api/servers", { cookie })).body.servers, hostInventory);

    const device = await call("/api/mobile/session", { method: "POST", cookie,
      body: { token: gateway.authToken, durableDeviceAuthorization: true, deviceLabel: "bootstrap review", requestInitialServers: true } });
    context.registerSecret(device.body.accessToken); context.registerSecret(device.body.refreshToken);
    assert.equal(device.body.capabilities.mobileRefreshV1, true);
    assert.equal(device.body.capabilities.mobileInitialServersV1, true);
    assert.equal(device.cookie, null);
    assert.deepEqual(device.body.initialServers.servers,
      (await call("/api/servers", { token: device.body.accessToken })).body.servers);
    const inspect = value => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        assert.equal(/token|password|credential|loginOwner/i.test(key), false, "inventory contains public fields only");
        inspect(child);
      }
    };
    inspect(device.body.initialServers); inspect(paired.body.initialServers);
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? "failed" : "passed", undefined, failure); }
});
