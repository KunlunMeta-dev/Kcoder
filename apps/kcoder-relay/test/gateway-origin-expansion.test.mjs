import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRelayCaddySnippet, createGatewayOriginExpansionPlan, parseTopLevelCaddyBlocks } from '../deploy/caddy-lifecycle.mjs';
const settings = { domain: 'relay.example', publicPort: 8451, controlPort: 18462, proxyPort: 18461 };
const main = '{\n    auto_https disable_redirects\n}\nhttps://ssh.relay.example { reverse_proxy 127.0.0.1:19454 }\nimport /etc/caddy/kcoder-relay.caddy\n';
const root = parseTopLevelCaddyBlocks(buildRelayCaddySnippet(settings))[0].text;

test('additive origin expansion preserves custom download and SSH routes and is idempotent', () => {
  const fragment = root.replace('    handle /_relay/*', '    handle /deliveries/* { respond 403 }\n    handle /_relay/*');
  const plan = createGatewayOriginExpansionPlan({ mainContents: main, fragmentContents: fragment, settings });
  assert.ok(plan.fragmentContents.startsWith(fragment.trimEnd()));
  assert.ok(plan.mainContents.includes('https://ssh.relay.example { reverse_proxy 127.0.0.1:19454 }'));
  assert.ok(plan.mainContents.includes('ask http://127.0.0.1:18462/_relay/tls-ask'));
  assert.match(plan.fragmentContents, /https:\/\/\*\.relay.example:8451/);
  assert.deepEqual(createGatewayOriginExpansionPlan({ ...plan, settings }), plan);
});

test('wrong instance ports or foreign on-demand policy fail without producing a plan', () => {
  assert.throws(() => createGatewayOriginExpansionPlan({ mainContents: main, fragmentContents: root,
    settings: { ...settings, controlPort: 18000 } }), /selected instance/);
  assert.throws(() => createGatewayOriginExpansionPlan({ mainContents: main.replace('auto_https disable_redirects',
    'auto_https disable_redirects\n    on_demand_tls { ask https://foreign.example }'), fragmentContents: root, settings }), /on-demand TLS/);
});

test('existing exact certificates stay explicitly managed without changing the registration ask', () => {
  const preserveCertificateNames = ['ssh.relay.example'];
  const plan = createGatewayOriginExpansionPlan({ mainContents: main, fragmentContents: root, settings, preserveCertificateNames });
  assert.match(plan.mainContents, /tls_automate_names ssh\.relay\.example\n/);
  assert.deepEqual(createGatewayOriginExpansionPlan({ ...plan, settings, preserveCertificateNames }), plan);
  assert.equal(createGatewayOriginExpansionPlan({ ...plan, settings }).mainContents.includes('tls_automate_names'), false);
  for (const names of [['*.relay.example'], ['unconfigured.relay.example'], ['outside.example'], ['ssh.relay.example', 'ssh.relay.example']]) {
    assert.throws(() => createGatewayOriginExpansionPlan({ mainContents: main, fragmentContents: root, settings,
      preserveCertificateNames: names }));
  }
});
