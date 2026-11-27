import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { runE2E, repoRoot } from '../../harness/run-context.mjs';
import { startWindowsRemoteStudio } from '../../harness/windows-remote-studio.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';

const quickOnly = process.env.KCODER_E2E_WINDOWS_QUICK_MIGRATION === '1';
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: quickOnly ? 'windows-studio-quick-history-migration' : 'windows-studio-claude-codex-migration-ui', tier: 'manual-live',
  modelPolicy: quickOnly ? 'actual Windows Electron quick migration of 6 owned vendor histories; pause/resume, duplicate prevention, light/dark/narrow layout; no personal histories, scheduled tasks or model turns' : 'actual Windows Electron, Gateway and app-server; owned synthetic vendor homes and private profile; no personal sources, scheduled tasks or paid model requests; one loopback protocol fixture turn for typography',
}, async context => {
  context.registerSecret('SYNTHETIC_WINDOWS_MIGRATION_KEY');
  const binary = process.env.KCODER_E2E_WINDOWS_CLI || resolve(repoRoot, 'target/x86_64-pc-windows-gnu/release/kcoder.exe');
  const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(sha256, process.env.KCODER_E2E_WINDOWS_CLI_SHA256, 'pin the reviewed native candidate');
  await context.writeArtifactJson('windows-ui-native-input.json', { sha256 });
  const host = await startWindowsRemoteStudio(context, {
    target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET,
    installation: process.env.KCODER_E2E_WINDOWS_STUDIO_DIRECTORY,
    node: process.env.KCODER_E2E_WINDOWS_NODE,
    windowsBinary: binary,
    localOnly: true,
    parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  });
  const result = await host.run('migration', {quickOnly}, quickOnly ? ['windows-quick-migration-ready.png','windows-quick-migration-complete.png','windows-quick-migration-narrow.png','windows-quick-migration-dark.png'] : [
    'windows-migration-claude-preview.png', 'windows-migration-claude-saved.png',
    'windows-migration-codex-preview.png', 'windows-migration-codex-saved.png','windows-longform-readable.png','windows-longform-dark.png','windows-longform-narrow.png',
  ]);
  assert.equal(result.nativeCliSha256, sha256);
  return result;
});
