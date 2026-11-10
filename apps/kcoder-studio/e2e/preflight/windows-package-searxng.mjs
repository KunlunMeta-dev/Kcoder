import { resolve } from 'node:path';
import { runE2E } from '../harness/run-context.mjs';
import { runWindowsPackageProbe, validatePackageProbe } from '../harness/windows-package-probe.mjs';

const options = {
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET,
  node: process.env.KCODER_E2E_WINDOWS_NODE,
  parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  archive: process.env.KCODER_E2E_WINDOWS_PAYLOAD_ARCHIVE ? resolve(process.env.KCODER_E2E_WINDOWS_PAYLOAD_ARCHIVE) : undefined,
  archiveSha256: process.env.KCODER_E2E_WINDOWS_PAYLOAD_SHA256,
  installedDirectory: process.env.KCODER_E2E_WINDOWS_INSTALLED_DIRECTORY,
  commit: process.env.KCODER_E2E_WINDOWS_EXPECTED_COMMIT,
  nativeCommit: process.env.KCODER_E2E_WINDOWS_EXPECTED_NATIVE_COMMIT,
  cliSha256: process.env.KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256,
  focus: process.env.KCODER_E2E_WINDOWS_PROBE_FOCUS,
  nativeConsent:process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST,
  externalConsent:process.env.KCODER_E2E_WEB_EXTERNAL_NETWORK,
  liveQuery: process.env.KCODER_E2E_WINDOWS_SEARCH_QUERY,
};
validatePackageProbe(options);
await runE2E(import.meta.url, {
  testId: 'windows-package-searxng', tier: 'manual-live',
  modelPolicy: 'owned Windows profiles and workers; real frozen installer payload or explicitly selected installed binaries, Studio backend and bundled search service; deterministic local provider protocol fixture, no external provider calls or personal configuration',
}, context => runWindowsPackageProbe(context, options));
