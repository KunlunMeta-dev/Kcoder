import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { startChromium } from '../../e2e/harness/chromium.mjs'
import { startGateway } from '../../e2e/harness/gateway.mjs'
import { assertRendererBuildFresh } from '../../e2e/harness/renderer-build.mjs'
import { runIntegration, waitFor } from '../../e2e/harness/run-context.mjs'
import { materializeWorkspace } from '../../e2e/harness/workspace-fixture.mjs'

const QUESTION_ID = 'responsive-status-question'
const TASK_PROMPT = 'RESPONSIVE_COMPOSER_STATUS_TASK'
const COMPOSER_DRAFT = 'Keep this composer draft'
const suiteSource = await readFile(new URL(import.meta.url))

const sourceRoot = process.env.KCODER_E2E_RENDERER_SOURCE_ROOT
await assertRendererBuildFresh(sourceRoot ? { sourceRoot } : {})
await runIntegration(import.meta.url, {
  testId: 'composer-status-responsive-actual-workbench',
  tier: 'full-integration',
  modelPolicy: 'model-independent actual WorkbenchPage/MobileWorkbenchLayout, KCODER_STUDIO_MOCK Gateway, Chromium, and page-owned asyncQuestion protocol fixture; no paid model calls',
  retainSuccessEvidence: true,
  evidenceReason: 'The narrow Workbench route, async-question retirement, composer draft, and 320/390px overflow need real browser evidence',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', {
    instanceId: 'composer-status-responsive',
  })
  const gateway = await startGateway(context, {
    auth: true,
    label: 'composer-status-responsive-gateway',
    workspace,
    // This UI protocol fixture does not stage or exercise Native channel bundles.
    // An unavailable binding stays fail-closed instead of staging the developer's SDK tree.
    env: {
      KCODER_STUDIO_MOCK: '1',
      KCODER_NATIVE_CONNECTIVITY_BINDING_V1: 'unavailable-for-ui-protocol-fixture',
    },
  })
  const chromium = await startChromium(context, {
    label: 'composer-status-responsive-chromium',
    startTimeoutMs: 60_000,
  })
  const page = await chromium.newPage({ viewport: { width: 320, height: 700 }, locale: 'zh-CN' })
  const fixture = createAsyncQuestionFixture()
  await fixture.install(page)
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(`pageerror: ${error.message}`))
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`)
  })

  try {
    const response = await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' })
    assert.equal(response?.status(), 200, 'the owned Gateway must serve the actual renderer')
    await page.locator('input[name="token"]').fill(gateway.authToken)
    await Promise.all([
      page.waitForURL(url => !url.pathname.startsWith('/login')),
      page.locator('button[type="submit"]').click(),
    ])
    await page.getByTestId('mobile-empty-header').waitFor({ timeout: 30_000 })
    await page.getByTestId('model-selector-button').click()
    await page.locator('[data-testid^="model-option-"]').filter({ hasText: 'MiniMax-M3' }).click()
    const input = page.getByTestId('chat-message-input')
    await input.fill(TASK_PROMPT)
    await page.getByTestId('send-message-button').click()
    await page.getByTestId('mobile-chat-input-dock').waitFor({ timeout: 30_000 })
    await assertNoHorizontalOverflow(page, 320)
    await waitFor(() => fixture.state.listRequests.length > 0, 30_000,
      'Workbench-created task asyncQuestion/list', 50, context.abortSignal)
    await page.getByTestId(`async-question-card-${QUESTION_ID}`).waitFor({ state: 'attached', timeout: 30_000 })

    assert.ok(fixture.state.threadStarts > 0, 'the composer must create a new mock thread')
    assert.equal(fixture.state.threadStartReceipts.length, 1, 'one authoritative create receipt must own this fixture')
    assert.ok(fixture.state.turnStarts.some(prompt => prompt.includes(TASK_PROMPT)), 'the entered task prompt must reach the mock turn')
    assert.ok(fixture.state.listRequests.every(item => item.includeTerminal), 'the renderer must read the full question ledger')
    assert.ok(fixture.state.listRequests.every(item => item.threadId === fixture.state.threadId), 'question reads must stay bound to the created thread')
    assert.equal(await page.getByTestId(`async-question-card-${QUESTION_ID}`).getAttribute('data-status'), 'pending')

    const statusTrigger = page.getByTestId('composer-status-trigger-questions')
    await statusTrigger.waitFor({ state: 'visible', timeout: 20_000 })
    if (await statusTrigger.getAttribute('aria-expanded') !== 'true') await statusTrigger.click()
    await page.getByTestId(`async-question-card-${QUESTION_ID}`).waitFor({ state: 'visible', timeout: 10_000 })
    await input.fill(COMPOSER_DRAFT)
    await waitFor(async () => page.getByTestId('send-message-button').isEnabled(), 15_000,
      'mock task turn to finish before draft and answer checks', 50, context.abortSignal)
    await input.fill('/goal')
    await input.press('Tab')
    await page.getByTestId('goal-draft-pill').waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByTestId('cancel-goal-draft-button').focus()
    await page.getByTestId('cancel-goal-draft-button').press('Enter')
    await page.getByTestId('goal-draft-pill').waitFor({ state: 'detached' })
    await input.fill(COMPOSER_DRAFT)

    const viewports = []
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: width === 320 ? 700 : 844 })
      await assertNoHorizontalOverflow(page, width)
      assert.equal(await input.innerText(), COMPOSER_DRAFT, 'responsive layout changes must preserve the composer draft')
      viewports.push({ width, pendingQuestionVisible: await page.getByTestId(`async-question-card-${QUESTION_ID}`).isVisible() })
      await page.screenshot({ path: context.pathInArtifacts(`pending-question-${width}.png`), fullPage: true })
    }

    await page.getByTestId('request-user-input-option-choice-0').click()
    await page.getByTestId('request-user-input-submit-button').click()
    await waitFor(() => fixture.state.answerRequests.length === 1, 20_000,
      'asyncQuestion/answer acknowledgement', 50, context.abortSignal)
    await page.getByTestId(`async-question-card-${QUESTION_ID}`).waitFor({ state: 'detached', timeout: 20_000 })
    assert.equal(await input.innerText(), COMPOSER_DRAFT, 'retiring a completed question must preserve the ordinary composer draft')
    assert.equal(fixture.state.record.status, 'context_applied')

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: width === 320 ? 700 : 844 })
      await assertNoHorizontalOverflow(page, width)
      assert.equal(await input.innerText(), COMPOSER_DRAFT)
      assert.equal(await page.getByTestId(`async-question-card-${QUESTION_ID}`).count(), 0,
        'context_applied question must stay out of the active composer projection')
      await page.screenshot({ path: context.pathInArtifacts(`retired-question-${width}.png`), fullPage: true })
    }
    assert.deepEqual(browserErrors, [], 'the actual mobile Workbench route must not emit browser errors')

    assert.deepEqual(await readFile(new URL(import.meta.url)), suiteSource,
      'the executable suite source must stay unchanged during acceptance')
    const evidence = {
      acceptance: 'actual WorkbenchPage -> MobileWorkbenchLayout -> owner-scoped ComposerStatusRegion -> AsyncQuestionPanel',
      modelPolicy: 'KCODER_STUDIO_MOCK plus page-scoped app-server asyncQuestion protocol fixture; no paid model calls',
      nativeConnectivity: 'explicitly unavailable; Native channel bundles are outside this UI protocol fixture',
      boundary: 'Chromium browser acceptance at 320px and 390px; not Android/iOS native acceptance',
      runRoot: context.runRoot,
      renderer: { sourceRoot: sourceRoot ?? 'current checkout', buildRoot: process.env.KCODER_E2E_RENDERER_ROOT ?? 'current checkout dist' },
      workspace,
      gateway: { baseUrl: gateway.baseUrl, port: gateway.port },
      fixture: fixture.state,
      viewports,
      composerDraftPreserved: true,
      compactGoalDraftAvailable: true,
      completedQuestionRetired: fixture.state.record.status === 'context_applied',
      browserErrors,
      suiteSourceSha256: createHash('sha256').update(suiteSource).digest('hex'),
    }
    await context.writeArtifactJson('composer-status-responsive-evidence.json', evidence)
    return evidence
  } catch (error) {
    await context.writeArtifactJson('composer-status-responsive-failure.json', {
      fixture: fixture.state,
      browserErrors,
      body: (await page.locator('body').innerText().catch(() => '')).slice(0, 12_000),
      layout: await page.evaluate(() => {
        const element = document.querySelector('[data-testid="mobile-chat-input-dock"]')
        const result = []
        for (let node = element; node; node = node.parentElement) {
          const box = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          result.push({ tag: node.tagName, id: node.getAttribute('data-testid'), className: node.className,
            x: box.x, width: box.width, height: box.height, display: style.display,
            flex: style.flex, minWidth: style.minWidth, overflow: style.overflow })
        }
        return result
      }).catch(() => []),
    })
    await page.screenshot({ path: context.pathInArtifacts('failure.png'), fullPage: true }).catch(() => {})
    throw error
  } finally {
    await page.close()
  }
})

function createAsyncQuestionFixture() {
  const state = {
    threadId: null,
    threadStarts: 0,
    threadStartReceipts: [],
    turnStarts: [],
    listRequests: [],
    answerRequests: [],
    record: null,
    methods: [],
    rpcErrors: [],
  }
  return {
    state,
    async install(page) {
      await page.routeWebSocket('**/rpc*', socket => {
        const upstream = socket.connectToServer()
        const requests = new Map()
        socket.onMessage(raw => {
          const frame = parseFrame(raw)
          if (frame?.method && state.methods.length < 200) state.methods.push(frame.method)
          if (frame?.method === 'initialize' && frame.id !== undefined) requests.set(frame.id, frame.method)
          if (frame?.method === 'thread/start') state.threadStarts += 1
          if (frame?.method === 'turn/start') state.turnStarts.push(String(frame.params?.input?.[0]?.text ?? ''))
          if (frame?.method === 'asyncQuestion/list' && frame.id !== undefined) {
            const threadId = String(frame.params?.threadId ?? '')
            state.listRequests.push({ threadId, includeTerminal: frame.params?.includeTerminal === true })
            if (!threadId || threadId !== state.threadId) {
              socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'fixture thread owner mismatch' } }))
              return
            }
            state.record ??= makePendingQuestion(threadId)
            socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { threadId, questions: [state.record] } }))
            return
          }
          if (frame?.method === 'asyncQuestion/answer' && frame.id !== undefined) {
            const params = frame.params ?? {}
            state.answerRequests.push({ threadId: params.threadId, questionId: params.questionId, expectedRevision: params.expectedRevision })
            if (!state.record || params.threadId !== state.threadId || params.questionId !== QUESTION_ID || params.expectedRevision !== state.record.revision) {
              socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'fixture answer identity mismatch' } }))
              return
            }
            state.record = {
              ...state.record,
              revision: state.record.revision + 1,
              status: 'context_applied',
              answer: {
                submissionId: String(params.submissionId),
                acceptedAtMs: Date.now(),
                answers: params.answers,
              },
            }
            socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {
              accepted: true,
              duplicate: false,
              threadId: state.threadId,
              question: state.record,
            } }))
            socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'asyncQuestion/changed', params: {
              threadId: state.threadId,
              question: state.record,
              sequence: state.record.revision,
            } }))
            return
          }
          if (frame?.id !== undefined && frame?.method) requests.set(frame.id, frame.method)
          upstream.send(raw)
        })
        upstream.onMessage(raw => {
          const frame = parseFrame(raw)
          if (frame?.error) state.rpcErrors.push({ method: requests.get(frame.id), code: frame.error.code, message: frame.error.message })
          if (requests.get(frame?.id) === 'thread/start' && typeof frame?.result?.thread?.id === 'string') {
            state.threadStartReceipts.push(frame.result.thread.id)
            state.threadId ??= frame.result.thread.id
          }
          if (requests.get(frame?.id) === 'initialize' && frame?.result) {
            const capabilities = frame.result.capabilities ?? {}
            const experimental = capabilities.experimental ?? {}
            socket.send(JSON.stringify({
              ...frame,
              result: {
                ...frame.result,
                capabilities: { ...capabilities, experimental: { ...experimental, asyncUserQuestionsV1: true } },
              },
            }))
            requests.delete(frame.id)
            return
          }
          socket.send(raw)
        })
      })
    },
  }
}

function makePendingQuestion(threadId) {
  return {
    questionId: QUESTION_ID,
    requestId: 'request-responsive-status',
    threadId,
    sourceTurnId: 'turn-responsive-status',
    toolCallId: 'tool-responsive-status',
    revision: 1,
    createdAtMs: Date.now(),
    status: 'pending',
    questions: [{
      id: 'choice',
      header: '窄屏状态测试',
      question: '选择用于状态投影测试的选项',
      multiSelect: false,
      options: [{ id: 'option-one', label: '继续', description: '确定回答' }],
    }],
  }
}

function parseFrame(raw) {
  try { return JSON.parse(String(raw)) } catch { return null }
}

async function assertNoHorizontalOverflow(page, width) {
  const actual = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    dock: document.querySelector('[data-testid="mobile-chat-input-dock"]')?.getBoundingClientRect().width ?? 0,
  }))
  assert.equal(actual.viewport, width)
  assert.ok(Math.max(actual.document, actual.body) <= width,
    `Mobile Workbench horizontal overflow at ${width}px: ${JSON.stringify(actual)}`)
  assert.ok(actual.dock >= width - 2,
    `Mobile Workbench must fill the viewport at ${width}px: ${JSON.stringify(actual)}`)
}
