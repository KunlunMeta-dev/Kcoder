import test from 'node:test';
import assert from 'node:assert/strict';
import { runE2E } from './run-context.mjs';
import { runWindowsNativeLibtest } from './windows-native-libtest.mjs';
import { windowsNativeCaseContext } from './windows-native-case.mjs';

test('actual Windows original supervisor cleanup receipts use exact handles and Job termination', {
  skip: process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST !== '1',
}, async () => {
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
  };
  const cases = [
    ['natural', 'original_private_receipt_confirms_natural_target_terminal_only'],
    ['tree-kill', 'kill_keeps_receipt_owner_alive_until_owned_job_is_empty'],
    ['unsafe-file', 'readonly_and_nonempty_files_cannot_start_a_receipt_owner'],
    ['host-crash', 'actual_host_kill_leaves_original_owner_to_confirm_cleanup'],
    ['outer-job', 'terminating_the_outer_job_never_fabricates_cleanup_confirmation'],
  ];
  const selected = process.env.KCODER_E2E_WINDOWS_CLEANUP_CASE;
  assert.ok(selected === undefined || cases.some(([slug]) => slug === selected));
  await runE2E(import.meta.url, {
    testId: 'windows-original-browser-cleanup-owner-native', tier: 'manual-live',
    modelPolicy: 'Explicit exact real Windows supervisor native cases with isolated owned files/processes. SSH identity only; no browser profile, ordinary-account UI, DESK01 capability or model acceptance claim.',
  }, async context => {
    for (const [slug, name] of cases.filter(([slug]) => selected === undefined || selected === slug)) {
      const exactTest = 'cleanup_receipt::' + name;
      await runWindowsNativeLibtest(windowsNativeCaseContext(context, slug), {
        ...options, exactTest, expectedTests: [exactTest],
      });
    }
  });
});
