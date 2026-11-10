import { runE2E } from '../../harness/run-context.mjs';
import { runOwnedKeyringAccount } from '../../harness/windows-keyring-account.mjs';

await runE2E(import.meta.url, { testId: 'windows-owned-keyring-account-adapter', tier: 'manual-live', cleanupTimeoutMs: 240000,
  modelPolicy: 'Compile-only adapter verification, or exact-source-reviewed owned normal-logon OS-vault roundtrip. No personal console token, keyring enumeration, original credentials, installation, scheduling, model, GUI or Core/Host credential-migration claim.' },
context => runOwnedKeyringAccount(context, { consent: process.env.KCODER_E2E_WINDOWS_KEYRING_LOGON,
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  mode: process.env.KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_MODE,
  fault: process.env.KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_FAULT,
  reviewedSourceSha256: process.env.KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_REVIEW_SHA256,
  helper: process.env.KCODER_E2E_WINDOWS_SECURITY_HELPER,
  helperSha256: process.env.KCODER_E2E_WINDOWS_SECURITY_HELPER_SHA256 }));
