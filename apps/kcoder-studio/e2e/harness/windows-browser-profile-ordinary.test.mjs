import test from 'node:test';
import { runE2E } from './run-context.mjs';
import { verifyWindowsNativeComponents } from './windows-installer-lifecycle.mjs';

const crash = process.env.KCODER_E2E_WINDOWS_BROWSER_PROFILE_STDIO_CRASH === '1';
const electron = process.env.KCODER_E2E_WINDOWS_BROWSER_PROFILE_ELECTRON_UI === '1';
test(electron ? 'actual ordinary Windows Electron UI closes its original managed browser profile'
  : crash ? 'actual ordinary Windows app-server crash requires its original browser cleanup receipt'
  : 'actual ordinary Windows account consumes managed Chromium profiles on its private desktop', {
  skip: process.env.KCODER_E2E_WINDOWS_BROWSER_PROFILE_ORDINARY !== '1',
}, async () => {
  await runE2E(import.meta.url, {
    testId: electron ? 'windows-browser-profile-ordinary-electron-ui' : crash ? 'windows-browser-profile-ordinary-stdio-crash' : 'windows-browser-profile-ordinary-native', tier: 'manual-live',
    modelPolicy: electron ? 'Actual packaged Windows Electron on a new ordinary private desktop: profile UI, human handoff, explicit switch and original Gateway-owned cleanup receipt. No installer, external website login, model or quality claim.'
      : crash ? 'A new ordinary Windows account uses actual default-profile app-server/Chromium, normal Cookie close/reopen, original hard-crash cleanup receipt and launch noReplay. Original private desktop/account cleanup, zero Provider/model. Not Studio UI, installer or external login.'
      : 'A new ordinary Windows account runs one exact managed Chromium native consumer on its private desktop, using original account/profile cleanup. No Studio UI, installer, external account login, app-server crash or model claim.',
  }, context => verifyWindowsNativeComponents(context, {
    target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET,
    installation: process.env.KCODER_E2E_WINDOWS_PERSONAL_INSTALLATION,
    node: process.env.KCODER_E2E_WINDOWS_NODE, probeVolume: 'D',
    browserProfileNativeProbe: true,
    browserProfileNativeMode: electron ? 'electron-ui' : crash ? 'stdio-crash' : 'native',
    desktopArchive: process.env.KCODER_E2E_WINDOWS_DESKTOP_ARCHIVE,
    desktopArchiveSha256: process.env.KCODER_E2E_WINDOWS_DESKTOP_ARCHIVE_SHA256,
    probeCli: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_BIN,
    probeSupervisor: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN,
    chromiumArchive: process.env.KCODER_E2E_WINDOWS_CHROMIUM_ARCHIVE,
    chromiumArchiveSha256: process.env.KCODER_E2E_WINDOWS_CHROMIUM_ARCHIVE_SHA256,
    sourceTreeSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256,
  }));
});
