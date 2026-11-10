import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPort80ListenerStateUnchanged,
  buildRelayCaddySnippet,
  createCaddyCleanupPlan,
  createCaddyInstallPlan,
  parseTopLevelCaddyBlocks,
  relayTlsAskUrl,
  validateRelayOnDemandTls,
} from '../deploy/caddy-lifecycle.mjs';

const settings = {
  domain: 'relay.example.test',
  publicPort: 443,
  controlPort: 18452,
  proxyPort: 18451,
};

const relaySite = buildRelayCaddySnippet(settings);
const [rootSiteBlock, gatewaySiteBlock] = parseTopLevelCaddyBlocks(relaySite);
const rootSite = rootSiteBlock.text;
const gatewaySite = gatewaySiteBlock.text;
const askUrl = 'http://127.0.0.1:18452/_relay/tls-ask';
const sharedMain = '{\n    auto_https disable_redirects\n}\nother.example.test {\n    respond 200\n}\n';

function installPlan({ mainContents, mainFileExists = true, adoptExisting = false, globalOwned = false, overrides = {} }) {
  return createCaddyInstallPlan({
    mainContents,
    mainFileExists,
    existingFragment: undefined,
    // An existing managed import models an upgrade whose fragment hash is receipted.
    fragmentHashOwned: mainContents.includes('# KCODER-RELAY-IMPORT-BEGIN v1'),
    globalOwned,
    settings: { ...settings, ...overrides },
    fragmentContents: buildRelayCaddySnippet({ ...settings, ...overrides }),
    adoptExisting,
  });
}

function cleanup(mainContents) {
  return createCaddyCleanupPlan({ mainContents, expectedFragmentHashes: ['owned'], actualFragmentHash: 'owned' });
}

test('the fragment serves the root site and an on-demand wildcard Gateway origin site', () => {
  assert.equal(relayTlsAskUrl(18452), askUrl);
  assert.match(rootSiteBlock.header, /^https:\/\/relay\.example\.test$/);
  assert.match(rootSite, /@relayAdmin path \/_relay\/admin \/_relay\/admin\/\*\s+respond @relayAdmin 404\s+reverse_proxy 127\.0\.0\.1:18452/);
  assert.equal(gatewaySiteBlock.header, 'https://*.relay.example.test');
  assert.match(gatewaySite, /tls \{\n {8}on_demand\n {8}issuer acme \{\n {12}disable_http_challenge/);
  assert.doesNotMatch(gatewaySite, /_relay/, 'Gateway origins never reach the control listener');
  assert.match(buildRelayCaddySnippet({ ...settings, publicPort: 8443 }), /^https:\/\/\*\.relay\.example\.test:8443 \{/m);
});

test('fresh Caddy install owns a global block with redirects disabled and the loopback ask', () => {
  const plan = installPlan({ mainContents: '', mainFileExists: false });
  assert.equal(plan.createdGlobal, true);
  assert.match(plan.mainContents, new RegExp(`# KCODER-RELAY-GLOBAL-BEGIN v1\\n\\{\\n    auto_https disable_redirects\\n    on_demand_tls \\{\\n        ask ${askUrl.replaceAll('.', '\\.')}\\n    \\}\\n\\}`));
  assert.match(plan.mainContents, /# KCODER-RELAY-IMPORT-BEGIN v1/);
  assert.equal(plan.fragmentContents, relaySite);
  const removed = cleanup(plan.mainContents);
  assert.equal(removed.mainContents, '');
});

test('shared Caddy gains only marked on-demand lines and cleanup restores it byte-for-byte', () => {
  const plan = installPlan({ mainContents: sharedMain });
  assert.equal(plan.createdGlobal, false);
  assert.ok(plan.mainContents.startsWith(`{\n    # KCODER-RELAY-ON-DEMAND-BEGIN v1\n    on_demand_tls {\n        ask ${askUrl}\n    }\n    # KCODER-RELAY-ON-DEMAND-END v1\n    auto_https disable_redirects\n}\n`));
  assert.match(plan.mainContents, /other\.example\.test \{\n    respond 200\n\}/);
  assert.equal((plan.mainContents.match(/import \/etc\/caddy\/kcoder-relay\.caddy/g) || []).length, 1);
  assert.equal(cleanup(plan.mainContents).mainContents, sharedMain);
  const moved = installPlan({ mainContents: plan.mainContents, overrides: { controlPort: 18460 } });
  assert.equal((moved.mainContents.match(/on_demand_tls/g) || []).length, 1, 'upgrade replaces, never duplicates, the managed ask');
  assert.match(moved.mainContents, /ask http:\/\/127\.0\.0\.1:18460\/_relay\/tls-ask/);
  assert.throws(() => installPlan({ mainContents: 'other.example.test {\n    respond 200\n}\n' }), /must already disable automatic HTTP redirects/);
});

test('upgrade replaces a pre-isolation managed global block and keeps it owned', () => {
  const v1 = `# KCODER-RELAY-GLOBAL-BEGIN v1\n{\n    auto_https disable_redirects\n}\n# KCODER-RELAY-GLOBAL-END v1\nother.example.test {\n    respond 200\n}\n# KCODER-RELAY-IMPORT-BEGIN v1\nimport /etc/caddy/kcoder-relay.caddy\n# KCODER-RELAY-IMPORT-END v1\n`;
  const plan = installPlan({ mainContents: v1, globalOwned: true });
  assert.equal(plan.createdGlobal, true);
  assert.equal((plan.mainContents.match(/KCODER-RELAY-GLOBAL-BEGIN/g) || []).length, 1);
  assert.match(plan.mainContents, /on_demand_tls \{\n        ask http:\/\/127\.0\.0\.1:18452\/_relay\/tls-ask/);
  const removed = cleanup(plan.mainContents);
  assert.equal(removed.globalRelinquished, true);
  assert.equal(removed.mainContents, '{\n    auto_https disable_redirects\n}\nother.example.test {\n    respond 200\n}\n');
});

test('existing on-demand policy, foreign wildcard sites and tampered markers fail closed', () => {
  const foreignAsk = '{\n    auto_https disable_redirects\n    on_demand_tls {\n        ask http://127.0.0.1:9999/check\n    }\n}\nother.example.test {\n    respond 200\n}\n';
  const foreignSite = `${sharedMain}tenant.example.test {\n    tls {\n        on_demand\n    }\n}\n`;
  for (const mainContents of [foreignAsk, foreignSite]) {
    assert.throws(() => installPlan({ mainContents }), /already configures on-demand TLS/);
  }
  assert.throws(() => installPlan({ mainContents: '{ auto_https disable_redirects\n}\nother.example.test {\n    respond 200\n}\n' }), /own line/);
  assert.throws(() => installPlan({ mainContents: `${sharedMain}*.relay.example.test {\n    respond 200\n}\n` }), /Gateway origin wildcard/);
  const managed = installPlan({ mainContents: sharedMain }).mainContents;
  assert.throws(() => installPlan({ mainContents: managed.replace('ask http://127.0.0.1:18452', 'ask http://10.0.0.1:18452') }), /on-demand TLS block was modified/);
  assert.throws(() => cleanup(managed.replace('/_relay/tls-ask', '/anything')), /on-demand TLS block was modified/);
});

test('adoption preserves both supported fallback semantics and adds the Gateway origin site', () => {
  const proxySite = rootSite.replace(
    '    handle {\n        respond 404\n    }',
    '    handle {\n        reverse_proxy 127.0.0.1:18451\n    }',
  );
  assert.notEqual(proxySite, rootSite);

  for (const site of [rootSite, proxySite]) {
    const plan = installPlan({ mainContents: `${sharedMain}${site}`, adoptExisting: true });
    assert.equal(plan.adoptedSite, true);
    assert.equal(plan.fragmentContents, `${site.endsWith('\n') ? site : `${site}\n`}\n${gatewaySite}`);
    assert.doesNotMatch(plan.mainContents, /https:\/\/relay\.example\.test/);
  }
});

test('adoption rejects unknown route shapes', () => {
  const unsupported = rootSite.replace(
    '    handle {\n        respond 404\n    }',
    '    handle / {\n        respond 404\n    }',
  );
  assert.throws(() => installPlan({ mainContents: `${sharedMain}${unsupported}`, adoptExisting: true }), /supported fallback/);
});

test('adapted JSON must carry exactly the Relay ask and no foreign on-demand policy', () => {
  const policies = [{ subjects: ['relay.example.test'] }, { subjects: ['*.relay.example.test'], on_demand: true }];
  assert.doesNotThrow(() => validateRelayOnDemandTls({ apps: { tls: { automation: { on_demand: { ask: askUrl }, policies } } } }, settings));
  assert.doesNotThrow(() => validateRelayOnDemandTls({ apps: { tls: { automation: { on_demand: { permission: { module: 'http', endpoint: askUrl } } } } } }, settings));
  assert.throws(() => validateRelayOnDemandTls({ apps: {} }, settings), /ask endpoint/);
  assert.throws(() => validateRelayOnDemandTls({ apps: { tls: { automation: { on_demand: { ask: 'http://127.0.0.1:1/other' } } } } }, settings), /ask endpoint/);
  assert.throws(() => validateRelayOnDemandTls({ apps: { tls: { automation: { on_demand: { ask: askUrl },
    policies: [{ subjects: ['tenant.example.test'], on_demand: true }] } } } }, settings), /Another Caddy site/);
});

test('port-80 listener state must remain byte-for-byte unchanged', () => {
  const baseline = {
    apps: { http: { servers: { shared: { listen: [':80'], routes: [{ handle: [{ handler: 'static_response', status_code: 308 }] }] } } } },
  };
  assert.doesNotThrow(() => assertPort80ListenerStateUnchanged(baseline, structuredClone(baseline)));
  assert.throws(() => assertPort80ListenerStateUnchanged(baseline, { apps: { http: { servers: {} } } }), /port-80 listener/);
  const changed = structuredClone(baseline);
  changed.apps.http.servers.shared.routes[0].handle[0].status_code = 301;
  assert.throws(() => assertPort80ListenerStateUnchanged(baseline, changed), /port-80 listener/);
});
