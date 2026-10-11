// phases / recovery for the existing desktop runner.
import {
  CANCELLATION_COMPLETION_TEXT,
  CANCELLATION_PROMPT,
  COMPOSER_READY_STABILITY_MS,
  REQUEST_INPUT_ONLY,
  REQUEST_USER_INPUT_COMPLETION_TEXT,
  REQUEST_USER_INPUT_PROMPT,
  REQUEST_USER_INPUT_QUESTION,
  UI_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
} from '../config.mjs'
import {
  captureVerificationScreenshot,
  sendPrompt,
  sendPromptUntilScenarioRequest,
  waitForSnapshot,
} from '../ui-helpers.mjs'
import { delay, withTimeout } from '../runtime.mjs'
import { verifyBackgroundTaskWindowLifecycle } from '../desktop-lifecycle.mjs'
import {
  verifyActiveGoalIdleUnreadLifecycle,
  verifyGoalRestartRecoveryLifecycle,
  verifyReconnectRecovery,
} from '../runtime-bindings.mjs'
import { verifyRetryFailureRestoration } from '../recovery-scenarios.mjs'
import assert from 'node:assert/strict'

export async function runRecoveryPhase(
  { executorLogPath, control, appIdentifier, restartDesktopApp, composerSelector },
  state
) {
  state.phase = 'background-request-user-input'
  control.setScenario('request_user_input')
  await control.command('click', '[data-testid="add-context-button"]')
  await control.command('click', '[data-testid="set-plan-mode-button"]')
  await control.command('waitFor', '[data-testid="plan-mode-pill"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    REQUEST_USER_INPUT_PROMPT,
    'request_user_input'
  )
  const requestInputDebugSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  const requestInputTaskId = requestInputDebugSnapshot.workbench?.currentRuntimeTask?.taskId
  assert.ok(requestInputTaskId, 'The request-user-input task did not expose its runtime task ID')
  const requestInputTaskRowTestId = `runtime-local-task-row-${requestInputTaskId}`
  await control.command('waitFor', `[data-testid="${requestInputTaskRowTestId}"]`, {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', composerSelector)
  await control.command('press', 'body', { key: 'Escape' })
  await captureVerificationScreenshot(control, '01-request-running-in-background.png')
  await withTimeout(
    control.releaseRequestUserInputResponse(),
    UI_TIMEOUT_MS,
    'Timed out waiting for the request-user-input SSE response'
  )
  await control.command('press', 'body', { key: 'Escape' })
  await control.command('click', `[data-testid="${requestInputTaskRowTestId}"]`)
  await control.command('waitFor', '[data-testid="request-user-input-card"]', {
    text: REQUEST_USER_INPUT_QUESTION,
    visible: true,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, '02-background-request-user-input-visible.png')
  await delay(3_000)
  await control.command('click', '[data-testid="request-user-input-option-direction-1"]')
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: REQUEST_USER_INPUT_COMPLETION_TEXT,
    visible: true,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, '03-delayed-answer-completed.png')
  await control.command('click', '[data-testid="cancel-plan-mode-button"]')
  if (REQUEST_INPUT_ONLY) return { stop: true }

  await verifyBackgroundTaskWindowLifecycle({
    app: state.app,
    appIdentifier,
    composerSelector,
    control,
    executorLogPath,
    setPhase: value => {
      state.phase = value
    },
  })

  state.phase = 'goal-idle-unread'
  await verifyActiveGoalIdleUnreadLifecycle({ composerSelector, control })

  state.phase = 'goal-restart-recovery'
  await verifyGoalRestartRecoveryLifecycle({
    composerSelector,
    control,
    executorLogPath,
    restartDesktopApp,
  })

  state.phase = 'cancellation'
  control.setScenario('cancellation')
  await sendPrompt(control, composerSelector, CANCELLATION_PROMPT)
  await withTimeout(
    control.awaitScenarioRequest('cancellation'),
    UI_TIMEOUT_MS,
    'The model service did not receive the cancellation request'
  )
  await control.command('waitFor', '[data-testid="pause-response-button"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="pause-response-button"]')
  await control.command('waitFor', '[data-testid="assistant-stopped-notice"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  const cancelledTaskSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  const cancelledTaskId = cancelledTaskSnapshot.workbench?.currentRuntimeTask?.taskId
  assert.ok(cancelledTaskId, 'The cancelled task did not expose its runtime task ID')
  const cancelledTaskUnreadTestId = `runtime-local-task-unread-dot-${cancelledTaskId}`
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(cancelledTaskUnreadTestId),
    'Stopping the task being viewed incorrectly marked it unread'
  )
  const cancellationText = await control.command('getText', 'body')
  assert.equal(
    cancellationText.includes(CANCELLATION_COMPLETION_TEXT),
    false,
    'The cancelled task unexpectedly rendered a completion response'
  )

  state.phase = 'retry'
  await verifyRetryFailureRestoration(control, composerSelector)

  state.phase = 'reconnect'
  await verifyReconnectRecovery({ composerSelector, control })
  return { stop: false }
}
