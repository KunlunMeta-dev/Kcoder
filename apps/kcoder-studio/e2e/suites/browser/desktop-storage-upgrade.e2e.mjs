import { runE2E } from '../../harness/run-context.mjs';
import { verifyWindowsInstallerMechanism } from '../../harness/windows-installer-lifecycle.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'windows-installed-storage-old-version-upgrade', tier: 'manual-live', variantId: 'windows-2.0.49-to-candidate',
  modelPolicy: 'actual pinned old/new NSIS under one owned ordinary OS profile; original Native/AppData startup migration, history/image/Cookie/draft cold read; no Provider, model or personal baseline',
  retainSuccessLogs: true, cleanupTimeoutMs: 120000,
}, context => verifyWindowsInstallerMechanism(context, {
  storageUpgrade: true, installer: process.env.KCODER_E2E_WINDOWS_OLD_INSTALLER,
  newInstaller: process.env.KCODER_E2E_WINDOWS_NEW_INSTALLER,
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, node: process.env.KCODER_E2E_WINDOWS_NODE,
  probeSupervisor: process.env.KCODER_E2E_WINDOWS_UNINSTALL_PROBE_SUPERVISOR,
  expectedCommit: process.env.KCODER_E2E_WINDOWS_EXPECTED_COMMIT,
  expectedNativeCommit: process.env.KCODER_E2E_WINDOWS_EXPECTED_NATIVE_COMMIT,
  expectedVersion: process.env.KCODER_E2E_WINDOWS_EXPECTED_VERSION,
  expectedInstallerSha256: process.env.KCODER_E2E_WINDOWS_EXPECTED_INSTALLER_SHA256,
  expectedCliSha256: process.env.KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256,
  expectedManifestSha256: process.env.KCODER_E2E_WINDOWS_EXPECTED_MANIFEST_SHA256,
  expectedHostSha256: process.env.KCODER_E2E_WINDOWS_EXPECTED_HOST_SHA256,
}));
