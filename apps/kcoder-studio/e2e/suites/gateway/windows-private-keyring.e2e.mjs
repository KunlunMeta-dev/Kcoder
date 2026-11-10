import assert from 'node:assert/strict';
import { runE2E } from '../../harness/run-context.mjs';
import { runOwnedKeyringAccount } from '../../harness/windows-keyring-account.mjs';

assert.equal(process.env.KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_FAULT, undefined, 'This reviewed scenario accepts only a normal roundtrip');

await runE2E(import.meta.url, { testId: 'windows-owned-private-transfer-keyring', tier: 'manual-live', cleanupTimeoutMs: 240000,
  modelPolicy: 'Exact reviewed normal-logon SID and C# Job. Two private offers/recipient keys, four synthetic Native imported references, durable prepare-status, source-offline publication and independent-logon reopen/Undo/key release. Forced keyring, read-only __kcoder_probe__, no personal vault, Console, scheduler, installer, Gateway or model call.' },
context => runOwnedKeyringAccount(context, { scenario: 'private-rpc', consent: process.env.KCODER_E2E_WINDOWS_KEYRING_LOGON,
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  mode: process.env.KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_MODE,
  reviewedSourceSha256: process.env.KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_REVIEW_SHA256,
  helper: process.env.KCODER_E2E_WINDOWS_SECURITY_HELPER, helperSha256: process.env.KCODER_E2E_WINDOWS_SECURITY_HELPER_SHA256,
  hostCli: process.env.KCODER_E2E_WINDOWS_KEYRING_HOST_CLI, hostCliSha256: process.env.KCODER_E2E_WINDOWS_KEYRING_HOST_CLI_SHA256,
  hostNode: process.env.KCODER_E2E_WINDOWS_NODE, hostNodeSha256: process.env.KCODER_E2E_WINDOWS_KEYRING_HOST_NODE_SHA256 }));
