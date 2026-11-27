import { expect, test, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'

for (const [theme, outcome] of [['light', 'success'], ['dark', 'failure']] as const) {
  test(`model connection indicator after explicit refresh (${theme}, ${outcome}, UI-only)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1064, height: 900 })
    await page.goto(`/e2e/fixtures/reference-panels.html?panel=provider&theme=${theme}&providerChecks=${outcome}`)
    const status = page.getByTestId('provider-connection-status')
    await expect(status).toHaveAttribute('data-status', 'untested')
    await page.getByTestId('provider-refresh').click()
    await expect(status).toHaveAttribute('data-status', outcome === 'success' ? 'connected' : 'failed')
    await expect(status).toHaveAttribute('title', /检测时间/)
    await expect(status).toHaveAttribute('title', /123 ms/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`provider-connection-${theme}.png`) })
  })
}

for (const theme of ['light', 'dark']) {
  for (const width of [390, 1280]) {
    test(`same-named image selection and preview retry (${theme}, ${width})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      const locale = width === 390 ? 'zh-CN' : 'en'
      await page.goto(`/e2e/fixtures/reference-panels.html?panel=composer-actions&attachments=true&locale=${locale}&theme=${theme}`)
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNwaDgARAwHGhyACAAqDgYBxIhtdAAAAABJRU5ErkJggg==', 'base64')
      await page.getByTestId('fixture-image-picker').setInputFiles([
        { name: 'image.png', mimeType: 'image/png', buffer: png },
        { name: 'image.png', mimeType: 'image/png', buffer: png },
      ])
      await expect(page.getByTestId('fixture-upload-count')).toHaveText('2')
      await expect(page.getByTestId('uploading-attachment-badge')).toHaveCount(2)
      await expect(page.getByTestId('fixture-transport-count')).toHaveText('2')
      await page.getByTestId('fixture-finish-second').click()
      await expect(page.getByTestId('fixture-image-order')).toHaveText('-2')
      await page.getByTestId('fixture-finish-first').click()
      await expect(page.getByTestId('fixture-image-order')).toHaveText('-1,-2')
      const previews = page.getByTestId('attachment-image-preview')
      await expect(previews).toHaveCount(2)
      await expect.poll(() => previews.evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth === 2))).toBe(true)
      await previews.first().evaluate(image => (image as HTMLImageElement).src = 'data:image/png;base64,broken')
      const retry = page.getByTestId('attachment-image-preview-error')
      await expect(retry).toHaveAccessibleName(locale === 'en'
        ? 'Image could not be loaded. Click to retry image.png'
        : '图片加载失败，点击重试 image.png')
      await page.screenshot({ path: testInfo.outputPath(`image-preview-error-${theme}-${width}.png`) })
      await retry.click()
      await expect(previews).toHaveCount(2)
      await expect.poll(() => previews.evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth === 2))).toBe(true)
      const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width)
      await page.screenshot({ path: testInfo.outputPath(`two-image-previews-${theme}-${width}.png`) })
    })
  }
}

for (const theme of ['light', 'dark']) {
  for (const width of [390, 1280]) {
    test(`remote project host selector has one focus surface (${theme}, ${width})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/e2e/fixtures/control-style-preview.html?panel=remote-project')
      await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme)
      const select = page.getByTestId('standalone-remote-device-select')
      await expect(select).toHaveValue('preview-h20')
      const field = select.locator('xpath=ancestor::label[1]')
      const geometry = await field.evaluate(label => {
        const input = label.querySelector('select')!.getBoundingClientRect()
        const icon = label.querySelector('svg')!.getBoundingClientRect()
        const frames = [...label.querySelectorAll('span')].filter(element => {
          const style = getComputedStyle(element)
          return Number.parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none'
        })
        return {
          frames: frames.length,
          iconInside: icon.left >= input.left && icon.right <= input.right && icon.top >= input.top && icon.bottom <= input.bottom,
          withinViewport: input.left >= 0 && input.right <= window.innerWidth,
        }
      })
      expect(geometry).toEqual({ frames: 1, iconInside: true, withinViewport: true })
      await page.getByTestId('close-standalone-folder-project-dialog').focus()
      await page.keyboard.press('Tab')
      await expect(select).toBeFocused()
      const focus = await select.evaluate(element => ({
        visible: element.matches(':focus-visible'),
        shadow: getComputedStyle(element.nextElementSibling!).boxShadow,
      }))
      expect(focus.visible).toBe(true)
      expect(focus.shadow).not.toBe('none')
      await page.screenshot({ path: testInfo.outputPath(`remote-host-${theme}-${width}.png`) })
      await select.press('ArrowDown')
      const menu = page.getByRole('listbox')
      await expect(menu).toBeVisible()
      await menu.getByRole('option', { name: /An unusually long host name/ }).click()
      await expect(select).toHaveValue('preview-long-host')
      await expect(select).toBeFocused()
      await select.press('ArrowDown')
      await menu.press('Escape')
      await expect(menu).toBeHidden()
      await expect(select).toBeFocused()
    })
  }
}

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

for (const [windowed, newChat] of [[false, true], [false, false], [true, false]]) test(`waiting hands off to the first streamed reply without moving earlier messages (windowed=${windowed}, newChat=${newChat})`, async ({ page }, testInfo) => {
  await loadReferencePanel(page, `waiting-transition${windowed ? '&windowed=1' : ''}${newChat ? '&newChat=1' : ''}`, 'thinking-indicator')
  const layoutSamples: unknown[] = []
  const sampleLayout = async (phase: string) => {
    layoutSamples.push(await page.evaluate(phase => {
      const scroller = document.querySelector('[data-testid="fixture-waiting-scroll"]')!
      const frame = (element: Element) => {
        const rect = element.getBoundingClientRect()
        return { id: element.getAttribute('data-message-id'), index: element.getAttribute('data-index'), top: rect.top, height: rect.height,
          style: element.getAttribute('style') }
      }
      return { phase, scrollTop: scroller.scrollTop, height: scroller.clientHeight, scrollHeight: scroller.scrollHeight,
        rows: [...scroller.querySelectorAll('[data-index]')].map(frame),
        waiting: [...scroller.querySelectorAll('[data-testid="thinking-indicator"]')].map(frame) }
    }, phase))
  }
  const previous = page.locator('[data-message-id="history-17"]')
  await expect(previous).toBeVisible()
  const original = await previous.boundingBox()
  const originalWaiting = await page.getByTestId('thinking-indicator').boundingBox()
  await sampleLayout('waiting')
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
  await sampleLayout('empty-stream')
  await page.getByTestId('fixture-first-response').click()
  await expect(page.locator('[data-message-id="response"]').getByText('第一段回复')).toBeVisible()
  const reply = await previous.boundingBox()
  await sampleLayout('first-response')
  await testInfo.attach('waiting-transition-layout', { body: JSON.stringify({ original, empty, reply, originalWaiting, streamingWaiting, layoutSamples }), contentType: 'application/json' })
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

for (const width of [1280, 390]) test(`tool sources stay inside their single detail disclosure at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 850 })
  await page.goto('/e2e/fixtures/turn-process-preview.html')
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: '切换主题', exact: true }).click()
    const outer = page.getByTestId('final-processing-toggle')
    await expect(outer).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('native-web-sources')).toHaveCount(0)
    const heading = await outer.textContent()
    await outer.click()
    expect(await outer.textContent()).toBe(heading)
    const batch = page.getByTestId('process-activity-toggle').first()
    if (await batch.getAttribute('aria-expanded') === 'false') await batch.click()
    await expect(page.getByTestId('native-web-sources')).toHaveCount(0)
    const search = page.locator('[data-processing-block-id="search-preview"]')
    if (width < 420) await expect(search.locator('.process-summary-text')).toBeHidden()
    else await expect(search.locator('.process-summary-text')).toBeVisible()
    const detail = search.locator('[data-tool-detail-toggle]').first()
    await expect(detail).toHaveAttribute('aria-expanded', 'false')
    await detail.click()
    await expect(search.getByTestId('native-web-sources')).toBeVisible()
    await expect(search.getByTestId('native-web-sources-toggle')).toHaveCount(0)
    await expect(search.getByRole('link').last()).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`tool-sources-${theme}.png`), animations: 'disabled' })
    await detail.click()
    await expect(page.getByTestId('native-web-sources')).toHaveCount(0)
    await outer.click()
  }
  await page.getByRole('button', { name: '工具失败', exact: true }).click()
  await expect(page.getByTestId('turn-process-status')).toHaveText('已完成')
  await expect(page.getByTestId('assistant-error-card')).toHaveCount(0)
})

test('process time stays left on one line and folded streaming items never mount extra rows', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/e2e/fixtures/reference-panels.html?panel=processing&display=three-level-v1')
  await page.getByTestId('fixture-process-new').click()
  const summary = page.getByTestId('turn-process-summary')
  const toggle = page.getByTestId('final-processing-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('turn-process-elapsed')).not.toHaveText('—')
  await expect(page.getByTestId('turn-process-activity')).toHaveCount(0)
  const activityGroup = page.getByTestId('process-activity-group')
  const activityToggle = page.getByTestId('process-activity-toggle')
  await expect(activityToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(activityToggle).toContainText('思考 2 · 工具调用 1')
  for (const width of [960, 420, 280, 160]) {
    await summary.evaluate((element, value) => { element.style.width = `${value}px` }, width)
    await activityGroup.evaluate((element, value) => { element.style.width = `${value}px` }, width)
    const activity = activityToggle.locator('.turn-process-activity')
    if (width <= 352) await expect(activity).toBeHidden()
    else await expect(activity).toBeVisible()
    const geometry = await toggle.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      const heading = element.firstElementChild!.getBoundingClientRect()
      const status = element.querySelector('[data-testid="turn-process-status"]')!.getBoundingClientRect()
      const elapsed = element.querySelector('[data-testid="turn-process-elapsed"]')!.getBoundingClientRect()
      return { left: bounds.left, headingLeft: heading.left, statusRight: status.right, timeLeft: elapsed.left, height: bounds.height,
        children: [...element.children].filter(child => getComputedStyle(child).display !== 'none')
          .map(child => ({ top: child.getBoundingClientRect().top, bottom: child.getBoundingClientRect().bottom })),
        top: bounds.top, bottom: bounds.bottom, scroll: element.scrollWidth, width: element.clientWidth }
    })
    expect(geometry.headingLeft).toBe(geometry.left)
    expect(geometry.timeLeft).toBeGreaterThanOrEqual(geometry.statusRight)
    expect(geometry.height).toBeLessThanOrEqual(36)
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width)
    expect(geometry.children.every(child => child.top >= geometry.top && child.bottom <= geometry.bottom)).toBe(true)
    await expect.poll(async () => {
      const height = await page.getByTestId('process-text-block').first().locator('p').first()
        .evaluate(element => element.getBoundingClientRect().height)
      return height > 0 && height === geometry.height
    }).toBe(true)
  }
  await summary.evaluate(element => { element.style.width = '' })
  await activityGroup.evaluate(element => { element.style.width = '' })
  await activityToggle.click()
  await expect(page.getByTestId('assistant-thinking-toggle')).toHaveCount(2)
  for (const thinking of await page.getByTestId('assistant-thinking-toggle').all()) {
    await expect(thinking).toHaveAttribute('aria-expanded', 'false')
    expect(await thinking.evaluate(element => element.getBoundingClientRect().height))
      .toBe(await toggle.evaluate(element => element.getBoundingClientRect().height))
  }
  const alignment = await page.getByTestId('process-activity-content').evaluate(element => {
    const rows = [...element.querySelectorAll<HTMLElement>('.process-summary-line')]
    const thought = element.querySelector<HTMLElement>('[data-testid="assistant-thinking-toggle"]')!
    const label = thought.querySelector<HTMLElement>('.process-summary-text')!
    const arrow = thought.querySelector<HTMLElement>('.lucide-chevron-down')!
    return {
      indent: rows[0].getBoundingClientRect().left - element.getBoundingClientRect().left,
      labels: rows.map(row => row.querySelector('.process-summary-text')!.getBoundingClientRect().left),
      gaps: rows.slice(1).map((row, index) => row.getBoundingClientRect().top - rows[index].getBoundingClientRect().bottom),
      arrowAfterText: arrow.getBoundingClientRect().left >= label.getBoundingClientRect().right,
    }
  })
  expect(alignment.indent).toBe(16)
  expect(new Set(alignment.labels).size).toBe(1)
  expect(alignment.gaps.length).toBeGreaterThan(0)
  expect(alignment.gaps.every(gap => gap === 4)).toBe(true)
  expect(alignment.arrowAfterText).toBe(true)
  const proseGaps = await page.getByTestId('turn-process-content').evaluate(element => {
    const children = [...element.children].filter(child => child.getBoundingClientRect().height > 0)
    return children.slice(1).map((child, index) => child.getBoundingClientRect().top - children[index].getBoundingClientRect().bottom)
  })
  expect(proseGaps.length).toBeGreaterThan(0)
  expect(proseGaps.every(gap => gap === 12)).toBe(true)
  const proseLeft = await page.getByTestId('process-text-block').first().locator('p').first()
    .evaluate(element => element.getBoundingClientRect().left)
  expect(await activityGroup.evaluate(element => element.getBoundingClientRect().left)).toBe(proseLeft)
  await page.screenshot({ path: testInfo.outputPath('process-spacing-restored.png'), animations: 'disabled' })
  await page.getByTestId('assistant-thinking-toggle').first().click()
  await expect(page.getByText('先查询资料，再继续分析。', { exact: true })).toBeVisible()
  await activityToggle.click()
  await toggle.click()
  await page.evaluate(() => {
    const state = window as Window & { processRowsMounted?: number; processObserver?: MutationObserver }
    state.processRowsMounted = 0
    state.processObserver = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element) state.processRowsMounted! +=
          Number(node.matches('[data-testid="message-hover-region"]')) +
          node.querySelectorAll('[data-testid="message-hover-region"]').length
      }
    })
    state.processObserver.observe(document.body, { subtree: true, childList: true })
  })
  for (let index = 0; index < 4; index++) await page.getByTestId('fixture-process-add-item').click()
  await expect(page.getByTestId('process-activity-toggle')).toHaveCount(0)
  await expect(page.getByTestId('turn-process-activity')).toHaveText('正在调用工具')
  expect(await page.evaluate(() => {
    const state = window as Window & { processRowsMounted?: number; processObserver?: MutationObserver }
    state.processObserver?.disconnect()
    return state.processRowsMounted
  })).toBe(0)
  await expect(page.getByTestId('message-hover-region')).toHaveCount(1)
  await page.screenshot({ path: testInfo.outputPath('elapsed-first-collapsed.png'), animations: 'disabled' })
  await toggle.click()
  await expect(page.getByTestId('message-hover-region')).toHaveCount(5)
  await expect(page.getByTestId('process-activity-toggle')).toHaveCount(5)
  await toggle.click()
  await expect(page.getByTestId('message-hover-region')).toHaveCount(1)
})

test('parallel preparation stays inside a folded turn and summaries keep ordinary text height', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/e2e/fixtures/reference-panels.html?panel=processing&display=three-level-v1')
  await page.getByTestId('fixture-process-new').click()
  const outer = page.getByTestId('final-processing-toggle')
  await expect(outer.locator('.animate-spin')).toHaveCount(0)
  const height = await outer.evaluate(element => element.getBoundingClientRect().height)
  await outer.click()
  await page.getByTestId('fixture-parallel-prepare').click()
  await expect(page.getByTestId('turn-process-activity')).toHaveText('正在访问网页')
  await expect(page.getByTestId('turn-process-content')).toHaveCount(0)
  await expect(page.getByTestId('tool-input-progress-status')).toHaveCount(0)
  await expect(page.getByTestId('tool-input-progress-count')).toHaveCount(0)
  await expect(page.getByText(/正在生成.*工具参数/)).toHaveCount(0)
  await expect(page.getByText('正在核对两项并行结果。', { exact: true })).toHaveCount(0)
  expect(await outer.evaluate(element => element.getBoundingClientRect().height)).toBe(height)
  const topSummary = page.getByTestId('turn-process-summary')
  await topSummary.evaluate(element => { element.style.width = '280px' })
  await expect(page.getByTestId('turn-process-activity')).toBeHidden()
  await expect(page.getByTestId('turn-process-elapsed')).toBeVisible()
  expect(await outer.evaluate(element => element.getBoundingClientRect().height)).toBe(height)
  await topSummary.evaluate(element => { element.style.width = '' })
  await page.screenshot({ path: testInfo.outputPath('parallel-turn-folded.png'), animations: 'disabled' })
  await page.getByTestId('fixture-parallel-finish-latest').click()
  await expect(page.getByTestId('turn-process-activity')).toHaveText('正在探索代码')
  expect(await outer.evaluate(element => element.getBoundingClientRect().height)).toBe(height)
  await outer.click()
  await expect(page.getByText('正在核对两项并行结果。', { exact: true })).toBeVisible()
  const group = page.getByTestId('process-activity-toggle').last()
  await expect(group).toContainText('工具调用 2')
  await expect(group).toContainText('正在探索代码')
  expect(await group.evaluate(element => element.getBoundingClientRect().height)).toBe(height)
  await group.click()
  const tool = page.getByTestId('subagent-tool-toggle')
  await expect(tool).toBeDisabled()
  await expect(tool).toContainText('正在运行 explore_agent')
  await expect(tool).not.toContainText('正在探索代码')
  const parallelRows = page.getByTestId('process-activity-content').last().locator('[data-processing-block-id]')
  await expect(parallelRows).toHaveCount(2)
  expect(await parallelRows.evaluateAll(elements => elements.map(element => element.getAttribute('data-processing-block-id'))))
    .toEqual(['parallel-0', 'parallel-1'])
  await expect(parallelRows.nth(1)).toContainText('已运行 WebFetch')
  expect(await tool.evaluate(element => element.getBoundingClientRect().height)).toBe(height)
  await page.screenshot({ path: testInfo.outputPath('parallel-turn-expanded.png'), animations: 'disabled' })
})

test('earlier reasoning stops spinning as soon as narrative or another activity appears', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/e2e/fixtures/reference-panels.html?panel=processing&display=three-level-v1')
  await page.getByTestId('fixture-process-new').click()
  const earlier = page.getByTestId('process-activity-toggle').first()
  await expect(earlier.locator('.animate-spin')).toHaveCount(1)
  await page.getByTestId('fixture-text-append').click()
  await expect(page.getByText('正在汇总检查结果，这段中间说明也应该留在同一个滚动区域内。', { exact: true }).first()).toBeVisible()
  await expect(earlier.locator('.animate-spin')).toHaveCount(0)
  await earlier.click()
  for (const thought of await page.getByTestId('assistant-thinking-toggle').all())
    await expect(thought).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByTestId('assistant-thinking-spinner')).toHaveCount(0)
  await page.getByTestId('fixture-parallel-prepare').click()
  const current = page.getByTestId('process-activity-toggle').last()
  await expect(current).toContainText('正在访问网页')
  await expect(current.locator('.animate-spin')).toHaveCount(1)
  await expect(earlier.locator('.animate-spin')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('reasoning-spinner-settled.png'), animations: 'disabled' })
})

test('English process summaries localize every disclosure level and stay on one line', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/e2e/fixtures/reference-panels.html?panel=processing&display=three-level-v1&locale=en')
  await page.getByTestId('fixture-process-new').click()
  const outer = page.getByTestId('final-processing-toggle')
  await expect(outer).toHaveAccessibleName(/^Processing \d+s$/)
  const group = page.getByTestId('process-activity-toggle')
  await expect(group).toContainText('2 reasoning steps · 1 tool call')
  await group.click()
  await expect(page.getByText('Ran web_search', { exact: true })).toBeVisible()
  await expect(page.getByTestId('assistant-thinking-toggle').first()).toHaveAccessibleName('Thought process')
  await expect(page.getByTestId('assistant-thinking-toggle').last()).toHaveAccessibleName('Analyzing the request')
  await outer.click()
  await page.getByTestId('fixture-parallel-prepare').click()
  await expect(page.getByTestId('turn-process-activity')).toHaveText('Visiting a webpage')
  await page.getByTestId('fixture-parallel-finish-latest').click()
  await expect(page.getByTestId('turn-process-activity')).toHaveText('Exploring the codebase')
  await page.getByTestId('turn-process-summary').evaluate(element => { element.style.width = '280px' })
  await expect(page.getByTestId('turn-process-activity')).toBeHidden()
  await expect(page.getByTestId('turn-process-heading')).toBeVisible()
  await page.getByTestId('turn-process-summary').evaluate(element => { element.style.width = '' })
  await outer.click()
  await page.getByTestId('process-activity-toggle').last().click()
  await expect(page.getByText('Running explore_agent', { exact: true })).toBeVisible()
  await expect(page.getByText('Ran WebFetch', { exact: true })).toBeVisible()
  const labels = await page.locator('[data-testid="process-activity-toggle"], [data-testid="assistant-thinking-toggle"], [data-testid="subagent-tool-toggle"]')
    .allTextContents()
  expect(labels.every(label => !/\p{Script=Han}/u.test(label))).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('english-process-expanded.png'), animations: 'disabled' })
  await page.getByTestId('fixture-process-finish').click()
  await expect(page.getByTestId('turn-process-status')).toHaveText('Completed')
  await expect(outer).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('turn-process-elapsed')).toHaveText(/^\d+s$/)
})

for (const width of [1280, 420]) {
  test(`retired process cache cannot override three-level turn presentation at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/e2e/fixtures/reference-panels.html?panel=processing&display=three-level-v1&legacyWindow=1')
    await page.evaluate(() => localStorage.setItem('kcoder-studio:conversation-processing-windows-v1',
      JSON.stringify([['fixture:process-1', true]])))
    await page.getByTestId('fixture-process-new').click()
    const summary = page.getByTestId('final-processing-toggle')
    await expect(summary).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('turn-process-summary')).toHaveCount(1)
    await expect(page.getByTestId('processing-group')).toHaveCount(0)
    await expect(page.getByTestId('processing-window')).toHaveCount(0)
    await expect(page.getByTestId('turn-process-content')).toBeVisible()
    await expect(page.getByTestId('process-activity-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('我会先查找相关说明，再检查页面布局。', { exact: true })).toBeVisible()
    await page.getByTestId('fixture-process-finish').click()
    await expect(summary).toHaveAttribute('aria-expanded', 'false')
    await expect(summary).toContainText('已完成')
    await expect(page.getByTestId('turn-process-elapsed')).not.toHaveText('—')
    await expect(page.getByTestId('assistant-message-content')).toContainText('最终回复：任务完成。')
    await expect(page.getByText('我会先查找相关说明，再检查页面布局。', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('completed-turn-collapsed.png'), animations: 'disabled' })
    await summary.click()
    await expect(page.getByTestId('turn-process-content')).toBeVisible()
    await expect(page.getByTestId('process-activity-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('我会先查找相关说明，再检查页面布局。', { exact: true })).toBeVisible()
    await page.getByTestId('process-activity-toggle').click()
    for (const thinking of await page.getByTestId('assistant-thinking-toggle').all())
      await expect(thinking).toHaveAttribute('aria-expanded', 'false')
    await page.screenshot({ path: testInfo.outputPath('current-process-summary.png'), animations: 'disabled' })
  })
}

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

test('local model discovery keeps late replies with their original editor in the browser', async ({ page }) => {
  let releaseOld!: () => void
  let releaseNew!: () => void
  const oldReply = new Promise<void>(resolve => { releaseOld = resolve })
  const newReply = new Promise<void>(resolve => { releaseNew = resolve })
  // Exercise the supported non-Gateway model editor with the existing settings fixture.
  await page.route('**/reference-panels.html?panel=settings-sidebar', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace(
      '<meta name="kcoder-rpc-token" content="ui-fixture-only" />', ''
    ) })
  })
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*',
  }
  await page.route('https://api.deepseek.com/models', async route => {
    await oldReply
    await route.fulfill({ headers, json: { data: [{ id: 'old-deepseek-model' }] } })
  })
  await page.route('https://api.moonshot.cn/v1/models', async route => {
    await newReply
    await route.fulfill({ headers, json: { data: [{ id: 'current-kimi-model' }] } })
  })
  try {
    await loadReferencePanel(page, 'settings-sidebar', 'settings-sidebar')
    await page.getByTestId('settings-nav-model-settings').click()
    await page.getByTestId('local-model-add-button').click()
    const provider = page.getByTestId('local-model-provider-select')
    await provider.selectOption('deepseek')
    await page.getByTestId('local-model-api-key-input').fill('synthetic-editor-test-key')
    const load = page.getByTestId('local-model-load-provider-models-button')
    const oldRequest = page.waitForRequest('https://api.deepseek.com/models')
    await load.click()
    await oldRequest
    await provider.selectOption('kimi')
    await expect(load).toBeEnabled()
    const newRequest = page.waitForRequest('https://api.moonshot.cn/v1/models')
    await load.click()
    await newRequest
    const oldResponse = page.waitForResponse('https://api.deepseek.com/models')
    releaseOld()
    await (await oldResponse).finished()
    await expect(page.getByTestId('local-model-provider-model-select')).toHaveCount(0)
    await expect(load).toBeDisabled()
    releaseNew()
    await expect(page.getByTestId('local-model-provider-model-select')).toHaveValue('current-kimi-model')
    await expect(load).toBeEnabled()
    await expect(page.getByTestId('local-model-display-name-input')).toHaveValue('current-kimi-model')
  } finally {
    releaseOld()
    releaseNew()
  }
})

test('settings fit below desktop chrome and the final navigation row remains reachable after resize', async ({ page }, testInfo) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1536, height: 912 })
  await page.goto('/e2e/fixtures/reference-panels.html?panel=settings-sidebar', { waitUntil: 'domcontentloaded' })
  await page.getByTestId('settings-sidebar-nav').waitFor({ timeout: 60000 })
  const settings = page.getByTestId('studio-settings-page')
  const nav = page.getByTestId('settings-sidebar-nav')
  const lastRow = nav.getByRole('button').last()
  for (const size of [{ width: 1536, height: 912 }, { width: 1280, height: 640 }, { width: 960, height: 640 }]) {
    await page.setViewportSize(size)
    await expect.poll(async () => {
      const box = (await settings.boundingBox())!
      return box.y + box.height
    }).toBeLessThanOrEqual(size.height)
    await nav.evaluate(node => { node.scrollTop = node.scrollHeight })
    const row = await lastRow.boundingBox()
    expect(row!.y + row!.height).toBeLessThanOrEqual(size.height)
    await expect(lastRow).toBeInViewport({ ratio: 1 })
    if (size.width === 1536) await page.screenshot({ path: testInfo.outputPath('settings-desktop-1536.png') })
    await lastRow.click()
    await expect(lastRow).toHaveAttribute('aria-current', 'page')
  }
  await page.screenshot({ path: testInfo.outputPath('settings-bottom-row-visible.png') })
  // A desktop Web page without native menu chrome uses the entire parent height.
  await page.getByTestId('desktop-brand-chrome').evaluate(node => { node.style.display = 'none' })
  await expect.poll(async () => (await settings.boundingBox())!.height).toBe(640)
})

for (const locale of ['zh-CN', 'en']) for (const theme of ['light', 'dark']) {
test(`narrow settings pages stay inside menu chrome (${locale}, ${theme})`, async ({ page }, testInfo) => {
  test.setTimeout(120000)
  await page.addInitScript(() => {
    const token = document.createElement('meta')
    token.name = 'kcoder-rpc-token'
    token.content = 'owned-settings-ui-fixture'
    const destination = document.head ?? document.documentElement
    destination.append(token)
  })
  await page.route('**/api/channels*', async route => {
    expect(route.request().method()).toBe('GET')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        installationId: 'settings-ui-fixture',
        settings: { mirrorClientTurns: false },
        connections: [],
        chats: [],
      }),
    })
  })
  await page.setViewportSize({ width: 390, height: 700 })
  await page.goto(`/e2e/fixtures/reference-panels.html?panel=settings-sidebar&mobileSettings=1&locale=${locale}&theme=${theme}`, { waitUntil: 'domcontentloaded' })
  await page.getByTestId('mobile-settings-page').waitFor({ timeout: 60000 })
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 700 })
    const main = page.getByTestId('mobile-settings-page')
    const bounds = await main.boundingBox()
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(700)
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }))
    expect(dimensions.viewport).toBe(width)
    expect(Math.max(dimensions.document, dimensions.body)).toBeLessThanOrEqual(width)

    const search = page.getByTestId('mobile-settings-search')
    const channelQuery = locale === 'en' ? 'Channels' : '通道'
    await search.fill(channelQuery)
    const channels = page.getByTestId('mobile-settings-channels-button')
    await expect(channels).toBeVisible()
    await expect(channels).toContainText(channelQuery)
    await channels.click()
    await expect(page.getByTestId('mobile-channels-settings-page')).toBeVisible()
    await expect(page.getByTestId('octop-channels-workspace')).toBeVisible()
    await expect(search).toHaveValue(channelQuery)
    await expect(search).toBeHidden()
    const channelDimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }))
    expect(Math.max(channelDimensions.document, channelDimensions.body)).toBeLessThanOrEqual(width)
    await page.screenshot({ path: testInfo.outputPath(`channels-${width}.png`) })
    await page.getByTestId('mobile-channels-back-button').click()
    await expect(page.getByTestId('mobile-settings-page')).toBeVisible()
    await expect(search).toHaveValue(channelQuery)
    await expect(channels).toBeFocused()
    await search.fill('')

    await page.getByTestId('mobile-settings-general-button').click()
    const detail = page.getByTestId('mobile-general-settings-page')
    const child = await detail.boundingBox()
    expect(child!.y + child!.height).toBeLessThanOrEqual(700)
    await page.screenshot({ path: testInfo.outputPath(`narrow-settings-${width}.png`) })
    await page.getByTestId('mobile-general-back-button').click()
    await expect(page.getByTestId('mobile-settings-page')).toBeVisible()
    await page.setViewportSize({ width, height: 400 })
    const lastRow = page.getByTestId('mobile-settings-archived-conversations-button')
    await lastRow.scrollIntoViewIfNeeded()
    await expect(lastRow).toBeInViewport({ ratio: 1 })
    const bottom = (await lastRow.boundingBox())!
    expect(bottom.y + bottom.height).toBeLessThanOrEqual(400)
    await page.setViewportSize({ width, height: 700 })
  }
})
}

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

for (const locale of ['zh-CN', 'en']) for (const theme of ['light', 'dark']) {
  test(`composer actions stay on one row (${locale}, ${theme})`, async ({ page }, testInfo) => {
    test.setTimeout(120000)
    await page.setViewportSize({ width: 1100, height: 700 })
    await page.goto(`/e2e/fixtures/reference-panels.html?panel=composer-actions&locale=${locale}&theme=${theme}`, { waitUntil: 'domcontentloaded' })
    const toolbar = page.getByTestId('composer-toolbar')
    await toolbar.waitFor({ timeout: 60000 })
    const input = page.getByTestId('chat-message-input')
    if (locale === 'zh-CN' && theme === 'light') {
      await page.setViewportSize({ width: 610, height: 700 })
      await expect(toolbar).toHaveAttribute('data-density', '1')
      await page.getByTestId('fixture-desktop-enabled').evaluate(node => { node.parentElement!.style.visibility = 'hidden' })
      await page.screenshot({ path: testInfo.outputPath('composer-empty-610.png') })
      await page.getByTestId('fixture-desktop-enabled').evaluate(node => { node.parentElement!.style.visibility = '' })
      await page.setViewportSize({ width: 1100, height: 700 })
    }
    await input.fill('Keep this draft during resize')
    await page.evaluate(() => {
      Object.assign(window, { composerEditor: document.querySelector('[data-testid="chat-message-input"]'),
        workflowButton: document.querySelector('[data-testid="workflow-reuse-open"]') })
    })
    await expect(toolbar).toHaveAttribute('data-density', '0')
    for (const width of [1100, 610, 390, 320]) {
      await page.setViewportSize({ width, height: 700 })
      await expect.poll(() => toolbar.evaluate(node => {
        const buttons = [
          node.querySelector('[data-testid="composer-permission-selector"]'),
          node.querySelector('[data-testid="model-selector-button"]'),
          node.querySelector('[data-testid="send-message-button"]'),
        ].map(button => button!.getBoundingClientRect())
        return Math.max(...buttons.map(b => b.bottom)) - Math.min(...buttons.map(b => b.bottom))
      })).toBeLessThanOrEqual(16)
      await expect.poll(() => toolbar.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
      if (width === 610) {
        await expect(toolbar).toHaveAttribute('data-density', '1')
        await expect(page.getByTestId('workflow-reuse-open').locator('[data-composer-label]')).toBeHidden()
      }
      if (width <= 390) {
        const more = page.getByTestId('composer-more-button')
        await expect(more).toBeVisible()
        await expect(page.getByTestId('workflow-reuse-open')).toBeHidden()
        await more.click()
        await expect(page.getByTestId('workflow-reuse-open')).toBeVisible()
        await expect(page.getByTestId('workflow-reuse-open').locator('[data-composer-label]')).toBeVisible()
        const group = page.locator('[data-composer-overflow-group]:popover-open')
        await expect(group).toHaveCount(1)
        const bounds = (await group.boundingBox())!
        expect(bounds.x).toBeGreaterThanOrEqual(0)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
        await page.screenshot({ path: testInfo.outputPath(`composer-more-${width}.png`) })
        await page.keyboard.press('Escape')
        await expect(more).toHaveAttribute('aria-expanded', 'false')
        await expect(more).toBeFocused()
        await more.click()
        await page.getByTestId('computer-use-submit').click()
        await expect(page.getByTestId('computer-use-approval')).toBeVisible()
        await expect(group).toHaveCount(0)
        await page.getByTestId('computer-use-cancel').click()
      }
      await page.screenshot({ path: testInfo.outputPath(`composer-actions-${width}.png`) })
    }
    await expect(page.getByTestId('model-selector-button').locator('[data-composer-model-icon]')).toBeVisible()
    await page.getByTestId('model-selector-button').click()
    await expect(page.getByTestId('model-selector-close-button')).toBeVisible()
    await page.getByTestId('model-selector-close-button').click()
    await page.getByTestId('composer-permission-selector').click()
    await expect(page.getByTestId('permission-mode-auto')).toBeVisible()
    await page.keyboard.press('Escape')
    const more = page.getByTestId('composer-more-button')
    await page.getByTestId('fixture-desktop-enabled').check()
    await expect.poll(() => more.evaluate(node => getComputedStyle(node, '::after').content)).toBe('""')
    await more.click()
    await expect(page.getByTestId('computer-use-submit')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('computer-use-submit').click()
    await expect(page.getByTestId('fixture-desktop-enabled')).not.toBeChecked()
    await more.click()
    await page.getByTestId('quick-phrase-button').click()
    await expect(page.getByTestId('quick-phrase-menu')).toBeVisible()
    await page.getByTestId('quick-phrase-search-input').fill('keep this query')
    await expect(page.getByTestId('quick-phrase-search-input')).toHaveValue('keep this query')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('quick-phrase-menu')).toHaveCount(0)
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1100, height: 700 })
    await expect(toolbar).toHaveAttribute('data-density', '0')
    // A narrow split pane must compact even while the viewport stays wide.
    await page.getByTestId('project-chat-composer').evaluate(node => { node.style.width = '320px' })
    await expect(toolbar).toHaveAttribute('data-compact', 'true')
    await expect.poll(() => toolbar.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
    await page.getByTestId('project-chat-composer').evaluate(node => { node.style.width = '' })
    await expect(toolbar).toHaveAttribute('data-density', '0')
    await expect(input).toHaveText('Keep this draft during resize')
    expect(await page.evaluate(() => {
      const saved = window as typeof window & { composerEditor: Element; workflowButton: Element }
      return saved.composerEditor === document.querySelector('[data-testid="chat-message-input"]') &&
        saved.workflowButton === document.querySelector('[data-testid="workflow-reuse-open"]')
    })).toBe(true)
  })
}

test('project composer stays inside its chat column as the right panel opens and closes', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/e2e/fixtures/reference-panels.html?panel=composer-actions&workbar=true&splitPane=true&theme=light&locale=zh-CN', { waitUntil: 'domcontentloaded' })
  const chatPane = page.getByTestId('fixture-chat-pane')
  const rightPanel = page.getByTestId('fixture-right-panel-shell')
  const toggle = page.getByTestId('toggle-right-workspace-panel-button')
  const dismissPanelToggleTooltip = async () => {
    await toggle.evaluate(element => (element as HTMLButtonElement).blur())
    await page.mouse.move(1240, 760)
    await expect(toggle.locator('xpath=..').getByRole('tooltip')).toHaveCSS('opacity', '0')
  }

  await expect(page.getByTestId('project-branch-button')).toContainText('加载中')
  await expect(chatPane).toHaveCSS('width', '1256px')
  await expect(rightPanel).toHaveAttribute('aria-hidden', 'true')
  await expect(rightPanel).toHaveCSS('width', '0px')

  const assertComposerContained = async (panelOpen: boolean) => {
    const geometry = await page.evaluate(() => {
    const bounds = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right }
    }
    const split = document.querySelector('[data-testid="fixture-workbench-split"]')!
    const chatPane = document.querySelector('[data-testid="fixture-chat-pane"]')!
    const host = document.querySelector('[data-testid="fixture-composer-host"]')!
    const composer = document.querySelector('[data-testid="project-chat-composer"]')!
    const context = document.querySelector('[data-testid="composer-project-context"]')!
    const workbar = context.querySelector(':scope > div')!
    const toolbar = document.querySelector('[data-testid="composer-toolbar"]')!
    const rightPanel = document.querySelector('[data-testid="fixture-right-panel-shell"]')!
    const controls = [...context.querySelectorAll('button')]
    return {
      split: bounds(split),
      chatPane: bounds(chatPane),
      host: bounds(host),
      composer: bounds(composer),
      context: bounds(context),
      workbar: bounds(workbar),
      rightPanel: bounds(rightPanel),
      controls: controls.map(bounds),
      contextOverflow: context.scrollWidth - context.clientWidth,
      workbarOverflow: workbar.scrollWidth - workbar.clientWidth,
      toolbarOverflow: toolbar.scrollWidth - toolbar.clientWidth,
      splitOverflow: split.scrollWidth - split.clientWidth,
    }
  })

    expect(geometry.chatPane.left).toBeGreaterThanOrEqual(geometry.split.left)
    expect(geometry.chatPane.right).toBeLessThanOrEqual(geometry.split.right)
    expect(geometry.composer.left).toBeGreaterThanOrEqual(geometry.chatPane.left)
    expect(geometry.composer.right).toBeLessThanOrEqual(geometry.chatPane.right)
    expect(geometry.context.left).toBeGreaterThanOrEqual(geometry.composer.left)
    expect(geometry.context.right).toBeLessThanOrEqual(geometry.composer.right)
    expect(geometry.workbar.left).toBeGreaterThanOrEqual(geometry.context.left)
    expect(geometry.workbar.right).toBeLessThanOrEqual(geometry.context.right)
    for (const control of geometry.controls) {
      expect(control.left).toBeGreaterThanOrEqual(geometry.context.left)
      expect(control.right).toBeLessThanOrEqual(geometry.context.right)
    }
    if (panelOpen) {
      expect(geometry.rightPanel.left).toBeGreaterThanOrEqual(geometry.chatPane.right)
      expect(geometry.rightPanel.right).toBeLessThanOrEqual(geometry.split.right)
    } else {
      expect(geometry.chatPane.left).toBe(geometry.split.left)
      expect(geometry.chatPane.right).toBe(geometry.split.right)
    }
    expect(geometry.contextOverflow).toBeLessThanOrEqual(1)
    expect(geometry.workbarOverflow).toBeLessThanOrEqual(1)
    expect(geometry.toolbarOverflow).toBeLessThanOrEqual(1)
    expect(geometry.splitOverflow).toBeLessThanOrEqual(1)
  }

  await toggle.click()
  await expect(rightPanel).toHaveAttribute('aria-hidden', 'false')
  await expect(chatPane).toHaveCSS('width', '420px')
  await assertComposerContained(true)
  await dismissPanelToggleTooltip()
  await page.screenshot({ path: testInfo.outputPath('project-composer-right-panel-open.png') })

  const resizeHandle = page.getByTestId('fixture-right-workspace-resize-handle')
  const handleBounds = await resizeHandle.boundingBox()
  expect(handleBounds).not.toBeNull()
  await page.mouse.move(handleBounds!.x + handleBounds!.width / 2, handleBounds!.y + 20)
  await page.mouse.down()
  await page.mouse.move(handleBounds!.x + handleBounds!.width / 2 + 90, handleBounds!.y + 20)
  await page.mouse.up()
  await expect(chatPane).toHaveCSS('width', '510px')
  await expect(rightPanel).toHaveAttribute('aria-hidden', 'false')
  await assertComposerContained(true)
  await dismissPanelToggleTooltip()
  await page.screenshot({ path: testInfo.outputPath('project-composer-resized-chat-column.png') })

  await toggle.click()
  await expect(rightPanel).toHaveAttribute('aria-hidden', 'true')
  await expect(rightPanel).toHaveCSS('width', '0px')
  await expect(chatPane).toHaveCSS('width', '1256px')
  await assertComposerContained(false)
  await dismissPanelToggleTooltip()
  await page.screenshot({ path: testInfo.outputPath('project-composer-right-panel-closed.png') })
})

for (const portal of [false, true]) test(`turn navigation hides when the conversation narrows inside a wide window (portal=${portal})`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await loadReferencePanel(page, `operation-feedback${portal ? '&navigationPortal=1' : ''}`, 'operation-feedback-scroll')
  const panel = page.getByTestId('feedback-conversation-panel')
  const navigation = page.getByTestId('message-turn-navigation')
  const content = page.getByTestId('operation-feedback-scroll-content')
  await expect(navigation).toBeVisible()
  for (const width of [640, 1023, 1024, 640, 1200]) {
    await panel.evaluate((element, width) => { element.style.width = `${width}px` }, width)
    if (portal) await page.getByTestId('feedback-navigation-overlay').evaluate(element => { element.style.width = '1440px' })
    if (width < 1024) {
      await expect(navigation).toBeHidden()
      await expect(content).toHaveCSS('padding-left', '0px')
    } else {
      await expect(navigation).toBeVisible()
      await expect(content).toHaveCSS('padding-left', '48px')
      const rail = await navigation.boundingBox()
      for (const card of await page.getByTestId('assistant-error-card').all()) {
        expect((await card.boundingBox())!.x).toBeGreaterThan(rail!.x + rail!.width)
      }
    }
  }
})

for (const [width, height] of [[1280, 580], [390, 640]]) {
  test(`expanded retry diagnostics stay above the composer at retry 4 and 5 (${width}px, UI-only)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height })
    await page.goto('/e2e/fixtures/reference-panels.html?panel=operation-feedback&retryTail=1')
    await page.getByTestId('feedback-show-retry').click()
    const status = page.getByTestId('provider-retry-status')
    await expect(status).toBeVisible()
    const outer = page.getByTestId('final-processing-toggle').last()
    await outer.click()
    await expect(status).toHaveCount(1)
    await expect(page.getByTestId('provider-retry-details-toggle')).toHaveAttribute('aria-expanded', 'false')
    await outer.click()
    await expect(status).toBeVisible()
    await page.getByTestId('provider-retry-details-toggle').click()
    const scroller = page.getByTestId('operation-feedback-scroll')
    for (const attempt of [4, 5]) {
      if (attempt === 5) await page.getByTestId('feedback-retry-next').click()
      await expect(status).toContainText(`${attempt}/5`)
      await scroller.evaluate(element => { element.scrollTop = element.scrollHeight })
      await expect(async () => {
        const details = await page.getByTestId('provider-retry-details').boundingBox()
        const composer = await page.getByTestId('feedback-composer').boundingBox()
        expect(details).not.toBeNull()
        expect(composer).not.toBeNull()
        expect(details!.y + details!.height).toBeLessThanOrEqual(composer!.y + 1)
      }).toPass({ timeout: 3000 })
      await page.screenshot({ path: testInfo.outputPath(`retry-${attempt}-details.png`), animations: 'disabled' })
    }
    await page.getByTestId('feedback-show-retry').click()
    await expect(status).toHaveCount(0)
  })
}

for (const width of [1280, 390]) test(`folded sibling questions remain usable without empty artifact rows at ${width}px (model-independent)`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 })
  await page.goto('/e2e/fixtures/reference-panels.html?panel=operation-feedback&disclosure=question')
  const question = page.getByTestId('request-user-input-custom-destination')
  await expect(question).toBeVisible()
  await question.fill('Owned destination draft')
  const summary = page.getByTestId('final-processing-toggle')
  await summary.click()
  await summary.click()
  await expect(question).toHaveValue('Owned destination draft')
  await page.screenshot({ path: testInfo.outputPath('folded-sibling-question.png'), animations: 'disabled' })
  await page.getByTestId('feedback-show-completed').click()
  await expect(question).toHaveCount(0)
  await expect(page.locator('[data-message-id="process-sibling"]')).toHaveCount(0)
  await page.goto('/e2e/fixtures/reference-panels.html?panel=operation-feedback&disclosure=artifacts')
  await expect(page.getByTestId('message-assistant')).toHaveCount(1)
  await expect(page.getByTestId('generated-image-gallery')).toHaveCount(0)
  await page.getByTestId('final-processing-toggle').click()
  await expect(page.getByTestId('message-assistant')).toHaveCount(2)
  await expect(page.locator('[data-message-id="process-sibling"]')).toBeVisible()
})

test('a late edit receipt cannot close another conversation draft (model-independent)', async ({ page }) => {
  await page.goto('/e2e/fixtures/reference-panels.html?panel=operation-feedback&disclosure=editing')
  await page.getByTestId('user-message-content').hover()
  await page.getByTestId('edit-message-button').click()
  await page.getByTestId('submit-edit-user-message-button').click()
  await expect(page.getByTestId('edit-user-message-textarea')).toBeDisabled()
  await page.getByTestId('feedback-show-streaming').click()
  await expect(page.getByTestId('edit-user-message-form')).toHaveCount(0)
  await page.getByTestId('user-message-content').hover()
  await page.getByTestId('edit-message-button').click()
  const draft = page.getByTestId('edit-user-message-textarea')
  await draft.fill('Another conversation draft')
  await page.getByTestId('feedback-edit-ack').click()
  await expect(draft).toHaveValue('Another conversation draft')
  await expect(draft).toBeEnabled()
})

test('switching conversations clears expanded error details for reused message identifiers (model-independent)', async ({ page }) => {
  await page.goto('/e2e/fixtures/reference-panels.html?panel=operation-feedback&disclosure=scope')
  await page.getByTestId('assistant-error-details-toggle').click()
  await expect(page.getByTestId('assistant-error-details')).toHaveText('Owned scope diagnostic')
  await page.getByTestId('feedback-show-streaming').click()
  await expect(page.getByTestId('assistant-error-details')).toHaveCount(0)
  await expect(page.getByTestId('assistant-error-card')).toHaveCount(1)
  await page.getByTestId('feedback-show-failed').click()
  await expect(page.getByTestId('assistant-error-details')).toHaveCount(0)
  await expect(page.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
})

for (const width of [1280, 390]) test(`consecutive failures and folded live siblings do not stack error cards or blank rows at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 })
  for (const failures of ['history', 'same-attempt', 'live']) {
    await page.goto(`/e2e/fixtures/reference-panels.html?panel=operation-feedback&display=three-level-v1&failures=${failures}`)
    await expect(page.getByTestId('feedback-show-failed')).toBeVisible()
    const cards = page.getByTestId('assistant-error-card')
    if (failures === 'live') {
      const liveSummary = page.getByTestId('final-processing-toggle').first()
      await expect(liveSummary).toHaveAttribute('aria-expanded', 'true')
      await liveSummary.click()
      await expect(cards).toHaveCount(0)
      await expect(page.getByTestId('message-assistant')).toHaveCount(1)
      await expect(page.getByTestId('turn-process-content')).toHaveCount(0)
    } else {
      await expect(cards).toHaveCount(1)
      await expect(cards).toHaveAttribute('data-presentation', 'current')
      await expect(page.getByTestId('assistant-error-retry')).toHaveCount(1)
      if (failures === 'history') {
        await expect(page.getByTestId('message-assistant')).toHaveCount(5)
        for (let index = 1; index <= 4; index++) {
          const row = page.locator(`[data-message-id="failed-${index}"]`)
          await row.scrollIntoViewIfNeeded()
          expect((await row.boundingBox())!.height).toBeLessThanOrEqual(48)
        }
      } else {
        await expect(page.getByTestId('message-assistant')).toHaveCount(2)
        await expect(page.getByTestId('final-processing-toggle')).toHaveCount(1)
      }
    }
    const summary = page.getByTestId('final-processing-toggle').first()
    await summary.click()
    await expect(page.getByTestId('message-assistant')).toHaveCount(5)
    if (failures !== 'live') {
      const history = page.locator('[data-testid="assistant-error-card"][data-presentation="history"]')
      await expect(history).toHaveCount(failures === 'history' ? 1 : 4)
      await history.first().getByTestId('assistant-error-details-toggle').click()
      await expect(history.first().getByTestId('assistant-error-details')).toHaveText('Saved diagnostic 1')
    }
    await summary.click()
    await expect(page.getByTestId('message-assistant')).toHaveCount(failures === 'live' ? 1 : failures === 'same-attempt' ? 2 : 5)
    await page.screenshot({ path: testInfo.outputPath(`consecutive-${failures}.png`), animations: 'disabled' })
  }
})

test('operation feedback keeps historical failures quiet and navigation outside content in both themes (model-independent)', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 1000 })
  for (const theme of ['light', 'dark']) {
    await page.goto(`/e2e/fixtures/reference-panels.html?panel=operation-feedback&theme=${theme}`)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(page.locator('main')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(17, 19, 22)' : 'rgb(255, 255, 255)')
    await expect(page.getByTestId('assistant-error-card')).toHaveCount(1)
    await expect(page.getByTestId('assistant-error-historical')).toHaveCount(0)
    const historySummary = page.getByTestId('final-processing-toggle').first()
    await historySummary.click()
    const historicalError = page.locator('[data-testid="assistant-error-card"][data-presentation="history"]')
    await expect(historicalError).toHaveCount(1)
    await historicalError.getByTestId('assistant-error-details-toggle').click()
    await expect(historicalError.getByTestId('assistant-error-details')).toHaveText('Saved diagnostic 1')
    await historySummary.click()
    await expect(page.getByTestId('assistant-error-card')).toHaveCount(1)
    await expect(page.getByTestId('assistant-error-retry')).toHaveCount(1)
    const outer = page.getByTestId('final-processing-toggle').last()
    const latestError = page.getByTestId('assistant-error-card').last()
    for (let index = 0; index < 2; index++) {
      await outer.click()
      await expect(latestError).toBeVisible()
      await expect(latestError.getByTestId('assistant-error-details-toggle')).toHaveAttribute('aria-expanded', 'false')
    }
    await latestError.getByTestId('assistant-error-details-toggle').click()
    await expect(latestError.getByTestId('assistant-error-details')).toHaveText('Saved diagnostic 3')
    await latestError.getByTestId('assistant-error-details-toggle').click()
    await expect(page.getByText('0 秒', { exact: true })).toHaveCount(0)
    await expect(page.getByText('不足 1 秒', { exact: true })).toHaveCount(3)
    const navigation = page.getByTestId('message-turn-navigation')
    await expect(navigation).toBeVisible()
    const rail = await navigation.boundingBox()
    expect(rail).not.toBeNull()
    const cards = await page.getByTestId('assistant-error-card').all()
    for (const card of cards) {
      const box = await card.boundingBox()
      expect(box!.x).toBeGreaterThan(rail!.x + rail!.width)
    }
    for (const marker of await page.getByTestId('message-turn-navigation-marker').all()) {
      expect((await marker.boundingBox())!.height).toBeGreaterThanOrEqual(24)
    }
    await page.getByTestId('assistant-error-retry').click()
    await expect(page.getByTestId('feedback-action')).toHaveText('failed-3')
    await page.screenshot({ path: testInfo.outputPath(`operation-feedback-${theme}.png`), animations: 'disabled' })
    await page.getByTestId('feedback-show-streaming').click()
    await expect(page.getByTestId('assistant-error-card')).toHaveCount(0)
    await expect(page.getByTestId('final-processing-toggle')).toHaveCount(3)
    await expect(page.getByTestId('assistant-error-retry')).toHaveCount(0)
    await page.getByTestId('feedback-show-completed').click()
    await expect(page.getByText('Later response', { exact: true })).toBeVisible()
    await expect(page.getByTestId('thinking-indicator')).toHaveCount(0)
    await page.getByTestId('feedback-show-retry').click()
    await expect(page.getByTestId('provider-retry-status')).toHaveAttribute('data-state', 'retrying')
    await expect(page.getByTestId('provider-retry-status')).not.toContainText('15 秒后重试')
    await page.getByTestId('feedback-show-retry').click()
    await expect(page.getByTestId('provider-retry-status')).toHaveCount(0)
  }
  await page.setViewportSize({ width: 390, height: 850 })
  await expect(page.getByTestId('message-turn-navigation')).toBeHidden()
  const widths = await page.evaluate(() => ({ actual: document.documentElement.scrollWidth, viewport: innerWidth }))
  expect(widths.actual).toBeLessThanOrEqual(widths.viewport)
})


test('automation snapshot polling has one visible owner and idles on retained pages (model-independent)', async ({ page }) => {
  await page.route('**/api/servers', route => route.fulfill({
    json: { servers: [{ id: 'local', label: 'Fixture target', transport: 'local' }] },
  }))
  await page.clock.install()
  await page.goto('/e2e/fixtures/control-style-preview.html?polling=1')
  const count = () => page.locator('html').getAttribute('data-automation-reads').then(value => Number(value ?? 0))
  await expect.poll(count).toBeGreaterThan(0)
  await page.getByTestId('fixture-toggle-automation').click()
  const hidden = await count()
  await page.clock.runFor(60_000)
  expect(await count()).toBe(hidden)
  await page.getByTestId('fixture-toggle-automation').click()
  await expect.poll(count).toBeGreaterThan(hidden)
  await page.getByTestId('automation-tab-history').click()
  await expect(page.getByTestId('automation-run-history')).toBeVisible()
  await page.clock.runFor(100)
  const history = await count()
  await page.clock.runFor(15_000)
  expect(await count()).toBe(history + 3)
  await page.getByTestId('fixture-toggle-automation').click()
  const hiddenHistory = await count()
  await page.clock.runFor(60_000)
  expect(await count()).toBe(hiddenHistory)
})

for (const [locale, width] of [['zh-CN', 1280], ['en', 390]] as const) {
  test(`three-level v1 is the default, persists mode switching and keeps progress visible (${locale}, ${width})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const url = `/e2e/fixtures/reference-panels.html?panel=processing&locale=${locale}&theme=dark`
    await page.goto(url)
    const two = page.getByTestId('general-process-display-two-level-v1')
    const three = page.getByTestId('general-process-display-three-level-v1')
    await expect(three).toHaveAttribute('aria-pressed', 'true')
    await expect(three).toHaveText(locale === 'en' ? 'Three-level folding v1' : '三层折叠 v1')
    const settingsFit = await two.evaluate(element => {
      const group = element.parentElement!.getBoundingClientRect()
      return group.left >= 0 && group.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth
    })
    expect(settingsFit).toBe(true)
    await two.click()
    await expect(two).toHaveAttribute('aria-pressed', 'true')
    await page.reload()
    await expect(two).toHaveAttribute('aria-pressed', 'true')
    await three.click()
    await expect(three).toHaveAttribute('aria-pressed', 'true')
    await page.reload()
    await expect(three).toHaveAttribute('aria-pressed', 'true')
    await two.click()
    await expect(two).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('fixture-process-new').click()
    await expect(page.getByTestId('final-processing-toggle')).toHaveCount(0)
    const group = page.getByTestId('process-activity-toggle')
    await expect(group).toHaveAttribute('aria-expanded', 'false')
    await expect(group).toContainText(locale === 'en' ? 'Executed' : '已执行')
    await expect(group).toHaveAccessibleName(locale === 'en'
      ? /Executed .*2 reasoning steps.*1 tool call.*Analyzing the request/
      : /已执行 .*思考 2.*工具调用 1.*正在分析请求/)
    await expect(page.getByTestId('process-activity-heading')).toContainText(/\d/)
    await expect(page.getByText('我会先查找相关说明，再检查页面布局。', { exact: true })).toBeVisible()
    for (const containerWidth of [300, 160]) {
      await page.getByTestId('process-activity-group').evaluate((element, value) => { element.style.width = `${value}px` }, containerWidth)
      await expect(group.locator('.turn-process-activity')).toBeHidden()
      const geometry = await group.evaluate(element => ({ height: element.getBoundingClientRect().height,
        width: element.clientWidth, scrollWidth: element.scrollWidth }))
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width)
      expect(geometry.height).toBe(await page.getByTestId('process-text-block').first().locator('p').first()
        .evaluate(element => element.getBoundingClientRect().height))
    }
    await page.getByTestId('process-activity-group').evaluate(element => { element.style.width = '' })
    await group.click()
    for (const thought of await page.getByTestId('assistant-thinking-toggle').all()) await expect(thought).toHaveAttribute('aria-expanded', 'false')
    await page.screenshot({ path: testInfo.outputPath(`two-level-running-${locale}-${width}.png`), animations: 'disabled' })
    await page.getByTestId('fixture-process-finish').click()
    await expect(group).toHaveAttribute('aria-expanded', 'true')
    await expect(group).toContainText(locale === 'en' ? 'Executed' : '已执行')
    await expect(page.getByText('我会先查找相关说明，再检查页面布局。', { exact: true })).toBeVisible()
    await expect(page.getByText('最终回复：任务完成。', { exact: true })).toBeVisible()
    await expect(page.getByTestId('final-processing-toggle')).toHaveCount(0)
    await page.getByTestId('fixture-process-settings').click()
    await expect(two).toHaveAttribute('aria-pressed', 'true')
    await three.click()
    await expect(three).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('fixture-process-back').click()
    await expect(page.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('我会先查找相关说明，再检查页面布局。', { exact: true })).toHaveCount(0)
    await expect(page.getByText('最终回复：任务完成。', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`three-level-completed-${locale}-${width}.png`), animations: 'disabled' })
  })
}

for (const [locale, width] of [['zh-CN', 1280], ['en', 390]] as const) {
  test(`two-level group timers freeze independently (${locale}, ${width})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/e2e/fixtures/reference-panels.html?panel=processing&display=two-level-v1&locale=${locale}&theme=dark`)
    await page.getByTestId('fixture-process-new').click()
    await page.getByTestId('fixture-group-timing').click()
    const headings = page.getByTestId('process-activity-heading')
    await expect(headings).toHaveCount(2)
    const frozen = locale === 'en' ? 'Executed 2s' : '已执行 2秒'
    await expect(headings.nth(0)).toHaveText(frozen)
    await expect(page.getByTestId('process-activity-toggle').nth(0)).toHaveAccessibleName(locale === 'en'
      ? 'Executed 2s · 1 reasoning step · 1 tool call' : '已执行 2秒 · 思考 1 · 工具调用 1')
    const active = locale === 'en' ? /^Executed \d+s$/ : /^已执行 \d+秒$/
    await expect(headings.nth(1)).toHaveText(active)
    const previous = await headings.nth(1).textContent()
    await expect.poll(() => headings.nth(1).textContent()).not.toBe(previous)
    await expect(headings.nth(0)).toHaveText(frozen)
    await expect(page.getByTestId('process-activity-toggle').nth(0).locator('.animate-spin')).toHaveCount(0)
    await expect(page.getByTestId('process-activity-toggle').nth(1).locator('.animate-spin')).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath(`independent-group-times-${locale}.png`), animations: 'disabled' })
    await page.getByTestId('fixture-process-finish').click()
    await expect(headings.nth(0)).toHaveText(frozen)
    await expect(headings.nth(1)).toContainText(locale === 'en' ? 'Executed' : '已执行')
    expect(await headings.nth(1).textContent()).not.toBe(frozen)
    await expect(page.getByTestId('process-activity-toggle').nth(1).locator('.animate-spin')).toHaveCount(0)
    for (const toggle of await page.getByTestId('process-activity-toggle').all()) await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
