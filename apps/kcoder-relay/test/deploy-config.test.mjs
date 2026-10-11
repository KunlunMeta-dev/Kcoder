import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createRelayDeploymentConfig,
  createRelayDeploymentDryRunSummary,
  createRelayUrls,
  relayDeploymentScpOptions,
  resolveRelayRouteMode,
} from '../deploy/config.mjs';
import { relayServerConfig } from '../src/config.mjs';

const gateways = [
  {
    id: 'gateway-a',
    secret: 'a'.repeat(32),
    pairingToken: 'b'.repeat(32),
    maxConnections: 128,
    maxBytesPerWindow: 64 * 1024 * 1024,
    trafficWindowMs: 60_000,
  },
  {
    id: 'gateway-b',
    secret: 'c'.repeat(32),
    pairingToken: 'd'.repeat(32),
    maxConnections: 64,
    maxBytesPerWindow: 32 * 1024 * 1024,
    trafficWindowMs: 30_000,
  },
];

test('multi-Gateway dry run emits one existing public authority and a private registry reference', () => {
  const plan = createRelayDeploymentConfig({
    relayConfig: { legacy: false, sharedHosts: ['hyf2333.top:8451'], gateways },
  });

  assert.equal(plan.publicAuthority, 'hyf2333.top:8451');
  assert.deepEqual(plan.gateways, ['gateway-a', 'gateway-b']);
  assert.equal((plan.caddyEnv.match(/^KCODER_RELAY_DOMAIN=/gm) || []).length, 1);
  assert.doesNotMatch(plan.caddyEnv, /www\.|subdomain/i);
  assert.match(plan.cloudEnv, /^KCODER_RELAY_REGISTRY_FILE=\/etc\/kcoder-relay-registry\.json$/m);
  assert.doesNotMatch(plan.cloudEnv, /secret|pairingToken|a{32}|b{32}/i);

  const registry = JSON.parse(plan.registryJson);
  assert.equal(Object.hasOwn(registry, 'legacy'), false);
  assert.deepEqual(registry.sharedHosts, ['hyf2333.top:8451']);
  assert.deepEqual(registry.gateways.map(({ id }) => id), ['gateway-a', 'gateway-b']);
  assert.equal(registry.gateways[1].maxBytesPerWindow, 32 * 1024 * 1024);
});

test('automatic registration supports an empty static list and keeps its store outside deployment files', () => {
  const registrationKey = `r${'k'.repeat(47)}`;
  const plan = createRelayDeploymentConfig({
    relayConfig: {
      sharedHosts: ['hyf2333.top:8451'],
      gateways: [],
      registrationKey,
      registrationStoreFile: '/local/private/registration-store.json',
    },
  });

  assert.equal(plan.registryJson, null);
  assert.deepEqual(plan.gateways, []);
  assert.equal(plan.registrationStoreFile, '/var/lib/kcoder-relay/registered-gateways.json');
  assert.match(plan.cloudEnv, /^KCODER_RELAY_REGISTRATION_STORE_FILE=\/var\/lib\/kcoder-relay\/registered-gateways\.json$/m);
  assert.match(plan.cloudEnv, new RegExp(`^KCODER_RELAY_REGISTRATION_KEY=${registrationKey}$`, 'm'));
  assert.doesNotMatch(plan.caddyEnv, /registrationKey|registrationStoreFile|registered-gateways/);

  const summary = createRelayDeploymentDryRunSummary({ target: 'admin@relay-host', deployment: plan });
  assert.equal(summary.registration.enabled, true);
  assert.equal(summary.registration.storeFile, '/var/lib/kcoder-relay/registered-gateways.json');
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(registrationKey));
  assert.equal(summary.deploymentPerformed, false);
});

test('server automatic-registration config maps its local default store to the cloud StateDirectory', () => {
  const registrationKey = 's'.repeat(48);
  const relayConfig = relayServerConfig({
    KCODER_RELAY_PUBLIC_URL: 'https://hyf2333.top:8451',
    KCODER_RELAY_REGISTRATION_KEY: registrationKey,
  });
  assert.deepEqual(relayConfig.gateways, []);
  assert.equal(relayConfig.registrationKey, registrationKey);
  assert.match(relayConfig.registrationStoreFile, /target[\\/]kcoder-relay[\\/]registered-gateways\.json$/);

  const deployment = createRelayDeploymentConfig({ relayConfig });
  assert.equal(deployment.registryJson, null);
  assert.equal(deployment.registrationStoreFile, '/var/lib/kcoder-relay/registered-gateways.json');
  assert.match(deployment.cloudEnv, /^KCODER_RELAY_REGISTRATION_KEY=s{48}$/m);
  assert.doesNotMatch(deployment.cloudEnv, /target[\\/]kcoder-relay/);
});

test('server store-only config preserves the store and disables deployment enrollment', () => {
  const relayConfig = relayServerConfig({
    KCODER_RELAY_REGISTRATION_STORE_FILE: '/local/private/registered-gateways.json',
    KCODER_RELAY_SHARED_HOSTS: 'hyf2333.top:8451',
  });
  assert.deepEqual(relayConfig.gateways, []);
  assert.equal(relayConfig.registrationKey, undefined);
  const deployment = createRelayDeploymentConfig({ relayConfig });
  assert.match(deployment.cloudEnv, /^KCODER_RELAY_REGISTRATION_STORE_FILE=\/var\/lib\/kcoder-relay\/registered-gateways\.json$/m);
  assert.doesNotMatch(deployment.cloudEnv, /^KCODER_RELAY_REGISTRATION_KEY=/m);
});

test('store-only deployment keeps registered Gateways without re-enabling enrollment', () => {
  const plan = createRelayDeploymentConfig({
    relayConfig: {
      sharedHosts: ['hyf2333.top:8451'],
      gateways: [],
      registrationStoreFile: '/local/private/registration-store.json',
    },
  });

  assert.equal(plan.registryJson, null);
  assert.equal(plan.registrationStoreFile, '/var/lib/kcoder-relay/registered-gateways.json');
  assert.match(plan.cloudEnv, /^KCODER_RELAY_REGISTRATION_STORE_FILE=\/var\/lib\/kcoder-relay\/registered-gateways\.json$/m);
  assert.doesNotMatch(plan.cloudEnv, /^KCODER_RELAY_REGISTRATION_KEY=/m);
});

test('static Gateways and the durable registration store are deployed independently', () => {
  const plan = createRelayDeploymentConfig({
    relayConfig: {
      sharedHosts: ['hyf2333.top:8451'],
      gateways: [gateways[0]],
      registrationKey: 'z'.repeat(32),
      registrationStoreFile: '/local/private/registration-store.json',
    },
  });

  assert.deepEqual(JSON.parse(plan.registryJson).gateways.map(({ id }) => id), ['gateway-a']);
  assert.match(plan.cloudEnv, /^KCODER_RELAY_REGISTRY_FILE=\/etc\/kcoder-relay-registry\.json$/m);
  assert.match(plan.cloudEnv, /^KCODER_RELAY_REGISTRATION_STORE_FILE=\/var\/lib\/kcoder-relay\/registered-gateways\.json$/m);
  assert.doesNotMatch(plan.cloudEnv, /\/local\/private/);
});

test('empty static configuration needs a persistent store and enrollment key must be safe for an env file', () => {
  const base = { sharedHosts: ['hyf2333.top:8451'], gateways: [] };
  assert.throws(() => createRelayDeploymentConfig({ relayConfig: base }), /requires the persistent registration store/);
  assert.throws(() => createRelayDeploymentConfig({
    relayConfig: { ...base, registrationKey: 'bad\nKCODER_RELAY_SECRET=leaked' },
  }), /Invalid relay registration key/);
});

test('systemd gives the relay service private persistent state and deployment never removes it', () => {
  const service = readFileSync(fileURLToPath(new URL('../deploy/kcoder-relay.service', import.meta.url)), 'utf8');
  const deploy = readFileSync(fileURLToPath(new URL('../src/deploy.mjs', import.meta.url)), 'utf8');
  assert.match(service, /^User=kcoder-relay$/m);
  assert.match(service, /^StateDirectory=kcoder-relay$/m);
  assert.match(service, /^StateDirectoryMode=0700$/m);
  assert.match(service, /^UMask=0077$/m);
  assert.doesNotMatch(deploy, /rm\s+[^\n]*registered-gateways\.json/);
  assert.doesNotMatch(deploy, /install\s+[^\n]*registered-gateways\.json/);
});

test('Caddy template declares one current-domain site with separate data and control routes', () => {
  const caddyfile = readFileSync(fileURLToPath(new URL('../deploy/Caddyfile', import.meta.url)), 'utf8');
  assert.equal((caddyfile.match(/^https:\/\//gm) || []).length, 1);
  assert.doesNotMatch(caddyfile, /www\.|DOMAIN_WWW/);
  assert.match(caddyfile, /handle \/_relay\/\*\s*\{[\s\S]*KCODER_RELAY_CONTROL_PORT/);
  assert.match(caddyfile, /handle \/g\/\*\s*\{[\s\S]*KCODER_RELAY_PROXY_PORT/);
});

test('deployment rejects extra hostnames and any alternate public domain', () => {
  assert.throws(() => createRelayDeploymentConfig({
    relayConfig: { sharedHosts: ['hyf2333.top:8451', 'www.hyf2333.top:8451'], gateways },
  }), /sharedHosts must contain only hyf2333\.top:8451/);
  assert.throws(() => createRelayDeploymentConfig({
    relayConfig: { sharedHosts: ['hyf2333.top:8451'], gateways },
    domain: 'www.hyf2333.top',
  }), /fixed to hyf2333\.top/);
  assert.throws(() => createRelayDeploymentConfig({
    relayConfig: { sharedHosts: ['hyf2333.top:8451'], gateways },
    publicPort: 8452,
  }), /fixed to port 8451/);
});

test('legacy mode keeps its one Gateway credentials in the protected service env', () => {
  const plan = createRelayDeploymentConfig({
    relayConfig: { legacy: true, sharedHosts: ['hyf2333.top:8451'], gateways: [gateways[0]] },
  });
  assert.equal(plan.registryJson, null);
  assert.match(plan.cloudEnv, /^KCODER_RELAY_DEVICE_ID=gateway-a$/m);
  assert.match(plan.cloudEnv, /^KCODER_RELAY_SECRET=a{32}$/m);
});

test('local path mode keeps /g/<id> while health uses the root origin', () => {
  const urls = createRelayUrls({
    publicUrl: 'https://hyf2333.top:8451',
    gatewayId: 'gateway-a',
    routeMode: 'path',
  });
  assert.equal(urls.gatewayBase.pathname, '/g/gateway-a/');
  assert.equal(urls.gatewayEndpoint('/api/mobile/session').pathname, '/g/gateway-a/api/mobile/session');
  assert.equal(urls.gatewayEndpoint('/rpc').pathname, '/g/gateway-a/rpc');
  assert.equal(new URL('/_relay/health', urls.publicRoot).pathname, '/_relay/health');
  assert.equal(createRelayUrls({ publicUrl: 'https://hyf2333.top:8451/g/gateway-b' }).gatewayBase.pathname, '/g/gateway-b/');
  assert.equal(createRelayUrls({
    publicUrl: 'https://hyf2333.top:8451', gatewayId: 'gateway-a', routeMode: 'legacy',
  }).gatewayBase.pathname, '/');
  assert.equal(resolveRelayRouteMode({ registryMode: true }), 'path');
  assert.throws(() => resolveRelayRouteMode({ registryMode: true, routeMode: 'legacy' }), /requires path routing/);
  assert.throws(() => createRelayUrls({
    publicUrl: 'https://hyf2333.top:8451', routeMode: 'path',
  }), /requires a Gateway ID/);
});

test('deployment transfer recurses into packaged source and deploy directories', () => {
  assert.deepEqual(relayDeploymentScpOptions(), ['-p', '-q', '-r']);
});
