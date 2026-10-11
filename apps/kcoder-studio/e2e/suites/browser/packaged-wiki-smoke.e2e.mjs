import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { runE2E, requireExecutable, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startPackagedDesktop } from '../../harness/packaged-desktop.mjs';
import { startWikiModelFixture } from '../../harness/wiki-model.mjs';
import { fixturePdf } from '../../harness/pdf-fixture.mjs';

// Actual packaged Electron/Gateway/CLI/PDF extraction with a deterministic target
// Provider. This is transport, UI and persistence coverage, not model quality.
await runE2E(import.meta.url, {
  testId: 'packaged-wiki-text-pdf-citations-and-restart', tier: 'manual-live',
  modelPolicy: 'model-independent packaged Wiki transport/persistence; owned HTTP fixture',
}, async context => {
  assert.ok(process.env.KCODER_E2E_PACKAGED_DIR, 'UNMET_PREREQUISITE: KCODER_E2E_PACKAGED_DIR is required');
  const root = resolve(process.env.KCODER_E2E_PACKAGED_DIR);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const cli = await requireExecutable(join(root, `resources/bin/kcoder${suffix}`), 'packaged CLI');
  await requireExecutable(join(root, `resources/bin/pdf/pdftotext${suffix}`), 'packaged PDF reader');
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'packaged-wiki' });
  const textMarker = 'PACKAGED_WIKI_TEXT_EVIDENCE';
  const pdfMarker = 'PACKAGED_WIKI_PDF_EVIDENCE';
  const model = await startWikiModelFixture(context, { pageForSource: source => {
    const text = source.chunks.map(chunk => chunk.text).join('\n');
    const pdf = text.includes(pdfMarker);
    const title = pdf ? 'Packaged PDF evidence' : 'Packaged text evidence';
    return { title, markdown: `# ${title}\n\n${pdf ? pdfMarker : textMarker}` };
  } });
  const servers = await context.writeStateJson('servers.json', [{
    id: 'local', label: 'Wiki package fixture', transport: 'local', command: cli, workspace: workspace.path,
  }]);
  const settingsPath = await context.writeStateJson('home/settings.json', {
    knowledge: { enabled: false }, active_provider: 'wiki-fixture', providers: {
      'wiki-fixture': { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
        endpoint: model.baseUrl, default_model: 'wiki-fixture', context_window_tokens: 128000,
        max_output_tokens: 8192, output_headroom_tokens: 8192, no_proxy: true },
    },
  });
  await context.writeStateJson('home/credentials.json', {});
  const enabled = async () => JSON.parse(await readFile(settingsPath, 'utf8')).knowledge?.enabled;
  const evidence = [];
  for (let round = 0; round < 2; round++) {
    const desktop = await startPackagedDesktop(context, {
      root, label: `packaged-wiki-${round}`, servers, workspace: workspace.path,
    });
    const { page } = desktop;
    try {
      await page.getByTestId('knowledge-button').click();
      await page.getByTestId('knowledge-enable').waitFor({ timeout: 30000 });
      assert.equal(await enabled(), false, 'opt-in remains off across application restart');
      assert.equal(model.requests.length, round === 0 ? 0 : 4, 'no model request while off/restarting');
      await page.getByTestId('knowledge-enable').click();
      await waitFor(async () => (await enabled()) === true, 10000, 'target Wiki enabled');
      if (round === 0) {
        await page.getByTestId('knowledge-create').click();
        await page.getByTestId('wiki-create-input').fill('Packaged Wiki');
        await page.getByTestId('wiki-create-confirm').click();
        await page.getByTestId('knowledge-library-picker').waitFor();
        for (const source of [
          { name: 'Wiki 文本资料.md', title: 'Packaged text evidence', marker: textMarker,
            mimeType: 'text/markdown', buffer: Buffer.from(`# Test source\n\n${textMarker}\n产品支持协议 A。`) },
          { name: 'Wiki PDF 资料.pdf', title: 'Packaged PDF evidence', marker: pdfMarker,
            mimeType: 'application/pdf', buffer: Buffer.from(fixturePdf(pdfMarker)) },
        ]) {
          await page.getByTestId('wiki-import-files').setInputFiles({
            name: source.name, mimeType: source.mimeType, buffer: source.buffer,
          });
          const row = page.locator(`[data-testid^="wiki-page-row-"][aria-label="${source.title}"]`);
          await row.waitFor({ timeout: 60000 });
          await row.click();
          await page.getByTestId('wiki-reader').getByText(source.marker, { exact: true }).waitFor();
          await page.getByTestId('wiki-citation-0').click();
          await page.getByTestId('wiki-source-preview').getByText(source.marker, { exact: false }).waitFor();
          await page.screenshot({ path: context.pathInArtifacts(`wiki-${source.mimeType === 'application/pdf' ? 'pdf' : 'text'}-citation.png`) });
          await page.getByTestId('wiki-reader-back').click();
        }
        assert.equal(model.requests.length, 4, 'two target model stages per imported source');
        await page.getByTestId('knowledge-organization-enabled').click();
        await page.getByTestId('knowledge-retrieval-enabled').click();
        await page.getByTestId('knowledge-enable').waitFor();
        await waitFor(async () => (await enabled()) === false, 10000, 'Wiki disabled before restart');
      } else {
        await page.getByTestId('knowledge-library-picker').waitFor();
        for (const title of ['Packaged text evidence', 'Packaged PDF evidence']) {
          await page.locator(`[data-testid^="wiki-page-row-"][aria-label="${title}"]`).waitFor();
        }
        await page.locator('[data-testid^="wiki-page-row-"][aria-label="Packaged PDF evidence"]').click();
        await page.getByTestId('wiki-citation-0').click();
        await page.getByTestId('wiki-source-preview').getByText(pdfMarker, { exact: false }).waitFor();
        await page.screenshot({ path: context.pathInArtifacts('wiki-restored-after-restart.png') });
        assert.equal(model.requests.length, 4, 'reading persisted content does not regenerate it');
      }
      evidence.push({ round, modelRequests: model.requests.length, targetEnabled: await enabled() });
    } catch (error) {
      await page.screenshot({ path: context.pathInArtifacts(`wiki-round-${round}-failure.png`) }).catch(() => {});
      throw error;
    } finally { await desktop.stop(); }
  }
  await context.writeArtifactJson('wiki-package-result.json', {
    platform: process.platform, nativeWindowsVerified: process.platform === 'win32',
    textImport: true, bundledPdfExtraction: true, originalCitation: true,
    defaultOff: true, restartPersistence: true, noUnexpectedModelCalls: true, rounds: evidence,
  });
});
