import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runE2E, waitFor } from './run-context.mjs';
import { startGateway, waitForGatewayRpcToken } from './gateway.mjs';
import { login } from './http.mjs';
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from './rpc.mjs';
import { loadServers, storedServer } from '../../src/server-config.js';
import { createDesktopProfileLaunchSpec } from '../../src/desktop-profile.mjs';
import { createMigrationSourceSessionLauncher } from '../../src/migration-source-session-launch.js';

test('actual owned Gateway keeps the Desktop profile in launch argv through A GET B without persisting it', { skip: process.platform === 'win32' ? 'owned executable shebang fixture requires POSIX; not native Windows evidence' : false }, async () => {
  await runE2E(import.meta.url, { tier: 'model-independent', modelPolicy: 'real Gateway HTTP/RPC and owned protocol argv observer, no native model/provider' }, async context => {
    const workspace = context.pathInState('workspace'), stage = context.pathInState('cli'), web = context.pathInState('web');
    for (const path of [workspace, stage, web]) await mkdir(path, { recursive: true });
    const binary = join(stage, 'owned-cli.mjs');
    await copyFile(new URL('./fixtures/desktop-profile-cli.mjs', import.meta.url), binary); await chmod(binary, 0o700);
    await writeFile(join(web, 'index.html'), '<html><head></head><body>Owned profile protocol fixture</body></html>');
    const [local] = await loadServers({ env: {}, repoRoot: workspace, appServerBin: binary, workspace });
    const a = storedServer(local), store = await context.writeStateJson('servers.json', [a]);
    const before = await readFile(store);
    const gateway = await startGateway(context, { auth: true, workspace, kcoderBin: binary, serversStore: store,
      env: { KCODER_STUDIO_DESKTOP_HOST: '1', KCODER_STUDIO_DESKTOP_PROFILE: 'owned-profile',
        KCODER_STUDIO_DATA_DIR: context.pathInState('gateway-data'), KCODER_STUDIO_WEB_ROOT: web,
        KCODER_STUDIO_RENDERER_MODE: 'static', KCODER_NATIVE_CONNECTIVITY_BINDING_V1: Buffer.from('{}').toString('base64url') } });
    const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
    const call = async (path, method = 'GET', body) => {
      const reply = await fetch(gateway.baseUrl + path, { method, signal: AbortSignal.timeout(5_000),
        headers: { cookie, origin: gateway.baseUrl, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: reply.status, body: await reply.json() };
    };
    assert.equal((await call('/api/servers/test', 'POST', a)).body.ok, true);
    const observations = async () => (await readFile(join(stage, 'argv.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    let argv = await observations(); assert.deepEqual(argv[0].args, ['--profile', 'owned-profile', 'app-server']);
    for (let count = 0; count < 40; count++) assert.equal((await call('/api/servers')).status, 200);
    assert.deepEqual(await readFile(store), before); assert.equal((await observations()).length, argv.length);
    const b = { id: 'peer', label: 'Peer', runtime: 'kcoder', transport: 'ssh', host: 'owned-peer.invalid', profile: 'peer-profile' };
    assert.equal((await call('/api/servers/peer', 'PUT', b)).status, 200);
    const disk = JSON.parse(await readFile(store, 'utf8')); assert.deepEqual(disk.find(row => row.id === 'local'), a);
    assert.equal(disk.find(row => row.id === 'peer').profile, 'peer-profile');
    const token = await waitForGatewayRpcToken(context, gateway, { headers: { cookie } });
    const uri = new URL(gatewayRpcUrl(gateway, 'local', token)); uri.searchParams.set('workspace', stage);
    const rpc = await openRpc(uri.href, { headers: { cookie, origin: gateway.baseUrl } });
    context.addCleanup('close owned profile RPC', () => closeRpcAndWait(rpc));
    await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-profile-client', version: '1' } });
    argv = await observations(); assert.equal(argv.length, 2);
    assert.deepEqual(argv[1].args, ['--profile', 'owned-profile', '--cwd', stage, 'app-server']);
    const launchProbe = createMigrationSourceSessionLauncher({
      makeLaunchSpec: createDesktopProfileLaunchSpec({ env: { KCODER_STUDIO_DESKTOP_HOST: '1', KCODER_STUDIO_DESKTOP_PROFILE: 'owned-profile' }, appServerBin: binary }),
      baseEnv: context.isolatedEnvironment(),
      spawnProcess: (command, args, options) => context.spawnOwned('migration-profile-probe', command, args, { ...options, stdin: 'pipe' }),
    });
    // Exercise the real dedicated launcher and process, without advertising or
    // invoking Native migration features that this argv observer cannot provide.
    await launchProbe({ target: local, phase: 'probe', adopt() {} });
    argv = await waitFor(async () => { const rows = await observations(); return rows.length === 3 ? rows : null; }, 5_000, 'owned dedicated probe argv');
    assert.deepEqual(argv[2].args, ['--profile', 'owned-profile', 'app-server']);
    await context.stopOwned('migration-profile-probe');
    await closeRpcAndWait(rpc); await context.stopOwned('gateway');
    const restarted = await startGateway(context, { label: 'gateway-no-profile', auth: true, workspace, kcoderBin: binary, serversStore: store,
      env: { KCODER_STUDIO_DESKTOP_HOST: '1', KCODER_STUDIO_DATA_DIR: context.pathInState('gateway-data'),
        KCODER_NATIVE_CONNECTIVITY_BINDING_V1: Buffer.from('{}').toString('base64url') } });
    const nextCookie = await login(restarted.baseUrl, restarted.authToken); context.registerSecret(nextCookie);
    const next = await fetch(restarted.baseUrl + '/api/servers/test', { method: 'POST', signal: AbortSignal.timeout(5_000),
      headers: { cookie: nextCookie, origin: restarted.baseUrl, 'content-type': 'application/json' }, body: JSON.stringify(a) });
    assert.equal((await next.json()).ok, true); argv = await observations(); assert.deepEqual(argv.at(-1).args, ['app-server']);
    await context.writeArtifactJson('profile-argv-and-storage.json', { argv, localRecordUnchanged: true, warmGets: 40, warmLaunches: 0, peerProfile: 'peer-profile', dedicatedLauncherArgv: true });
    return { launchOnlyDefault: true, ordinaryHealthAndProbeArgv: true, warmGets: 40, originalLocalRecordRetained: true, restartWithoutDefault: true, modelCalls: 0, nativeWindows: false };
  });
});
