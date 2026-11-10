import test from 'node:test';
import { runE2E } from './run-context.mjs';
import { runWindowsNativeLibtest } from './windows-native-libtest.mjs';

const launchPair = process.env.KCODER_E2E_WINDOWS_BROWSER_LAUNCH_PAIR === '1';
test(launchPair ? 'actual Windows Chromium original owner observes launch representation pair'
  : 'actual Windows Chromium profiles retain isolation, handoff and original cleanup receipts', {
  skip: process.env.KCODER_E2E_WINDOWS_BROWSER_PROFILE_NATIVE !== '1',
}, async () => {
  const exactTest = launchPair ? 'cleanup_receipt::chromium::actual_chromium_receipt_owner_observes_normal_and_verbatim_user_data_arguments'
    : 'app_server::browser::profile_binding::tests::actual_chromium_profiles_keep_cookie_identity_exclusive_reconcile_start_and_release_owned_tree';
  await runE2E(import.meta.url, {
    testId: launchPair ? 'windows-original-browser-launch-representation' : 'windows-original-browser-profile-native', tier: 'manual-live',
    modelPolicy: launchPair ? 'Original native V2 receipt owner with actual Chrome normal/verbatim user-data arguments and exact owned cleanup; diagnostic pair only, not profile persistence, ordinary UI, app-server crash or model acceptance.'
      : 'Explicit real Chromium loopback profile consumer with native ownership, persistence, exclusivity and handoff. SSH identity only; not ordinary-account UI, app-server crash, external login or model acceptance.',
  }, async context => {
    await runWindowsNativeLibtest(context, {
      consent: '1', target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET,
      parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
      node: process.env.KCODER_E2E_WINDOWS_NODE,
      testBinary: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_BIN,
      testSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256,
      sourceTreeSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256,
      supervisor: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN,
      supervisorSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256,
      chromiumArchive: process.env.KCODER_E2E_WINDOWS_CHROMIUM_ARCHIVE,
      chromiumArchiveSha256: process.env.KCODER_E2E_WINDOWS_CHROMIUM_ARCHIVE_SHA256,
      runIgnored: true, exactTest, expectedTests: [exactTest],
    });
  });
});
