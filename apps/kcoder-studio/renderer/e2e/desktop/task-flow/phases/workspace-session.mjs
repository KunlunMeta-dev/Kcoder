// phases / workspace session for the existing desktop runner.
import {
  ACTIVE_WORKBENCH_SELECTOR,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  TASK_PROMPT,
  UI_TIMEOUT_MS,
  UNSENT_FIRST_TASK_DRAFT,
  UNSENT_SECOND_TASK_DRAFT,
  WORKBENCH_READY_TIMEOUT_MS,
} from '../config.mjs'
import {
  captureVerificationScreenshot,
  ensureTaskRowVisible,
  selectE2EModel,
  waitForControlValue,
  waitForPersistedComposerInput,
  waitForSnapshot,
} from '../ui-helpers.mjs'
import { verifyShortConversationLayout } from '../conversation-scenarios.mjs'
import assert from 'node:assert/strict'

export async function runWorkspaceSessionPhase(
  { control, composerSelector, taskRowTestId },
  state
) {
  state.phase = 'fresh-chat'
  control.setScenario('fresh_chat')
  const taskRowsBeforeFreshChat = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  const freshChatSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.equal(
    freshChatSnapshot.text.includes(TASK_PROMPT),
    false,
    'The new conversation retained the previous task'
  )
  await verifyShortConversationLayout({ composerSelector, control })

  state.phase = 'task-draft-isolation'
  const secondTaskSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.some(
        testId =>
          testId.startsWith('runtime-local-task-row-') && !taskRowsBeforeFreshChat.has(testId)
      ),
    'The second task was not available for task draft isolation'
  )
  const secondTaskRowTestId = secondTaskSnapshot.testIds.find(
    testId => testId.startsWith('runtime-local-task-row-') && !taskRowsBeforeFreshChat.has(testId)
  )
  assert.ok(secondTaskRowTestId, 'The second task row was not found')
  await control.command('fill', composerSelector, { value: UNSENT_SECOND_TASK_DRAFT })
  await waitForPersistedComposerInput(
    control,
    UNSENT_SECOND_TASK_DRAFT,
    'The second task composer did not persist its draft before switching tasks'
  )
  await ensureTaskRowVisible(control, taskRowTestId)
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  await control.command('fill', composerSelector, { value: UNSENT_FIRST_TASK_DRAFT })
  await waitForPersistedComposerInput(
    control,
    UNSENT_FIRST_TASK_DRAFT,
    'The first task composer did not persist its draft before switching tasks'
  )
  await control.command('click', `[data-testid="${secondTaskRowTestId}"]`)
  await waitForControlValue(
    control,
    composerSelector,
    UNSENT_SECOND_TASK_DRAFT,
    'The second task lost its unsent composer draft after switching tasks'
  )
  await ensureTaskRowVisible(control, taskRowTestId)
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  await waitForControlValue(
    control,
    composerSelector,
    UNSENT_FIRST_TASK_DRAFT,
    'The first task lost its unsent composer draft after switching tasks'
  )

  state.phase = 'workspace-resources-across-conversation-switch'
  const activeBrowserInputSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-url-input"]`
  const activeTerminalSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-terminal-window"]`
  const rightPanelToggleSelector = '[data-testid="toggle-right-workspace-panel-button"]'
  const bottomPanelToggleSelector = '[data-testid="toggle-bottom-workspace-panel-button"]'
  const bottomWorkspaceTabCloseSelector = '[data-testid="close-bottom-workspace-tab-button"]'
  const rightBrowserTabCloseSelector = '[data-testid="right-workspace-browser-tab-close-button"]'
  const retainedBrowserUrl = 'https://example.com/session-state'
  await control.command('waitFor', rightPanelToggleSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', rightPanelToggleSelector)
  await control.command(
    'click',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-browser-option"]`
  )
  await control.command('waitFor', activeBrowserInputSelector, { timeoutMs: UI_TIMEOUT_MS })
  await control.command('fill', activeBrowserInputSelector, { value: retainedBrowserUrl })
  await control.command('click', bottomPanelToggleSelector)
  const firstTaskBottomWorkspaceSnapshot = await waitForSnapshot(
    control,
    value => {
      const terminalOpened =
        value.testIds.includes('workspace-terminal-window') &&
        !value.testIds.includes('workspace-tool-launcher')
      const localTerminalUnavailable =
        value.testIds.includes('workspace-tool-launcher') &&
        value.testIds.includes('workspace-local-device-limited-tools')
      return terminalOpened || localTerminalUnavailable
    },
    'The first task bottom workspace panel did not open a terminal or limited-tools launcher',
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  const firstTaskOpenedTerminal = firstTaskBottomWorkspaceSnapshot.testIds.includes(
    'workspace-terminal-window'
  )
  await control.command('click', `[data-testid="${secondTaskRowTestId}"]`)
  const secondTaskWorkspaceSnapshot = JSON.parse(
    await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
  )
  assert.equal(
    secondTaskWorkspaceSnapshot.testIds.includes('workspace-terminal-window'),
    false,
    'The first task terminal leaked into the second task'
  )
  assert.equal(
    secondTaskWorkspaceSnapshot.testIds.includes('workspace-browser-panel'),
    false,
    'The first task browser leaked into the second task'
  )
  assert.equal(
    secondTaskWorkspaceSnapshot.testIds.includes('workspace-tool-launcher'),
    false,
    'The first task bottom workspace launcher leaked into the second task'
  )
  await ensureTaskRowVisible(control, taskRowTestId)
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  if (firstTaskOpenedTerminal) {
    await control.command('waitFor', activeTerminalSelector, { timeoutMs: UI_TIMEOUT_MS })
  } else {
    await waitForSnapshot(
      control,
      value =>
        value.testIds.includes('bottom-workspace-panel') &&
        value.testIds.includes('workspace-tool-launcher') &&
        value.testIds.includes('workspace-local-device-limited-tools'),
      'The first task bottom workspace limited-tools state was not restored',
      UI_TIMEOUT_MS,
      ACTIVE_WORKBENCH_SELECTOR
    )
  }
  await control.command('waitFor', activeBrowserInputSelector, { timeoutMs: UI_TIMEOUT_MS })
  assert.equal(
    await control.command('getValue', activeBrowserInputSelector),
    retainedBrowserUrl,
    'The Wework built-in browser URL was reset after switching conversations'
  )
  const restoredWorkspaceSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    restoredWorkspaceSnapshot.testIds.includes('right-workspace-browser-tab'),
    'The browser tab was not restored after switching conversations'
  )
  await captureVerificationScreenshot(control, 'workspace-resources-restored-after-switch.png')
  await control.command('click', bottomWorkspaceTabCloseSelector)
  await control.command('click', rightBrowserTabCloseSelector)

  await control.command('fill', composerSelector, { value: '' })
  await control.command('click', `[data-testid="${secondTaskRowTestId}"]`)
  await control.command('fill', composerSelector, { value: '' })
  return { stop: false }
}
