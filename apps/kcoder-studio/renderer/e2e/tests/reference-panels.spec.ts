import { expect, test, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'

test('remote operation ID has clear spacing from its input', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/control-style-preview.html?panel=remote-operation')
  const input = page.getByTestId('remote-operation-id')
  await expect(input).toBeVisible({ timeout: 30000 })
  const label = page.getByText('原 operation ID', { exact: true })
  const labelBox = await label.boundingBox()
  const inputBox = await input.boundingBox()
  expect(labelBox).not.toBeNull()
  expect(inputBox).not.toBeNull()
  expect(inputBox!.y - (labelBox!.y + labelBox!.height)).toBe(8)
  await label.click()
  await expect(input).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('remote-operation-id-spacing.png'), fullPage: true })
})

test('scheduled task selector has no visible label and matches the title field', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/control-style-preview.html')
  const kind = page.getByTestId('scheduled-task-kind')
  const title = page.getByTestId('automation-title')
  await expect(kind).toBeVisible({ timeout: 30000 })
  await expect(title).toBeVisible()
  await expect(page.getByText('运行什么')).toHaveCount(0)
  await expect(kind).toHaveAccessibleName('运行什么')
  await page.evaluate(() => document.fonts.ready)

  const captureLayout = () => page.evaluate(() => {
    const kind = document.querySelector<HTMLElement>('[data-testid="scheduled-task-kind"]')!
    const title = document.querySelector<HTMLElement>('[data-testid="automation-title"]')!
    const kindSurface = kind.nextElementSibling as HTMLElement
    const kindRect = kindSurface.getBoundingClientRect()
    const titleRect = title.getBoundingClientRect()
    const kindStyle = getComputedStyle(kindSurface)
    const titleStyle = getComputedStyle(title)
    return {
      heights: [kindRect.height, titleRect.height],
      widths: [kindRect.width, titleRect.width],
      radii: [kindStyle.borderRadius, titleStyle.borderRadius],
      borders: [kindStyle.borderColor, titleStyle.borderColor],
    }
  })
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme)
    await expect.poll(async () => {
      const { borders } = await captureLayout()
      return borders[0] === borders[1]
    }).toBe(true)
    const layout = await captureLayout()
    for (const pair of [layout.heights, layout.widths, layout.radii, layout.borders]) {
      expect(pair[0]).toEqual(pair[1])
    }
    if (theme === 'light')
      await page.screenshot({ path: testInfo.outputPath('scheduled-task-field-alignment.png'), fullPage: true })
  }

  await kind.focus()
  await kind.press('Enter')
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.getByRole('listbox').getByRole('option', { name: '运行工作流' }).click()
  await expect(kind).toHaveValue('workflow')
  const workflow = page.getByTestId('scheduled-workflow-choice')
  await expect(workflow).toBeVisible()
  await expect(workflow).toHaveAccessibleName('选择已保存的工作流版本')
  await expect(page.locator('label').filter({ hasText: '选择已保存的工作流版本' })).toHaveCount(0)
  await expect(workflow.locator('xpath=following-sibling::span')).toContainText('选择已保存的工作流版本')
  const workflowSize = await workflow.boundingBox()
  const kindSize = await kind.boundingBox()
  expect(workflowSize?.height).toBe(kindSize?.height)
  expect(workflowSize?.width).toBe(kindSize?.width)
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await expect.poll(async () => {
    const { borders } = await captureLayout()
    return borders[0] === borders[1]
  }).toBe(true)
  await kind.evaluate(element => element.blur())
  await page.screenshot({ path: testInfo.outputPath('scheduled-workflow-no-label.png'), fullPage: true })
})

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

async function loadReferencePanel(page: Page, panel: string, readyTestId: string) {
  let networkChanged = false
  const onFailure = (request: import('@playwright/test').Request) => {
    if (request.failure()?.errorText === 'net::ERR_NETWORK_CHANGED') networkChanged = true
  }
  page.on('requestfailed', onFailure)
  try {
    await page.goto(`/e2e/fixtures/reference-panels.html?panel=${panel}`)
    try {
      await page.getByTestId(readyTestId).waitFor({ state: 'visible', timeout: 5000 })
    } catch (error) {
      if (!networkChanged) throw error
      // Only untouched bootstrap resources may be reloaded; never replay UI actions.
      await page.reload()
      await expect(page.getByTestId(readyTestId)).toBeVisible()
    }
  } finally {
    page.off('requestfailed', onFailure)
  }
}

for (const [windowed, newChat] of [[false, true], [false, false], [true, false]]) test(`waiting hands off to the first streamed reply without moving earlier messages (windowed=${windowed}, newChat=${newChat})`, async ({ page }) => {
  await loadReferencePanel(page, `waiting-transition${windowed ? '&windowed=1' : ''}${newChat ? '&newChat=1' : ''}`, 'thinking-indicator')
  const previous = page.locator('[data-message-id="history-17"]')
  await expect(previous).toBeVisible()
  const original = await previous.boundingBox()
  const originalWaiting = await page.getByTestId('thinking-indicator').boundingBox()
  expect(original).not.toBeNull()
  if (newChat) {
    await page.getByTestId('fixture-confirm-conversation').click()
    await expect(page.getByTestId('thinking-indicator')).toBeVisible()
    const confirmedWaiting = await page.getByTestId('thinking-indicator').boundingBox()
    expect(Math.abs(confirmedWaiting!.y - originalWaiting!.y)).toBeLessThanOrEqual(1)
  }
  await page.getByTestId('fixture-empty-stream').click()
  await expect(page.getByTestId('thinking-indicator')).toBeVisible()
  const empty = await previous.boundingBox()
  const streamingWaiting = await page.getByTestId('thinking-indicator').boundingBox()
  await page.getByTestId('fixture-first-response').click()
  await expect(page.locator('[data-message-id="response"]').getByText('第一段回复')).toBeVisible()
  const reply = await previous.boundingBox()
  expect(Math.abs(empty!.y - original!.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(reply!.y - original!.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(streamingWaiting!.y - originalWaiting!.y)).toBeLessThanOrEqual(1)
  if (!windowed) {
    const status = await page.getByTestId('processing-summary-header').boundingBox()
    expect(Math.abs(status!.y + status!.height / 2 - originalWaiting!.y - originalWaiting!.height / 2)).toBeLessThanOrEqual(1)
  }
})

for (const [windowed, newChat] of [[false, true], [false, false], [true, true]]) test(`waiting and thinking share a status line (windowed=${windowed}, newChat=${newChat})`, async ({ page }) => {
  await loadReferencePanel(page, `waiting-transition${windowed ? '&windowed=1' : ''}${newChat ? '&newChat=1' : ''}`, 'thinking-indicator')
  const textTop = (element: Element) => {
    const node = [...element.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim())!
    const range = document.createRange()
    range.selectNodeContents(node)
    return range.getBoundingClientRect().top
  }
  const waiting = await page.locator('.waiting-thinking-text').evaluate(textTop)
  await page.getByTestId('fixture-empty-stream').click()
  await expect(page.getByTestId('thinking-indicator')).toBeVisible()
  expect(Math.abs(await page.locator('.waiting-thinking-text').evaluate(textTop) - waiting)).toBeLessThanOrEqual(1)
  await page.getByTestId('fixture-first-thinking').click()
  await expect(page.getByTestId('assistant-thinking-toggle')).toBeVisible()
  const thinking = await page.getByTestId('assistant-thinking-toggle').evaluate(textTop)
  expect(Math.abs(thinking - waiting), 'thinking must replace waiting on the same text baseline').toBeLessThanOrEqual(1)
})

async function pauseComposerMotion(page: Page) {
  await page.addInitScript(() => {
    const animate = Element.prototype.animate
    Element.prototype.animate = function (frames, options) {
      const motion = animate.call(this, frames, options)
      if (this.matches('[data-composer-exit-visual], [data-testid="project-chat-composer-form"]')) {
        motion.pause()
        motion.currentTime = 100
      }
      return motion
    }
  })
}

test('task details use aligned tables for original records and empty observations', async ({ page }, testInfo) => {
  for (const empty of [false, true]) {
    await loadReferencePanel(page, `task-details${empty ? '&emptyTaskDetails=1' : ''}`, 'native-task-workspace')
    await page.getByText('直接选择任务', { exact: true }).click()
    await page.getByTestId('task-workspace-thread-select').selectOption(JSON.stringify(['thread-one', '/fixture']))
    const tables = ['task-workspace-related-table', 'task-workspace-artifacts-table', 'task-workspace-interactions-table']
    for (const id of tables) await expect(page.getByTestId(id)).toBeVisible()
    const widths = await Promise.all(tables.map(id => page.getByTestId(id).evaluate(table => table.parentElement!.parentElement!.getBoundingClientRect().width)))
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1)
    await expect(page.getByTestId('task-workspace-related-table').locator('tbody tr')).toHaveCount(empty ? 1 : 2)
    await expect(page.getByTestId('task-workspace-artifacts-table').locator('tbody tr')).toHaveCount(empty ? 1 : 2)
    await page.getByRole('region', { name: '关联工作', exact: true }).evaluate(node => node.scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: testInfo.outputPath(`task-detail-tables-${empty ? 'empty' : 'records'}.png`) })
  }
})

test('selecting a task scrolls only its own panel and keeps the application frame in place', async ({ page }, testInfo) => {
  await loadReferencePanel(page, 'task-details&taskScrollFrame=1', 'native-task-workspace')
  await page.evaluate(() => document.fonts.ready)
  const header = page.getByTestId('fixture-task-header'), sidebar = page.getByTestId('fixture-task-sidebar')
  const before = [await header.boundingBox(), await sidebar.boundingBox()]
  await page.getByTestId('task-board-list-row').getByRole('button').first().click()
  await expect(page.getByTestId('task-workspace-related-table')).toBeVisible()
  const panel = page.getByTestId('native-task-workspace')
  await expect.poll(() => panel.evaluate(root => {
    const anchor = root.querySelector<HTMLElement>('[data-testid="task-workspace-details-anchor"]')!
    const top = Math.max(0, Math.min(root.scrollHeight - root.clientHeight,
      root.scrollTop + anchor.getBoundingClientRect().top - root.getBoundingClientRect().top - 16))
    return Math.abs(root.scrollTop - top)
  })).toBeLessThan(1)
  expect(await panel.evaluate(root => root.scrollTop)).toBeGreaterThan(0)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  const after = [await header.boundingBox(), await sidebar.boundingBox()]
  expect(after[0]!.y).toBe(before[0]!.y)
  expect(after[1]!.y).toBe(before[1]!.y)
  await page.screenshot({ path: testInfo.outputPath('task-selection-frame-preserved.png') })
})

async function finishComposerMotion(page: Page) {
  await page.evaluate(() => {
    for (const node of document.querySelectorAll('[data-composer-exit-visual], [data-testid="project-chat-composer-form"]'))
      for (const motion of node.getAnimations()) motion.finish()
  })
}

test('composer loading fades removed controls without resizing the editor or hiding models', async ({ page }, testInfo) => {
  await pauseComposerMotion(page)
  await loadReferencePanel(page, 'composer-transition', 'execution-mode-button')
  const model = page.getByTestId('model-selector-button')
  await expect(model).toBeVisible()
  await expect(model).toBeDisabled()
  const editor = page.getByTestId('chat-message-input')
  await editor.fill('保留新输入的草稿')
  await editor.focus()
  const before = await page.getByTestId('project-chat-composer-form').boundingBox()
  const modelNode = await model.elementHandle()
  await page.getByTestId('fixture-composer-ready').evaluate(button => button.click())
  await expect(page.getByTestId('execution-mode-button')).toHaveCount(0)
  const visuals = page.locator('[data-composer-exit-visual]')
  await expect(visuals).toHaveCount(2)
  for (const visual of await visuals.all()) {
    const opacity = await visual.evaluate(node => Number(getComputedStyle(node).opacity))
    expect(opacity).toBeGreaterThan(0)
    expect(opacity).toBeLessThan(1)
    await expect(visual).toHaveAttribute('inert', '')
    await expect(visual.locator('[data-testid], [id]')).toHaveCount(0)
  }
  const after = await page.getByTestId('project-chat-composer-form').boundingBox()
  expect(Math.abs(after!.height - before!.height)).toBeLessThan(1)
  expect(await modelNode!.evaluate(node => node === document.querySelector('[data-testid="model-selector-button"]'))).toBe(true)
  await expect(model).toBeEnabled()
  await expect(editor).toBeFocused()
  await expect(editor).toHaveText('保留新输入的草稿')
  await page.screenshot({ path: testInfo.outputPath('composer-loading-mid-transition.png') })
  await finishComposerMotion(page)
  await expect(visuals).toHaveCount(0)
})

test('composer first-message handoff fades its header and retains the model trigger while running', async ({ page }, testInfo) => {
  await pauseComposerMotion(page)
  await loadReferencePanel(page, 'composer-transition', 'execution-mode-button')
  await page.getByTestId('fixture-composer-ready').click()
  await expect(page.getByTestId('model-selector-button')).toBeEnabled()
  await finishComposerMotion(page)
  await expect(page.locator('[data-composer-exit-visual]')).toHaveCount(0)
  await page.getByTestId('fixture-composer-start').click()
  await expect(page.getByTestId('composer-project-context')).toHaveCount(0)
  const header = page.locator('[data-composer-exit-visual]')
  await expect(header).toHaveCount(1)
  const opacity = await header.evaluate(node => Number(getComputedStyle(node).opacity))
  expect(opacity).toBeGreaterThan(0)
  expect(opacity).toBeLessThan(1)
  await expect(page.getByTestId('pause-response-button')).toBeVisible()
  const model = page.getByTestId('model-selector-button')
  await expect(model).toBeVisible()
  await expect(model).toBeDisabled()
  const bounds = await model.boundingBox()
  const modelNode = await model.elementHandle()
  await page.screenshot({ path: testInfo.outputPath('composer-handoff-mid-transition.png') })
  await page.getByTestId('fixture-composer-model-ready').click()
  await expect(model).toBeEnabled()
  expect(await modelNode!.evaluate(node => node === document.querySelector('[data-testid="model-selector-button"]'))).toBe(true)
  const loaded = await model.boundingBox()
  expect(loaded!.height).toBe(bounds!.height)
  expect(loaded!.x).toBe(bounds!.x)
  await expect(header).toHaveCount(1)
  await finishComposerMotion(page)
  await expect(header).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('composer-running-model-ready.png') })
})

for (const variant of ['desktop', 'compact']) {
  test(`input history restores drafts and fences conversations (${variant})`, async ({
    page,
  }, testInfo) => {
    await loadReferencePanel(page, `input-history&variant=${variant}`, 'chat-message-input')
    const editor = page.getByTestId('chat-message-input')
    const draft = page.getByTestId('fixture-history-draft')
    await editor.click()
    await editor.press('End')
    await editor.press('ArrowUp')
    await expect(draft).toHaveText('第二条输入\n保留换行')
    await editor.press('ArrowUp')
    await expect(draft).toHaveText('第一条输入 中文🙂')
    await editor.press('ArrowDown')
    await expect(draft).toHaveText('第二条输入\n保留换行')
    await editor.press('ArrowDown')
    await expect(draft).toHaveText('未发送的草稿')
    await editor.press('Control+a')
    await editor.pressSequentially('刚刚发送的内容')
    await editor.press('Enter')
    await expect(page.getByTestId('fixture-history-sent')).toHaveText('1')
    await editor.press('ArrowUp')
    await expect(draft).toHaveText('刚刚发送的内容')
    await page.getByTestId('fixture-history-switch').click()
    await editor.click()
    await editor.press('ArrowDown')
    await expect(draft).toBeEmpty()
    await editor.press('ArrowUp')
    await expect(draft).toHaveText('其他会话的输入')
    await page.screenshot({ path: testInfo.outputPath(`input-history-${variant}.png`) })
  })
}

test('input history never restores another conversation draft even when editor text is unchanged', async ({
  page,
}) => {
  await loadReferencePanel(page, 'input-history', 'chat-message-input')
  const editor = page.getByTestId('chat-message-input')
  const draft = page.getByTestId('fixture-history-draft')
  await editor.click()
  await editor.press('End')
  await editor.press('ArrowUp')
  await expect(draft).toHaveText('第二条输入\n保留换行')
  await page.getByTestId('fixture-history-switch-keep').click()
  await editor.click()
  await editor.press('ArrowDown')
  await expect(draft).toHaveText('第二条输入\n保留换行')
  await editor.press('Control+Home')
  await editor.press('ArrowUp')
  await expect(draft).toHaveText('其他会话的输入')
})

test('input history preserves visual-row navigation, modifiers, IME and slash menus', async ({
  page,
}) => {
  await loadReferencePanel(page, 'input-history', 'chat-message-input')
  const editor = page.getByTestId('chat-message-input')
  const draft = page.getByTestId('fixture-history-draft')
  await editor.fill('第一行')
  await editor.press('End')
  await editor.press('Shift+Enter')
  await editor.pressSequentially('第二行')
  await editor.press('ArrowUp')
  await expect(draft).toHaveText('第一行\n第二行')
  await editor.press('ArrowUp')
  await expect(draft).toHaveText('第二条输入\n保留换行')
  await editor.press('ArrowDown')
  await expect(draft).toHaveText('第一行\n第二行')
  await page.getByTestId('fixture-history-width').evaluate(node => {
    node.style.width = '260px'
  })
  const wrapped = 'wrapped-content-'.repeat(30)
  await editor.fill(wrapped)
  await editor.press('End')
  await editor.press('ArrowUp')
  await expect(draft).toHaveText(wrapped)
  await editor.fill('保留当前草稿')
  await editor.press('Control+ArrowUp')
  await editor.press('Shift+ArrowUp')
  await expect(draft).toHaveText('保留当前草稿')
  await editor.press('End')
  await editor.dispatchEvent('keydown', { key: 'ArrowUp', isComposing: true })
  await expect(draft).toHaveText('保留当前草稿')
  await editor.fill('/')
  await editor.press('ArrowUp')
  await expect(draft).toHaveText('/')
  await expect(page.getByTestId('fixture-history-sent')).toHaveText('0')
})

test('desktop sidebar toggle remains visible through page-control changes and compact widths', async ({
  page,
}, testInfo) => {
  await loadReferencePanel(page, 'desktop-sidebar', 'desktop-brand-chrome')
  const chrome = page.getByTestId('desktop-brand-chrome')
  for (const width of [1280, 640, 390]) {
    await page.setViewportSize({ width, height: 800 })
    for (let pageChange = 0; pageChange < 2; pageChange++) {
      const toggle = chrome.getByTestId('desktop-titlebar-sidebar-toggle')
      await expect(toggle).toHaveCount(1)
      await expect(toggle).toBeInViewport()
      await expect(toggle).toHaveCSS('transition-duration', '0.15s')
      await toggle.click()
      await expect.poll(() =>
        page.evaluate(() => localStorage.getItem('kcoder.desktop.sidebar.collapsed'))
      ).toBe('true')
      await toggle.click()
      await page.getByTestId('fixture-change-page-controls').click()
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(chrome.getByTestId('desktop-titlebar-sidebar-toggle')).toHaveCSS(
    'transition-property',
    /transform/
  )
  await chrome.screenshot({ path: testInfo.outputPath('persistent-sidebar-toggle.png') })
})

async function installWidgetSandbox(page: Page) {
  const document = await readFile(
    new URL('../../public/widget-sandbox/host-v1.html', import.meta.url),
    'utf8'
  )
  const policy = JSON.parse(
    await readFile(new URL('../../public/widget-sandbox/policy-v1.json', import.meta.url), 'utf8')
  )
  await page.route('**/api/widgets/sandbox-v1.html', route =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: document,
      headers: { 'Content-Security-Policy': policy.csp, 'Cache-Control': 'no-store' },
    })
  )
}

test('model-independent conversation widgets show process status and expand final artifacts once with history state preserved', async ({
  page,
}, testInfo) => {
  await installWidgetSandbox(page)
  await page.setViewportSize({ width: 1280, height: 1000 })
  await loadReferencePanel(page, 'widgets', 'widget-fixture-prefix')
  await page.getByTestId('widget-fixture-prefix').click()
  await expect(page.getByTestId('widget-deferred-status').first()).toBeVisible()
  await expect(page.getByTestId('widget-svg-prefix')).toHaveCount(0)
  await expect(page.getByTestId('widget-chart-checkpoint')).toHaveCount(0)
  await page.getByTestId('widget-fixture-prefix').click()
  await expect(page.getByTestId('widget-svg-prefix')).toHaveCount(0)
  await expect(page.getByTestId('inline-widget-frame')).toHaveCount(0)
  await page.getByTestId('widget-fixture-commit').click()
  await expect
    .poll(async () =>
      Number(await page.getByTestId('widget-fixture-active-receipts').textContent())
    )
    .toBeGreaterThan(0)
  await expect(
    page.locator('[data-testid=inline-widget]:not([aria-hidden=true]) iframe')
  ).toHaveCount(0)
  await expect(page.getByTestId('widget-svg-prefix')).toHaveCount(0)
  await page.screenshot({
    path: testInfo.outputPath('conversation-widgets-process-status-only.png'),
  })
  await page.getByTestId('widget-fixture-complete').click()
  const overview = page.getByTestId('inline-widget').filter({ hasText: '可视化类型' })
  await expect(overview).toHaveAttribute('data-widget-status', 'ready')
  await expect(
    page.locator('[data-testid="inline-widget"][data-widget-id="w-0"]:not([aria-hidden=true])')
  ).toHaveCount(1)
  const overviewFrame = page.frameLocator('iframe[title="可视化类型"]')
  await overview.screenshot({ path: testInfo.outputPath('conversation-overview.png') })
  await overviewFrame.locator('[data-kcoder-prompt]').first().click()
  await expect(page.getByTestId('widget-fixture-draft')).toHaveValue(
    '保留已有草稿\n画一个检索流程图'
  )
  const chart = page.getByTestId('inline-widget').filter({ hasText: '季度营收与同比增速' })
  await chart.scrollIntoViewIfNeeded()
  await expect(chart).toHaveAttribute('data-widget-status', 'ready')
  await expect(
    page.locator('[data-testid="inline-widget"][data-widget-id="w-1"]:not([aria-hidden=true])')
  ).toHaveCount(1)
  const chartFrame = page.frameLocator('iframe[title="季度营收与同比增速"]')
  await expect(chartFrame.locator('canvas')).toHaveCount(1)
  await chart.screenshot({ path: testInfo.outputPath('conversation-revenue.png') })
  const compound = page.getByTestId('inline-widget').filter({ hasText: '复利试算器' })
  await compound.scrollIntoViewIfNeeded()
  await expect(compound).toHaveAttribute('data-widget-status', 'ready')
  await expect(
    page.locator('[data-testid="inline-widget"][data-widget-id="w-2"]:not([aria-hidden=true])')
  ).toHaveCount(1)
  const calculator = page.frameLocator('iframe[title="复利试算器"]')
  const total = calculator.locator('output').first()
  expect(Number(await total.getAttribute('data-value'))).toBeCloseTo(991279.658373168, 6)
  await calculator.locator('input[type="range"]').nth(2).focus()
  await page.keyboard.press('ArrowRight')
  await expect(calculator.locator('input[type="number"]').nth(2)).toHaveValue('8')
  expect(Number(await total.getAttribute('data-value'))).toBeCloseTo(1075538.4293348873, 6)
  const frame = compound.getByTestId('inline-widget-frame')
  await frame.evaluate(element => element.setAttribute('data-stability-marker', 'unchanged'))
  await page
    .getByTestId('widget-fixture-delta')
    .evaluate(element => (element as HTMLButtonElement).click())
  await expect(frame).toHaveAttribute('data-stability-marker', 'unchanged')
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage)
          .filter(key => key.startsWith('kcoder-studio:widget-ui-v1:'))
          .some(key => {
            try {
              return JSON.parse(localStorage.getItem(key)!).state?.savings?.years === 8
            } catch {
              return false
            }
          })
      )
    )
    .toBe(true)
  await compound.screenshot({ path: testInfo.outputPath('conversation-compound.png') })
  await page.screenshot({
    path: testInfo.outputPath('conversation-widgets-completed.png'),
    fullPage: true,
  })
  await loadReferencePanel(page, 'widgets&history=1', 'widget-fixture-scroll')
  const restored = page.getByTestId('inline-widget').filter({ hasText: '复利试算器' })
  await restored.scrollIntoViewIfNeeded()
  await expect(restored).toHaveAttribute('data-widget-status', 'ready')
  await expect(
    page.frameLocator('iframe[title="复利试算器"]').locator('input[type="number"]').nth(2)
  ).toHaveValue('8')
})

test('model-independent widget generation stays text-only and only a completed final reply opens one widget', async ({
  page,
}, testInfo) => {
  await installWidgetSandbox(page)
  await page.goto('/e2e/fixtures/reference-panels.html?panel=widgets&singleWidget=1')
  const assertDeferred = async () => {
    await expect(page.getByTestId('widget-deferred-status').first()).toBeVisible()
    await expect(page.getByTestId('widget-svg-prefix')).toHaveCount(0)
    await expect(page.getByTestId('widget-chart-checkpoint')).toHaveCount(0)
    await expect(page.locator('[data-testid="inline-widget"]:not([aria-hidden=true])')).toHaveCount(
      0
    )
  }
  for (const outcome of ['fail', 'cancel', 'unknown', 'complete']) {
    await page.goto('/e2e/fixtures/reference-panels.html?panel=widgets&singleWidget=1')
    await page.getByTestId('widget-fixture-prefix').click()
    await assertDeferred()
    await page.getByTestId('widget-fixture-commit').click()
    await expect
      .poll(async () =>
        Number(await page.getByTestId('widget-fixture-active-receipts').textContent())
      )
      .toBeGreaterThan(0)
    await assertDeferred()
    await page.getByTestId(`widget-fixture-${outcome}`).click()
    if (outcome === 'complete') {
      await expect(
        page.locator('[data-testid="inline-widget"]:not([aria-hidden=true])')
      ).toHaveCount(1)
      await expect(page.getByTestId('inline-widget')).toHaveAttribute('data-widget-status', 'ready')
      await expect(page.frameLocator('iframe[title="可视化类型"]').locator('svg')).toHaveCount(1)
      await page.screenshot({ path: testInfo.outputPath('final-only-completed-one-widget.png') })
    } else {
      await expect(page.getByTestId('widget-first-frame-probe')).toHaveCount(0)
      await expect(
        page.locator('[data-testid="inline-widget"]:not([aria-hidden=true])')
      ).toHaveCount(0)
      await expect(page.getByTestId('widget-svg-prefix')).toHaveCount(0)
      await expect(page.getByTestId('widget-chart-checkpoint')).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath(`final-only-${outcome}-not-expanded.png`) })
    }
  }
})

test('Studio work mode keeps the blank composer and office suggestions contained', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await loadReferencePanel(page, 'work-mode', 'chat-message-input')
  const composer = page.getByTestId('chat-message-input')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = 'false'
  })
  const composerNode = await composer.elementHandle()
  const composerBefore = await composer.boundingBox()
  const highlight = page.getByTestId('studio-work-mode-highlight')
  await highlight.evaluate(element => {
    element.addEventListener('transitionrun', event => {
      element.setAttribute('data-observed-transition', (event as TransitionEvent).propertyName)
    })
    element.addEventListener('transitionend', event => {
      element.setAttribute('data-observed-transition-end', (event as TransitionEvent).propertyName)
    })
  })
  await page.getByRole('heading').evaluate(element => {
    element.addEventListener('animationstart', () => {
      element.setAttribute('data-observed-content-animation', 'true')
    })
  })
  await expect(composer).toHaveValue('保留草稿')
  await composer.fill('资料整理草稿，先保留附件和模型选择')
  await page.getByRole('button', { name: 'KWorker', exact: true }).click()
  await expect(page.getByRole('button', { name: 'KWorker', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.getByRole('heading', { name: '今天有什么工作需要帮忙？' })).toBeVisible()
  await expect(highlight).toHaveAttribute('data-observed-transition', 'transform')
  await expect(highlight).toHaveAttribute('data-observed-transition-end', 'transform')
  await expect(page.getByRole('heading')).toHaveAttribute('data-observed-content-animation', 'true')
  await expect(page.getByRole('button', { name: 'KWorker', exact: true })).toBeFocused()
  expect(
    await composerNode!.evaluate(
      element => element === document.querySelector('[data-testid="chat-message-input"]')
    )
  ).toBe(true)
  const composerAfter = await composer.boundingBox()
  expect(composerAfter?.y).toBeCloseTo(composerBefore!.y, 0)
  expect(composerAfter?.width).toBeCloseTo(composerBefore!.width, 0)
  expect(composerAfter?.height).toBeCloseTo(composerBefore!.height, 0)
  await expect(page.getByTestId('task-suggestion-category-documents')).toBeVisible()
  await expect(composer).toHaveValue('资料整理草稿，先保留附件和模型选择')
  await page.screenshot({ path: testInfo.outputPath('kworker-home.png'), fullPage: true })
  await page.getByTestId('task-suggestion-category-documents').click()
  await page.getByTestId('task-suggestion-documents-organize').click()
  await expect(composer).toHaveValue(
    /^请整理我提供的文件或指定目录[\s\S]*执行：[\s\S]*交付：[\s\S]*验收：/
  )
  const selectedPrompt = await composer.inputValue()
  await page.getByRole('button', { name: 'KCoder', exact: true }).click()
  await expect(page.getByTestId('task-suggestion-category-explore')).toBeVisible()
  await expect(composer).toHaveValue(selectedPrompt)
  await page.setViewportSize({ width: 600, height: 800 })
  await page.getByRole('button', { name: 'KWorker', exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'KCoder', exact: true }).click()
  expect(
    await highlight.evaluate(element => getComputedStyle(element).transitionDuration)
  ).not.toBe('0s')
  expect(
    await page
      .getByRole('heading')
      .locator('span')
      .first()
      .evaluate(element => getComputedStyle(element).animationName)
  ).not.toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = 'true'
  })
  await page.getByRole('button', { name: 'KWorker', exact: true }).click()
  expect(
    await highlight.evaluate(element => getComputedStyle(element).transitionDuration)
  ).not.toBe('0s')
  expect(
    await page
      .getByRole('heading')
      .locator('span')
      .first()
      .evaluate(element => getComputedStyle(element).animationName)
  ).not.toBe('none')
  await page.getByTestId('fixture-mode-settings').click()
  const visualization = page.getByTestId('general-inline-widgets-toggle')
  await expect(visualization).toHaveAttribute('aria-checked', 'true')
  await visualization.click()
  await expect(visualization).toHaveAttribute('aria-checked', 'false')
  expect(await page.evaluate(() => localStorage.getItem('kcoder-studio:inline-widgets-v1'))).toBe(
    'false'
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
  await expect(page.getByTestId('assistant-thinking-icon').last()).toBeVisible()
  const liveDuration = page.getByTestId('thinking-duration').last()
  const initialDuration = await liveDuration.textContent()
  await expect(liveDuration).not.toHaveText(initialDuration!)
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
  await page.getByTestId('fixture-text-append').click()
  await expect(window).toContainText('正在汇总检查结果')
  await expect(page.getByTestId('assistant-message-content')).toHaveCount(0)
  await page.getByTestId('fixture-text-append').click()
  await expect(page.getByTestId('processing-group')).toHaveCount(1)
  expect(await outer.evaluate(node => node.scrollHeight)).toBe(outerHeight)
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
  expect(areaBox!.width).toBeCloseTo(messageBox!.width, 0)
  expect(scrollbarBox!.x + scrollbarBox!.width).toBeLessThanOrEqual(areaBox!.x + areaBox!.width)
  await window.evaluate(node => {
    node.scrollTop = node.scrollHeight
  })
  await expect
    .poll(async () =>
      Number(await page.getByTestId('processing-window-scrollbar').getAttribute('aria-valuenow'))
    )
    .toBeGreaterThan(0)
  const thumb = await page.getByTestId('processing-window-thumb').boundingBox()
  const beforeDrag = await window.evaluate(node => node.scrollTop)
  await page.mouse.move(thumb!.x + thumb!.width / 2, thumb!.y + thumb!.height / 2)
  await page.mouse.down()
  await page.mouse.move(thumb!.x + thumb!.width / 2, thumb!.y + thumb!.height / 2 - 20, {
    steps: 4,
  })
  await page.mouse.up()
  await expect.poll(() => window.evaluate(node => node.scrollTop)).toBeLessThan(beforeDrag)
  await expect(window).toContainText('我会先查找相关说明，再检查页面布局。')
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
  expect(finalCard!.width).toBeCloseTo(messageBox!.width, 0)
  await page.getByTestId('message-assistant').screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('processing-window-completed.png'),
  })
  await page.getByTestId('final-processing-toggle').click()
  await page.getByTestId('assistant-thinking-toggle').last().click()
  await expect(window).toBeVisible()
  await expect(window).toContainText('正在汇总检查结果')
  await expect(window).not.toContainText('最终回复：任务完成。')
  expect(await window.evaluate(node => node.clientHeight)).toBe(initial.height)
  await page.getByTestId('fixture-process-settings').click()
  await page.getByTestId('general-processing-window-toggle').click()
  await page.getByTestId('fixture-process-back').click()
  await expect(page.getByTestId('final-processing-toggle')).toBeVisible()
  await page.getByTestId('fixture-process-new').click()
  await expect(page.getByTestId('processing-window')).toHaveCount(0)
})

test('intermediate prose and live tool counts share one activity window', async ({
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
    await expect(completed).toHaveCount(0)
    await expect(active).toHaveCount(1)
    await expect(page.getByTestId('processing-group')).toHaveCount(1)
    await expect(narrative).toHaveCount(1)
    await expect(page.getByTestId('processing-window-scroll')).toContainText(
      '检索已完成，现在写入文件。'
    )
    await expect
      .poll(() =>
        narrative.evaluate(node => {
          const tool = document.querySelector('[data-processing-block-id="writer-live"]')
          return Boolean(
            tool && (node.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
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
  await expect(page.getByTestId('processing-window-scroll')).toContainText(
    '检索已完成，现在写入文件。'
  )
  await page.getByTestId('message-assistant').screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('tool-lines-live.png'),
  })
  await page.getByTestId('fixture-process-finish').click()
  await expect(active).toHaveCount(0)
  await expect(page.getByTestId('final-processing-toggle')).toHaveCount(1)
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
      const message = await page.getByTestId('message-assistant').boundingBox()
      expect(area!.width).toBeCloseTo(message!.width, 0)
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
    await loadReferencePanel(page, 'usage', 'usage-settings-page')
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
        ['workflow', 'workflow-settings-dialog-content', 'workflow-settings-dialog'],
      ]) {
        await loadReferencePanel(page, `${panel}&theme=${theme}`, contentId)
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
        if (panel !== 'workflow') {
          expect(pane.left).toBe(metrics.left)
          expect(pane.right).toBe(metrics.right)
        }
        const expectedWidth = Math.min(maxWidth, pane.width - pane.left - pane.right)
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
            ? page.locator('#workflow-settings-dialog-title')
            : content.locator(panel === 'wiki' ? 'h2' : 'h1').first()
        expect(await heading.evaluate(node => getComputedStyle(node).fontSize)).toBe(
          panel === 'wiki' ? '24px' : baselineTitleSize
        )
        if (panel !== 'wiki') {
          expect((await heading.boundingBox())!.x).toBeCloseTo(box!.x, 0)
        }
        if (panel !== 'workflow') {
          expect(box!.x).toBeCloseTo(baseline!.x, 0)
          expect(box!.width).toBeCloseTo(baseline!.width, 0)
        } else if (panel === 'workflow') {
          expect(box!.width).toBeLessThanOrEqual(baseline!.width)
          if (width >= 1120) expect(box!.width).toBeCloseTo(baseline!.width, 0)
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
      ['workflow', 'workflow-settings-dialog', 'h2'],
    ]) {
      await loadReferencePanel(page, `${panel}&fontSize=${fontSize}`, contentId)
      const content = page.getByTestId(contentId)
      await expect(content).toBeVisible()
      const headingSize = await content
        .locator(headingSelector)
        .first()
        .evaluate(node => getComputedStyle(node).fontSize)
      expect(headingSize).toBe(`${Math.round(((panel === 'wiki' ? 24 : 20) * fontSize) / 14)}px`)
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
  await loadReferencePanel(page, 'workflow', 'workflow-static-coverage')
  const section = page.getByTestId('workflow-static-coverage')
  await expect(section).not.toHaveAttribute('open', '')
  await page.getByTestId('workflow-static-coverage-toggle').click()
  await page
    .getByTestId('workflow-model-evidence-workflow-4b225af-71ce-4a25-8975-f47ba6e5d0bf-toggle')
    .click()
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

test('workflow settings match the compact reference with independently usable sections', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1120, height: 730 })
  await loadReferencePanel(page, 'workflow&workflowSummary=1', 'workflow-settings-dialog')
  const dialog = page.getByTestId('workflow-settings-dialog')
  const staticSection = page.getByTestId('workflow-static-coverage')
  const capacity = page.getByTestId('workflow-library-capacity')
  const management = page.getByTestId('workflow-management')
  await expect(staticSection).not.toHaveAttribute('open', '')
  await expect(capacity).not.toHaveAttribute('open', '')
  await expect(management).not.toHaveAttribute('open', '')
  await expect(page.getByTestId('workflow-prepare-verification')).toBeVisible()
  await expect(page.getByTestId('workflow-settings-done')).toBeVisible()
  const image = testInfo.outputPath('workflow-settings.png')
  await dialog
    .locator('button')
    .first()
    .evaluate(element => (element as HTMLElement).blur())
  await page.screenshot({ path: image, animations: 'disabled' })
  await page.getByTestId('workflow-static-coverage-toggle').click()
  await expect(staticSection).toHaveAttribute('open', '')
  await page.getByTestId('workflow-capacity-toggle').click()
  await expect(capacity).toHaveAttribute('open', '')
  await page.getByTestId('workflow-management-toggle').click()
  await expect(management).toHaveAttribute('open', '')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
})

for (const theme of ['light', 'dark']) {
  test(`Wiki busy refusal can reload without replaying writes in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 844 })
    await loadReferencePanel(page, `wiki&wikiBusy=1&theme=${theme}`, 'knowledge-space-hero')
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('知识服务当前繁忙，请稍后重试。')
    await expect(alert).not.toContainText('检查当前目标连接')
    await expect(page.getByTestId('knowledge-organization-enabled')).toBeDisabled()
    await alert.getByText('查看详细原因').click()
    await expect(alert.getByText('knowledge service is busy')).toBeVisible()
    await alert.getByRole('button', { name: '重新加载' }).click()
    await expect(page.getByTestId('knowledge-library-picker')).toBeVisible()
    await expect(alert).toHaveCount(0)
    await expect(page.getByTestId('knowledge-organization-enabled')).toBeEnabled()
    await expect(page.getByTestId('knowledge-organization-enabled')).toHaveAttribute('aria-checked', 'true')
    const probe = await page.evaluate(() =>
      (window as Window & { wikiBusyProbe?: { statusReads: number; operations: string[] } }).wikiBusyProbe
    )
    expect(probe?.statusReads).toBe(2)
    expect(probe?.operations).not.toContain('knowledge/configure')
    expect(probe?.operations.some(method => /import|create|start|resume|update/.test(method))).toBe(false)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test('Wiki and memory cards align and transitions retain the unsent draft', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1440, height: 1050 })
  await loadReferencePanel(page, 'wiki&memoryPreview=1', 'knowledge-space-hero')
  const hero = page.getByTestId('knowledge-space-hero')
  const importCard = page.getByTestId('knowledge-import-card')
  await expect(importCard).toBeVisible()
  await expect(hero.getByTestId('knowledge-refresh')).toHaveCount(0)
  const library = await page.evaluate(() => {
    const hero = document.querySelector<HTMLElement>('[data-testid="knowledge-space-hero"]')!
    const card = document.querySelector<HTMLElement>('[data-testid="knowledge-import-card"]')!
    const sw = document.querySelector<HTMLElement>('[data-testid="knowledge-retrieval-enabled"]')!
    const a = hero.getBoundingClientRect(),
      b = card.getBoundingClientRect(),
      c = sw.getBoundingClientRect()
    return {
      x: a.x,
      width: a.width,
      importX: b.x,
      importWidth: b.width,
      gap: b.top - a.bottom,
      padding: parseFloat(getComputedStyle(hero).paddingLeft),
      importPadding: parseFloat(getComputedStyle(card).paddingLeft),
      right: a.right - c.right,
    }
  })
  expect(library.x).toBeCloseTo(library.importX, 0)
  expect(library.width).toBeCloseTo(library.importWidth, 0)
  expect(library.gap).toBeCloseTo(16, 0)
  expect(library.padding).toBe(20)
  expect(library.importPadding).toBe(20)
  expect(library.right).toBeCloseTo(21, 0)
  let image = testInfo.outputPath('wiki-library.png')
  await page.screenshot({ path: image, animations: 'disabled' })
  await page.evaluate(() => {
    const original = Element.prototype.animate
    const observed = window as typeof window & {
      __pageAnimations: number
      __memoryDraft?: Element | null
    }
    observed.__pageAnimations = 0
    Element.prototype.animate = function (keyframes, options) {
      observed.__pageAnimations++
      return original.call(this, keyframes, options)
    }
  })
  await page.getByTestId('wiki-workspace-tab-memory').click()
  const draft = page.getByTestId('memory-new-content')
  await draft.fill('保留这段未发送的草稿')
  const firstCard = page.getByTestId('memory-create-toggle').locator('..')
  const secondCard = page.getByTestId('reviewed-memory-row').first()
  await expect(secondCard).toBeVisible()
  const memory = await firstCard.evaluate(node => {
    const first = node.getBoundingClientRect()
    const second = document
      .querySelector('[data-testid="reviewed-memory-row"]')!
      .getBoundingClientRect()
    ;(window as typeof window & { __memoryDraft?: Element | null }).__memoryDraft =
      document.querySelector('[data-testid="memory-new-content"]')
    return {
      x: first.x,
      width: first.width,
      padding: parseFloat(getComputedStyle(node).paddingLeft),
      gap: second.top - first.bottom,
    }
  })
  expect(memory.x).toBeCloseTo(library.x, 0)
  expect(memory.width).toBeCloseTo(library.width, 0)
  expect(memory.padding).toBe(20)
  expect(memory.gap).toBeCloseTo(16, 0)
  await draft.blur()
  image = testInfo.outputPath('wiki-memory.png')
  await page.screenshot({ path: image, animations: 'disabled' })
  const beforeReturn = await page.evaluate(
    () => (window as typeof window & { __pageAnimations: number }).__pageAnimations
  )
  await page.getByTestId('wiki-workspace-tab-library').click()
  await page.getByTestId('wiki-workspace-tab-memory').click()
  await expect(draft).toHaveValue('保留这段未发送的草稿')
  expect(
    await draft.evaluate(
      node => node === (window as typeof window & { __memoryDraft?: Element | null }).__memoryDraft
    )
  ).toBe(true)
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { __pageAnimations: number }).__pageAnimations)
    )
    .toBeGreaterThan(beforeReturn)
  await draft.focus()
  await page.evaluate(() => {
    window.history.pushState({}, '', `${location.pathname}${location.search}&page=2`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(draft).toBeFocused()
  await expect(draft).toHaveValue('保留这段未发送的草稿')
  await page.getByTestId('wiki-workspace-tab-library').click()
  const beforeOpen = await page.evaluate(
    () => (window as typeof window & { __pageAnimations: number }).__pageAnimations
  )
  await page.getByTestId('wiki-page-row-page-0').click()
  await expect(page.getByTestId('wiki-reader')).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { __pageAnimations: number }).__pageAnimations)
    )
    .toBeGreaterThan(beforeOpen)
  await page.getByTestId('wiki-reader-back').click()
  await expect(page.getByTestId('wiki-page-row-page-0')).toBeVisible()
  await page.getByTestId('wiki-workspace-tab-memory').click()
  await expect(draft).toHaveValue('保留这段未发送的草稿')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
})

test('provider reference tabs and safe configuration download work in the real browser', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1124, height: 1375 })
  await loadReferencePanel(page, 'provider', 'provider-effective-details-toggle')
  await page.getByTestId('provider-effective-details-toggle').click()
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

test('schedule time picker supports selection and keyboard dismissal in a narrow viewport', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await page.goto('/e2e/fixtures/reference-panels.html?panel=schedule-time')
  await page.getByTestId('schedule-time-picker').hover()
  await page.getByTestId('schedule-time-picker').click()
  await page.getByRole('listbox').nth(0).hover()
  await page.mouse.wheel(0, 220)
  await page.getByTestId('schedule-time-hour-14').click()
  await page.getByRole('listbox').nth(1).hover()
  await page.mouse.wheel(0, 660)
  await page.getByTestId('schedule-time-minute-45').click()
  await expect(page.getByTestId('schedule-time')).toHaveValue('14:45')
  await expect(page.getByTestId('schedule-time-panel')).toBeVisible()
  expect((await page.getByTestId('schedule-time').boundingBox())!.y).toBeGreaterThanOrEqual(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('schedule-time.png'), animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('schedule-time-panel')).toHaveCount(0)
  await expect(page.getByTestId('schedule-time')).toBeFocused()
})

test('plugin management has an explicit return to workbench', async ({ page }) => {
  await page.goto('/e2e/fixtures/reference-panels.html?panel=plugins')
  await expect(page.getByTestId('plugins-back-button')).toBeVisible()
  await page.getByTestId('plugins-back-button').click()
  await expect(page).toHaveURL(/\/$/)
})

test('titlebar sidebar toggle collapses and restores the actual settings navigation', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 850 })
  await loadReferencePanel(page, 'settings-sidebar', 'settings-sidebar')
  const chrome = page.getByTestId('desktop-brand-chrome')
  const sidebar = page.getByTestId('settings-sidebar')
  const main = page.getByTestId('studio-settings-page').locator('main')
  const original = await sidebar.boundingBox()
  const mainBefore = await main.boundingBox()
  expect(original?.width).toBeGreaterThan(200)
  await chrome.getByTestId('desktop-titlebar-sidebar-toggle').click()
  await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
  await expect(sidebar).toHaveAttribute('inert', '')
  await expect(sidebar).toHaveCSS('width', '0px')
  const mainAfter = await main.boundingBox()
  expect(mainBefore!.x - mainAfter!.x).toBeGreaterThan(200)
  const image = testInfo.outputPath('settings-sidebar-collapsed.png')
  await page.screenshot({ path: image, animations: 'disabled' })
  await chrome.getByTestId('desktop-titlebar-sidebar-toggle').click()
  await expect(sidebar).toHaveAttribute('aria-hidden', 'false')
  await expect(sidebar).not.toHaveAttribute('inert', '')
  await expect(sidebar).toHaveCSS('width', `${original!.width}px`)
})
