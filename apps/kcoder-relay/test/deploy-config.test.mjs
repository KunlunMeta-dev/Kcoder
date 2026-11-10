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
    gatewaySecret: 'b'.repeat(32),
    maxConnections: 128,
    maxBytesPerWindow: 64 * 1024 * 1024,
    trafficWindowMs: 60_000,
  },
  {
    id: 'gateway-b',
    secret: 'c'.repeat(32),
    gatewaySecret: 'd'.repeat(32),
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
  assert.match(plan.cloudEnv, /^KCODER_RELAY_PUBLIC_URL=https:\/\/hyf2333\.top:8451$/m);
  assert.equal((plan.caddyEnv.match(/^KCODER_RELAY_DOMAIN=/gm) || []).length, 1);
  assert.doesNotMatch(plan.caddyEnv, /www\.|subdomain/i);
  assert.match(plan.cloudEnv, /^KCODER_RELAY_REGISTRY_FILE=\/etc\/kcoder-relay-registry\.json$/m);
  assert.doesNotMatch(plan.cloudEnv, /secret|gatewaySecret|a{32}|b{32}/i);

  const registry = JSON.parse(plan.registryJson);
  assert.equal(Object.hasOwn(registry, 'legacy'), false);
  assert.deepEqual(registry.sharedHosts, ['hyf2333.top:8451']);
  assert.deepEqual(registry.gateways.map(({ id }) => id), ['gateway-a', 'gateway-b']);
  assert.equal(registry.gateways[1].maxBytesPerWindow, 32 * 1024 * 1024);
  assert.deepEqual(plan.stun, {
    enabled: true,
    mode: 'stun-only',
    publicUrl: 'stun:hyf2333.top:8452',
    protocol: 'udp',
    listenAddress: '0.0.0.0',
    port: 8452,
    unitName: 'kcoder-stun.service',
    unitPath: '/etc/systemd/system/kcoder-stun.service',
    configPath: '/etc/coturn/kcoder-stun.conf',
    ownerReceiptPath: '/var/lib/kcoder-relay-stun/owner.json',
    lifecycleActions: ['install', 'upgrade', 'status', 'cleanup'],
  });
});

test('canonical HTTPS URL normalizes host case and explicit default port 443', () => {
  const domain = 'relay.tenxunyun2.hyf2333.top';
  const plan = createRelayDeploymentConfig({
    relayConfig: { sharedHosts: [`${domain.toUpperCase()}:443`], gateways },
    publicUrl: `https://${domain.toUpperCase()}:443`,
  });

  assert.equal(plan.publicUrl, `https://${domain}`);
  assert.equal(plan.canonicalPublicUrl, `https://${domain}`);
  assert.equal(plan.domain, domain);
  assert.equal(plan.publicPort, 443);
  assert.equal(plan.publicAuthority, domain);
  assert.match(plan.caddyEnv, new RegExp(`^KCODER_RELAY_DOMAIN=${domain}$`, 'm'));
  assert.match(plan.caddyEnv, /^KCODER_RELAY_PUBLIC_PORT=443$/m);
  assert.ok(plan.cloudEnv.split('\n').includes(`KCODER_RELAY_PUBLIC_URL=https://${domain}`));
  assert.equal(plan.stun.publicUrl, `stun:${domain}:8452`);
  assert.equal(plan.stun.port, 8452);
  assert.deepEqual(JSON.parse(plan.registryJson).sharedHosts, [domain]);
});

test('canonical custom HTTPS port must match the legacy domain and port inputs when supplied', () => {
  const domain = 'relay.example.com';
  const plan = createRelayDeploymentConfig({
    relayConfig: { sharedHosts: [`${domain}:9443`], gateways },
    publicUrl: `https://${domain}:9443/`,
    domain,
    publicPort: '9443',
    stunPort: '8453',
  });

  assert.equal(plan.publicUrl, `https://${domain}:9443`);
  assert.equal(plan.publicAuthority, `${domain}:9443`);
  assert.equal(plan.stun.publicUrl, `stun:${domain}:8453`);
  assert.equal(plan.stun.port, 8453);
  assert.throws(() => createRelayDeploymentConfig({
    relayConfig: { sharedHosts: [`${domain}:9443`], gateways },
    publicUrl: `https://${domain}:9443`,
    domain: 'other.example.com',
    publicPort: 9443,
  }), /DOMAIN must match/);
  assert.throws(() => createRelayDeploymentConfig({
    relayConfig: { sharedHosts: [`${domain}:9443`], gateways },
    publicUrl: `https://${domain}:9443`,
    domain,
    publicPort: 8451,
  }), /PUBLIC_PORT must match/);
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
  assert.deepEqual(summary.stun, plan.stun);
  assert.equal(summary.stun.protocol, 'udp');
  assert.equal(summary.stun.listenAddress, '0.0.0.0');
  assert.deepEqual(summary.stun.lifecycleActions, ['install', 'upgrade', 'status', 'cleanup']);
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(registrationKey));
  assert.equal(summary.deploymentPerformed, false);
});

test('cloud registration environment resolves sharedHosts from the canonical public URL', () => {
  const domain = 'relay.tenxunyun2.hyf2333.top';
  const registrationKey = 't'.repeat(48);
  const plan = createRelayDeploymentConfig({
    relayConfig: {
      sharedHosts: [`${domain}:443`],
      gateways: [],
      registrationKey,
      registrationStoreFile: '/local/private/registration-store.json',
    },
    publicUrl: `https://${domain}:443`,
  });
  const cloudEnv = Object.fromEntries(plan.cloudEnv.trim().split('\n').map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const runtimeConfig = relayServerConfig(cloudEnv);

  assert.equal(cloudEnv.KCODER_RELAY_PUBLIC_URL, `https://${domain}`);
  assert.deepEqual(runtimeConfig.gateways, []);
  assert.deepEqual(runtimeConfig.sharedHosts, [domain]);
  assert.equal(runtimeConfig.sharedHosts.includes('hyf2333.top:8451'), false);
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
  assert.match(deploy, /gatewayConnectionRoutes\.runtime\.mjs/);
  assert.match(deploy, /kcoder-studio\/shared\/gatewayConnectionRoutes\.js/);
});

test('Caddy template declares the current-domain site and one on-demand Gateway origin wildcard', () => {
  const caddyfile = readFileSync(fileURLToPath(new URL('../deploy/Caddyfile', import.meta.url)), 'utf8');
  const sites = caddyfile.match(/^https:\/\/\S+/gm) || [];
  assert.deepEqual(sites, [
    'https://{$KCODER_RELAY_DOMAIN}:{$KCODER_RELAY_PUBLIC_PORT}',
    'https://*.{$KCODER_RELAY_DOMAIN}:{$KCODER_RELAY_PUBLIC_PORT}',
  ]);
  assert.doesNotMatch(caddyfile, /www\.|DOMAIN_WWW/);
  const [root, gatewayOrigins] = caddyfile.split(/^https:\/\/\*\./m);
  assert.match(root, /handle \/_relay\/\*\s*\{[\s\S]*KCODER_RELAY_CONTROL_PORT/);
  assert.match(root, /handle \/g\/\*\s*\{[\s\S]*KCODER_RELAY_PROXY_PORT/);
  assert.doesNotMatch(root, /on_demand/);
  assert.match(gatewayOrigins, /tls \{\s*on_demand\s/);
  assert.doesNotMatch(gatewayOrigins, /_relay|CONTROL_PORT/, 'Gateway origins cannot reach registration or control');
});

test('deployment requires exactly one shared host matching the canonical public site', () => {
  assert.throws(() => createRelayDeploymentConfig({
    relayConfig: { sharedHosts: ['hyf2333.top:8451', 'www.hyf2333.top:8451'], gateways },
    publicUrl: 'https://hyf2333.top:8451',
  }), /sharedHosts must contain only hyf2333\.top:8451/);
  assert.throws(() => createRelayDeploymentConfig({
    relayConfig: { sharedHosts: ['hyf2333.top:8451'], gateways },
    publicUrl: 'https://new.example.com',
  }), /sharedHosts must contain only new\.example\.com/);
  assert.throws(() => createRelayDeploymentConfig({
    relayConfig: { sharedHosts: ['new.example.com'], gateways },
    publicUrl: 'https://new.example.com',
    domain: 'new.example.com:443',
  }), /Invalid KCODER_RELAY_DOMAIN/);
  assert.throws(() => createRelayDeploymentConfig({
    relayConfig: { sharedHosts: [], gateways },
  }), /Configure one canonical Relay public URL or sharedHosts authority/);
  assert.throws(() => createRelayDeploymentConfig({
    relayConfig: { sharedHosts: ['one.example.com', 'two.example.com'], gateways },
  }), /Configure one canonical Relay public URL or sharedHosts authority/);
  const inferredLegacy = createRelayDeploymentConfig({
    relayConfig: { sharedHosts: ['hyf2333.top:8451'], gateways },
  });
  assert.equal(inferredLegacy.publicUrl, 'https://hyf2333.top:8451');
  const inferredPort = createRelayDeploymentConfig({
    relayConfig: { sharedHosts: ['relay.example.com:9443'], gateways },
    domain: 'relay.example.com',
  });
  assert.equal(inferredPort.publicPort, 9443);
  assert.equal(inferredPort.publicUrl, 'https://relay.example.com:9443');
});

test('deployment rejects unsafe public URLs, shell-like domains, and port collisions', () => {
  const sharedHosts = ['relay.example.com'];
  const relayConfig = { sharedHosts, gateways };
  for (const publicUrl of [
    'https://user:pass@relay.example.com',
    'https://relay.example.com/path',
    'https://relay.example.com?x=1',
    'https://relay.example.com#fragment',
    'https://relay.example.com;$(id)',
    'https://relay.example.com\nKCODER_RELAY_SECRET=leaked',
    'https://127.0.0.1',
  ]) {
    assert.throws(() => createRelayDeploymentConfig({ relayConfig, publicUrl }));
  }
  assert.throws(() => createRelayDeploymentConfig({
    relayConfig,
    publicUrl: 'https://relay.example.com',
    domain: 'relay.example.com;$(id)',
  }), /Invalid KCODER_RELAY_DOMAIN/);
  assert.throws(() => createRelayDeploymentConfig({
    relayConfig,
    publicUrl: 'https://relay.example.com',
    controlPort: '18452; id',
  }), /Invalid KCODER_RELAY_CONTROL_PORT/);
  assert.throws(() => createRelayDeploymentConfig({
    relayConfig,
    publicUrl: 'https://relay.example.com',
    stunPort: 18452,
  }), /ports must be distinct/);
  assert.throws(() => createRelayDeploymentConfig({
    relayConfig,
    publicUrl: 'https://relay.example.com:18451',
  }), /ports must be distinct/);
  assert.throws(() => createRelayDeploymentConfig({
    relayConfig,
    publicUrl: 'https://relay.example.com',
    stunPort: 1023,
  }), /KCODER_RELAY_STUN_PORT must be between 1024 and 65535/);
  const unprivilegedBoundary = createRelayDeploymentConfig({
    relayConfig,
    publicUrl: 'https://relay.example.com',
    stunPort: 1024,
  });
  assert.equal(unprivilegedBoundary.stun.port, 1024);
});

test('legacy mode keeps its one Gateway credentials in the protected service env', () => {
  const plan = createRelayDeploymentConfig({
    relayConfig: { legacy: true, sharedHosts: ['hyf2333.top:8451'], gateways: [gateways[0]] },
  });
  assert.equal(plan.registryJson, null);
  assert.match(plan.cloudEnv, /^KCODER_RELAY_PUBLIC_URL=https:\/\/hyf2333\.top:8451$/m);
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
