import { runE2E } from '../../harness/run-context.mjs';
import { runWindowsNativeLibtest, validateNativeLibtestOptions } from '../../harness/windows-native-libtest.mjs';

const options = { consent: process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST, probeKind: 'terminal',
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  node: process.env.KCODER_E2E_WINDOWS_NODE, testBinary: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_BIN,
  testSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256, sourceTreeSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256,
  supervisor: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN, supervisorSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256,
  expectedCommit: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT,
  rustMinStack: process.env.KCODER_E2E_WINDOWS_NATIVE_RUST_MIN_STACK === undefined ? undefined : Number(process.env.KCODER_E2E_WINDOWS_NATIVE_RUST_MIN_STACK),
  expectedDirty: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY === 'true' };
if (!['true', 'false'].includes(process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY)) throw Error('Explicit source dirty identity required');
validateNativeLibtestOptions(options);
await runE2E(import.meta.url, { testId: 'windows-terminal-lifecycle-native-cli', tier: 'manual-live',
  modelPolicy: 'actual CLI native ConPTY and official renderer xterm protocol/buffer; isolated owned PowerShell command only; no model, GUI, personal state, credentials or installation' },
context => runWindowsNativeLibtest(context, options));
