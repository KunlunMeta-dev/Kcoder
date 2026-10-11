// phases / selection for the existing desktop runner.
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  ATTACHMENT_ONLY,
  BLOCKED_CLOUD_MODEL_PATH,
  CLOUD_ONLY,
  CLOUD_PUBLIC_MODEL_NAME,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DESKTOP_SCENARIO_ONLY,
  DROPPED_WORKSPACE_PATHS_ONLY,
  GOAL_IDLE_ONLY,
  GOAL_RESTART_ONLY,
  MODEL_API_KEY,
  PASTED_WORKSPACE_PATHS_ONLY,
  PLUGINS_ONLY,
  RETRY_ONLY,
  SHORT_CONVERSATION_ONLY,
  SYSTEM_DRAG_PANEL_ONLY,
  TOOL_BLOCK_ORDER_ONLY,
  TURN_NAVIGATION_ONLY,
  TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX,
  TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX,
  TURN_NAVIGATION_REGRESSION_TURN_COUNT,
  UI_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  resultDir,
} from '../config.mjs'
import {
  verifyAttachmentOnlySidebarLifecycle,
  verifyDroppedWorkspacePaths,
  verifyPastedWorkspacePaths,
  verifySystemDragPanelLayout,
} from '../attachment-bindings.mjs'
import {
  verifyCloudProjectFlow,
  verifyConnectedModelsOnLocalExecution,
} from '../model-scenarios.mjs'
import { codexUpstreamApiFormat, writeCodexConfig } from '../builds.mjs'
import { withTimeout, writeRedactedJson } from '../runtime.mjs'
import {
  captureVerificationScreenshot,
  ensureModelOptionVisible,
  selectE2EModel,
  sendPrompt,
  triggerModelReloadUntilCloudFailure,
} from '../ui-helpers.mjs'
import { verifyToolBlockChronologicalOrder } from '../session-scenarios.mjs'
import { verifyRetryFailureRestoration } from '../recovery-scenarios.mjs'
import {
  verifyActiveGoalIdleUnreadLifecycle,
  verifyGoalRestartRecoveryLifecycle,
} from '../runtime-bindings.mjs'
import { verifyShortConversationLayout } from '../conversation-scenarios.mjs'
import { verifyPluginLifecycle } from '../plugin-scenarios.mjs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

export async function runSelectionPhase(
  {
    workspacePath,
    executorHome,
    pluginMarketplacePath,
    executorLogPath,
    desktopScenario,
    control,
    cloudEnvironment,
    appIdentifier,
    restartDesktopApp,
  },
  state
) {
  if (SYSTEM_DRAG_PANEL_ONLY) {
    state.phase = 'system-drag-panel-layout'
    await verifySystemDragPanelLayout(control)
    console.log(`Wework desktop system-drag-panel E2E passed. Evidence: ${resultDir}`)
    return { stop: true }
  }

  if (CLOUD_ONLY) {
    state.phase = 'local-connected-model-protocol-matrix'
    await verifyConnectedModelsOnLocalExecution({
      control,
      cloudEnvironment,
      setCodexUpstreamProtocol: protocol =>
        writeCodexConfig(
          join(executorHome, 'codex'),
          control.url,
          '',
          codexUpstreamApiFormat(protocol)
        ),
      workspacePath,
    })
    state.phase = 'cloud-project-flow'
    await verifyCloudProjectFlow(control, cloudEnvironment, workspacePath)
    await writeRedactedJson(join(resultDir, 'model-requests.json'), control.modelRequests, [
      MODEL_API_KEY,
      cloudEnvironment?.authToken,
    ])
    console.log(`Wework desktop cloud-project E2E passed. Diagnostics: ${resultDir}`)
    return { stop: true }
  }

  state.phase = 'cloud-request-non-blocking'
  await withTimeout(
    control.awaitBlockedCloudRequest(BLOCKED_CLOUD_MODEL_PATH),
    WORKBENCH_READY_TIMEOUT_MS,
    'The connected desktop app did not start the intentionally blocked cloud model request'
  )
  await control.command('waitFor', '[data-testid="projects-create-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  control.failBlockedCloudModels()
  await triggerModelReloadUntilCloudFailure(control)
  control.restoreCloudModels()
  await control.command('dispatchLocalModelSettingsChanged', '')
  const canonicalModelOption = `model-option-${DEFAULT_MODEL_ID}`
  const synthesizedModelOption = `model-option-codex-${DEFAULT_MODEL_ID}`
  const legacyGpt55ModelOption = 'model-option-gpt-5.5'
  const publicModelOption = `model-option-${CLOUD_PUBLIC_MODEL_NAME}`
  const recoveredModelMenu = await ensureModelOptionVisible(control, canonicalModelOption)
  assert.equal(
    recoveredModelMenu.testIds.filter(testId => testId === canonicalModelOption).length,
    1,
    'The canonical Executor model appeared more than once'
  )
  assert.equal(
    recoveredModelMenu.testIds.includes(synthesizedModelOption),
    false,
    'The Backend-synthesized runtime Codex duplicate remained visible'
  )
  assert.equal(
    recoveredModelMenu.testIds.includes(legacyGpt55ModelOption),
    false,
    'The legacy GPT 5.5 Codex model remained visible'
  )
  assert.equal(
    (await ensureModelOptionVisible(control, publicModelOption)).testIds.includes(
      publicModelOption
    ),
    true,
    'The independent public model was removed while deduplicating runtime Codex'
  )
  await captureVerificationScreenshot(control, '00-canonical-model-catalog.png')
  await control.command('press', 'body', { key: 'Escape' })

  if (TOOL_BLOCK_ORDER_ONLY) {
    state.phase = 'tool-block-chronological-order'
    await verifyToolBlockChronologicalOrder({
      control,
      executorHome,
      restartDesktopApp,
      workspacePath,
    })
    console.log(`Wework desktop tool-block-order E2E passed. Evidence: ${resultDir}`)
    return { stop: true }
  }

  if (RETRY_ONLY) {
    state.phase = 'retry-failure-restoration'
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
    await verifyRetryFailureRestoration(control, ACTIVE_COMPOSER_SELECTOR)
    console.log(`Wework desktop retry-restoration E2E passed. Evidence: ${resultDir}`)
    return { stop: true }
  }

  if (GOAL_IDLE_ONLY) {
    state.phase = 'goal-idle-state-lifecycle'
    await verifyActiveGoalIdleUnreadLifecycle({
      composerSelector: ACTIVE_COMPOSER_SELECTOR,
      control,
    })
    console.log(`Wework desktop Goal idle-state E2E passed. Evidence: ${resultDir}`)
    return { stop: true }
  }

  if (GOAL_RESTART_ONLY) {
    state.phase = 'goal-restart-recovery'
    await verifyGoalRestartRecoveryLifecycle({
      composerSelector: ACTIVE_COMPOSER_SELECTOR,
      control,
      executorLogPath,
      restartDesktopApp,
    })
    console.log(`Wework desktop Goal restart E2E passed. Evidence: ${resultDir}`)
    return { stop: true }
  }

  if (TURN_NAVIGATION_ONLY) {
    state.phase = 'turn-navigation-only'
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
    control.setScenario('turn_navigation')
    for (let index = 0; index < TURN_NAVIGATION_REGRESSION_TURN_COUNT; index += 1) {
      const turnNumber = index + 1
      await sendPrompt(
        control,
        ACTIVE_COMPOSER_SELECTOR,
        `${TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX}_${turnNumber}`
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        {
          text: `${TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX}_${turnNumber}`,
          timeoutMs: UI_TIMEOUT_MS,
        }
      )
    }
    console.log(
      'Turn navigation metrics:',
      await control.command('getElementMetrics', '[data-testid="desktop-workbench-content"]')
    )
    await control.command('waitFor', '[data-testid="message-turn-navigation-marker"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    console.log(`Wework desktop turn-navigation E2E passed. Evidence: ${resultDir}`)
    return { stop: true }
  }

  if (ATTACHMENT_ONLY) {
    state.phase = 'attachment-only-sidebar'
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
    await verifyAttachmentOnlySidebarLifecycle({
      app: state.app,
      appIdentifier,
      composerSelector: ACTIVE_COMPOSER_SELECTOR,
      control,
    })
    console.log(`Wework desktop attachment-only E2E passed. Evidence: ${resultDir}`)
    return { stop: true }
  }

  if (PASTED_WORKSPACE_PATHS_ONLY) {
    state.phase = 'pasted-workspace-paths'
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
    await verifyPastedWorkspacePaths({
      composerSelector: ACTIVE_COMPOSER_SELECTOR,
      control,
      workspacePath,
    })
    console.log(`Wework desktop pasted-workspace-paths E2E passed. Evidence: ${resultDir}`)
    return { stop: true }
  }

  if (DROPPED_WORKSPACE_PATHS_ONLY) {
    state.phase = 'dropped-workspace-paths'
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
    await verifyDroppedWorkspacePaths({
      composerSelector: ACTIVE_COMPOSER_SELECTOR,
      control,
      workspacePath,
    })
    console.log(`Wework desktop dropped-workspace-paths E2E passed. Evidence: ${resultDir}`)
    return { stop: true }
  }

  if (SHORT_CONVERSATION_ONLY) {
    state.phase = 'short-conversation-layout'
    control.setScenario('fresh_chat')
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
    await verifyShortConversationLayout({
      composerSelector: ACTIVE_COMPOSER_SELECTOR,
      control,
    })
    console.log(`Wework desktop short-conversation E2E passed. Evidence: ${resultDir}`)
    return { stop: true }
  }

  if (PLUGINS_ONLY) {
    state.phase = 'plugin-lifecycle'
    await verifyPluginLifecycle(control, pluginMarketplacePath)
    console.log(`Wework desktop plugin E2E passed. Evidence: ${resultDir}`)
    return { stop: true }
  }

  if (desktopScenario && DESKTOP_SCENARIO_ONLY) {
    state.phase = 'desktop-extension-scenario'
    await desktopScenario.verify(control)
    await writeRedactedJson(join(resultDir, 'model-requests.json'), control.modelRequests, [
      MODEL_API_KEY,
      cloudEnvironment?.authToken,
    ])
    console.log(`Wework desktop extension scenario E2E passed. Evidence: ${resultDir}`)
    return { stop: true }
  }
  return { stop: false }
}
