import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/servers', route =>
    route.fulfill({
      json: {
        servers: [
          { id: 'local', label: '当前计算机', transport: 'local', workspacePath: 'D:/fixture' },
        ],
      },
    })
  )
})

test('the optional processing window bounds incremental activity and collapses on completion', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto('/e2e/fixtures/reference-panels.html?panel=processing')
  const toggle = page.getByTestId('general-processing-window-toggle')
  await expect(toggle).toBeEnabled()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await page.getByTestId('fixture-process-new').click()
  const window = page.getByTestId('processing-window-scroll')
  await expect(window).toBeVisible()
  await expect(page.getByTestId('file-changes-card')).toHaveCount(0)
  const initial = await window.evaluate(node => ({
    height: node.clientHeight,
    content: node.scrollHeight,
  }))
  expect(initial.content).toBeGreaterThan(initial.height)
  expect(initial.height).toBeLessThanOrEqual(208)
  await expect(window).not.toContainText(/第\s*\d+\s*步/)
  const outer = page.getByTestId('fixture-process-page-scroll')
  const outerHeight = await outer.evaluate(node => node.scrollHeight)
  await window.evaluate(node => {
    node.scrollTop = 0
  })
  await expect(page.getByTestId('processing-window-latest')).toBeVisible()
  await page.getByTestId('fixture-process-append').click()
  await expect
    .poll(() => window.evaluate(node => node.scrollHeight))
    .toBeGreaterThan(initial.content)
  expect(await window.evaluate(node => node.clientHeight)).toBe(initial.height)
  expect(await window.evaluate(node => node.scrollTop)).toBe(0)
  expect(await outer.evaluate(node => node.scrollHeight)).toBe(outerHeight)
  await page.getByTestId('processing-window-latest').click()
  await expect
    .poll(() => window.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThan(2)
  await page.getByTestId('fixture-file-progress').click()
  await expect(page.getByTestId('workspace-file-progress')).toHaveCount(0)
  await page.getByTestId('fixture-file-progress').click()
  await expect(page.getByTestId('workspace-file-progress')).toHaveCount(0)
  await page.getByTestId('assistant-thinking-toggle').last().click()
  await page.getByTestId('assistant-thinking-toggle').last().click()
  await expect(page.getByTestId('workspace-file-progress')).toHaveCount(0)
  const beforeWheel = await window.evaluate(node => node.scrollTop)
  const pageScrollTop = await outer.evaluate(node => node.scrollTop)
  await window.hover()
  await page.mouse.wheel(0, -120)
  await expect.poll(() => window.evaluate(node => node.scrollTop)).toBeLessThan(beforeWheel)
  expect(await outer.evaluate(node => node.scrollTop)).toBe(pageScrollTop)
  await expect(page.getByTestId('processing-window-scrollbar')).toBeVisible()
  await expect(page.getByTestId('processing-window-thumb')).toBeVisible()
  const areaBox = await window.boundingBox()
  const messageBox = await page.getByTestId('message-assistant').boundingBox()
  const scrollbarBox = await page.getByTestId('processing-window-scrollbar').boundingBox()
  expect(areaBox!.width).toBeLessThanOrEqual(560)
  expect(scrollbarBox!.x + scrollbarBox!.width).toBeLessThanOrEqual(areaBox!.x + areaBox!.width)
  expect(messageBox!.width - areaBox!.width).toBeGreaterThanOrEqual(100)
  const thumb = await page.getByTestId('processing-window-thumb').boundingBox()
  const beforeDrag = await window.evaluate(node => node.scrollTop)
  await page.mouse.move(thumb!.x + thumb!.width / 2, thumb!.y + thumb!.height / 2)
  await page.mouse.down()
  await page.mouse.move(thumb!.x + thumb!.width / 2, thumb!.y + thumb!.height / 2 - 20, {
    steps: 4,
  })
  await page.mouse.up()
  await expect.poll(() => window.evaluate(node => node.scrollTop)).toBeLessThan(beforeDrag)
  await expect(window).not.toContainText('我会先查找相关说明，再检查页面布局。')
  await window.evaluate(node => {
    node.scrollTop = 0
  })
  await page.getByTestId('message-assistant').screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('processing-window-live.png'),
  })
  await page.getByTestId('fixture-process-finish').click()
  await expect(page.getByTestId('final-processing-toggle')).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  await expect(window).toHaveCount(0)
  await expect(page.getByTestId('assistant-message-content')).toContainText('最终回复：任务完成。')
  await expect(page.getByTestId('file-changes-card')).toBeVisible()
  await expect(page.getByTestId('final-processing-toggle')).toContainText('已处理')
  const finalCard = await page.getByTestId('file-changes-card').boundingBox()
  expect(finalCard!.width).toBeGreaterThan(areaBox!.width)
  await page.getByTestId('message-assistant').screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('processing-window-completed.png'),
  })
  await page.getByTestId('final-processing-toggle').click()
  await page.getByTestId('assistant-thinking-toggle').last().click()
  await expect(window).toBeVisible()
  expect(await window.evaluate(node => node.clientHeight)).toBe(initial.height)
  await page.getByTestId('fixture-process-settings').click()
  await page.getByTestId('general-processing-window-toggle').click()
  await page.getByTestId('fixture-process-back').click()
  await expect(page.getByTestId('final-processing-toggle')).toBeVisible()
  await page.getByTestId('fixture-process-new').click()
  await expect(page.getByTestId('processing-window')).toHaveCount(0)
})

test('completed groups settle while the current writing tool updates its own line counts', async ({
  page,
}, testInfo) => {
  await page.goto('/e2e/fixtures/reference-panels.html?panel=processing')
  await page.getByTestId('general-processing-window-toggle').click()
  await page.getByTestId('fixture-process-new').click()
  await page.getByTestId('fixture-write-prepare').click()
  const completed = page.getByTestId('final-processing-toggle')
  const active = page.getByTestId('processing-window-toggle')
  const narrative = page.getByText('检索已完成，现在写入文件。', { exact: true })
  const expectWritingChronology = async () => {
    await expect(completed).toHaveCount(1)
    await expect(completed).toHaveAttribute('aria-expanded', 'false')
    await expect(completed.locator('..').locator('.animate-spin')).toHaveCount(0)
    await expect(active).toHaveCount(1)
    await expect(narrative).toHaveCount(1)
    await expect
      .poll(() =>
        narrative.evaluate(node => {
          const previous = document
            .querySelector('[data-testid="final-processing-toggle"]')
            ?.closest('section')
          const following = document
            .querySelector('[data-testid="processing-window-toggle"]')
            ?.closest('section')
          return Boolean(
            previous &&
            following &&
            !previous.contains(node) &&
            !following.contains(node) &&
            (previous.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
            (node.compareDocumentPosition(following) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
          )
        })
      )
      .toBe(true)
  }
  await expectWritingChronology()
  await expect(active).toContainText('正在处理')
  const lines = page.locator('[data-testid="tool-line-progress"][data-tool-id="writer-live"]')
  await expect(lines).toContainText('+12')
  await expect(lines).toContainText('-3')
  await page.getByTestId('fixture-write-generate').click()
  await expect(lines).toContainText('+20')
  await expectWritingChronology()
  await page.getByTestId('fixture-write-start').click()
  await expect(lines).toHaveCount(1)
  await expect(lines).toContainText('+20')
  await expectWritingChronology()
  await page.getByTestId('fixture-write-update').click()
  await expect(lines).toContainText('+27')
  await expect(lines).toContainText('-4')
  await page.getByTestId('fixture-write-update').click()
  await expect(lines).toContainText('+34')
  await page.getByTestId('fixture-file-progress').click()
  await expect(lines).toContainText('+34')
  await expect(page.getByTestId('workspace-file-progress')).toHaveCount(0)
  await expect(page.getByTestId('file-changes-card')).toHaveCount(0)
  await completed.click()
  await expect(completed.locator('..').locator('.animate-spin')).toHaveCount(0)
  await page.getByTestId('message-assistant').screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('tool-lines-live.png'),
  })
  await page.getByTestId('fixture-process-finish').click()
  await expect(active).toHaveCount(0)
  await expect(page.getByTestId('final-processing-toggle')).toHaveCount(2)
  await expect(page.getByTestId('file-changes-card')).toBeVisible()
})

test('processing scrollbar stays inside the compact area across themes and narrow viewports', async ({
  page,
}, testInfo) => {
  await page.goto('/e2e/fixtures/reference-panels.html?panel=processing')
  await page.getByTestId('general-processing-window-toggle').click()
  await page.getByTestId('fixture-process-new').click()
  const viewport = page.getByTestId('processing-window-scroll')
  const scrollbar = page.getByTestId('processing-window-scrollbar')
  for (const dark of [false, true]) {
    await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark)
    for (const width of [900, 480]) {
      await page.setViewportSize({ width, height: 800 })
      await expect(scrollbar).toBeVisible()
      const area = await viewport.boundingBox()
      const track = await scrollbar.boundingBox()
      expect(area!.width).toBeLessThanOrEqual(560)
      expect(track!.x + track!.width).toBeLessThanOrEqual(area!.x + area!.width)
      expect(await viewport.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      const outer = page.getByTestId('fixture-process-page-scroll')
      const outerTop = await outer.evaluate(node => node.scrollTop)
      await viewport.evaluate(node => {
        node.scrollTop = 0
      })
      await scrollbar.hover()
      await page.mouse.wheel(0, 120)
      await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
      expect(await outer.evaluate(node => node.scrollTop)).toBe(outerTop)
      await scrollbar.focus()
      await scrollbar.press('Home')
      await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBe(0)
      await scrollbar.press('PageDown')
      await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
      await scrollbar.press('End')
      await expect
        .poll(() =>
          viewport.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)
        )
        .toBeLessThan(2)
      await page.getByTestId('message-assistant').screenshot({
        animations: 'disabled',
        path: testInfo.outputPath(`processing-${dark ? 'dark' : 'light'}-${width}.png`),
      })
    }
  }
})

for (const width of [1440, 900, 480]) {
  test(`reference pages match ordinary settings content and gutters at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto('/e2e/fixtures/reference-panels.html?panel=usage')
    const baseline = await page.getByTestId('usage-settings-page').boundingBox()
    expect(baseline).not.toBeNull()
    const metrics = await page.getByTestId('reference-settings-scroll').evaluate(node => {
      const style = getComputedStyle(node)
      return {
        left: parseFloat(style.paddingLeft),
        right: parseFloat(style.paddingRight),
      }
    })
    const maxWidth = await page
      .getByTestId('usage-settings-page')
      .evaluate(node => parseFloat(getComputedStyle(node).maxWidth))
    const baselineTitleSize = await page
      .getByTestId('usage-settings-page')
      .locator('h1')
      .evaluate(node => getComputedStyle(node).fontSize)
    const baselineTypeScale = await page.getByTestId('usage-settings-page').evaluate(node => {
      const style = getComputedStyle(node)
      return ['--text-xs', '--text-sm', '--text-base', '--text-lg', '--text-heading-md'].map(key =>
        style.getPropertyValue(key).trim()
      )
    })

    for (const theme of ['light', 'dark']) {
      for (const [panel, contentId, scrollId] of [
        ['provider', 'kcoder-provider-settings-page', 'reference-settings-scroll'],
        ['wiki', 'knowledge-content', 'knowledge-scroll'],
        ['plugins', 'kcoder-plugin-content', 'kcoder-plugin-scroll'],
        ['workflow', 'reference-workflow-dialog-content', 'reference-workflow-dialog'],
      ]) {
        await page.goto(`/e2e/fixtures/reference-panels.html?panel=${panel}&theme=${theme}`)
        const content = page.getByTestId(contentId)
        await expect(content).toBeVisible()
        const box = await content.boundingBox()
        expect(box).not.toBeNull()
        const pane = await page.getByTestId(scrollId).evaluate(node => {
          const style = getComputedStyle(node)
          return {
            x: node.getBoundingClientRect().x + node.clientLeft,
            width: node.clientWidth,
            left: parseFloat(style.paddingLeft),
            right: parseFloat(style.paddingRight),
            hasHorizontalOverflow: node.scrollWidth > node.clientWidth,
          }
        })
        expect(pane.left).toBe(metrics.left)
        expect(pane.right).toBe(metrics.right)
        const expectedWidth = Math.min(maxWidth, pane.width - metrics.left - metrics.right)
        expect(box!.width).toBeCloseTo(expectedWidth, 0)
        expect(box!.x - pane.x).toBeCloseTo((pane.width - expectedWidth) / 2, 0)
        expect(pane.hasHorizontalOverflow).toBe(false)
        const typeScale = await content.evaluate(node => {
          const style = getComputedStyle(node)
          return ['--text-xs', '--text-sm', '--text-base', '--text-lg', '--text-heading-md'].map(
            key => style.getPropertyValue(key).trim()
          )
        })
        expect(typeScale).toEqual(baselineTypeScale)
        const heading =
          panel === 'workflow'
            ? page.locator('#reference-workflow-dialog-title')
            : content.locator(panel === 'wiki' ? 'h2' : 'h1').first()
        expect(await heading.evaluate(node => getComputedStyle(node).fontSize)).toBe(
          baselineTitleSize
        )
        if (panel !== 'wiki') {
          expect((await heading.boundingBox())!.x).toBeCloseTo(box!.x, 0)
        }
        if (panel !== 'plugins' && panel !== 'workflow') {
          expect(box!.x).toBeCloseTo(baseline!.x, 0)
          expect(box!.width).toBeCloseTo(baseline!.width, 0)
        } else if (panel === 'workflow') {
          expect(box!.width).toBeLessThanOrEqual(baseline!.width)
          if (width >= 900) expect(box!.width).toBeCloseTo(baseline!.width, 0)
        }
        if (width !== 900) {
          await page.screenshot({
            animations: 'disabled',
            path: testInfo.outputPath(`${panel}-${theme}-${width}-aligned.png`),
          })
        }
      }
    }
  })
}

test('configuration pages follow the global appearance font size', async ({ page }) => {
  for (const fontSize of [11, 16]) {
    for (const [panel, contentId, headingSelector] of [
      ['usage', 'usage-settings-page', 'h1'],
      ['provider', 'kcoder-provider-settings-page', 'h1'],
      ['wiki', 'knowledge-content', 'h2'],
      ['plugins', 'kcoder-plugin-content', 'h1'],
      ['workflow', 'reference-workflow-dialog', 'h2'],
    ]) {
      await page.goto(`/e2e/fixtures/reference-panels.html?panel=${panel}&fontSize=${fontSize}`)
      const content = page.getByTestId(contentId)
      await expect(content).toBeVisible()
      const headingSize = await content
        .locator(headingSelector)
        .first()
        .evaluate(node => getComputedStyle(node).fontSize)
      expect(headingSize).toBe(`${Math.round((20 * fontSize) / 14)}px`)
      const helperSize = await content
        .locator('.text-sm')
        .first()
        .evaluate(node => getComputedStyle(node).fontSize)
      expect(helperSize).toBe(`${Math.round((13 * fontSize) / 14)}px`)
    }
  }
})

test('workflow reference sections retain readable two-column snapshots and native disclosure interaction', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1210, height: 1420 })
  await page.goto('/e2e/fixtures/reference-panels.html?panel=workflow')
  const section = page.getByTestId('workflow-static-coverage')
  await expect(section).toHaveAttribute('open', '')
  await expect(page.getByTestId('workflow-agent-model-configuration')).toBeVisible()
  await expect(page.getByTestId('workflow-verification')).not.toContainText(
    'synthetic-private-input'
  )
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('workflow-reference.png'),
  })
  await page.getByTestId('workflow-static-coverage-toggle').click()
  await expect(section).not.toHaveAttribute('open', '')
  await page.getByTestId('workflow-static-coverage-toggle').press('Enter')
  await expect(section).toHaveAttribute('open', '')
})

test('provider reference tabs and safe configuration download work in the real browser', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1124, height: 1375 })
  await page.goto('/e2e/fixtures/reference-panels.html?panel=provider')
  await expect(page.getByTestId('provider-effectiveSnapshot')).toBeVisible()
  await expect(page.getByTestId('provider-effectiveSnapshot')).toContainText('1,048,576')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  const { root } = await cdp.send('DOM.getDocument')
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'h1' })
  await writeFile(
    testInfo.outputPath('reference-fonts.json'),
    JSON.stringify(
      {
        computed: await page.locator('h1').evaluate(node => ({
          fontFamily: getComputedStyle(node).fontFamily,
          fontSize: getComputedStyle(node).fontSize,
        })),
        platform: await cdp.send('CSS.getPlatformFontsForNode', { nodeId }),
      },
      null,
      2
    )
  )
  await cdp.detach()
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('provider-reference.png'),
  })
  await page.getByTestId('provider-tab-effectiveNextTurn').click()
  await expect(page.getByTestId('provider-effectiveNextTurn')).toBeVisible()
  await expect(page.getByTestId('provider-effectiveSnapshot')).toBeHidden()
  const download = page.waitForEvent('download')
  await page.getByTestId('provider-export-configuration').click()
  const file = await download
  expect(file.suggestedFilename()).toBe('model-configuration.json')
  const stream = await file.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(chunk)
  const exported = Buffer.concat(chunks).toString('utf8')
  expect(exported).toContain('MiniMax-M3.1-Flash-Preview')
  expect(exported).not.toMatch(/apiKey|endpoint|example\.invalid/)
})

test('Wiki reference keeps upload controls, jobs and searchable rows within one page scroll', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1463, height: 1076 })
  await page.goto('/e2e/fixtures/reference-panels.html?panel=wiki')
  await expect(page.getByTestId('wiki-page-row-page-5')).toBeVisible()
  await expect(page.getByTestId('wiki-image-import-image-1')).toBeVisible()
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('wiki-reference.png') })
  await page.getByTestId('wiki-title-search').fill('SGLang')
  await expect(page.getByTestId('wiki-page-row-page-0')).toBeVisible()
  await expect(page.getByTestId('wiki-page-row-page-1')).toHaveCount(0)
  await page.getByTestId('wiki-page-actions-page-0').click()
  await expect(page.getByTestId('wiki-page-actions-page-0-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('wiki-page-actions-page-0')).toBeFocused()
  await page.setViewportSize({ width: 480, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
})

for (const pagination of ['cursor', 'oversized']) {
  test(`Wiki UI fixture paginates tabs independently with ${pagination} responses`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/e2e/fixtures/reference-panels.html?panel=wiki&wikiPagination=${pagination}`)
    const previous = page.getByTestId('wiki-content-previous')
    const next = page.getByTestId('wiki-content-next')
    const current = page.getByTestId('wiki-content-page')
    const expectRows = async (kind: 'page' | 'source', start: number, count: number) => {
      const rows = page.locator(`[data-testid^="wiki-${kind}-row-"]`)
      await expect(rows).toHaveCount(count)
      await expect(rows.first()).toHaveAttribute('data-testid', `wiki-${kind}-row-${kind}-${start}`)
      expect(
        await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')))
      ).toEqual(
        Array.from({ length: count }, (_, index) => `wiki-${kind}-row-${kind}-${start + index}`)
      )
    }
    const expectPage = async (number: number) => {
      await expect(current).toHaveText(new RegExp(`^第\\s*${number}\\s*页$`))
    }
    await expectRows('page', 0, 10)
    await expectPage(1)
    await expect(previous).toBeDisabled()
    await expect(next).toBeEnabled()
    await next.click()
    await expectRows('page', 10, 10)
    await expectPage(2)
    await page.getByTestId('knowledge-tab-sources').click()
    await expectRows('source', 0, 10)
    await expectPage(1)
    await expect(previous).toBeDisabled()
    await next.click()
    await expectRows('source', 10, 1)
    await expectPage(2)
    await expect(next).toBeDisabled()
    await page.getByTestId('knowledge-tab-pages').click()
    await expectRows('page', 10, 10)
    await expectPage(2)
    await next.click()
    await expectRows('page', 20, 1)
    await expectPage(3)
    await expect(next).toBeDisabled()
    await previous.click()
    await expectRows('page', 10, 10)
    await previous.click()
    await expectRows('page', 0, 10)
    await expectPage(1)
    await expect(previous).toBeDisabled()
    await page.getByTestId('knowledge-tab-sources').click()
    await expectRows('source', 10, 1)
    await expectPage(2)
    await previous.click()
    await expectRows('source', 0, 10)
    await expectPage(1)
    await current.scrollIntoViewIfNeeded()
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath(`wiki-pagination-${pagination}.png`),
      fullPage: true,
    })
  })
}

test('usage tables paginate independently for dates and models', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/reference-panels.html?panel=usage')
  await expect(page.getByTestId('usage-page-next')).toBeEnabled()
  await expect(page.locator('tbody tr')).toHaveCount(10)
  await page.getByTestId('usage-page-next').click()
  await expect(page.getByTestId('usage-page-number')).toContainText('2')
  await page.getByTestId('usage-view-models').click()
  await expect(page.getByTestId('usage-page-number')).toContainText('1')
  await page.getByTestId('usage-page-next').click()
  await page.getByTestId('usage-page-next').click()
  await expect(page.locator('tbody tr')).toHaveCount(3)
  await expect(page.getByTestId('usage-page-next')).toBeDisabled()
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('usage-pagination.png'),
    fullPage: true,
  })
  await page.getByTestId('usage-view-daily').click()
  await expect(page.getByTestId('usage-page-number')).toContainText('2')
})

test('plugin management reference supports search, all component tabs and confirmed changes', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1448, height: 1086 })
  await page.goto('/e2e/fixtures/reference-panels.html?panel=plugins')
  const row = page.getByTestId('kcoder-plugin-row-ai-websearch-expert@fixture-market')
  await expect(row).toBeVisible()
  await expect(page.getByTestId('kcoder-plugin-tab-skills')).toContainText('(7)')
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('plugins-reference.png'),
  })
  const search = page.getByTestId('kcoder-plugin-search')
  await search.fill('research')
  await expect(page.locator('[data-testid^="kcoder-plugin-row-"]')).toHaveCount(1)
  await search.fill('')
  const toggle = page.getByTestId('kcoder-plugin-toggle-ai-websearch-expert@fixture-market')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await page.getByTestId('kcoder-plugin-tab-skills').click()
  await expect(page.getByTestId('kcoder-skill-row')).toHaveCount(7)
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('skills-reference.png'),
  })
  await page.getByTestId('kcoder-plugin-tab-mcp').click()
  await expect(page.getByRole('heading', { name: 'research-search', exact: true })).toBeVisible()
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('mcp-reference.png') })
  await page.getByTestId('kcoder-plugin-tab-hooks').click()
  await expect(page.getByRole('heading', { name: 'UserPromptSubmit', exact: true })).toHaveCount(7)
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('hooks-reference.png'),
  })
  await page.getByTestId('kcoder-plugin-tab-plugins').click()
  await page.getByTestId('kcoder-plugin-uninstall-ai-websearch-expert@fixture-market').click()
  await expect(row).toBeVisible()
  await page
    .getByTestId('kcoder-plugin-confirm-uninstall-ai-websearch-expert@fixture-market')
    .click()
  await expect(row).toHaveCount(0)
  await page.setViewportSize({ width: 480, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
})
