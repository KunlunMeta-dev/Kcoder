import { expect, test, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'

async function prepare(page: Page, history = false, extraQuery = '') {
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
  await page.route('**/api/servers', route =>
    route.fulfill({
      json: {
        servers: [{ id: 'local', label: 'Fixture', transport: 'local', workspacePath: '/fixture' }],
      },
    })
  )
  await page.setViewportSize({ width: 1280, height: 760 })
  await page.goto(
    `/e2e/fixtures/reference-panels.html?panel=widgets&scroll=1${history ? '&history=1' : ''}${extraQuery}`
  )
}

async function sampleScroll(page: Page, frames = 120) {
  return page.getByTestId('widget-conversation-scroll').evaluate(async (scroller, count) => {
    const samples = []
    for (let index = 0; index < count; index += 1) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      samples.push({
        index,
        top: scroller.scrollTop,
        height: scroller.scrollHeight,
        viewport: scroller.clientHeight,
        widgets: [...scroller.querySelectorAll<HTMLElement>('[data-testid="inline-widget"]')].map(
          widget => ({
            title: widget.textContent?.slice(0, 50),
            height: widget.getBoundingClientRect().height,
            state: widget.dataset.widgetStatus,
            frame: Boolean(widget.querySelector('iframe')),
          })
        ),
      })
    }
    return samples
  }, frames)
}

test('model-independent widgets keep a user-scrolled conversation stable while visible frames settle', async ({
  page,
}, info) => {
  await prepare(page, true)
  const scroller = page.getByTestId('widget-conversation-scroll')
  await expect(page.getByTestId('inline-widget-frame').first()).toBeVisible()
  await scroller.hover({ position: { x: 18, y: 300 } })
  await page.mouse.wheel(0, -420)
  const samples = await sampleScroll(page)
  await writeFile(
    info.outputPath('user-scroll-frame-samples.json'),
    JSON.stringify(samples, null, 2)
  )
  await page.screenshot({ path: info.outputPath('user-scroll-visible-widgets.png') })
  const settled = samples.slice(30)
  const movement =
    Math.max(...settled.map(sample => sample.top)) - Math.min(...settled.map(sample => sample.top))
  const heightMovement =
    Math.max(...settled.map(sample => sample.height)) -
    Math.min(...settled.map(sample => sample.height))
  expect(
    movement,
    `Main scrollbar kept moving after the user wheel gesture; content height varied ${heightMovement}px`
  ).toBeLessThanOrEqual(3)
  expect(settled.at(-1)!.height - settled.at(-1)!.viewport - settled.at(-1)!.top).toBeGreaterThan(
    100
  )
})

test('model-independent widget source previews do not steal an anonymous conversation from a user reading history', async ({
  page,
}, info) => {
  await prepare(page, false, '&noScrollKey=1')
  const scroller = page.getByTestId('widget-conversation-scroll')
  await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(1000)
  await scroller.hover({ position: { x: 18, y: 300 } })
  await page.mouse.wheel(0, -520)
  await expect
    .poll(() => scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop))
    .toBeGreaterThan(300)
  const before = await scroller.evaluate(node => ({
    top: node.scrollTop,
    height: node.scrollHeight,
  }))
  await page
    .getByTestId('widget-fixture-prefix')
    .evaluate(node => (node as HTMLButtonElement).click())
  await expect(page.getByTestId('widget-deferred-status').first()).toBeVisible()
  await expect(page.getByTestId('widget-svg-prefix')).toHaveCount(0)
  const samples = await sampleScroll(page, 90)
  await writeFile(
    info.outputPath('anonymous-preview-scroll-samples.json'),
    JSON.stringify({ before, samples }, null, 2)
  )
  await page.screenshot({ path: info.outputPath('anonymous-preview-reading-position.png') })
  expect(samples.at(-1)!.height - samples.at(-1)!.viewport - samples.at(-1)!.top).toBeGreaterThan(
    300
  )
})

test('model-independent terminal promotion keeps the explicit user pause after the processing window contracts', async ({
  page,
}, info) => {
  await prepare(page, false, '&singleWidget=1&denseProcess=1&slowContent=1')
  const scroller = page.getByTestId('widget-conversation-scroll')
  await page.getByTestId('widget-fixture-prefix').click()
  await expect(page.getByTestId('widget-deferred-status').first()).toBeVisible()
  await expect(page.getByTestId('widget-svg-prefix')).toHaveCount(0)
  await page.getByTestId('widget-fixture-commit').click()
  await expect
    .poll(async () =>
      Number(await page.getByTestId('widget-fixture-active-receipts').textContent())
    )
    .toBeGreaterThan(0)
  await scroller.hover({ position: { x: 18, y: 300 } })
  await page.mouse.wheel(0, -64)
  await expect
    .poll(() => scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop))
    .toBeGreaterThan(40)
  const before = await scroller.evaluate(node => ({
    top: node.scrollTop,
    height: node.scrollHeight,
  }))
  await page
    .getByTestId('widget-fixture-complete')
    .evaluate(node => (node as HTMLButtonElement).click())
  const samples = await sampleScroll(page, 120)
  await writeFile(
    info.outputPath('terminal-promotion-scroll-samples.json'),
    JSON.stringify({ before, samples }, null, 2)
  )
  await page.screenshot({ path: info.outputPath('terminal-promotion-reading-position.png') })
  expect(
    samples.at(-1)!.top,
    'A contracted process window must not convert an explicit history-reading pause into auto-follow'
  ).toBeLessThanOrEqual(before.top + 3)
})

test('model-independent previews and final widgets follow the bottom only while the user keeps following', async ({
  page,
}, info) => {
  await prepare(page)
  const scroller = page.getByTestId('widget-conversation-scroll')
  const distance = () =>
    scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)
  await expect.poll(distance).toBeLessThanOrEqual(2)
  await page.getByTestId('widget-fixture-prefix').click()
  await expect(page.getByTestId('widget-deferred-status').first()).toBeVisible()
  await expect(page.getByTestId('widget-svg-prefix')).toHaveCount(0)
  await expect.poll(distance).toBeLessThanOrEqual(2)
  await page.getByTestId('widget-fixture-prefix').click()
  await page.getByTestId('widget-fixture-commit').click()
  await expect
    .poll(async () =>
      Number(await page.getByTestId('widget-fixture-active-receipts').textContent())
    )
    .toBeGreaterThan(0)
  await expect.poll(distance).toBeLessThanOrEqual(2)
  await page.getByTestId('widget-fixture-complete').click()
  const samples = await sampleScroll(page, 150)
  await writeFile(
    info.outputPath('bottom-follow-scroll-samples.json'),
    JSON.stringify(samples, null, 2)
  )
  const final = samples.at(-1)!
  expect(final.height - final.viewport - final.top).toBeLessThanOrEqual(2)
  expect(
    Math.max(...samples.slice(90).map(sample => sample.top)) -
      Math.min(...samples.slice(90).map(sample => sample.top)),
    'Settled widgets must not keep oscillating the main scrollbar'
  ).toBeLessThanOrEqual(3)
})

test('model-independent visible widget ready resize and theme changes preserve the user reading anchor', async ({
  page,
}, info) => {
  await prepare(page, true)
  const scroller = page.getByTestId('widget-conversation-scroll')
  await expect(page.getByTestId('inline-widget-frame').first()).toBeVisible()
  await scroller.hover({ position: { x: 18, y: 300 } })
  await page.mouse.wheel(0, -420)
  await expect
    .poll(() => scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop))
    .toBeGreaterThan(200)
  // Ready precedes the sandbox's measured SVG resize; observe that real layout first.
  const overviewFrame = page.locator('iframe[title="可视化类型"]')
  await expect
    .poll(async () => (await overviewFrame.boundingBox())?.height ?? 1000)
    .toBeLessThan(300)
  const chart = page.getByTestId('inline-widget').filter({ hasText: '季度营收与同比增速' })
  await expect(chart).toHaveAttribute('data-widget-status', 'ready')
  const frame = chart.getByTestId('inline-widget-frame')
  await expect.poll(async () => (await frame.boundingBox())?.height ?? 0).toBeGreaterThan(380)
  const anchor = await scroller.evaluate(node => {
    const outer = node.getBoundingClientRect()
    const candidate = [...node.querySelectorAll<HTMLElement>('[data-scroll-anchor]')].find(
      element => {
        const rect = element.getBoundingClientRect()
        return rect.top >= outer.top && rect.top < outer.top + outer.height / 2
      }
    )
    if (!candidate) throw new Error('No visible production message anchor')
    candidate.dataset.widgetScrollReadingAnchor = 'true'
    return candidate.getBoundingClientRect().top - outer.top
  })
  const oldHeight = (await frame.boundingBox())!.height
  // A real child ResizeObserver reports a late layout change, without forged bridge messages.
  await page
    .frameLocator('iframe[title="季度营收与同比增速"]')
    .locator('#widget-root')
    .evaluate(node => {
      const block = document.createElement('div')
      block.style.height = '180px'
      block.textContent = 'Late chart layout content'
      node.append(block)
    })
  await expect
    .poll(async () => (await frame.boundingBox())?.height ?? 0)
    .toBeGreaterThan(oldHeight + 100)
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  const samples = await sampleScroll(page, 90)
  const finalAnchor = await scroller.evaluate(node => {
    const reading = node.querySelector<HTMLElement>('[data-widget-scroll-reading-anchor]')
    if (!reading) throw new Error('Reading anchor was replaced')
    return reading.getBoundingClientRect().top - node.getBoundingClientRect().top
  })
  await writeFile(
    info.outputPath('visible-resize-theme-scroll-samples.json'),
    JSON.stringify({ anchor, finalAnchor, samples }, null, 2)
  )
  expect(Math.abs(finalAnchor - anchor)).toBeLessThanOrEqual(3)
  expect(samples.at(-1)!.height - samples.at(-1)!.viewport - samples.at(-1)!.top).toBeGreaterThan(
    100
  )
})

test('model-independent scrolling inside a tall widget keeps the conversation stationary', async ({
  page,
}, info) => {
  await prepare(page, true, '&tallWidget=1')
  const scroller = page.getByTestId('widget-conversation-scroll')
  const host = page.getByTestId('inline-widget')
  await expect(host).toHaveAttribute('data-widget-status', 'ready')
  const inner = page.frameLocator('iframe[title="长图示内部滚动"]').locator('#widget-root')
  await expect
    .poll(() => inner.evaluate(node => node.scrollHeight - node.clientHeight))
    .toBeGreaterThan(1000)
  const before = await scroller.evaluate(node => node.scrollTop)
  await inner.hover({ position: { x: 30, y: 100 } })
  await page.mouse.wheel(0, 320)
  await expect.poll(() => inner.evaluate(node => node.scrollTop)).toBeGreaterThan(200)
  const samples = await sampleScroll(page, 90)
  await writeFile(
    info.outputPath('inner-widget-wheel-scroll-samples.json'),
    JSON.stringify({ before, samples }, null, 2)
  )
  expect(Math.max(...samples.map(sample => Math.abs(sample.top - before)))).toBeLessThanOrEqual(3)
})
