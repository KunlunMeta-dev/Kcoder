import { runE2E } from '../../harness/run-context.mjs';
import { runOwnedKeyringAccount } from '../../harness/windows-keyring-account.mjs';

await runE2E(import.meta.url, { testId: 'windows-owned-keyring-native-migration-host', tier: 'manual-live', cleanupTimeoutMs: 240000,
  modelPolicy: 'True app-server MigrationStore Provider/MCP grouped credential plan/apply/reopen/rollback in an owned normal-logon SID. Forced keyring; two native import references and read-only __kcoder_probe__. Synthetic private source only. No personal vault, Console, scheduler, install, model turn or Gateway acceptance claim.' },
context => runOwnedKeyringAccount(context, { scenario: 'host-rpc', consent: process.env.KCODER_E2E_WINDOWS_KEYRING_LOGON,
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  mode: process.env.KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_MODE,
  reviewedSourceSha256: process.env.KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_REVIEW_SHA256,
  helper: process.env.KCODER_E2E_WINDOWS_SECURITY_HELPER,
  helperSha256: process.env.KCODER_E2E_WINDOWS_SECURITY_HELPER_SHA256,
  hostCli: process.env.KCODER_E2E_WINDOWS_KEYRING_HOST_CLI,
  hostCliSha256: process.env.KCODER_E2E_WINDOWS_KEYRING_HOST_CLI_SHA256,
  hostNode: process.env.KCODER_E2E_WINDOWS_NODE,
  hostNodeSha256: process.env.KCODER_E2E_WINDOWS_KEYRING_HOST_NODE_SHA256 }));
