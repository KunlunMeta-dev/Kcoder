import { resolve } from 'node:path';
import { runE2E } from '../../harness/run-context.mjs';
import { runWindowsMigrationSecurity, validateSecurityOptions } from '../../harness/windows-migration-security.mjs';

const options = { consent: process.env.KCODER_E2E_WINDOWS_MIGRATION_SECURITY,
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  helper: process.env.KCODER_E2E_WINDOWS_SECURITY_HELPER ? resolve(process.env.KCODER_E2E_WINDOWS_SECURITY_HELPER) : undefined,
  helperSha256: process.env.KCODER_E2E_WINDOWS_SECURITY_HELPER_SHA256,
  baselineSource: process.env.KCODER_E2E_WINDOWS_SECURITY_BASELINE_SOURCE };
validateSecurityOptions(options);
await runE2E(import.meta.url, { testId: 'windows-migration-real-vault-and-paths', tier: 'manual-live',
  modelPolicy: 'no models; one UUID synthetic Windows Credential Manager entry and owned D-drive Unicode/junction fixtures; no personal keyring enumeration, settings, login, installation, scheduled tasks or GUI' },
context => runWindowsMigrationSecurity(context, options));
