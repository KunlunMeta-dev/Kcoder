// conversation scenarios for the existing desktop runner.
import {
  ACTIVE_SEND_BUTTON_SELECTOR,
  ACTIVE_SWITCH_MODEL_RETRY_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  COMPOSER_READY_STABILITY_MS,
  FRESH_CHAT_COMPLETION_TEXT,
  FRESH_CHAT_PROMPT,
  PROVIDER_SWITCH_LUNA_LABEL,
  PROVIDER_SWITCH_LUNA_OPTION_ID,
  PROVIDER_SWITCH_PROMPT,
  PROVIDER_SWITCH_SOL_LABEL,
  PROVIDER_SWITCH_SOL_OPTION_ID,
  QUEUED_FOLLOW_UP,
  SHORT_CONVERSATION_MAX_MESSAGE_TOP_OFFSET,
  UI_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  resultDir,
} from './config.mjs'
import {
  captureVerificationScreenshot,
  ensureModelOptionVisible,
  ensureTaskRowVisible,
  getElementMetrics,
  getSingleElementMetrics,
  prepareCompletedTurnScreenshot,
  selectE2EModel,
  sendPrompt,
  waitForNewTaskRow,
  waitForScenarioRequestCount,
  waitForSnapshot,
} from './ui-helpers.mjs'
import { artifactSink } from './runtime.mjs'
import assert from 'node:assert/strict'
import { countTextOccurrences } from '../task-flow-evidence.mjs'
import { join } from 'node:path'

export async function verifyQueuedFollowUpNavigation({
  composerSelector,
  control,
  projectRowSelector,
}) {
  await control.command('fill', composerSelector, { value: QUEUED_FOLLOW_UP })
  await control.command('press', composerSelector, { key: 'Enter' })
  await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
    text: QUEUED_FOLLOW_UP,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'queue-navigation-01-source-queued.png')

  const runningTaskSnapshot = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.some(testId => testId.startsWith('runtime-local-task-row-')),
    'The streaming task row was not available before switching conversations'
  )
  const runningTaskRowTestId = runningTaskSnapshot.testIds.find(testId =>
    testId.startsWith('runtime-local-task-row-')
  )
  assert.ok(runningTaskRowTestId, 'The streaming task row identity was not found')

  await control.command(
    'clickWhenEnabled',
    `${projectRowSelector} [data-testid="project-new-conversation-button"]`,
    { timeoutMs: UI_TIMEOUT_MS }
  )
  await control.command('waitFor', composerSelector, { timeoutMs: UI_TIMEOUT_MS })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('conversation-queue-panel'),
    'The queued follow-up leaked into the other conversation'
  )
  await captureVerificationScreenshot(control, 'queue-navigation-02-other-conversation.png')

  await ensureTaskRowVisible(control, runningTaskRowTestId)
  await control.command('clickWhenEnabled', `[data-testid="${runningTaskRowTestId}"]`, {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
    text: QUEUED_FOLLOW_UP,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'queue-navigation-03-source-restored.png')

  await control.command('click', '[data-testid^="queue-cancel-button-"]')
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('conversation-queue-panel'),
    'The queued follow-up could not be cleared after restoration'
  )
}

export async function verifyShortConversationLayout({ composerSelector, control }) {
  const taskRowsBeforeConversation = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  await prepareCompletedTurnScreenshot(control)
  await captureVerificationScreenshot(control, 'short-conversation-00-ready.png')
  await control.command('fill', composerSelector, { value: FRESH_CHAT_PROMPT })
  await control.command('waitFor', composerSelector, {
    text: FRESH_CHAT_PROMPT,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'short-conversation-01-prompt-filled.png')
  await control.command('press', composerSelector, { key: 'Enter' })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: FRESH_CHAT_COMPLETION_TEXT,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await sendPrompt(control, composerSelector, `${FRESH_CHAT_PROMPT} FOLLOW_UP`)
  await waitForScenarioRequestCount(control, 'fresh_chat', 2)
  await control.command('waitFor', ACTIVE_SEND_BUTTON_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })
  const shortConversationTaskRowTestId = await waitForNewTaskRow(
    control,
    taskRowsBeforeConversation,
    'KCODER_STUDIO_DESKTOP_E2E_FRESH_CHAT'
  )
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await control.command('clickWhenEnabled', `[data-testid="${shortConversationTaskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: FRESH_CHAT_COMPLETION_TEXT,
    timeoutMs: UI_TIMEOUT_MS,
  })

  const scroller = await getSingleElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll"]`,
    'The short conversation message scroller'
  )
  const userMessages = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
  )
  const assistantMessages = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`
  )
  const virtualRows = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"] [data-index]`
  )
  assert.equal(userMessages.length, 2, 'The short conversation did not render both user messages')
  assert.equal(
    assistantMessages.length,
    2,
    'The reopened short conversation did not render both assistant messages'
  )
  assert.equal(
    virtualRows.length,
    4,
    'The unified virtual list did not mount every short-conversation turn'
  )
  assert.equal(
    await control.command(
      'getStyle',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"] [data-index]`,
      { value: 'position' }
    ),
    'absolute',
    'Short conversations did not use the unified virtual row layout'
  )
  const conversationSnapshot = JSON.parse(
    await control.command(
      'snapshot',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"]`
    )
  )
  assert.ok(
    countTextOccurrences(conversationSnapshot.text, FRESH_CHAT_PROMPT) >= 2,
    'The reopened virtualized conversation lost an earlier user message'
  )
  assert.ok(
    countTextOccurrences(conversationSnapshot.text, FRESH_CHAT_COMPLETION_TEXT) >= 2,
    'The reopened virtualized conversation lost an earlier assistant message'
  )
  const firstMessage = userMessages[0]
  const messageTopOffset = firstMessage.top - scroller.top
  await artifactSink.writeJson(join(resultDir, 'short-conversation-layout-metrics.json'), {
    assistantMessages,
    firstMessage,
    messageTopOffset,
    scroller,
    userMessages,
    virtualRows,
  })
  await captureVerificationScreenshot(control, 'short-conversation-02-completed-top-aligned.png')

  assert.ok(
    messageTopOffset >= 0,
    'The first short-conversation message rendered above the viewport'
  )
  assert.ok(
    messageTopOffset <= SHORT_CONVERSATION_MAX_MESSAGE_TOP_OFFSET,
    `The short conversation left ${messageTopOffset}px of blank space above its first message`
  )
}

export async function verifyProviderBoundaryRestriction(control, composerSelector) {
  control.setScenario('provider_switch_retry')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, PROVIDER_SWITCH_LUNA_OPTION_ID, PROVIDER_SWITCH_LUNA_LABEL)
  await sendPrompt(control, composerSelector, PROVIDER_SWITCH_PROMPT)
  await control.command('waitFor', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR, {
    visible: true,
    timeoutMs: UI_TIMEOUT_MS,
  })
  assert.equal(
    control.scenarioRequests.get('provider_switch_retry')?.length,
    1,
    'The failed Luna turn was unexpectedly sent more than once'
  )

  await control.command('scrollIntoView', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR)
  await control.command('clickWhenEnabled', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="model-selector-menu"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await ensureModelOptionVisible(control, `model-option-${PROVIDER_SWITCH_SOL_OPTION_ID}`)
  const officialModelSelector = `[data-testid="model-option-${PROVIDER_SWITCH_SOL_OPTION_ID}"]`
  await control.command('waitFor', officialModelSelector, {
    text: PROVIDER_SWITCH_SOL_LABEL,
    timeoutMs: UI_TIMEOUT_MS,
  })
  const disabledModelText = await control.command('getText', officialModelSelector)
  assert.match(
    disabledModelText,
    /官方 Codex|Official Codex/,
    'The official Codex option did not explain the provider boundary restriction'
  )
  await assert.rejects(
    control.command('click', officialModelSelector),
    /disabled/,
    'The official Codex option remained selectable in a third-party conversation'
  )
  assert.equal(
    control.scenarioRequests.get('provider_switch_retry')?.length,
    1,
    'Selecting the disabled official Codex option unexpectedly sent another request'
  )
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    snapshot.testIds.includes('model-selector-menu'),
    'The model selector closed after clicking a disabled cross-provider option'
  )
  await control.command('press', 'body', { key: 'Escape' })
}
