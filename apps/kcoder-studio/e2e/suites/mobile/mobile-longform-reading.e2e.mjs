import assert from 'node:assert/strict';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { captureMobileExportSourceSnapshot } from '../../harness/mobile-export-source-snapshot.mjs';
import { materializeOwnedDependencies } from '../../harness/owned-dependencies.mjs';
import { startMobileDevelopmentServer } from '../../harness/mobile-development-server.mjs';
import { exportMobileWeb } from '../../harness/mobile-web-export.mjs';
import { startChromium } from '../../harness/chromium.mjs';

const baseline = process.argv.includes('--baseline');
process.umask(0o077);
await runE2E(import.meta.url, { testId: 'mobile-longform-reading', tier: 'full-integration', retainSuccessLogs: true,
  modelPolicy: 'Model-independent long-form Markdown through production cached conversation components; synthetic text, owned Chromium and source, no Gateway/personal session/model calls or native-device claim',
}, async run => {
  const snapshotRoot = run.pathInState('source');
  await run.writeArtifactJson('source.json', await captureMobileExportSourceSnapshot({ snapshotRoot, layout: 'preflight-source-root', sourceRoots: [
    { name: 'mobile', path: resolve(repoRoot, 'apps/kcoder-studio/mobile'), destination: 'apps/kcoder-studio/mobile' },
    { name: 'studio-shared', path: resolve(repoRoot, 'apps/kcoder-studio/shared'), destination: 'apps/kcoder-studio/shared' },
  ] }));
  const mobileRoot = resolve(snapshotRoot, 'apps/kcoder-studio/mobile');
  const originalMetroConfig = await readFile(resolve(mobileRoot, 'metro.config.cjs'), 'utf8');
  const fixture = await readFile(resolve(repoRoot, 'apps/kcoder-studio/e2e/fixtures/mobile-longform-reading.tsx'), 'utf8');
  const content = await readFile(resolve(repoRoot, 'apps/kcoder-studio/e2e/fixtures/mobile-longform-reading.md'), 'utf8');
  await writeFile(resolve(mobileRoot, 'src/app/longform-reading.tsx'), fixture.replace("'__LONGFORM_CONTENT__'", () => JSON.stringify(content)));
  if (baseline) {
    const original = JSON.parse(await readFile(resolve(repoRoot, 'apps/kcoder-studio/e2e/fixtures/mobile-longform-baseline.json'), 'utf8'));
    const changes = {
      'src/features/task/taskStyles.ts': [
        ['import { longformMarkdownStyles } from "@/features/conversation/longform-markdown-styles";\n', ''],
        ['import type { InterfaceVersion } from "@/storage/app-preferences";\n', ''],
        ['  interfaceVersion: InterfaceVersion = "modern",\n', ''],
        ['  const styles = {\n  body:', '  return ({\n  body:'],
        ['  };\n  if (interfaceVersion !== "v3") return styles;\n  const reading = longformMarkdownStyles(colors, bodyTypography, gap, boldFontFamily);\n  return { ...styles, ...reading, body: { ...styles.body, ...reading.body } };', '  });'],
        ['      preferences.interfaceVersion,\n', ''],
        ['preferences.conversationFontFamily, preferences.interfaceVersion, fontStatus]', 'preferences.conversationFontFamily, fontStatus]'],
      ],
      'src/features/task/MessageBubble.tsx': [
        ['import { longformMarkdownRules } from "@/features/conversation/longform-markdown-rules";\n', ''],
        ['...(v3 ? longformMarkdownRules : markdownReadingRules)', '...markdownReadingRules'],
        ['markdownStyles, readOnly, task, v3]', 'markdownStyles, readOnly, task]'],
      ],
      'src/features/interface/v3-styles.ts': [
        ['assistantBubble: { width: "100%", maxWidth: 760, minWidth: 0, borderWidth: 0, borderRadius: 10, padding: 12,', 'assistantBubble: { width: "88%", borderWidth: 0, borderRadius: 10, padding: 10,'],
      ],
    };
    const reconstructed = [];
    for (const [path, edits] of Object.entries(changes)) {
      let before = await readFile(resolve(mobileRoot, path), 'utf8');
      for (const [after, prior] of edits) { assert.equal(before.split(after).length, 2, `unique baseline edit ${path}`); before = before.replace(after, () => prior); }
      const hash = createHash('sha256').update(before).digest('hex');
      assert.equal(hash, original.files.find(row => row.root === 'mobile' && row.path === path)?.sha256, `baseline exactly matches the captured original ${path}`);
      await writeFile(resolve(mobileRoot, path), before);
      reconstructed.push({ path, sha256: hash, matchesOriginal: true });
    }
    await run.writeArtifactJson('baseline-source-verification.json', reconstructed);
  }
  await materializeOwnedDependencies(run, { sourceRoot: resolve(repoRoot, 'apps/kcoder-studio/mobile/node_modules'), destination: resolve(mobileRoot, 'node_modules'), label: 'reading-dependencies' });
  const metro = await startMobileDevelopmentServer(run, { mobileRoot });
  const browser = await startChromium(run, { label: 'reading-browser', noSandbox: true });
  const diagnostics = [], cases = [];
  for (const scenario of [
    { width: 390, language: 'zh-CN', theme: 'light' },
    { width: 320, language: 'zh-CN', theme: 'dark' },
    { width: 390, language: 'en', theme: 'dark' },
    { width: 320, language: 'en', theme: 'light' },
    { width: 1024, language: 'zh-CN', theme: 'light' },
  ]) {
    const name = `${scenario.width}-${scenario.language}-${scenario.theme}`;
    const page = await browser.newPage({ viewport: { width: scenario.width, height: 844 } });
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) diagnostics.push({ name, type: message.type(), text: run.redactText(message.text()) }); });
    page.on('pageerror', error => diagnostics.push({ name, type: 'exception', text: run.redactText(error.message) }));
    try {
      await page.addInitScript(preferences => localStorage.setItem('kcoder-studio:mobile-app-preferences:v1', JSON.stringify({ ...preferences, interfaceVersion: 'v3' })), scenario);
      await page.goto(`${metro.baseUrl}/longform-reading`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.getByText('READING_FINAL_MARKER', { exact: true }).waitFor({ timeout: 60_000 });
      await page.getByTestId('message-list').hover(); await page.mouse.wheel(0, -600);
      const shot = async (label, locator) => {
        // Browser scrollIntoView reverses block alignment inside RNW's inverted list.
        // Measure its physical movement instead, without changing production geometry.
        const align = () => locator.evaluate(node => {
          const host = document.querySelector('[data-testid="message-list"]');
          const max = host.scrollHeight - host.clientHeight;
          if (max <= 0) return;
          const saved = host.scrollTop, top = node.getBoundingClientRect().top;
          host.scrollTop = saved < max ? saved + 1 : saved - 1;
          const probe = host.scrollTop - saved;
          const direction = probe ? (node.getBoundingClientRect().top - top) / probe : 0;
          host.scrollTop = saved;
          if (Math.abs(direction) > .1) host.scrollTop = saved - (top - host.getBoundingClientRect().top - 12) / direction;
        });
        await align(); await page.waitForTimeout(150); await align(); await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name}/${label} page overflow`);
        await page.screenshot({ path: run.pathInArtifacts(`${name}-${label}.png`) });
      };
      await shot('top', page.getByText('把复杂的问题，讲清楚', { exact: true }));
      await shot('list', page.getByText('先看重点，再看细节', { exact: true }));
      await shot('quote', page.getByText('一段补充说明', { exact: true }));
      await shot('table', page.getByText('方案对比', { exact: true }));
      await shot('code', page.getByText('代码示例', { exact: true }));
      await page.getByTestId('code-disclosure').first().getByRole('button').first().click();
      await page.getByText('console.log(result.thread.title);', { exact: false }).first().waitFor();
      await shot('code-expanded', page.getByText('代码示例', { exact: true }));
      if (!baseline) {
        const firstCode = page.getByTestId('code-disclosure').first();
        const retained = await firstCode.elementHandle();
        const append = async text => {
          await page.evaluate(value => window.dispatchEvent(new CustomEvent('kcoder-reading-fixture-append', { detail: value })), text);
        };
        await append('\n\nSTREAMING_APPEND_ONE');
        await page.getByText('STREAMING_APPEND_ONE', { exact: true }).waitFor();
        assert.equal(await firstCode.getByRole('button').first().getAttribute('aria-expanded'), 'true', 'later Markdown must retain the expanded code block');
        assert.equal(await retained.evaluate(node => node.isConnected), true, 'existing disclosure DOM must stay mounted across deltas');
        await append('\n\n~~~text\nSTREAMING_CODE_ONE');
        const growingCode = page.getByTestId('code-disclosure').last();
        await growingCode.getByRole('button').first().click();
        const growing = await growingCode.elementHandle();
        await append('\nSTREAMING_CODE_TWO\n~~~\n\nSTREAMING_APPEND_TWO');
        await page.getByText('STREAMING_APPEND_TWO', { exact: true }).waitFor();
        assert.equal(await growingCode.getByRole('button').first().getAttribute('aria-expanded'), 'true', 'an expanded open fence stays expanded when it grows and closes');
        assert.equal(await growing.evaluate(node => node.isConnected), true);
        await page.getByText('STREAMING_CODE_TWO', { exact: false }).waitFor();
        await firstCode.getByRole('button').first().click();
        await append('\n\nSTREAMING_APPEND_THREE');
        await page.getByText('STREAMING_APPEND_THREE', { exact: true }).waitFor();
        assert.equal(await firstCode.getByRole('button').first().getAttribute('aria-expanded'), 'false', 'manual collapse also survives later deltas');
        await firstCode.getByRole('button').first().click();
        await shot('code-after-deltas', page.getByText('代码示例', { exact: true }));
        await retained.dispose(); await growing.dispose();
      }
      await shot('prose', page.getByText('持续阅读的节奏', { exact: true }));
      await page.getByText('READING_FINAL_MARKER', { exact: true }).scrollIntoViewIfNeeded();
      const geometry = await page.getByTestId('conversation-markdown-body').first().evaluate(node => ({ width: node.getBoundingClientRect().width, text: node.innerText }));
      assert.ok(geometry.text.includes('conversation_rendering_preferences_with_a_very_long_unbroken_identifier'));
      if (!baseline) {
        const table = page.getByTestId('conversation-markdown-table-scroll').first();
        await table.scrollIntoViewIfNeeded();
        const scroller = table.locator('[data-testid="conversation-markdown-table-viewport"]');
        const dimensions = await scroller.evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }));
        if (scenario.width < 600) {
          assert.ok(dimensions.scroll > dimensions.client, 'wide tables scroll inside their own viewport');
          await scroller.focus(); await scroller.press('ArrowRight');
          await waitFor(async () => await scroller.evaluate(node => node.scrollLeft > 0), 3000, 'table is keyboard scrollable');
          for (let step = 0; step < 20; step++) await scroller.press('ArrowRight', { delay: 30 });
          await waitFor(async () => await scroller.evaluate(node => node.scrollLeft + node.clientWidth >= node.scrollWidth - 2), 3000, 'the final table columns remain reachable');
          await scroller.evaluate(node => node.blur());
          await shot('table-final-columns', page.getByText('方案对比', { exact: true }));
          await scroller.evaluate(node => { node.scrollLeft = 0; });
          await scroller.hover({ position: { x: 50, y: 32 } }); await page.mouse.wheel(1000, 0);
          await waitFor(async () => await scroller.evaluate(node => node.scrollLeft + node.clientWidth >= node.scrollWidth - 2), 3000, 'horizontal wheel reaches the final table columns');
          const list = page.getByTestId('message-list'), previousTop = await list.evaluate(node => node.scrollTop);
          await page.mouse.wheel(0, 120);
          await waitFor(async () => await list.evaluate((node, previous) => node.scrollTop !== previous, previousTop), 3000, 'vertical wheel still scrolls the outer conversation');
          assert.ok(geometry.width > scenario.width * .78, 'long replies use the available phone width');
        } else assert.ok(geometry.width <= 760 && geometry.width > 600, 'wide displays keep a bounded reading measure');
        const card = page.getByTestId('markdown-table-card').first();
        await scroller.evaluate(node => { node.scrollLeft = 0; });
        await shot('table-toolbar', page.getByText('方案对比', { exact: true }));
        const toolbar = card.getByTestId('markdown-table-toolbar');
        const beforeToolbar = await toolbar.boundingBox();
        await scroller.evaluate(node => { node.scrollLeft = node.scrollWidth; });
        assert.equal((await toolbar.boundingBox()).x, beforeToolbar.x, 'horizontal scrolling must not move table actions');
        for (const action of ['copy', 'expand', 'more']) {
          const box = await card.getByTestId(`markdown-table-${action}`).boundingBox();
          assert.ok(box.width >= 44 && box.height >= 44, `${action} remains touchable on ${name}`);
        }
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: metro.baseUrl });
        const expectedTable = content.match(/^\| 关注点 [\s\S]*?(?=\n\n)/m)?.[0];
        assert.ok(expectedTable);
        await card.getByTestId('markdown-table-copy').click();
        await waitFor(async () => await page.evaluate(() => navigator.clipboard.readText()) === expectedTable, 3000, 'copy writes only the whole selected Markdown table');
        const expand = card.getByTestId('markdown-table-expand');
        await expand.focus();
        const conversationPosition = await page.getByTestId('message-list').evaluate(node => node.scrollTop);
        await expand.click();
        const dialog = page.getByTestId('markdown-table-expanded');
        await dialog.waitFor();
        assert.ok(await dialog.evaluate(node => node.contains(document.activeElement)), 'viewer receives focus');
        assert.equal(await dialog.getByText('READING_FINAL_MARKER', { exact: true }).count(), 0, 'viewer contains only the chosen table');
        const expandedViewport = dialog.getByTestId('markdown-table-expanded-viewport');
        await expandedViewport.focus();
        await page.screenshot({ path: run.pathInArtifacts(`${name}-table-expanded-start.png`) });
        if (scenario.width < 600) {
          await expandedViewport.hover({ position: { x: 50, y: 32 } });
          await page.mouse.wheel(1000, 0);
          await waitFor(async () => await expandedViewport.evaluate(node => node.scrollLeft + node.clientWidth >= node.scrollWidth - 2), 3000, 'expanded table final columns remain reachable');
        }
        await dialog.getByTestId('markdown-table-expanded-copy').click();
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expectedTable);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'full-screen table does not overflow the page');
        await page.screenshot({ path: run.pathInArtifacts(`${name}-table-expanded.png`) });
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        assert.equal(await expand.evaluate(node => node === document.activeElement), true, 'Escape restores focus to Expand');
        assert.equal(await page.getByTestId('message-list').evaluate(node => node.scrollTop), conversationPosition, 'closing the table preserves transcript position');
        await scroller.evaluate(node => { node.scrollLeft = 0; });
        await card.getByTestId('markdown-table-more').click();
        const menu = page.getByTestId('markdown-table-menu');
        await menu.waitFor();
        for (const action of ['image', 'share']) {
          const todo = menu.getByTestId(`markdown-table-${action}-todo`);
          assert.equal(await todo.isDisabled(), true);
          assert.match(await todo.innerText(), /TODO/);
        }
        await page.screenshot({ path: run.pathInArtifacts(`${name}-table-more-todo.png`) });
        await menu.getByTestId('markdown-table-panel-close').click();
        await menu.waitFor({ state: 'detached' });
        assert.equal(await card.getByTestId('markdown-table-more').evaluate(node => node === document.activeElement), true, 'menu close restores focus');
        await expand.click();
        await page.getByTestId('markdown-table-expanded').getByTestId('markdown-table-panel-close').click();
        await page.getByTestId('markdown-table-expanded').waitFor({ state: 'detached' });
      }
      cases.push({ ...scenario, bodyWidth: geometry.width, contentPreserved: true, disclosureSurvivesDeltas: !baseline, tableToolbar: !baseline });
    } catch (error) {
      await page.screenshot({ path: run.pathInArtifacts(`${name}-failure.png`) });
      await run.writeArtifactJson('failure.json', { name, diagnostics, body: await page.locator('body').innerText() });
      throw error;
    } finally { await page.close(); }
  }
  await run.writeArtifactJson('console.json', diagnostics);
  assert.deepEqual(diagnostics, []);
  if (!baseline && !process.argv.includes('--screenshots-only')) {
    await run.stopOwned('mobile-metro');
    // Development owns this generated cache/config. Export from clean build inputs,
    // without relaxing the export harness's source-integrity checks.
    const cachePath = resolve(mobileRoot, '.metro-cache');
    const cache = await lstat(cachePath);
    assert.ok(cache.isDirectory() && !cache.isSymbolicLink());
    await rm(cachePath, { recursive: true });
    await writeFile(resolve(mobileRoot, 'metro.config.cjs'), originalMetroConfig);
    await exportMobileWeb(run, { mobileRoot, dependencyRoot: resolve(mobileRoot, 'node_modules'), label: 'reading-web-build' });
  }
  return { baseline, cases, diagnostics };
});
