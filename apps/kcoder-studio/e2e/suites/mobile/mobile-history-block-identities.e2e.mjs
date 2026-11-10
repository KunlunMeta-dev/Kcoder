import assert from 'node:assert/strict';
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { captureMobileExportSourceSnapshot } from '../../harness/mobile-export-source-snapshot.mjs';
import { materializeOwnedDependencies } from '../../harness/owned-dependencies.mjs';
import { startMobileDevelopmentServer } from '../../harness/mobile-development-server.mjs';
import { startChromium } from '../../harness/chromium.mjs';

process.umask(0o077);
await runE2E(import.meta.url, { testId: 'mobile-history-block-identities', tier: 'full-integration', retainSuccessLogs: true,
  modelPolicy: 'Model-independent synthetic legacy cached history through production normalizer/cache codec/renderers in development Chromium; no Gateway, personal session or model calls',
}, async run => {
  const snapshotRoot = run.pathInState('source');
  await run.writeArtifactJson('source.json', await captureMobileExportSourceSnapshot({ snapshotRoot, layout: 'preflight-source-root', sourceRoots: [
    { name: 'mobile', path: resolve(repoRoot, 'apps/kcoder-studio/mobile'), destination: 'apps/kcoder-studio/mobile' },
    { name: 'studio-shared', path: resolve(repoRoot, 'apps/kcoder-studio/shared'), destination: 'apps/kcoder-studio/shared' },
  ] }));
  const mobileRoot = resolve(snapshotRoot, 'apps/kcoder-studio/mobile');
  await copyFile(resolve(repoRoot, 'apps/kcoder-studio/e2e/fixtures/mobile-history-block-identities.tsx'), resolve(mobileRoot, 'src/app/history-block-identities.tsx'));
  await materializeOwnedDependencies(run, { sourceRoot: resolve(repoRoot, 'apps/kcoder-studio/mobile/node_modules'), destination: resolve(mobileRoot, 'node_modules'), label: 'history-identity-dependencies' });
  const metro = await startMobileDevelopmentServer(run, { mobileRoot });
  const browser = await startChromium(run, { label: 'history-identity-browser', noSandbox: true });
  const diagnostics = [], cases = [];
  for (const scenario of [
    { width: 390, language: 'zh-CN', theme: 'light' },
    { width: 320, language: 'zh-CN', theme: 'dark' },
    { width: 390, language: 'en', theme: 'dark' },
    { width: 320, language: 'en', theme: 'light' },
  ]) {
    const name = `${scenario.width}-${scenario.language}-${scenario.theme}`;
    const page = await browser.newPage({ viewport: { width: scenario.width, height: 844 } });
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) diagnostics.push({ name, type: message.type(), text: run.redactText(message.text()) }); });
    page.on('pageerror', error => diagnostics.push({ name, type: 'exception', text: run.redactText(error.message) }));
    try {
      await page.addInitScript(preferences => localStorage.setItem('kcoder-studio:mobile-app-preferences:v1', JSON.stringify({ ...preferences, interfaceVersion: 'v3' })), scenario);
      await page.goto(`${metro.baseUrl}/history-block-identities`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      for (let load = 0; load < 2; load++) {
        if (load) await page.reload();
        await page.getByText('HISTORY_IDENTITY_FINAL', { exact: true }).waitFor({ timeout: 45_000 });
        assert.equal(await page.getByText('HISTORY_IDENTITY_REPEATED', { exact: true }).count(), 2);
        assert.equal(await page.getByText('HISTORY_IDENTITY_DIFFERENT', { exact: true }).count(), 1);
        assert.equal(await page.getByText('HISTORY_IDENTITY_FINAL', { exact: true }).count(), 1);
      }
      await page.screenshot({ path: run.pathInArtifacts(`${name}.png`) });
      cases.push({ ...scenario, reloads: 1, repeatedSegments: 2, contentPreserved: true });
    } finally { await page.close(); }
  }
  await run.writeArtifactJson('console.json', diagnostics);
  assert.deepEqual(diagnostics, []);
  return { cases, diagnostics };
});
