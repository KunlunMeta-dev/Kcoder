// phases / initial task for the existing desktop runner.
import { captureVerificationScreenshot, sendPrompt, waitForSnapshot } from '../ui-helpers.mjs'
import {
  ARTIFACT_CONTENT,
  ARTIFACT_NAME,
  COMPLETION_TEXT,
  MODEL_API_KEY,
  QUEUE_NAVIGATION_ONLY,
  SEND_MODE_DRAFT,
  SIDE_CHAT_ONLY,
  TASK_PROMPT,
  UI_TIMEOUT_MS,
  VIEW_IMAGE_ONLY,
  resultDir,
} from '../config.mjs'
import { delay, withTimeout, writeRedactedJson } from '../runtime.mjs'
import { verifyQueuedFollowUpNavigation } from '../conversation-scenarios.mjs'
import { verifySideChatAttachmentIsolation } from '../attachment-bindings.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile, readFile } from 'node:fs/promises'

export async function runInitialTaskPhase(
  { workspacePath, control, cloudEnvironment, composerSelector, projectRowSelector },
  state
) {
  state.phase = 'initial-task'
  await sendPrompt(control, composerSelector, TASK_PROMPT)
  await withTimeout(
    control.awaitScenarioRequest('initial'),
    UI_TIMEOUT_MS,
    'The model service did not receive the initial task request'
  )

  if (VIEW_IMAGE_ONLY) {
    control.releaseInitialToolExecution()
  } else {
    state.phase = 'send-mode-menu'
    await control.command('waitFor', '[data-testid="pause-response-button"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('fill', composerSelector, { value: SEND_MODE_DRAFT })
    await control.command('waitFor', '[data-testid="send-mode-menu-button"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await captureVerificationScreenshot(control, '01-send-mode-follow-up-ready.png')
    await control.command('click', '[data-testid="send-mode-menu-button"]')
    await control.command('waitFor', '[data-testid="send-mode-menu-button-menu"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    const sendModeMenuText = await control.command(
      'getText',
      '[data-testid="send-mode-menu-button-menu"]'
    )
    assert.match(
      sendModeMenuText,
      /当前回复结束后发送|Send after current response/,
      'The send-after-turn option was not visible in the send mode menu'
    )
    assert.match(
      sendModeMenuText,
      /引导当前回复|Guide current response/,
      'The guide-current-turn option was not visible in the send mode menu'
    )
    assert.match(
      sendModeMenuText,
      /打断并立即发送|Interrupt and send now/,
      'The interrupt-and-send option was not visible in the send mode menu'
    )
    await captureVerificationScreenshot(control, '02-send-mode-menu-open.png')
    await control.command('press', 'body', { key: 'Escape' })
    await verifyQueuedFollowUpNavigation({
      composerSelector,
      control,
      projectRowSelector,
    })
    if (QUEUE_NAVIGATION_ONLY) {
      await writeRedactedJson(join(resultDir, 'model-requests.json'), control.modelRequests, [
        MODEL_API_KEY,
        cloudEnvironment?.authToken,
      ])
      console.log(`Wework queue navigation desktop E2E passed. Evidence: ${resultDir}`)
      return { stop: true }
    }
  }

  state.phase = 'initial-task-completion'
  await control.command('waitFor', '[data-testid="environment-info-button"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  const environmentSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (!environmentSnapshot.testIds.includes('environment-changes-button')) {
    await control.command('click', '[data-testid="environment-info-button"]')
  }
  await control.command('waitFor', '[data-testid="environment-changes-button"]', {
    text: '+0',
    timeoutMs: UI_TIMEOUT_MS,
  })
  const cleanEnvironmentText = await control.command(
    'getText',
    '[data-testid="environment-changes-button"]'
  )
  assert.match(cleanEnvironmentText, /\+0\s*-0/, 'The clean workspace diff was not displayed')

  control.releaseInitialToolExecution()
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: COMPLETION_TEXT,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="final-processing-toggle"]')
  await control.command('waitFor', '[data-testid="processing-summary-toggle"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  const processingSummaryText = await control.command(
    'getText',
    '[data-testid="processing-summary-toggle"]'
  )
  assert.match(
    processingSummaryText,
    /调用 2 个工具，编辑 1 个文件|Called 2 tools, edited 1 file/,
    'The processing summary did not report tool calls and edited files separately'
  )
  await control.command('waitFor', '[aria-label="编辑 1"], [aria-label="Edits 1"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  if (process.platform === 'darwin') {
    await control.command('scrollIntoView', '[data-testid="processing-summary-header"]')
    await control.command('waitFor', '[data-testid="processing-summary-toggle"]', {
      visible: true,
      stableMs: 500,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await delay(500)
    const processingSummaryScreenshot = await control.command(
      'capture',
      '[data-testid="processing-summary-toggle"]'
    )
    await writeFile(
      join(resultDir, 'processing-summary.png'),
      Buffer.from(processingSummaryScreenshot.replace(/^data:image\/png;base64,/, ''), 'base64')
    )
  }
  await control.command('click', '[data-testid="processing-summary-toggle"]')
  await control.command('waitFor', '[data-processing-block-id="studio-e2e-view-image"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('scrollIntoView', '[data-testid="processing-live-preview"]')
  await control.command(
    'waitFor',
    '[data-processing-block-id="studio-e2e-view-image"] [data-tool-detail-toggle][aria-expanded="false"]',
    { visible: true, stableMs: 300, timeoutMs: UI_TIMEOUT_MS }
  )
  await delay(500)
  await captureVerificationScreenshot(
    control,
    '03-view-image-collapsed.png',
    '[data-testid="processing-live-preview"]'
  )
  await control.command(
    'click',
    '[data-processing-block-id="studio-e2e-view-image"] [data-tool-detail-toggle]'
  )
  await control.command('waitFor', '[data-testid="image-view-preview"]', {
    stableMs: 500,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    '[data-processing-block-id="studio-e2e-view-image"] [data-tool-detail-toggle][aria-expanded="true"]',
    { stableMs: 500, timeoutMs: UI_TIMEOUT_MS }
  )
  await control.command('scrollIntoView', '[data-testid="processing-live-preview"]')
  await control.command('waitFor', '[data-testid="image-view-preview"]', {
    visible: true,
    stableMs: 500,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await delay(500)
  await captureVerificationScreenshot(
    control,
    '04-view-image-expanded.png',
    '[data-testid="processing-live-preview"]'
  )
  await control.command('click', '[data-testid="processing-summary-toggle"]')
  await control.command('waitFor', '[data-testid="environment-changes-button"]', {
    text: '+1',
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="file-change-stats-label"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  if (VIEW_IMAGE_ONLY) {
    await writeRedactedJson(join(resultDir, 'model-requests.json'), control.modelRequests, [
      MODEL_API_KEY,
      cloudEnvironment?.authToken,
    ])
    console.log(`Wework view_image desktop E2E passed. Evidence: ${resultDir}`)
    return { stop: true }
  }
  const changedEnvironmentText = await control.command(
    'getText',
    '[data-testid="file-change-stats-label"]'
  )
  assert.match(
    changedEnvironmentText,
    /\+1\s*-0/,
    'The real apply_patch result did not render the expected file diff'
  )

  state.phase = 'workspace-mention'
  await control.command('fill', composerSelector, { value: '@auth' })
  await control.command('waitFor', '[data-testid="workspace-mention-option-0"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="workspace-mention-option-0"]')
  await control.command('waitFor', '[data-testid="composer-path-chip-auth-ts"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('fill', composerSelector, { value: '' })

  assert.equal(
    await readFile(join(workspacePath, ARTIFACT_NAME), 'utf8'),
    `${ARTIFACT_CONTENT}\n`,
    'The real Codex tool execution did not create the expected workspace artifact'
  )
  assert.equal(
    control.modelStage,
    'complete',
    'The model service did not complete the Codex tool loop'
  )
  assert.ok(control.modelRequests.length >= 2, 'The real Codex did not make both model requests')
  assert.ok(
    control.catalogRequests.length >= 1,
    'The Codex model catalog did not pass through the local router'
  )
  assert.ok(
    typeof control.modelRequests[0].body.model === 'string' &&
      control.modelRequests[0].body.model.length > 0,
    'The real Codex request did not select a model'
  )
  assert.ok(control.toolOutput, 'Codex did not report its real tool execution to the model service')

  state.phase = 'conversation-model-restore'
  const taskSnapshot = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.some(testId => testId.startsWith('runtime-local-task-row-')),
    'The completed task was not available for model restoration'
  )
  const taskRowTestId = taskSnapshot.testIds.find(testId =>
    testId.startsWith('runtime-local-task-row-')
  )
  assert.ok(taskRowTestId, 'The completed task row was not found')

  if (SIDE_CHAT_ONLY) {
    state.phase = 'side-chat-attachment-isolation'
    await verifySideChatAttachmentIsolation({ control, taskRowTestId })
    await writeRedactedJson(join(resultDir, 'model-requests.json'), control.modelRequests, [
      MODEL_API_KEY,
      cloudEnvironment?.authToken,
    ])
    console.log(`Wework side-chat desktop E2E passed. Evidence: ${resultDir}`)
    return { stop: true }
  }
  return { stop: false, taskRowTestId }
}
