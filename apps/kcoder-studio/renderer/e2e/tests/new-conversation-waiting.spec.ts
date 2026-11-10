import { expect, test, type WebSocketRoute } from '@playwright/test'
import { withWaitingLayoutGateway } from '../../../e2e/harness/waiting-layout-gateway.mjs'

test('new conversation keeps the waiting indicator still before first output', async ({ page }) => {
  test.setTimeout(60_000)
  await withWaitingLayoutGateway(async fixture => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.addInitScript(() => {
      const samples: Record<string, unknown>[] = []
      const state = window as typeof window & {
        __waitingLayout: typeof samples
        __stopWaitingSample: boolean
      }
      state.__waitingLayout = samples
      const sample = () => {
        if (state.__stopWaitingSample) return
        const waiting = document.querySelector('[data-testid="thinking-indicator"]')
        const article = waiting?.closest('article')
        const parent = article?.parentElement
        const list = parent?.hasAttribute('data-index') ? parent.parentElement : parent
        const user = [...(list?.querySelectorAll('[data-testid="message-user"]') ?? [])].at(-1)
        const scroller = waiting?.closest('[data-testid="desktop-workbench-content"]')
        if (waiting && waiting.getClientRects().length) {
          samples.push({
            y: waiting.getBoundingClientRect().top,
            userY: user?.getBoundingClientRect().top,
            height: user?.getBoundingClientRect().height,
            time: performance.now(),
            articleY: article?.getBoundingClientRect().top,
            articleHeight: article?.getBoundingClientRect().height,
            articleType: article?.getAttribute('data-testid'),
            messageId: article?.getAttribute('data-message-id'),
            userId: user?.getAttribute('data-message-id'),
            userText: user?.textContent?.slice(0, 80),
            listGap: list ? getComputedStyle(list).rowGap : null,
            listTop: list?.getBoundingClientRect().top,
            scrollTop: scroller?.scrollTop,
            scrollHeight: scroller?.scrollHeight,
          })
        }
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    await page.goto(fixture.baseUrl)
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 30_000 })
    const project = page.getByTestId('project-item').filter({ hasText: 'Waiting fixture' }).first()
    await project.hover()
    await project.getByTestId('project-new-conversation-button').click()
    await page.getByTestId('chat-message-input').click()
    await page.keyboard.insertText('测试新会话等待响应位置')
    await page.getByTestId('send-message-button').click()
    await expect(page.getByText('已连接当前虚拟机。', { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    })
    const positions = await page.evaluate(() => {
      const state = window as typeof window & {
        __waitingLayout: { y: number; userId: string | null; articleType: string | null }[]
        __stopWaitingSample: boolean
      }
      state.__stopWaitingSample = true
      return state.__waitingLayout
    })
    await fixture.writePositions(positions)
    // The mock later injects a separate history attachment; measure the same
    // first-message handoff before that unrelated fixture data is inserted.
    const handoff = positions.filter(sample => sample.userId === positions[0]?.userId)
    expect(handoff.some(sample => sample.articleType === 'message-assistant-waiting')).toBe(true)
    expect(handoff.some(sample => sample.articleType === 'message-assistant')).toBe(true)
    const y = handoff.map(sample => sample.y)
    expect(
      Math.max(...y) - Math.min(...y),
      'waiting moved during new-conversation initialization'
    ).toBeLessThanOrEqual(1)
  })
})

test('reconnects the task socket with a notice outside the conversation', async ({ page }) => {
  await withWaitingLayoutGateway(async fixture => {
    let taskSocket: WebSocketRoute | undefined
    let releaseResume: (() => void) | undefined
    let holdResume = false
    let sawTerminal = false
    await page.routeWebSocket(url => url.pathname === '/rpc', socket => {
      const server = socket.connectToServer()
      socket.onMessage(message => {
        const { method } = JSON.parse(String(message)) as { method?: string }
        if (method === 'turn/start') taskSocket = socket
        if (method === 'thread/resume' && holdResume) {
          releaseResume = () => server.send(message)
          return
        }
        server.send(message)
      })
      server.onMessage(message => {
        const { method } = JSON.parse(String(message)) as { method?: string }
        if (socket === taskSocket && method === 'turn/completed') {
          // The backend completed, but the renderer loses this frame with the socket.
          sawTerminal = true
          return
        }
        socket.send(message)
      })
    })
    await page.goto(fixture.baseUrl)
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 30_000 })
    const project = page.getByTestId('project-item').filter({ hasText: 'Waiting fixture' }).first()
    await project.hover()
    await project.getByTestId('project-new-conversation-button').click()
    await page.getByTestId('chat-message-input').click()
    await page.keyboard.insertText('验证任务重连提示')
    await page.getByTestId('send-message-button').click()
    await expect(page.getByText('已连接当前虚拟机。', { exact: false }).first()).toBeVisible()
    await expect.poll(() => sawTerminal).toBe(true)
    expect(taskSocket).toBeDefined()
    const messages = page.getByTestId('message-assistant')
    const assistantCount = await messages.count()

    holdResume = true
    await taskSocket!.close()
    const notice = page.getByTestId('task-connection-notice')
    await expect(notice).toContainText('连接中断，正在重连')
    await expect(page.getByTestId('desktop-floating-composer-card').getByRole('status')
      .filter({ hasText: '连接中断，正在重连' })).toBeVisible()
    await expect(messages).toHaveCount(assistantCount)
    await expect.poll(() => Boolean(releaseResume)).toBe(true)

    holdResume = false
    releaseResume?.()
    await expect(notice).toHaveCount(0)
    await expect(page.locator('[data-message-id*="runtime-reconnecting"]')).toHaveCount(0)
    await expect(page.getByText('KCoder app-server 连接已断开，已停止当前任务')).toHaveCount(0)
  })
})
