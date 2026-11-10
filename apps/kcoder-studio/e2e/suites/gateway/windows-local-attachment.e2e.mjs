import { runE2E } from '../../harness/run-context.mjs';
import { runWindowsNativeLibtest, validateNativeLibtestOptions } from '../../harness/windows-native-libtest.mjs';

const options = { consent: process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST, probeKind: 'local-attachment',
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  node: process.env.KCODER_E2E_WINDOWS_NODE, testBinary: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_BIN,
  testSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256, sourceTreeSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256,
  supervisor: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN, supervisorSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256,
  expectedCommit: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT,
  expectedDirty: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY === 'true' };
if (process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY !== 'false') throw Error('A clean frozen release CLI is required');
validateNativeLibtestOptions(options);
await runE2E(import.meta.url, { testId: 'windows-local-attachment-native-cli', tier: 'manual-live',
  modelPolicy: 'actual frozen Windows release CLI upload/restart/receipt/provenance and idle continuation; isolated synthetic source and explicit bytes; no model turn, external MCP, personal state, installation or GUI acceptance' },
context => runWindowsNativeLibtest(context, options));
