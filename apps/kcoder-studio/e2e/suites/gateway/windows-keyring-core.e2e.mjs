import { runE2E } from '../../harness/run-context.mjs';
import { runOwnedKeyringAccount } from '../../harness/windows-keyring-account.mjs';

await runE2E(import.meta.url, { testId: 'windows-owned-keyring-imported-credential-core', tier: 'manual-live', cleanupTimeoutMs: 240000,
  modelPolicy: 'Real ImportedCredentialStore Provider/MCP group publication, independent normal logon reopen, lost backend replies and owned Undo. Only two operation-owned import accounts plus read-only __kcoder_probe__ in a newly created isolated SID. No personal vault, console token, scheduling, install, model or Host migration claim.' },
context => runOwnedKeyringAccount(context, { scenario: 'config-core', consent: process.env.KCODER_E2E_WINDOWS_KEYRING_LOGON,
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  mode: process.env.KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_MODE,
  reviewedSourceSha256: process.env.KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_REVIEW_SHA256,
  helper: process.env.KCODER_E2E_WINDOWS_SECURITY_HELPER,
  helperSha256: process.env.KCODER_E2E_WINDOWS_SECURITY_HELPER_SHA256 }));
