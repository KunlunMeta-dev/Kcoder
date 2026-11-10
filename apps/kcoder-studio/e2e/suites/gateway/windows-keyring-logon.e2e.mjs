import { runE2E } from '../../harness/run-context.mjs';
import { runKeyringLogonPreflight } from '../../harness/windows-keyring-logon.mjs';

await runE2E(import.meta.url, { testId: 'windows-keyring-owned-logon-prerequisites', tier: 'manual-live',
  modelPolicy: 'Read-only effective-admin/SecondaryLogon/local-account-command prerequisites. No account, normal logon, Credential Manager API, personal data, installation, scheduler, model or GUI operation.' },
context => runKeyringLogonPreflight(context, { consent: process.env.KCODER_E2E_WINDOWS_KEYRING_LOGON,
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  mode: process.env.KCODER_E2E_WINDOWS_KEYRING_LOGON_MODE }));
