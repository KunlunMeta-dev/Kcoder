import { runE2E, waitFor, isolatedEnvironment } from '../harness/run-context.mjs'
import { startChromium } from '../harness/chromium.mjs'
import { mkdir, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
await runE2E(import.meta.url, { modelIndependent: true, purpose: 'User-requested actual React control screenshots with synthetic data' }, async context => {
  const child = context.spawnOwned('vite', process.execPath, [resolve('apps/kcoder-studio/renderer/e2e/harness/vite-server.mjs')], { cwd: resolve('apps/kcoder-studio/renderer'), env: isolatedEnvironment({ VITE_KCODER_STUDIO_E2E: 'true', VITE_KCODER_STUDIO_RUNTIME_MODE: 'backend', KCODER_STUDIO_E2E_VITE_PUBLIC_DIR: context.pathInState('public') }) })
  let origin
  child.stdout.on('data', chunk => { for (const line of String(chunk).split('\n')) { try { const value = JSON.parse(line); if (value.event === 'READY') origin = `http://127.0.0.1:${value.port}` } catch {} } })
  await waitFor(() => Boolean(origin), 60000, 'owned Vite ready')
  const browser = await startChromium(context, { executablePath: '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', noSandbox: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 })
  await page.route('**/api/servers', route => route.fulfill({ json: { servers: [{ id: 'local', transport: 'local', label: '当前计算机', workspacePath: '/preview' }] } }))
  const output = resolve(process.env.KCODER_UI_CAPTURE_UPDATES_ONLY === '1' ? 'tmp/task-board-wiki-upload-20261031-v3' : process.env.KCODER_UI_CAPTURE_HEADER_ONLY === '1' ? 'tmp/page-headers-20261030' : process.env.KCODER_UI_CAPTURE_PROVIDER_ONLY === '1' ? 'tmp/model-settings-20261030' : process.env.KCODER_UI_CAPTURE_TOOLS_ONLY === '1' ? 'tmp/tools-settings-20261030' : 'tmp/ui-status-overview-20261030')
  await mkdir(output, { recursive: true })
  async function capture(name) {
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))) })
    const path = context.pathInArtifacts(name)
    await page.screenshot({ path, fullPage: true })
    await copyFile(path, resolve(output, name))
  }
  page.on('pageerror', error => console.error('PREVIEW_PAGE_ERROR', error.message))
  if (process.env.KCODER_UI_CAPTURE_UPDATES_ONLY === '1') {
    await page.goto(`${origin}/e2e/fixtures/control-style-preview.html?panel=board`)
    const periods = page.getByRole('group', { name: '按更新时间筛选' })
    await periods.getByRole('button', { name: '最近 7 天' }).waitFor()
    if (await periods.getByRole('button', { name: '最近 7 天' }).getAttribute('aria-pressed') !== 'true') throw new Error('Seven-day default not selected')
    await page.getByTestId('task-board-list-row').first().waitFor()
    await capture('01-task-board-time-filters.png')
    await periods.getByRole('button', { name: '全部', exact: true }).click()
    await capture('02-task-board-all.png')
    await page.setViewportSize({ width: 900, height: 850 })
    await capture('03-task-board-narrow.png')
    await page.goto(`${origin}/e2e/fixtures/control-style-preview.html?panel=upload`)
    await page.getByTestId('wiki-upload-browse').waitFor()
    await capture('04-wiki-upload-icon.png')
    const chooser = page.waitForEvent('filechooser')
    await page.getByTestId('wiki-upload-browse').click()
    const picker = await chooser
    if (!picker.isMultiple()) throw new Error('Upload icon did not open the multiple-file picker')
    await picker.setFiles([])
    await page.goto(`${origin}/e2e/fixtures/control-style-preview.html`)
    const target = page.getByTestId('automation-target')
    await target.waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="automation-target"]')?.selectedOptions[0]?.textContent?.trim() === '当前计算机')
    await capture('05-scheduler-current-computer.png')
    await page.getByTestId('scheduled-task-kind').selectOption('workflow')
    await page.getByTestId('scheduled-workflow-choice').waitFor()
    const spacing = await page.evaluate(() => {
      const choice = document.querySelector('[data-testid="scheduled-workflow-choice"]').getBoundingClientRect()
      const title = document.querySelector('[data-testid="automation-title"]').closest('label').getBoundingClientRect()
      return title.top - choice.bottom
    })
    if (spacing < 24) throw new Error(`Workflow and title spacing is too small: ${spacing}`)
    await capture('06-scheduler-workflow-spacing.png')
    console.log(JSON.stringify({ output, runRoot: context.runRoot, spacing }))
    return { screenshots: 6, spacing, boundary: 'Real React controls with synthetic data; no native/model calls' }
  }
  if (process.env.KCODER_UI_CAPTURE_HEADER_ONLY === '1') {
    await page.goto(`${origin}/e2e/fixtures/control-style-preview.html?panel=headers`)
    await page.getByTestId('header-wiki').waitFor()
    const heights = await page.evaluate(() => ['wiki','tasks','schedule','workflow','plugins','channels'].map(id => document.querySelector(`[data-testid="header-${id}"]`).getBoundingClientRect().height))
    if (heights.some(height => height !== 56)) throw new Error(`Header heights differ: ${JSON.stringify(heights)}`)
    await capture('01-unified-page-headers.png')
    await page.goto(`${origin}/e2e/fixtures/control-style-preview.html`)
    await page.getByTestId('automation-target').waitFor()
    await capture('02-scheduler-header.png')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${origin}/e2e/fixtures/control-style-preview.html?panel=headers`)
    await page.getByTestId('header-wiki').waitFor()
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Page headers overflow on mobile')
    await capture('03-unified-page-headers-mobile.png')
    console.log(JSON.stringify({ output, heights, runRoot: context.runRoot }))
    return { screenshots: 3, heights, boundary: 'Real shared headers and scheduler; synthetic data; no native operations' }
  }
  if (process.env.KCODER_UI_CAPTURE_PROVIDER_ONLY === '1') {
    await page.goto(`${origin}/e2e/fixtures/provider-style-preview.html`)
    await page.getByTestId('provider-edit-demo::MiniMax-M3').waitFor()
    await capture('01-model-overview.png')
    await page.getByTestId('provider-edit-demo::MiniMax-M3').click()
    await page.getByTestId('provider-form').waitFor({ state: 'visible' })
    const geometry = await page.evaluate(() => {
      const basic = document.querySelector('[data-testid="provider-default"]').closest('fieldset').getBoundingClientRect()
      const advanced = document.querySelector('[data-testid="provider-advanced-settings"]').getBoundingClientRect()
      const security = document.querySelector('[data-testid="provider-advanced-settings"] + details').getBoundingClientRect()
      return { basicToAdvanced: advanced.top - basic.bottom, advancedToSecurity: security.top - advanced.bottom }
    })
    if (geometry.basicToAdvanced < 15 || geometry.advancedToSecurity < 15) throw new Error(`Model section gaps are too small: ${JSON.stringify(geometry)}`)
    await page.getByTestId('provider-advanced-settings').scrollIntoViewIfNeeded()
    await capture('02-model-editor-spacing.png')
    console.log(JSON.stringify({ output, geometry, runRoot: context.runRoot }))
    return { screenshots: 2, geometry, boundary: 'Real model settings components; rendering-only provider data; no writes or model calls' }
  }
  if (process.env.KCODER_UI_CAPTURE_TOOLS_ONLY === '1') {
    await page.goto(`${origin}/e2e/fixtures/tools-settings-preview.html`)
    await page.getByTestId('tool-selection-read').waitFor()
    if (await page.getByRole('switch').count() !== 10) throw new Error('Expected ten tools on the first page')
    await capture('01-kcoder-tools.png')
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    if (await page.getByRole('switch').count() !== 3) throw new Error('Expected three remaining tools on the second page')
    await capture('03-kcoder-tools-page-2.png')
    await page.getByTestId('tool-selections-mode-kworker').click()
    await page.getByTestId('tool-selection-read').waitFor()
    if (await page.getByRole('switch').count() !== 10) throw new Error('Mode changes must return to the first page')
    await capture('02-kworker-tools.png')
    console.log(JSON.stringify({ output, runRoot: context.runRoot }))
    return { screenshots: 3, boundary: 'Real tool settings components and 10-item pagination; synthetic catalog; writes rejected by fixture' }
  }

  if (process.env.KCODER_UI_CAPTURE_DETAIL_ONLY === '1') {
    await page.goto(`${origin}/e2e/fixtures/control-style-preview.html?panel=overview`)
    await page.getByTestId('task-workspace-root-status').waitFor()
    await capture('01-task-status-overview.png')
    await page.goto(`${origin}/e2e/fixtures/control-style-preview.html?panel=storage`)
    await page.getByTestId('storage-bucket-debug-logs').waitFor()
    const geometry = await page.evaluate(() => {
      const heading = [...document.querySelectorAll('h2')].find(element => element.textContent === '目录占用')
      const header = heading.parentElement.parentElement.querySelector('[aria-hidden="true"]')
      const row = document.querySelector('[data-testid="storage-bucket-debug-logs"] [aria-hidden="true"]')
      const a = header.getBoundingClientRect(), b = row.getBoundingClientRect()
      return { headerX: a.x, rowX: b.x, headerWidth: a.width, rowWidth: b.width }
    })
    if (Math.abs(geometry.headerX - geometry.rowX) > 0.5 || geometry.headerWidth !== geometry.rowWidth) throw Error('Storage icon alignment failed')
    await capture('02-storage-icons-aligned.png')
    console.log(JSON.stringify({ output, runRoot: context.runRoot, geometry }))
    return { screenshots: 2, geometry, boundary: 'Real product components with synthetic data; no native/model acceptance' }
  }

  if (process.env.KCODER_UI_CAPTURE_DISCLOSURE_ONLY !== '1' && process.env.KCODER_UI_CAPTURE_BOARD_ONLY !== '1') {
  await page.goto(`${origin}/e2e/fixtures/control-style-preview.html`)
  await page.getByTestId('scheduled-task-kind').waitFor()
  await page.getByTestId('scheduled-task-kind').selectOption('workflow')
  await page.getByTestId('scheduled-workflow-choice').waitFor()
  await page.getByTestId('scheduled-workflow-choice').locator('option').filter({ hasText: '旅游攻略' }).waitFor({ state: 'attached' })
  await capture('01-scheduler-selects.png')
  await page.getByTestId('scheduled-workflow-choice').dispatchEvent('mousedown', { button: 0 })
  await page.getByRole('listbox').waitFor()
  await capture('02-workflow-dropdown-open.png')
  await page.keyboard.press('Escape')
  }
  if (process.env.KCODER_UI_CAPTURE_BOARD_ONLY !== '1') {
  await page.goto(`${origin}/e2e/fixtures/control-style-preview.html?panel=proxy`)
  await page.getByTestId('plugins-proxy-details').waitFor()
  await capture('03-disclosures-collapsed.png')
  await page.getByTestId('plugins-proxy-details').locator('summary').click()
  await capture('04-disclosures-expanded.png')
  }
  if (process.env.KCODER_UI_CAPTURE_DISCLOSURE_ONLY !== '1') {
  await page.goto(`${origin}/e2e/fixtures/control-style-preview.html?panel=board&layout=rows`)
  await page.getByTestId('task-board-list-row').first().waitFor()
  await capture('05-task-board-wide.png')
  await page.setViewportSize({ width: 900, height: 850 })
  await capture('06-task-board-compact.png')
  }
  console.log(JSON.stringify({ output, runRoot: context.runRoot }))
  return { screenshots: 6, output, boundary: 'Real product React components; synthetic backend data; no model/native acceptance' }
})
