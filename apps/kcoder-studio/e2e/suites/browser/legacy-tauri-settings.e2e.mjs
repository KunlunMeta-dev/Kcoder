import { resolve } from 'node:path';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';

await runE2E(import.meta.url, {
  testId: 'legacy-tauri-settings-native-webview', tier: 'manual-live',
  modelPolicy: 'native Tauri appearance validation only; no model turns, no replacement of a failed executor',
  retainSuccessLogs: true,
}, async context => {
  const xvfb = await requireExecutable('/usr/bin/xvfb-run', 'isolated Xvfb');
  const child = context.spawnOwned('tauri-settings', xvfb,
    ['-a', process.execPath, resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/tauri-settings-probe.mjs'), context.artifactsDir],
    { cwd: repoRoot, env: { ...process.env, KCODER_DISABLE_SCCACHE: '1' } });
  await waitFor(() => child.exitCode !== null, 110000, 'Tauri settings probe', 100, context.abortSignal);
  if (child.exitCode !== 0) throw new Error('Legacy Tauri settings verification failed; inspect tauri-result.json and the native snapshot');
  return { passed: true, nativeTauri: true };
});
