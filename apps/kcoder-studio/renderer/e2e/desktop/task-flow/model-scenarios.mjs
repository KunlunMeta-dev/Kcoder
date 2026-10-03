// model scenarios for the existing desktop runner.
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  CLOUD_ARTIFACT_CONTENT,
  CLOUD_ARTIFACT_NAME,
  CLOUD_COMPLETION_TEXT,
  CLOUD_DEVICE_ID,
  CLOUD_FOLLOW_UP_COMPLETION_TEXT,
  CLOUD_FOLLOW_UP_PROMPT,
  CLOUD_TASK_PROMPT,
  COMPOSER_READY_STABILITY_MS,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  HIDDEN_CLOUD_MODEL_PROTOCOL_MATRIX_CASES,
  LOCAL_CONNECTED_MODEL_PROTOCOL_MATRIX_CASES,
  LOCAL_CUSTOM_MODEL_PROTOCOL_MATRIX_CASES,
  LOCAL_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES,
  MODEL_PROTOCOL_MATRIX_TIMEOUT_MS,
  MODEL_PROTOCOL_MATRIX_TOTAL,
  REMOTE_MODEL_PROTOCOL_MATRIX_CASES,
  UI_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  resultDir,
} from './config.mjs'
import {
  assertConfiguredLocalModelsHidden,
  captureVerificationScreenshot,
  closeBottomWorkspacePanel,
  confirmLocalProjectName,
  openBottomWorkspaceTerminal,
  prepareCompletedTurnScreenshot,
  selectE2EModel,
  sendPrompt,
  sendPromptWithButton,
  waitForControlValue,
  waitForFolderPathReady,
  waitForFolderPickerInitialized,
  waitForSnapshot,
  waitForTaskRowByText,
} from './ui-helpers.mjs'
import { delay, withTimeout } from './runtime.mjs'
import {
  matrixArtifact,
  matrixArtifactContent,
  matrixCaseId,
  matrixTextCompletion,
  matrixTextPrompt,
  matrixToolCompletion,
  matrixToolPrompt,
} from './model-bindings.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

export async function verifyConnectedModelsOnLocalExecution({
  control,
  cloudEnvironment,
  setCodexUpstreamProtocol,
  workspacePath,
}) {
  const composerSelector = ACTIVE_COMPOSER_SELECTOR
  await control.command('waitFor', '[data-testid="projects-create-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-local-option"]')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await waitForFolderPickerInitialized(control)
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await waitForFolderPathReady(control, workspacePath)
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await confirmLocalProjectName(control, 'workspace')
  await control.command('waitFor', composerSelector, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  const projectSnapshot = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.some(testId => testId.startsWith('project-menu-')),
    'The local matrix project was not shown in the sidebar'
  )
  const projectMenuTestId = projectSnapshot.testIds.find(testId =>
    testId.startsWith('project-menu-')
  )
  assert.ok(projectMenuTestId, 'The local matrix project did not expose its project menu')
  const projectId = projectMenuTestId.slice('project-menu-'.length)
  const newConversationSelector = `[data-testid="project-row-${projectId}"] [data-testid="project-new-conversation-button"]`

  await verifyModelProtocolMatrix({
    cases: LOCAL_CONNECTED_MODEL_PROTOCOL_MATRIX_CASES,
    composerSelector,
    control,
    newConversationSelector,
    screenshotPrefix: 'local-connected-matrix',
    setCodexUpstreamProtocol,
    startIndex: LOCAL_CUSTOM_MODEL_PROTOCOL_MATRIX_CASES.length,
    workspacePath,
  })

  const currentProjectSnapshot = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.some(testId => testId.startsWith('project-menu-')),
    'The local matrix project was not shown before removal'
  )
  const currentProjectMenuTestId = currentProjectSnapshot.testIds.find(testId =>
    testId.startsWith('project-menu-')
  )
  assert.ok(currentProjectMenuTestId, 'The local matrix project did not expose its project menu')
  const currentProjectId = currentProjectMenuTestId.slice('project-menu-'.length)
  await control.command('click', `[data-testid="${currentProjectMenuTestId}"]`)
  await control.command('click', `[data-testid="remove-project-${currentProjectId}"]`)
  await control.command(
    'clickWhenEnabled',
    `[data-testid="remove-project-dialog-${currentProjectId}-confirm-button"]`
  )
  await cloudEnvironment.waitForWorkspaceRemoved(workspacePath)
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.some(testId => testId.startsWith('project-menu-')),
    'The local matrix project remained visible after removal'
  )
}

export async function verifyCloudProjectFlow(control, cloudEnvironment, workspacePath) {
  const composerSelector = ACTIVE_COMPOSER_SELECTOR
  await control.command('waitFor', '[data-testid="projects-create-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  await control.command('click', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-remote-option"]')
  await control.command('waitFor', '[data-testid="standalone-folder-project-dialog"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  const remoteDialogSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('standalone-remote-device-select') ||
      snapshot.testIds.includes('refresh-remote-devices-button'),
    'The remote device dialog exposed neither a connected device nor its refresh action'
  )
  if (!remoteDialogSnapshot.testIds.includes('standalone-remote-device-select')) {
    await control.command('clickIfPresent', '[data-testid="refresh-remote-devices-button"]')
  }
  await control.command('waitFor', '[data-testid="standalone-remote-device-select"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="standalone-remote-device-select"]', {
    value: CLOUD_DEVICE_ID,
  })
  await waitForControlValue(
    control,
    '[data-testid="device-folder-path-input"]',
    join(resultDir, 'cloud-executor-home'),
    'The remote folder picker did not load the real executor home directory'
  )
  await captureVerificationScreenshot(control, 'cloud-01-remote-device-selected.png')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await waitForControlValue(
    control,
    '[data-testid="device-folder-path-input"]',
    workspacePath,
    'The remote folder picker did not retain the selected cloud workspace path'
  )
  await captureVerificationScreenshot(control, 'cloud-02-workspace-path-confirmed.png')
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]')
  await waitForSnapshot(
    control,
    value =>
      !value.testIds.includes('standalone-folder-project-dialog') &&
      value.testIds.some(testId => testId.startsWith('project-device-status-')),
    'The real cloud project was not shown with its remote device status'
  )
  await control.command('waitFor', '[data-testid^="project-menu-"]', {
    stableMs: COMPOSER_READY_STABILITY_MS * 2,
    timeoutMs: UI_TIMEOUT_MS,
  })
  const projectSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  const projectMenuTestIds = projectSnapshot.testIds.filter(testId =>
    testId.startsWith('project-menu-')
  )
  assert.equal(
    projectMenuTestIds.length,
    1,
    'The cloud flow did not expose exactly one remote project'
  )
  await captureVerificationScreenshot(control, 'cloud-03-project-created.png')
  await control.command(
    'clickWhenEnabled',
    '[data-testid^="project-row-"] [data-testid="project-new-conversation-button"]'
  )
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'workspace',
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('waitFor', composerSelector, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await assertConfiguredLocalModelsHidden(
    control,
    LOCAL_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES.length
  )
  await captureVerificationScreenshot(control, 'cloud-04-conversation-ready.png')
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await openBottomWorkspaceTerminal(control, 'The new cloud task')
  await captureVerificationScreenshot(control, 'cloud-04b-new-task-terminal-open.png')
  await control.command('click', '[data-testid="close-bottom-workspace-tab-button"]')
  await waitForSnapshot(
    control,
    value =>
      !value.testIds.includes('workspace-tool-launcher') &&
      !value.testIds.includes('workspace-terminal-window'),
    'The new cloud task terminal and bottom panel did not close cleanly',
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )

  control.setScenario('cloud_initial')
  await sendPrompt(control, composerSelector, CLOUD_TASK_PROMPT)
  const cloudInitialRequest = await withTimeout(
    control.awaitScenarioRequestCount('cloud_initial', 2),
    UI_TIMEOUT_MS,
    'The real cloud executor did not complete its model tool loop'
  )
  assert.equal(
    cloudInitialRequest.body?.model,
    DEFAULT_MODEL_ID,
    'The remote executor did not receive the selected canonical model id'
  )
  assert.equal(
    (await readFile(join(workspacePath, CLOUD_ARTIFACT_NAME), 'utf8')).trim(),
    CLOUD_ARTIFACT_CONTENT,
    'The real cloud executor did not create the verification artifact'
  )
  const taskRowTestId = await waitForTaskRowByText(control, 'KCODER_STUDIO_DESKTOP_E2E_CLOUD_TASK')
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: CLOUD_COMPLETION_TEXT,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-05-initial-task-completed.png')

  await openBottomWorkspaceTerminal(control, 'The historical cloud task')
  await closeBottomWorkspacePanel(control)
  await control.command('click', '[data-testid="toggle-bottom-workspace-panel-button"]')
  await waitForSnapshot(
    control,
    value =>
      value.testIds.includes('workspace-terminal-window') &&
      value.testIds.includes('remote-terminal') &&
      !value.testIds.includes('workspace-tool-launcher'),
    'The historical cloud task did not restore its existing terminal',
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  await control.command('click', '[data-testid="workspace-terminal-new-tab-button"]')
  const addMenuSnapshot = await waitForSnapshot(
    control,
    value => value.testIds.includes('workspace-terminal-new-tab-menu'),
    'The bottom workspace add menu did not open'
  )
  assert.ok(addMenuSnapshot.testIds.includes('workspace-add-terminal-option'))
  assert.equal(
    addMenuSnapshot.testIds.includes('workspace-add-ide-option'),
    false,
    'The bottom workspace add menu exposed IDE'
  )
  assert.equal(
    addMenuSnapshot.testIds.includes('workspace-add-desktop-option'),
    false,
    'The external build exposed the internal desktop extension'
  )
  await control.command('press', 'body', { key: 'Escape' })
  await captureVerificationScreenshot(control, 'cloud-05b-historical-terminal-restored.png')
  await closeBottomWorkspacePanel(control)

  control.setScenario('cloud_follow_up')
  const runningTaskTestId = taskRowTestId.replace(
    'runtime-local-task-row-',
    'runtime-local-task-running-'
  )
  const unreadTaskTestId = taskRowTestId.replace(
    'runtime-local-task-row-',
    'runtime-local-task-unread-dot-'
  )
  await sendPrompt(control, composerSelector, CLOUD_FOLLOW_UP_PROMPT)
  await withTimeout(
    control.awaitScenarioRequest('cloud_follow_up'),
    UI_TIMEOUT_MS,
    'The real cloud executor did not send the follow-up model request'
  )
  await waitForSnapshot(
    control,
    value =>
      value.testIds.includes(runningTaskTestId) &&
      value.testIds.includes('pause-response-button') &&
      value.testIds.includes('thinking-indicator') &&
      !value.testIds.includes('send-message-button') &&
      !value.testIds.includes(unreadTaskTestId),
    'The cloud follow-up task did not render a consistent sidebar, composer, and message state',
    UI_TIMEOUT_MS
  )
  control.releaseCloudFollowUpResponse()
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: CLOUD_FOLLOW_UP_COMPLETION_TEXT,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    value => !value.testIds.includes(runningTaskTestId),
    'The cloud follow-up task did not settle before project removal'
  )
  await captureVerificationScreenshot(control, 'cloud-06-follow-up-completed.png')

  await verifyModelProtocolMatrix({
    cases: REMOTE_MODEL_PROTOCOL_MATRIX_CASES,
    composerSelector,
    control,
    newConversationSelector:
      '[data-testid^="project-row-"] [data-testid="project-new-conversation-button"]',
    screenshotPrefix: 'cloud-matrix',
    setCodexUpstreamProtocol: protocol => cloudEnvironment.setCodexUpstreamProtocol(protocol),
    startIndex:
      LOCAL_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES.length +
      HIDDEN_CLOUD_MODEL_PROTOCOL_MATRIX_CASES.length,
    workspacePath,
  })

  const currentProjectSnapshot = await waitForSnapshot(
    control,
    value => value.testIds.some(testId => testId.startsWith('project-menu-')),
    'The cloud project was not shown in the sidebar'
  )
  const currentProjectMenuTestId = currentProjectSnapshot.testIds.find(testId =>
    testId.startsWith('project-menu-')
  )
  assert.ok(currentProjectMenuTestId, 'The cloud project did not expose its project menu')
  const currentProjectId = currentProjectMenuTestId.slice('project-menu-'.length)
  const projectMenuTestId = `project-menu-${currentProjectId}`
  await control.command('click', `[data-testid="${projectMenuTestId}"]`)
  await control.command('click', `[data-testid="remove-project-${currentProjectId}"]`)
  await control.command(
    'clickWhenEnabled',
    `[data-testid="remove-project-dialog-${currentProjectId}-confirm-button"]`
  )
  await cloudEnvironment.waitForWorkspaceRemoved(workspacePath)
  await waitForSnapshot(
    control,
    value =>
      !value.testIds.includes(projectMenuTestId) &&
      !value.testIds.includes(`remove-project-dialog-${currentProjectId}`),
    'The removed cloud project remained visible in the workbench'
  )
  await captureVerificationScreenshot(control, 'cloud-07-project-removed.png')
}

export async function verifyModelProtocolMatrix({
  cases,
  composerSelector,
  control,
  newConversationSelector,
  screenshotPrefix,
  setCodexUpstreamProtocol,
  startIndex = 0,
  workspacePath,
}) {
  for (const [caseIndex, model] of cases.entries()) {
    const matrixIndex = startIndex + caseIndex
    console.log(
      `Model protocol matrix ${matrixIndex + 1}/${MODEL_PROTOCOL_MATRIX_TOTAL} started: ${matrixCaseId(model)}`
    )
    if (model.source === 'codex') {
      assert.ok(
        setCodexUpstreamProtocol,
        `${matrixCaseId(model)} requires a Codex upstream protocol setter`
      )
      await setCodexUpstreamProtocol(model.protocol)
    }
    control.setMatrixCase(model)
    await control.command('clickWhenEnabled', newConversationSelector)
    await control.command('waitFor', composerSelector, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await selectE2EModel(control, model.optionId, model.label)

    await sendPromptWithButton(control, composerSelector, matrixTextPrompt(model))
    await waitForMatrixStage(control, model, 'tool')
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: matrixTextCompletion(model),
      timeoutMs: MODEL_PROTOCOL_MATRIX_TIMEOUT_MS,
    })

    await sendPromptWithButton(control, composerSelector, matrixToolPrompt(model))
    await waitForMatrixStage(control, model, 'awaiting_tool_output', 'complete')
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: matrixToolCompletion(model),
      timeoutMs: MODEL_PROTOCOL_MATRIX_TIMEOUT_MS,
    })
    assert.equal(
      (await readFile(join(workspacePath, matrixArtifact(model)), 'utf8')).trim(),
      matrixArtifactContent(model),
      `${matrixCaseId(model)} apply_patch did not create the expected artifact`
    )
    assert.equal(
      control.matrixState?.stage,
      'complete',
      `${matrixCaseId(model)} did not complete text and tool turns`
    )
    assert.ok(
      control.matrixState.requests.length >= 3,
      `${matrixCaseId(model)} did not send the text/tool/tool-output request sequence`
    )
    await prepareCompletedTurnScreenshot(control)
    await captureVerificationScreenshot(
      control,
      `${screenshotPrefix}-${String(matrixIndex + 1).padStart(2, '0')}-${matrixCaseId(model)}.png`
    )
    console.log(`Model protocol matrix passed: ${matrixCaseId(model)}`)
  }
}

export async function waitForMatrixStage(control, model, ...expectedStages) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < MODEL_PROTOCOL_MATRIX_TIMEOUT_MS) {
    if (control.fatalError) throw control.fatalError
    if (expectedStages.includes(control.matrixState?.stage)) return
    await delay(50)
  }
  throw new Error(
    `${matrixCaseId(model)} did not reach ${expectedStages.join(' or ')} within ${MODEL_PROTOCOL_MATRIX_TIMEOUT_MS}ms; current stage=${control.matrixState?.stage ?? 'missing'}`
  )
}
