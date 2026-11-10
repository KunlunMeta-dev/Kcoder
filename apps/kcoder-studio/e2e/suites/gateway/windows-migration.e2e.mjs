import { resolve } from 'node:path';
import { runE2E } from '../../harness/run-context.mjs';
import { runWindowsPackageProbe, validatePackageProbe } from '../../harness/windows-package-probe.mjs';

const options = { target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, node: process.env.KCODER_E2E_WINDOWS_NODE,
  parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  archive: process.env.KCODER_E2E_WINDOWS_PAYLOAD_ARCHIVE ? resolve(process.env.KCODER_E2E_WINDOWS_PAYLOAD_ARCHIVE) : undefined,
  archiveSha256: process.env.KCODER_E2E_WINDOWS_PAYLOAD_SHA256,
  nativeCommit: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT, commit: process.env.KCODER_E2E_WINDOWS_EXPECTED_COMMIT, cliSha256: process.env.KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256,
  catalogLockTests: process.env.KCODER_E2E_WINDOWS_CATALOG_LOCK_TESTS,
  catalogLockTestsSha256: process.env.KCODER_E2E_WINDOWS_CATALOG_LOCK_TESTS_SHA256,
  catalogLockTestMode: process.env.KCODER_E2E_WINDOWS_CATALOG_LOCK_TEST_MODE,
  focus: 'migration' };
validatePackageProbe(options);
await runE2E(import.meta.url, { testId: 'windows-frozen-package-migration', tier: 'manual-live',
  modelPolicy: 'model-independent native Windows app-server and actual installer payload; owned profile, Unicode workspace and synthetic sources only; no model turn, personal configuration, installation or GUI acceptance' },
context => runWindowsPackageProbe(context, options));
