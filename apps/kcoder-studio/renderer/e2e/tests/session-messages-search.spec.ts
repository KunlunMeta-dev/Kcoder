import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

interface SessionMessagesSearchRequest { operation: string; source: string; title?: string; cursor?: string }

declare global {
  interface Window {
    __sessionMessagesSearchFixture: {
      requests: SessionMessagesSearchRequest[]
      composerEnterCount: number
      modelCalls: number
      navigationCalls: number
      releaseOldSearch(): void
    }
  }
}

async function sourceIdentity() {
  const paths = ['src/components/chat/SessionMessagesControl.tsx', '../shared/agentMessageController.ts',
    'src/i18n/locales/zh-CN/chat.json', 'src/i18n/locales/en/chat.json', 'e2e/fixtures/session-messages-search.tsx']
  return Promise.all(paths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(resolve(path))).digest('hex') })))
}

test('owned browser title-search UI keeps committed filters, ignores stale results and never dispatches a turn', async ({ page }, info) => {
  const source = await sourceIdentity()
  await page.route('**/api/servers', route => route.fulfill({ json: { servers: [] } }))
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto('/e2e/fixtures/session-messages-search.html')
  await page.getByTestId('session-messages-open').click()
  await expect(page.getByText('默认会话', { exact: true })).toBeVisible()
  await page.getByTestId('session-message-target').click()
  await page.getByTestId('session-message-input').fill('不发送的示例草稿')
  const search = page.getByRole('searchbox', { name: '按会话标题搜索' })
  await search.fill('旧'); await search.press('Enter')
  await expect.poll(() => page.evaluate(() => window.__sessionMessagesSearchFixture.requests.filter(r => r.operation === 'targets' && r.title === '旧').length)).toBe(1)
  await expect(page.getByTestId('session-message-target')).toHaveCount(0)
  await search.fill('新'); await search.press('Enter')
  await expect(page.getByText('新结果', { exact: true })).toBeVisible()
  await page.evaluate(() => window.__sessionMessagesSearchFixture.releaseOldSearch())
  await expect(page.getByText('旧结果', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('session-message-send')).toBeDisabled()
  await expect(page.getByTestId('session-message-input')).toHaveValue('不发送的示例草稿')
  await search.fill('未提交草稿')
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__sessionMessagesSearchFixture.requests.filter(r => r.operation === 'targets' && r.title === '新').length)).toBe(2)
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.getByText('新结果更多', { exact: true })).toBeVisible()
  await search.fill('新')
  await page.screenshot({ path: info.outputPath('session-title-search-desktop.png'), fullPage: true })
  await page.getByTestId('session-message-search-clear').click()
  await expect(search).toHaveValue(''); await expect(page.getByText('默认会话', { exact: true })).toBeVisible()
  await expect(page.getByTestId('session-message-send')).toBeDisabled()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByTestId('search-fixture-switch-source').click()
  await page.getByTestId('session-messages-open').click()
  await expect(page.getByText('新来源默认会话')).toBeVisible()
  await expect(page.getByTestId('session-message-title-search')).toHaveValue('')
  const evidence = await page.evaluate(() => {
    const state = window.__sessionMessagesSearchFixture
    return { requests: state.requests, composerEnterCount: state.composerEnterCount, modelCalls: state.modelCalls, navigationCalls: state.navigationCalls }
  })
  expect(evidence.requests.every(r => ['supports', 'policyRead', 'targets'].includes(r.operation))).toBe(true)
  expect(evidence.requests.some(r => r.title === '未提交草稿')).toBe(false)
  expect(await sourceIdentity()).toEqual(source)
  expect(evidence.composerEnterCount).toBe(0); expect(evidence.modelCalls).toBe(0); expect(pageErrors).toEqual([])
  await writeFile(info.outputPath('session-title-search-ui-proof.json'), JSON.stringify({ modelIndependentUiFixture: true, source, ...evidence, pageErrors }, null, 2))
})

test('owned narrow browser shows legacy default listing without claiming title-search support', async ({ page }, info) => {
  const source = await sourceIdentity()
  await page.route('**/api/servers', route => route.fulfill({ json: { servers: [] } }))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/e2e/fixtures/session-messages-search.html?legacy=1')
  await page.getByTestId('session-messages-open').click()
  await expect(page.getByText('默认会话', { exact: true })).toBeVisible()
  await expect(page.getByTestId('session-message-title-search')).toBeDisabled()
  await expect(page.getByTestId('session-message-search-help')).toContainText('不支持标题搜索')
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  const layout = await page.getByTestId('session-messages-dialog').evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1)
  expect(await sourceIdentity()).toEqual(source)
  await page.screenshot({ path: info.outputPath('session-title-search-legacy-narrow.png'), fullPage: true })
  const evidence = await page.evaluate(() => window.__sessionMessagesSearchFixture.requests)
  expect(evidence.every(r => ['supports', 'policyRead', 'targets'].includes(r.operation) && r.title === undefined)).toBe(true)
  await writeFile(info.outputPath('legacy-title-search-ui-proof.json'), JSON.stringify({ modelIndependentUiFixture: true, source, requests: evidence, layout }, null, 2))
})
