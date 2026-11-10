import { runE2E } from '../../harness/run-context.mjs';
import { verifyWindowsDesktopActionUnknown } from '../../harness/windows-desktop-action-host.mjs';

const ownedFixtureInput = process.env.KCODER_E2E_WINDOWS_DESKTOP_OWNED_FIXTURE_INPUT === '1';
await runE2E(import.meta.url, { testId: ownedFixtureInput ? 'actual-windows-computer-use-owned-fixture-input' : 'actual-windows-desktop-action-caller-receipt-loss', tier: 'manual-live',
  cleanupTimeoutMs: 120000,
  modelPolicy: ownedFixtureInput
    ? 'Model-independent actual owned full-view fixture: broker turn lease, real Click-to-focus, screenshot-only (no UIA/window enumeration), short harmless Type and Verify Click; mouse point-owner and keyboard foreground/textbox-focus fences, revoke and read-only original-history reconciliation. No full DESK02, paid model, personal app or final-release claim.'
    : 'Model-independent loopback protocol fixture. Actual Windows native Screenshot/UIA/Type/Click, original tool event loss and read-only original-thread reconciliation. No paid model, external send, personal app or native-broker loss claim.' },
context => verifyWindowsDesktopActionUnknown(context, {
  ownedFixtureInput,
  consent: process.env.KCODER_E2E_WINDOWS_DESKTOP_ACTION,
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET,
  parent: process.env.KCODER_E2E_WINDOWS_PACKAGE_PARENT,
  node: process.env.KCODER_E2E_WINDOWS_NODE,
  archive: process.env.KCODER_E2E_WINDOWS_DESKTOP_ARCHIVE,
  archiveSha256: process.env.KCODER_E2E_WINDOWS_DESKTOP_ARCHIVE_SHA256,
  cliSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_CLI_SHA256,
  runtimeManifestSha256: process.env.KCODER_E2E_WINDOWS_DESKTOP_RUNTIME_SHA256,
}));
