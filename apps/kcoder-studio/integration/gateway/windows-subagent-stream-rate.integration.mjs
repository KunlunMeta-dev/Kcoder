import { runIntegration } from '../../e2e/harness/run-context.mjs';
import { runWindowsNativeLibtest, validateNativeLibtestOptions } from '../../e2e/harness/windows-native-libtest.mjs';

const options = { consent: process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST, probeKind: 'subagent-stream-rate',
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  node: process.env.KCODER_E2E_WINDOWS_NODE, testBinary: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_BIN,
  testSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256, sourceTreeSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256,
  supervisor: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN, supervisorSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256,
  streamRateChildren: Number(process.env.KCODER_E2E_SUBAGENT_STREAM_CHILDREN ?? '1'),
  streamRateLong: process.env.KCODER_E2E_SUBAGENT_STREAM_LONG === '1',
  streamRateSources: process.env.KCODER_E2E_SUBAGENT_STREAM_SOURCES === '1',
  profileOutputReads: process.env.KCODER_E2E_SUBAGENT_PROFILE_READS === '1',
  expectedCommit: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT,
  expectedDirty: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY === 'true' };
if (!['true', 'false'].includes(process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY)) throw Error('Explicit source dirty identity required');
validateNativeLibtestOptions(options);
await runIntegration(import.meta.url, { testId: 'windows-subagent-stream-rate-native-authorization', tier: 'manual-live',
  modelPolicy: 'actual Windows CLI, Native task authorization and concurrent loopback SSE with cumulative usage; owned profile and Job cleanup; no installed app, live provider or GUI claim' },
context => runWindowsNativeLibtest(context, options));
