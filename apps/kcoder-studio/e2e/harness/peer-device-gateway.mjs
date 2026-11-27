import assert from 'node:assert/strict';
import { stat, mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { RunContext, waitFor } from './run-context.mjs';
import { startGateway } from './gateway.mjs';
import { startPeerDeviceProxy } from './peer-device-proxy.mjs';
import { readOwnedPeerDeviceCredential } from './peer-device-credentials.mjs';
import { openOwnedPeerBrowserRuntime } from './peer-browser-runtime.mjs';
import { openOwnedPeerStudioPage } from './peer-studio-browser.mjs';
import { captureTrustedLocalAppServer } from '../../src/trusted-local-app-server.js';

/** Actual HTTP device pairing and production Gateway for an owned TUI Lab
 * profile. The caller keeps that original profile/workspace; this RunContext
 * exclusively owns its Gateway, Native children, ports and pairing process.
 */
export async function startPeerDeviceGateway({ binary, profile, workspace, parentArtifacts, actors, directDefaultNative = false, sourceOnlyNetworkFault = false, accessTtlMs, socketGraceMs, peerNotificationDiagnostics = false }) {
  assert.equal(process.platform, 'linux', 'this owned cross-harness acceptance currently requires Linux');
  assert.ok(path.isAbsolute(binary));
  assert.ok((await stat(binary)).isFile());
  const crossTarget = actors !== undefined;
  assert.equal(typeof directDefaultNative, 'boolean');
  if (directDefaultNative) assert.equal(crossTarget, true);
  if (crossTarget) {
    assert.equal(actors.length, 2);
    assert.equal(new Set(actors.map(actor => actor.profile)).size, 2);
    assert.equal(new Set(actors.map(actor => actor.workspace)).size, 2);
    assert.equal(new Set(actors.map(actor => actor.alias)).size, 2);
    for (const actor of actors) {
      assert.ok(path.isAbsolute(actor.profile) && path.isAbsolute(actor.workspace));
      assert.match(actor.alias, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
    }
  }
  const endpoints = actors ?? [{ alias: 'owned-peer-native', profile, workspace }];
  const context = await RunContext.create(import.meta.url, {
    testId: crossTarget ? 'cross-target-peer-device-http-pairing-and-native-gateway' : 'peer-device-http-pairing-and-native-gateway', tier: 'full-integration',
    modelPolicy: 'Actual HTTP pairing, device WebSockets and Native Gateway. Parent owns deterministic Provider and actual terminal/browser actors; no autonomous model or Windows claim.',
    parentArtifacts, accessTtlMs, socketGraceMs,
  });
  let finished = false, network, gatewayUrl, observedDevice;
  const observedDevices = new Map(), pairPids = [];
  const rememberCredentials = async () => {
    for (const actor of endpoints) observedDevices.set(actor.alias, await readOwnedPeerDeviceCredential(context, actor.profile));
    observedDevice = observedDevices.get(endpoints[0].alias);
  };
  const finish = async failure => {
    if (finished) return;
    if (network) await context.writeArtifactJson('peer-device-network.json', network.snapshot());
    finished = true;
    await context.finish(failure ? 'failed' : 'passed', { actualHttpDevicePairing: true,
      actualGateway: true, parentTuiLabArtifacts: parentArtifacts }, failure);
  };
  try {
    const alias = endpoints[0].alias;
    const servers = [];
    for (const actor of endpoints) {
      let command = binary;
      if (crossTarget && !(directDefaultNative && actor === endpoints[0])) {
        command = context.pathInState(`native-launch-${actor.alias}`);
        const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
        // exec retains the actual Gateway parent/PID and inherited private pipes.
        // It selects a real private profile, never a serialized permission grant.
        await writeFile(command, `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(actor.profile)}\nexport KCODER_HOME=${quote(actor.profile)}\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 });
        await chmod(command, 0o700);
      }
      servers.push({ id: actor.alias, label: `Owned peer ${actor.alias}`, runtime: 'kcoder', transport: 'local', command, workspace: actor.workspace });
    }
    const serversFile = await context.writeStateJson('servers.json', servers);
    const gatewayProfile = crossTarget && !directDefaultNative ? context.pathInState('gateway-profile') : endpoints[0].profile;
    if (crossTarget && !directDefaultNative) { await mkdir(gatewayProfile, { mode: 0o700 }); await context.writeStateJson('gateway-profile/settings.json', { providers: {}, credential_store: 'file' }); }
    if (directDefaultNative) {
      // The real default image/profile needs no launcher. Check the same held
      // image predicate the production Gateway uses; never override its verdict.
      const image = captureTrustedLocalAppServer(binary);
      try { assert.ok(image?.matches(servers[0]), 'Actual default Native image must satisfy the production identity predicate'); }
      finally { image?.close(); }
    }
    const gateway = await startGateway(context, { label: 'peer-device-gateway', auth: true,
      peerNotificationDiagnostics,
      workspace: endpoints[0].workspace, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: gatewayProfile,
        KCODER_HOME: gatewayProfile, KCODER_STUDIO_DATA_DIR: gatewayProfile,
        ...(accessTtlMs===undefined?{}:{KCODER_STUDIO_MOBILE_ACCESS_TTL_MS:String(accessTtlMs)}),
        ...(socketGraceMs===undefined?{}:{KCODER_STUDIO_MOBILE_SOCKET_GRACE_MS:String(socketGraceMs)}) } });
    if (sourceOnlyNetworkFault || crossTarget) network = await startPeerDeviceProxy(context, gateway);
    gatewayUrl = network?.baseUrl ?? gateway.baseUrl;
    for (const actor of endpoints) {
      const env = context.isolatedEnvironment({ KCODER_CONFIG_DIR: actor.profile, KCODER_HOME: actor.profile, KCODER_STUDIO_DATA_DIR: gatewayProfile });
      const pair = context.spawnOwned(crossTarget ? `peer-device-pair-${actor.alias}` : 'peer-device-pair', binary,
        ['--cwd', actor.workspace, 'peer-gateway', 'pair', '--gateway', gatewayUrl, '--store', 'file', '--code-stdin'],
        { cwd: actor.workspace, env, stdin: 'pipe' });
      pairPids.push(pair.pid); pair.stdin.end(gateway.authToken + '\n');
      await waitFor(() => pair.exitCode !== null || pair.signalCode !== null, 30_000, 'owned first-party Gateway pairing');
      assert.equal(pair.exitCode, 0, 'inspect the owned redacted pair log on failure');
    }
    await rememberCredentials();
    if (crossTarget) assert.equal(new Set([...observedDevices.values()].map(value => value.id)).size, 2);
    return { alias, artifacts: context.runRoot, rememberCredentials, finish, network,
      actors: endpoints.map(actor => ({ ...actor })),
      directDefaultNative,
      deviceIds: () => [...observedDevices.values()].map(value => value.id),
      actorPids: () => ({ gatewayPid: gateway.child.pid, pairPid: pairPids[0], pairPids }),
      redactEvidence: value => context.redactValue(value),
      openBrowserRuntime: () => openOwnedPeerBrowserRuntime(context, gateway, { serverId: alias, workspace }),
      openStudioPage: () => openOwnedPeerStudioPage(context, gateway),
      async waitForPeerSockets(count = 2) {
        assert.ok(network, 'This run did not request an owned network fault');
        assert.equal(count, 2, 'The fault has exactly one Source and one Receiver');
        await waitFor(() => { const value = network.snapshot(); return value.peerUpgrades === count && value.sourceConnected && value.receiverConnected; },
          30_000, 'Source then Receiver actual device WebSockets');
        return network.snapshot();
      },
      async observeDeviceAuthorization({ reloadFile = true } = {}) {
        if (reloadFile) await rememberCredentials();
        assert.ok(observedDevice, 'Read only this fixture explicit private file credential before probing');
        // A post-revoke observation deliberately uses the last real credential;
        // no personal profile, keyring or environment fallback is attempted.
        context.registerSecret(observedDevice.token);
        let response;
        try {
          response = await fetch(gatewayUrl + '/api/mobile/devices', { headers: { authorization: 'Bearer ' + observedDevice.token },
            signal: AbortSignal.timeout(10_000), redirect: 'manual' });
        } catch { throw new Error('Owned device authorization transport unconfirmed'); }
        if ([401, 403].includes(response.status)) return { httpStatus: response.status, authorized: false, deviceId: observedDevice.id, expiresAt: null };
        assert.equal(response.status, 200, 'Owned device authorization returned an unexpected HTTP status');
        let body;
        try { const text = await response.text(); assert.ok(Buffer.byteLength(text) <= 1024 * 1024); body = JSON.parse(text); }
        catch { throw new Error('Owned device authorization response is unconfirmed'); }
        assert.ok(Array.isArray(body.devices), 'Owned device list response is missing');
        const device = body.devices.find(device => device.id === observedDevice.id);
        return { httpStatus: response.status, authorized: Boolean(device), deviceId: observedDevice.id, expiresAt: device?.expiresAt ?? null };
      },
      async revoke() {
        const env = context.isolatedEnvironment({ KCODER_CONFIG_DIR: profile, KCODER_HOME: profile, KCODER_STUDIO_DATA_DIR: profile });
        await rememberCredentials();
        const child = context.spawnOwned('peer-device-revoke', binary,
          ['--cwd', workspace, 'peer-gateway', 'revoke'], { cwd: workspace, env, stdin: 'pipe' });
        child.stdin.end();
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, 30_000, 'owned device revocation');
        assert.equal(child.exitCode, 0, 'owned device revocation must be authoritative');
      } };
  } catch (error) { await finish(error); throw error; }
}
