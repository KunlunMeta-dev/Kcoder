import assert from 'node:assert/strict';
import test from 'node:test';
import { suiteEnvironmentNames } from './runner-options.mjs';
import { prepareSuiteArtifacts } from '../run-all.mjs';
const suite = 'suites/browser/memory-native-management.e2e.mjs';
test('focused native Agent acceptance stays inside its registered suite and explicit binary roots', () => {
  const flags = ['KCODER_E2E_NATIVE_MEMORY_ONLY', 'KCODER_E2E_NATIVE_MEMORY_PUBLICATION_ONLY', 'KCODER_E2E_KNOWLEDGE_FIXTURE_BIN', 'KCODER_E2E_NATIVE_AGENT_TEMPLATE_ONLY', 'KCODER_E2E_NATIVE_AGENT_TEMPLATE_BUDGET', 'KCODER_E2E_RENDERER_ROOT', 'KCODER_E2E_GATEWAY_ROOT'];
  for (const name of flags) {
    assert.ok(suiteEnvironmentNames(suite, {}).includes(name));
    assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs', {}).includes(name), false);
  }
});
test('the registered native suite prepares its versioned Wiki fixture through the normal artifact pipeline', async () => {
  const commands = [];
  await prepareSuiteArtifacts([suite], { environment: {}, run: async (command, args) => { commands.push([command, args]); } });
  assert.ok(commands.some(([command, args]) => command === 'cargo' && args.includes('kcoder_cli')));
  assert.ok(commands.some(([command, args]) => command === 'cargo' && args.includes('kcoder_knowledge') && args.includes('native_wiki_publication_fixture')));
  assert.ok(commands.some(([, args]) => args.includes('node_modules/typescript/bin/tsc')));
  assert.ok(commands.some(([, args]) => args.includes('node_modules/vite/bin/vite.js')));
});
test('an explicit existing Wiki binary does not trigger another fixture build', async () => {
  const commands = [];
  await prepareSuiteArtifacts([suite], { environment: { KCODER_E2E_KNOWLEDGE_FIXTURE_BIN: '/owned/frozen/wiki-fixture' }, run: async (command, args) => { commands.push([command, args]); } });
  assert.equal(commands.some(([, args]) => args.includes('native_wiki_publication_fixture')), false);
});
