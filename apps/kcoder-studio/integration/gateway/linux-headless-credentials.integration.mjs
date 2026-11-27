import { runIntegration } from '../../e2e/harness/run-context.mjs';
import { runLinuxHeadlessCredentials } from '../../e2e/harness/linux-headless-credential-flow.mjs';

await runIntegration(import.meta.url, { testId: 'linux-owned-headless-credential-policies', tier: 'manual-live', cleanupTimeoutMs: 30000,
  modelPolicy: 'Real pinned Linux Native OsCredentialBackend on owned unreachable DBus. Forced-keyring failure without file fallback, explicit file publication/independent reopen/original Undo. No personal DBus, desktop, source command, model call or usable-vault claim.' },
context => runLinuxHeadlessCredentials(context, { consent: process.env.KCODER_E2E_LINUX_HEADLESS_CREDENTIALS,
  binary: process.env.KCODER_E2E_LINUX_HEADLESS_NATIVE, sha256: process.env.KCODER_E2E_LINUX_HEADLESS_NATIVE_SHA256 }));
