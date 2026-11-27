import { expect, test } from '@playwright/test'

test('MCP App protocol forwards original data, authorized requests and explicit draft decisions', async ({
  page,
}) => {
  await page.goto('/e2e/fixtures/mcp-app.html')
  await expect(page.getByTestId('mcp-proof-kind')).toContainText('conformance only')
  const app = page.frameLocator('[data-testid=inline-widget-frame]')
  await expect(app.locator('#input')).toContainText('input:{"value":7}')
  await expect(app.locator('#result')).toContainText('"uiOnly":8')
  await expect(app.locator('#result')).toContainText('"original":true')
  await expect(app.locator('#capabilities')).toContainText('"serverTools":{}')
  await app.locator('#refresh').click()
  await expect(app.locator('#action')).toContainText('refresh:8')
  await expect(page.getByTestId('mcp-actions')).toHaveText('1')
  await app.locator('#foreign').click()
  await expect(app.locator('#foreign-result')).toContainText('not app-visible')
  await expect(page.getByTestId('mcp-actions')).toHaveText('1')
  await app.locator('#resource').click()
  await expect(app.locator('#data')).toContainText('original resource')
  await expect(page.getByTestId('mcp-resource-reads')).toHaveText('1')
  await app.locator('#draft').click()
  await expect(page.getByRole('button', { name: '添加到草稿' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '所属会话草稿' })).toHaveValue('保留已有草稿')
  await page.getByRole('button', { name: '添加到草稿' }).click()
  await expect(page.getByRole('textbox', { name: '所属会话草稿' })).toHaveValue(
    '保留已有草稿\n\n请解释这组数据'
  )
  await expect(app.locator('#draft-result')).toHaveText('drafted')
})
test('historical MCP UI keeps its data and offers no live tool or resource capability', async ({
  page,
}) => {
  await page.goto('/e2e/fixtures/mcp-app.html?history=1')
  const app = page.frameLocator('[data-testid=inline-widget-frame]')
  await expect(app.locator('#result')).toContainText('visible original result')
  await expect(app.locator('#capabilities')).not.toContainText('serverTools')
  await expect(app.locator('#capabilities')).not.toContainText('serverResources')
  await app.locator('#refresh').click()
  await expect(app.locator('#action')).toContainText('read-only')
  await app.locator('#resource').click()
  await expect(app.locator('#data')).toContainText('read-only')
  await expect(page.getByTestId('mcp-actions')).toHaveText('0')
  await expect(page.getByTestId('mcp-resource-reads')).toHaveText('0')
})
