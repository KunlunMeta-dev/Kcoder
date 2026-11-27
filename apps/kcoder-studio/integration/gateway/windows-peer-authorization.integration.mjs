//! Exact Windows native regressions only; no model, Gateway session or installed app is exercised.
import assert from 'node:assert/strict';
import { runIntegration } from '../../e2e/harness/run-context.mjs';
import { runWindowsNativeLibtest, validateNativeLibtestOptions } from '../../e2e/harness/windows-native-libtest.mjs';

const cases = {
  composition: { crate: 'kcoder_engine', name: 'peer_provider_start::tests::peer_native_model_health_composition_dispatches_the_original_provider_once' },
  'claimed-facts': { crate: 'kcoder_engine', name: 'peer_message_runtime::claimed_validation::tests::claimed_validation_distinguishes_busy_changes_expiry_and_actual_turn_retirement' },
  'record-identity': { crate: 'kcoder_state', name: 'peer_agent_history::tests::immutable_record_mismatch_is_not_hidden_by_actual_state_lock_contention' },
  'queue-lock': { crate: 'kcoder_cli_runtime', name: 'app_server::session_messages::delivery::claimed_validation::tests::actual_original_queue_lock_is_busy_and_corruption_never_becomes_message_changed' },
  'history-binding-contention': { crate: 'kcoder_state', name: 'peer_wake_budget::tests::start_contention_tests::original_permit_survives_known_state_and_kernel_read_contention_without_a_new_claim' },
};
const selected = process.env.KCODER_E2E_WINDOWS_PEER_AUTH_CASE ?? 'composition';
assert.ok(Object.hasOwn(cases, selected), 'Select one of this repair\'s exact native regressions');
const { name: exactTest, crate: ownerCrate } = cases[selected];
const options = {
  consent: process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST,
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET,
  parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  node: process.env.KCODER_E2E_WINDOWS_NODE,
  testBinary: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_BIN,
  testSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256,
  sourceTreeSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256,
  supervisor: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN,
  supervisorSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256,
  expectedCommit: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT,
  expectedDirty: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY === 'true',
  exactTest, expectedTests: [exactTest],
};
assert.match(options.expectedCommit ?? '', /^[a-f0-9]{40}$/);
assert.ok(['true', 'false'].includes(process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY));
validateNativeLibtestOptions(options);
await runIntegration(import.meta.url, {
  testId: `windows-peer-authorization-${selected}`, tier: 'manual-live',
  modelPolicy: 'actual Windows native libtest and original peer claim/scope; deterministic Provider counter only; owned temporary config/history and supervisor Job; no user session, paid model, installation or configuration changes',
}, async context => {
  await context.writeArtifactJson('windows-peer-authorization-selection.json', {
    case: selected, ownerCrate, exactTest, binarySha256: options.testSha256,
    sourceTreeSha256: options.sourceTreeSha256, unselectedTestsAreNotPasses: true,
  });
  // The native probe first lists this exact name and requires one actual pass;
  // an Engine/State/CLI executable cannot substitute for a different test owner.
  return runWindowsNativeLibtest(context, options);
});
