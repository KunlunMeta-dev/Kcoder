import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test('model-independent widget renderer keeps 100 histories bounded, survives 100 real prefixes and measures local input latency', async ({page}, testInfo) => {
  const document = await readFile(new URL('../../public/widget-sandbox/host-v1.html', import.meta.url), 'utf8')
  const policy = JSON.parse(await readFile(new URL('../../public/widget-sandbox/policy-v1.json', import.meta.url), 'utf8'))
  await page.route('**/api/widgets/sandbox-v1.html', route => route.fulfill({ status:200, contentType:'text/html', body:document,
    headers:{'Content-Security-Policy':policy.csp,'Cache-Control':'no-store'} }))
  await page.setViewportSize({width:1280,height:900})
  await page.goto('/e2e/fixtures/reference-panels.html?panel=widget-performance')
  const first = page.getByTestId('performance-item-performance-widget-0')
  await expect(first.getByTestId('inline-widget')).toHaveAttribute('data-widget-status','ready')
  await expect(page.locator('[data-testid^=performance-item-]')).toHaveCount(100)
  expect(await page.getByTestId('inline-widget-frame').count()).toBeLessThanOrEqual(3)
  const frame = page.frameLocator('iframe[title="Performance widget 0"]')
  await frame.locator('input[type=range]').nth(2).focus()
  await page.keyboard.press('ArrowRight')
  await expect(frame.locator('input[type=number]').nth(2)).toHaveValue('8')
  await first.getByTestId('inline-widget-frame').evaluate(element => element.setAttribute('data-stable-instance','initial'))
  await page.evaluate(() => {
    const stats = { inserted:0, maximum:document.querySelectorAll('iframe').length }
    const observer = new MutationObserver(records => {
      stats.inserted += records.reduce((count,record)=>count+[...record.addedNodes].filter(node=>node instanceof HTMLIFrameElement).length,0)
      stats.maximum = Math.max(stats.maximum,document.querySelectorAll('iframe').length)
    })
    observer.observe(document.body,{childList:true,subtree:true})
    Object.assign(window,{widgetPerformanceStats:stats,widgetPerformanceObserver:observer})
  })
  for (let index=1;index<=100;index++) {
    await page.getByTestId('performance-delta').evaluate(element=>(element as HTMLButtonElement).click())
    await expect(page.getByTestId('performance-delta-count')).toHaveText(String(index))
  }
  await expect(first.getByTestId('inline-widget-frame')).toHaveAttribute('data-stable-instance','initial')
  const stability = await page.evaluate(()=>(window as Window & {widgetPerformanceStats:{inserted:number;maximum:number}}).widgetPerformanceStats)
  expect(stability.inserted).toBe(0)
  expect(stability.maximum).toBeLessThanOrEqual(3)
  await page.getByTestId('performance-composer').fill('Draft remains editable after 100 deltas')
  await expect(page.getByTestId('performance-composer')).toHaveValue('Draft remains editable after 100 deltas')
  const samples = await frame.locator('input[type=range]').nth(2).evaluate(async element => {
    const input = element as HTMLInputElement, samples:number[]=[]
    for(let index=1;index<=30;index++) {
      const started=performance.now(); input.value=String(index)
      input.dispatchEvent(new Event('input',{bubbles:true}))
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))
      samples.push(performance.now()-started)
      const actual=Number(document.querySelector('output')?.getAttribute('data-value'))
      if(Math.abs(actual-560000*1.085**index)>1e-5) throw new Error('Local update diverged from independent calculation')
    }
    input.value='8'; input.dispatchEvent(new Event('input',{bubbles:true}))
    return samples
  })
  const p95=[...samples].sort((a,b)=>a-b)[Math.ceil(samples.length*.95)-1]
  expect(p95).toBeLessThanOrEqual(100)
  for (const index of [25,50,75,99]) {
    const item=page.getByTestId(`performance-item-performance-widget-${index}`)
    await item.scrollIntoViewIfNeeded()
    await expect(item.getByTestId('inline-widget')).toHaveAttribute('data-widget-status','ready')
    expect(await page.getByTestId('inline-widget-frame').count()).toBeLessThanOrEqual(3)
  }
  await first.scrollIntoViewIfNeeded()
  await expect(first.getByTestId('inline-widget')).toHaveAttribute('data-widget-status','ready')
  await expect(frame.locator('input[type=number]').nth(2)).toHaveValue('8')
  const result={scope:'model-independent actual renderer',historyWidgets:100,realPrefixUpdates:100,maximumActiveFrames:3,
    remountsDuringPrefixes:stability.inserted,sliderSamplesMs:samples,sliderP95Ms:p95,
    browser:await page.context().browser()?.version(),viewport:page.viewportSize()}
  await testInfo.attach('widget-performance.json',{body:JSON.stringify(result,null,2),contentType:'application/json'})
})
