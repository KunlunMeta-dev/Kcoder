import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelayCaddySnippet, createCaddyInstallPlan, createCaddyCleanupPlan,
  createGatewayOriginExpansionPlan, parseTopLevelCaddyBlocks } from '../deploy/caddy-lifecycle.mjs';

const settings = { domain: 'relay.example.test', publicPort: 443, controlPort: 18452, proxyPort: 18453 };

test('Caddy environment placeholders are site-address tokens rather than global block braces', () => {
  const text = '{$HOST}.example.test:8443 {\n    respond "{not_a_block}"\n}\n';
  const blocks = parseTopLevelCaddyBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].header, '{$HOST}.example.test:8443');
  assert.equal(blocks[0].text, text);
  const withDefault = '{$HOST:relay.example.test} {\n    respond /#anchor 200\n}\n';
  assert.equal(parseTopLevelCaddyBlocks(withDefault)[0].header, '{$HOST:relay.example.test}');
});

test('expanding a managed global keeps it upgradeable and removable without nested ownership markers', () => {
  const plan = createCaddyInstallPlan({ mainContents: '', mainFileExists: false, settings,
    fragmentContents: buildRelayCaddySnippet(settings) });
  const expanded = createGatewayOriginExpansionPlan({ mainContents: plan.mainContents,
    fragmentContents: plan.fragmentContents, settings, preserveCertificateNames: ['relay.example.test'] });
  assert.doesNotMatch(expanded.mainContents, /KCODER-RELAY-ON-DEMAND-BEGIN/);
  assert.match(expanded.mainContents, /tls_automate_names relay\.example\.test/);
  const upgrade = createCaddyInstallPlan({ mainContents: expanded.mainContents, mainFileExists: true,
    existingFragment: expanded.fragmentContents, fragmentHashOwned: true, globalOwned: true, settings,
    fragmentContents: buildRelayCaddySnippet(settings) });
  assert.equal((upgrade.mainContents.match(/on_demand_tls/g) ?? []).length, 1);
  assert.match(upgrade.mainContents, /tls_automate_names relay\.example\.test/);
  const cleaned = createCaddyCleanupPlan({ mainContents: expanded.mainContents,
    expectedFragmentHash: 'owned-fixture', actualFragmentHash: 'owned-fixture' });
  assert.equal(cleaned.mainContents, '');
});
