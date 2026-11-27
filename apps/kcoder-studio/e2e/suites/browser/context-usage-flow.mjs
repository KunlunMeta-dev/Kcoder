import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect } from '../../../renderer/node_modules/@playwright/test/index.mjs'
import { startApprovalModelFixture } from '../../harness/approval-model.mjs'
import { startChromium } from '../../harness/chromium.mjs'
import { startGateway } from '../../harness/gateway.mjs'
import { repoRoot } from '../../harness/run-context.mjs'
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs'
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs'
import { prepareIsolatedRealModelConfig, realModelPreflight } from '../../harness/real-model.mjs'

export async function verifyContextUsage(context, { realModel }) {
  if (realModel && !process.env.KCODER_E2E_MODEL_PROFILE) {
    throw new Error('Select an approved KCODER_E2E_MODEL_PROFILE')
  }

  // The run-owned Native profile must satisfy the cold metadata reader's privacy contract.
  const previousUmask = process.umask(0o077)
  context.addCleanup('restore context-usage test umask', () => { process.umask(previousUmask) })

  const { path: workspace } = await materializeWorkspace(context, 'minimal', {
    instanceId: 'live-context-usage',
  })
  const approved = realModel ? await realModelPreflight(process.env.KCODER_E2E_MODEL_PROFILE) : null
  const isolated = approved ? await prepareIsolatedRealModelConfig(context, {
    ...approved,
    providerConfig: { ...approved.providerConfig, max_output_tokens: 1024, max_retries: 0, request_timeout_secs: 120 },
  }) : null
  const configDir = isolated?.configDir ?? context.pathInState('kcoder-config')
  if (!isolated) {
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    await context.writeStateJson('kcoder-config/settings.json', {})
    await context.writeStateJson('kcoder-config/credentials.json', {
      'context-usage-fixture': { type: 'api', key: 'context-usage-fixture-key' },
    })
  }

  let releaseFollowUp = false
  const providerFixture = approved ? null : await startApprovalModelFixture(context, {
    responseSteps: ({ body }) => [
      { delta: { role: 'assistant', content: 'CONTEXT_USAGE_RESPONSE' } },
      {
        finishReason: 'stop',
        ready: () => releaseFollowUp || !JSON.stringify(body.messages).includes('CONTEXT_USAGE_FOLLOW_UP'),
      },
    ],
    usage: {
      prompt_tokens: 10_000,
      completion_tokens: 2_000,
      total_tokens: 12_000,
      prompt_tokens_details: { cached_tokens: 8_000 },
    },
  })
  const settingsFile = isolated?.settingsFile ?? await context.writeStateJson('kcoder-settings.json', {
    active_provider: 'context-usage-fixture',
    max_retries: 0,
    providers: {
      'context-usage-fixture': {
        api_format: 'openai_chat_completions',
        endpoint: providerFixture?.baseUrl,
        default_model: 'context-usage-fixture-model',
        context_window_tokens: 100_000,
        output_headroom_tokens: 8_192,
        max_output_tokens: 4_096,
        request_timeout_secs: 30,
        no_proxy: true,
        extra_body: {},
      },
    },
  })
  const serversFile = await context.writeStateJson('servers.json', [{
    id: 'local',
    label: 'Context Usage E2E',
    runtime: 'kcoder',
    transport: 'local',
    command: approved?.kcoderBin ?? process.env.KCODER_E2E_KCODER_BIN ?? resolve(repoRoot, 'target/debug/kcoder'),
    workspace,
    settingsFile,
    ...(approved ? { profile: approved.profile } : {}),
  }])
  await assertRendererBuildFresh()
  const gateway = await startGateway(context, {
    workspace,
    serversFile,
    auth: true,
    startTimeoutMs: 120_000,
    env: {
      KCODER_CONFIG_DIR: configDir,
      ...(approved ? {
        KCODER_TRAINING_MODE: 'true',
        KCODER_MAX_TOKENS: '1024', KCODER_MAX_RETRIES: '0', KCODER_MAX_DURATION_SECS: '120',
        ...Object.fromEntries(approved.credentialEnv.filter(name => process.env[name])
          .map(name => [name, process.env[name]])),
      } : {}),
    },
  })
  const chromium = await startChromium(context, { label: 'context-usage-browser' })
  const page = await chromium.newPage({ viewport: { width: 1280, height: 800 } })
  let verified = false
  const failureScreenshot = context.pathInArtifacts('context-usage-failed.png')
  context.addCleanup('capture context-usage browser failure', async () => {
    if (!verified && !page.isClosed()) await page.screenshot({ path: failureScreenshot })
  })
  const diagnostics = []
  const reportedUsage = []
  const completedTurns = []
  page.on('websocket', socket => socket.on('framereceived', frame => {
    let message
    try { message = JSON.parse(String(frame.payload)) } catch { return }
    const event = message.params?.event
    if (message.method === 'item/event' && event?.type === 'context_usage_updated') {
      reportedUsage.push(event.contextUsage)
    }
    if (message.method === 'turn/completed') completedTurns.push(message.params?.turn?.status)
  }))
  page.on('pageerror', error => diagnostics.push(`pageerror: ${error.message}`))
  page.on('console', message => {
    if (message.type() === 'error') diagnostics.push(`console: ${message.text()}`)
  })

  await login(page, gateway.baseUrl, gateway.authToken)
  await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' })
  const project = page.getByTestId('project-item').filter({ hasText: 'Context Usage E2E' }).first()
  await project.waitFor({ state: 'visible', timeout: 60_000 })
  await project.hover()
  await project.getByTestId('project-new-conversation-button').click()
  const composer = page.getByTestId('chat-message-input')
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await expect(page.getByTestId('context-usage-indicator')).toHaveCount(0)
  await composer.click()
  await page.keyboard.insertText(approved
    ? '请用一句简短中文打招呼，不要调用工具。' : 'CONTEXT_USAGE_E2E')
  await page.getByTestId('send-message-button').click()

  if (providerFixture) {
    await expect(page.getByTestId('message-assistant').filter({ hasText: 'CONTEXT_USAGE_RESPONSE' }))
      .toBeVisible({ timeout: 60_000 })
  } else {
    await expect(page.getByTestId('message-assistant').first()).toBeVisible({ timeout: 120_000 })
  }
  if (providerFixture) assert.ok(providerFixture.requests.length >= 1, 'the browser turn must reach the loopback SSE provider')
  await expect.poll(() => completedTurns.at(-1), { timeout: 120_000 }).toBe('completed')
  await expect.poll(() => reportedUsage.length).toBeGreaterThan(0)

  const usageIndicator = page.getByTestId('context-usage-indicator')
  await expect(usageIndicator).toBeVisible({ timeout: 30_000 })
  const percentage = page.getByTestId('context-usage-percent')
  const lastUsage = reportedUsage.at(-1)
  const usedTokens = lastUsage?.last?.totalTokens
  const contextWindow = lastUsage?.modelContextWindow
  if (providerFixture) {
    assert.equal(usedTokens, 12_000, 'the UI stream must carry the provider usage snapshot')
    assert.equal(contextWindow, 100_000, 'the UI stream must carry the active model context window')
  }
  assert.ok(Number.isFinite(usedTokens) && usedTokens > 0, 'provider must report positive usage')
  assert.ok(Number.isFinite(contextWindow) && contextWindow > 0, 'effective context window must be known')
  const expectedPercent = `已用 ${Math.min(100, Math.round(usedTokens / contextWindow * 100))}%`
  await expect(page.getByTestId('context-usage-button')).toHaveText('')
  await expect(percentage).toBeHidden()
  await usageIndicator.hover()
  await expect(page.getByTestId('context-usage-tooltip')).toContainText('上下文用量')
  await expect(percentage).toContainText(expectedPercent, { timeout: 30_000 })
  const indicatorBounds = await usageIndicator.boundingBox()
  const modelSelectorBounds = await page.getByTestId('model-selector-button').boundingBox()
  assert.ok(indicatorBounds && modelSelectorBounds, 'context usage and model selector must be laid out')
  assert.ok(indicatorBounds.x < modelSelectorBounds.x, 'context usage must sit beside the model selector')
  await page.screenshot({ path: context.pathInArtifacts('context-usage-wide.png') })

  if (providerFixture) {
    const completedBeforeFollowUp = completedTurns.length
    await composer.click()
    await page.keyboard.insertText('CONTEXT_USAGE_FOLLOW_UP')
    await page.getByTestId('send-message-button').click()
    await expect(page.getByTestId('pause-response-button')).toBeVisible()
    await expect(usageIndicator).toBeVisible()
    await usageIndicator.hover()
    await expect(percentage).toContainText(expectedPercent)
    await page.screenshot({ path: context.pathInArtifacts('context-usage-running.png') })
    releaseFollowUp = true
    await expect.poll(() => completedTurns.length, { timeout: 60_000 })
      .toBeGreaterThan(completedBeforeFollowUp)
    await expect(usageIndicator).toBeVisible()
    await expect(percentage).toContainText(expectedPercent)
  }

  const requestsBeforeReload = providerFixture?.requests.length
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(usageIndicator).toBeVisible({ timeout: 60_000 })
  await usageIndicator.hover()
  await expect(percentage).toContainText(expectedPercent)
  if (providerFixture) assert.equal(providerFixture.requests.length, requestsBeforeReload,
    'restoring context usage must not invoke the provider')
  await page.screenshot({ path: context.pathInArtifacts('context-usage-restored.png') })

  await page.setViewportSize({ width: 960, height: 800 })
  await expect(usageIndicator).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(percentage).toBeHidden()
  await expect(page.getByTestId('context-usage-button')).toHaveText('')
  await usageIndicator.hover()
  await expect(percentage).toBeVisible()
  await expect(percentage).toContainText(expectedPercent)
  const compactIndicatorBounds = await usageIndicator.boundingBox()
  assert.ok(compactIndicatorBounds && compactIndicatorBounds.width >= 20)
  assert.deepEqual(diagnostics, [])

  await context.writeArtifactJson('context-usage-live.json', {
    model: approved?.model ?? 'context-usage-fixture-model',
    providerProfile: approved?.profile ?? 'context-usage-fixture',
    providerRequests: providerFixture?.requests.length ?? null,
    usage: lastUsage?.last ?? { inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 },
    modelContextWindow: contextWindow ?? 100_000,
    expectedPercent,
    completedTurns,
    wideLayout: { indicatorVisible: true, inlinePercentageVisible: false, tooltipPercentageVisible: true, adjacentToModel: true },
    narrowLayout: { indicatorVisible: true, inlinePercentageVisible: false, tooltipPercentageVisible: true },
    diagnostics,
  })
  await page.screenshot({ path: context.pathInArtifacts('context-usage-live.png') })
  verified = true
  return {
    providerToEngineToGatewayToComposer: true,
    realModel,
    model: approved?.model ?? 'context-usage-fixture-model',
    providerRequests: providerFixture?.requests.length ?? null,
    displayedUsage: expectedPercent,
    iconOnlyAtAllWidths: true,
    contextUsageSurvivesPageReload: true,
    contextUsageVisibleWhileRunning: providerFixture ? true : null,
  }
}

async function login(page, baseUrl, token) {
  const response = await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  assert.equal(response?.status(), 200)
  await page.locator('input[name="token"]').fill(token)
  await Promise.all([
    page.waitForURL(url => !url.pathname.startsWith('/login'), { waitUntil: 'domcontentloaded', timeout: 60_000 }),
    page.locator('button[type="submit"]').click(),
  ])
  await page.getByTestId('desktop-sidebar').waitFor({ state: 'visible', timeout: 90_000 })
}
