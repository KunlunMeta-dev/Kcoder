import { expect, test } from '@playwright/test'

const themes = ['light', 'dark'] as const
const widths = [320, 390] as const
const locales = ['zh-CN', 'en'] as const
const copy = {
  'zh-CN': {
    query: '查询创建状态',
    connection: '检查连接',
    unknownHealth: '目标连接状态尚未确认',
    onlineHealth: '目标最近状态：在线。上方记录是此前的发送错误。',
    failedAt: /^失败于/,
    unknownOutcome: '创建结果尚未确认。可以稍后再查询，请勿重复发送。',
    messageUnknown: '已找到原会话，但首条消息是否接收尚未确认。请打开后先核对内容。',
    openOriginal: '打开原会话',
    details: '创建失败详情',
  },
  en: {
    query: 'Check creation status',
    connection: 'Check connection',
    unknownHealth: 'Target connection status is unconfirmed',
    onlineHealth: 'Latest target status: online. The error above is from the earlier send.',
    failedAt: /^Failed /,
    unknownOutcome: 'The creation outcome is still unknown. Check again later without resending.',
    messageUnknown:
      'The conversation exists, but initial message acceptance is unknown. Open it and check its contents first.',
    openOriginal: 'Open original conversation',
    details: 'Creation failure details',
  },
} as const

for (const locale of locales) {
  for (const theme of themes) {
    for (const width of widths) {
      test(`failed-task recovery stays usable at ${width}px in ${locale}/${theme} (synthetic callbacks, model-independent)`, async ({
        page,
      }, testInfo) => {
        const text = copy[locale]
        await page.setViewportSize({ width, height: 820 })
        await page.goto(`/e2e/fixtures/failed-task-recovery.html?locale=${locale}&theme=${theme}`)

        const frame = page.getByTestId('recovery-frame')
        const frameBox = await frame.boundingBox()
        expect(frameBox?.width).toBeLessThanOrEqual(320)
        expect(frameBox?.x).toBeGreaterThanOrEqual(0)
        const noHorizontalOverflow = async () => {
          const metrics = await page.evaluate(() => ({
            viewport: window.innerWidth,
            document: document.documentElement.scrollWidth,
            body: document.body.scrollWidth,
          }))
          expect(Math.max(metrics.document, metrics.body)).toBeLessThanOrEqual(metrics.viewport)
        }
        await noHorizontalOverflow()

        const queryButton = page.getByRole('button', { name: text.query })
        const connectionButton = page.getByRole('button', { name: text.connection })
        for (const button of [queryButton, connectionButton]) {
          const metrics = await button.evaluate(element => ({
            minHeight: Number.parseFloat(getComputedStyle(element).minHeight),
            height: element.getBoundingClientRect().height,
          }))
          expect(metrics.minHeight).toBeGreaterThanOrEqual(44)
          expect(metrics.height).toBeGreaterThanOrEqual(44)
        }

        const details = page.locator('[data-testid="recovery-frame"] details')
        const rawError = details.locator('p')
        const failedTime = page.locator('[data-testid="recovery-frame"] time')
        await expect(page.getByTestId('failed-task-target-health')).toContainText(
          text.unknownHealth
        )
        await expect(failedTime).toHaveAttribute('datetime', '2026-11-13T09:00:00.000Z')
        await expect(failedTime).toContainText(text.failedAt)
        await expect(queryButton).toBeDisabled()
        await expect(details).not.toHaveAttribute('open', '')
        await expect(rawError).toBeHidden()
        await page.screenshot({
          path: testInfo.outputPath(`recovery-${locale}-${theme}-${width}-unknown.png`),
          fullPage: true,
        })

        // A newer target status updates task.updatedAt but must retain failedAt and the error.
        // The fixture callback is the boundary: changing status must not query, open, or resend.
        await page.getByTestId('target-status-online').click()
        await expect(page.getByTestId('task-updated-at')).toHaveText('2026-11-13T12:00:00.000Z')
        await expect(page.getByTestId('failed-task-target-health')).toContainText(text.onlineHealth)
        await expect(failedTime).toHaveAttribute('datetime', '2026-11-13T09:00:00.000Z')
        await expect(failedTime).toContainText(text.failedAt)
        await expect(rawError).toBeHidden()
        await expect(queryButton).toBeEnabled()
        await expect(page.getByTestId('query-calls')).toHaveText('0')
        await expect(page.getByTestId('open-calls')).toHaveText('0')
        await expect(page.getByTestId('navigate-calls')).toHaveText('0')
        await noHorizontalOverflow()
        await page.screenshot({
          path: testInfo.outputPath(`recovery-${locale}-${theme}-${width}-online.png`),
          fullPage: true,
        })

        await queryButton.click()
        await expect(page.getByText(text.unknownOutcome)).toBeVisible()
        await expect(page.getByRole('button', { name: text.openOriginal })).toHaveCount(0)
        await expect(page.getByTestId('query-calls')).toHaveText('1')
        await expect(page.getByTestId('open-calls')).toHaveText('0')
        await expect(page.getByTestId('navigate-calls')).toHaveText('0')
        await noHorizontalOverflow()

        await page.getByTestId('mode-ready-message-unknown').click()
        await page.getByRole('button', { name: text.query }).click()
        await expect(page.getByText(text.messageUnknown)).toBeVisible()
        await expect(page.getByRole('button', { name: text.openOriginal })).toBeVisible()
        await expect(page.getByTestId('query-calls')).toHaveText('2')
        await expect(page.getByTestId('open-calls')).toHaveText('0')
        await expect(page.getByTestId('navigate-calls')).toHaveText('0')
        await expect(details).not.toHaveAttribute('open', '')
        await expect(rawError).toBeHidden()
        await noHorizontalOverflow()

        await page.getByRole('button', { name: text.openOriginal }).click()
        await expect(page.getByTestId('open-calls')).toHaveText('1')
        await expect(page.getByTestId('navigate-calls')).toHaveText('1')
        await expect(details).not.toHaveAttribute('open', '')

        await details.locator('summary').click()
        await expect(details).toHaveAttribute('open', '')
        await expect(rawError).toBeVisible()
        await expect(rawError).toContainText('Synthetic fixture error:')
        await noHorizontalOverflow()
        if (locale === 'zh-CN' && theme === 'light' && width === 320) {
          await page.screenshot({
            path: testInfo.outputPath('recovery-320-light-expanded.png'),
            fullPage: true,
          })
        }
      })
    }
  }
}
