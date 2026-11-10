import { runE2E } from '../../harness/run-context.mjs';
import { runWindowsNativeLibtest, validateNativeLibtestOptions } from '../../harness/windows-native-libtest.mjs';

const exactTest = 'external_history::local_attachment::tests::observer_treats_the_native_writer_lock_as_busy_without_changing_its_identity';
const options = { consent: process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST,
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  node: process.env.KCODER_E2E_WINDOWS_NODE, testBinary: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_BIN,
  testSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256, sourceTreeSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256,
  supervisor: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN, supervisorSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256,
  expectedCommit: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT, expectedDirty: false,
  exactTest, expectedTests: [exactTest] };
if (!/^[a-f0-9]{40}$/.test(options.expectedCommit ?? '') || process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY !== 'false')
  throw Error('Exact clean State source identity required');
validateNativeLibtestOptions(options);
await runE2E(import.meta.url, { testId: 'windows-local-attachment-native-writer-contention', tier: 'manual-live',
  modelPolicy: 'actual Windows State lock regression under a held native writer; exactly one named Rust test, other filtered tests explicitly unexecuted; owned temporary paths only, no model, credentials, installation or GUI' },
context => runWindowsNativeLibtest(context, options));
