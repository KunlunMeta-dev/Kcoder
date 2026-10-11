// recovery scenarios for the existing desktop runner.
import {
  captureVerificationScreenshot,
  sendPromptUntilScenarioRequest,
  waitForScenarioRequestCount,
  waitForWorkbenchTask,
} from './ui-helpers.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  COMPOSER_READY_STABILITY_MS,
  RETRY_CODEX_ERROR_TEXT,
  RETRY_COMPLETION_TEXT,
  RETRY_PROMPT,
  UI_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
} from './config.mjs'
import assert from 'node:assert/strict'

export async function verifyRetryFailureRestoration(control, composerSelector) {
  control.setScenario('retry')
  await sendPromptUntilScenarioRequest(control, composerSelector, RETRY_PROMPT, 'retry')
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-card"]`,
    {
      timeoutMs: UI_TIMEOUT_MS,
    }
  )
  const retryDebugSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  const retryTaskId = retryDebugSnapshot.workbench?.currentRuntimeTask?.taskId
  assert.ok(retryTaskId, 'The failed retry task did not expose its runtime task ID')
  const retryTaskRowTestId = `runtime-local-task-row-${retryTaskId}`
  await control.command('waitFor', `[data-testid="${retryTaskRowTestId}"]`, {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', `[data-testid="${retryTaskRowTestId}"]`)
  await waitForWorkbenchTask(
    control,
    retryTaskId,
    'The failed retry task did not become active again'
  )
  await control.command(
    'clickIfPresent',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="scroll-to-bottom-button"]`
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-card"]`,
    {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: UI_TIMEOUT_MS,
    }
  )
  await control.command(
    'click',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-details-toggle"]`
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-card"]`,
    {
      text: RETRY_CODEX_ERROR_TEXT,
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: UI_TIMEOUT_MS,
    }
  )
  await captureVerificationScreenshot(
    control,
    'retry-01-failure-restored-after-switch.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
  await control.command(
    'click',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-retry"]`
  )
  await waitForScenarioRequestCount(control, 'retry', 2)
  control.releaseRetryResponse()
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: RETRY_COMPLETION_TEXT,
      timeoutMs: UI_TIMEOUT_MS,
    }
  )
  let successfulRetrySnapshot = JSON.parse(
    await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
  )
  assert.equal(
    successfulRetrySnapshot.testIds.includes('assistant-error-card'),
    false,
    'The failed attempt card remained after retry succeeded'
  )
  assert.equal(
    successfulRetrySnapshot.testIds.filter(testId => testId === 'message-assistant').length,
    1,
    'Retry success left an empty assistant turn in the live conversation'
  )

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', `[data-testid="${retryTaskRowTestId}"]`)
  await waitForWorkbenchTask(
    control,
    retryTaskId,
    'The successful retry task did not become active again'
  )
  await control.command(
    'clickIfPresent',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="scroll-to-bottom-button"]`
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: RETRY_COMPLETION_TEXT,
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: UI_TIMEOUT_MS,
    }
  )
  successfulRetrySnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    successfulRetrySnapshot.testIds.includes('assistant-error-card'),
    false,
    'A cached failure card returned after reopening the successfully retried conversation'
  )
  assert.equal(
    successfulRetrySnapshot.testIds.filter(testId => testId === 'message-assistant').length,
    1,
    'Reopening a successful retry restored an empty failed assistant turn'
  )
  await captureVerificationScreenshot(
    control,
    'retry-02-success-restored-without-failed-turn.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
  assert.equal(
    control.scenarioRequests.get('retry')?.length,
    2,
    'Retry did not issue exactly one additional request for the failed user message'
  )
}
