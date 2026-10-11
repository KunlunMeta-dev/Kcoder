// phases / projects for the existing desktop runner.
import { verifySystemDragPanelLayout } from '../attachment-bindings.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  COMPOSER_READY_STABILITY_MS,
  MEMORY_ONLY,
  UI_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  resultDir,
} from '../config.mjs'
import {
  selectE2EModel,
  waitForFolderPathReady,
  waitForFolderPickerInitialized,
  waitForSnapshot,
} from '../ui-helpers.mjs'
import { verifyConcurrentTaskMemory, verifyMemoryGrowth } from '../memory-scenarios.mjs'
import assert from 'node:assert/strict'

export async function runProjectsPhase({ workspacePath, secondaryProjectPath, control }, state) {
  state.phase = 'system-drag-panel-layout'
  await verifySystemDragPanelLayout(control)

  state.phase = 'remote-project-dialog'
  await control.command('click', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-remote-option"]')
  await control.command('waitFor', '[data-testid="standalone-folder-project-dialog"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  const remoteProjectDialogText = await control.command(
    'getText',
    '[data-testid="standalone-folder-project-dialog"]'
  )
  assert.match(
    remoteProjectDialogText,
    /New remote project|新建远程项目/,
    'The remote project dialog title was not localized'
  )
  await control.command('click', '[data-testid="standalone-folder-project-dialog-overlay"]')
  const closedRemoteDialogSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.equal(
    closedRemoteDialogSnapshot.testIds.includes('standalone-folder-project-dialog'),
    false,
    'Clicking the remote project dialog backdrop did not restore the workbench'
  )

  state.phase = 'project-folder-cancel'
  await control.command('click', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-local-option"]')
  await control.command('waitFor', '[data-testid="standalone-folder-project-dialog"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="cancel-device-folder-picker-button"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="cancel-device-folder-picker-button"]')
  const cancelledFolderPickerSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.equal(
    cancelledFolderPickerSnapshot.testIds.includes('standalone-folder-project-dialog'),
    false,
    'Cancelling folder selection did not restore the workbench'
  )

  state.phase = 'composer-project-folder-select'
  await control.command('click', '[data-testid="project-work-button"]')
  await control.command('click', '[data-testid="add-local-project-option"]')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await waitForFolderPickerInitialized(control)
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  assert.equal(
    await control.command('getValue', '[data-testid="device-folder-path-input"]'),
    workspacePath,
    'The device folder path did not update before confirmation'
  )
  await control.command('press', '[data-testid="device-folder-path-input"]', {
    key: 'Enter',
  })
  await waitForFolderPathReady(control, workspacePath)
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="local-project-create-dialog"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="local-project-create-name-input"]', {
    value: 'workspace',
  })
  await control.command('click', '[data-testid="add-local-project-create-folders"]')
  await control.command('waitFor', '[data-testid="local-project-create-folder-picker"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: secondaryProjectPath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', {
    key: 'Enter',
  })
  await waitForFolderPathReady(control, secondaryProjectPath)
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="local-project-create-root-1"]', {
    text: 'secondary-project-root',
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="confirm-local-project-create-button"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })

  const composerSelector = ACTIVE_COMPOSER_SELECTOR
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  state.phase = 'composer-project-visible-in-sidebar'
  const openedProjectSnapshot = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.some(testId => testId.startsWith('project-menu-')),
    'The newly opened folder project was not shown in the sidebar'
  )
  let projectMenuTestId = openedProjectSnapshot.testIds.find(testId =>
    testId.startsWith('project-menu-')
  )
  assert.ok(projectMenuTestId, 'The newly opened folder project was not shown in the sidebar')
  let projectId = projectMenuTestId.slice('project-menu-'.length)
  let projectRowSelector = `[data-testid="project-row-${projectId}"]`
  await control.command('waitFor', projectRowSelector, {
    text: 'workspace',
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'workspace',
    timeoutMs: UI_TIMEOUT_MS,
  })

  state.phase = 'sidebar-project-new-conversation'
  await control.command(
    'click',
    `${projectRowSelector} [data-testid="project-new-conversation-button"]`
  )
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'workspace',
    timeoutMs: UI_TIMEOUT_MS,
  })

  state.phase = 'project-folder-remove-immediately'
  await control.command('click', `[data-testid="${projectMenuTestId}"]`)
  await control.command('click', `[data-testid="remove-project-${projectId}"]`)
  await control.command(
    'click',
    `[data-testid="remove-project-dialog-${projectId}-confirm-button"]`
  )
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(projectMenuTestId),
    'A folder project could not be removed immediately after it was opened'
  )

  state.phase = 'project-folder-reopen'
  await control.command('click', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-local-option"]')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await waitForFolderPickerInitialized(control)
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  assert.equal(
    await control.command('getValue', '[data-testid="device-folder-path-input"]'),
    workspacePath,
    'The device folder path did not update before confirmation'
  )
  await control.command('press', '[data-testid="device-folder-path-input"]', {
    key: 'Enter',
  })
  await waitForFolderPathReady(control, workspacePath)
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="local-project-create-dialog"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="local-project-create-name-input"]', {
    value: 'workspace',
  })
  await control.command('click', '[data-testid="add-local-project-create-folders"]')
  await control.command('waitFor', '[data-testid="local-project-create-folder-picker"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: secondaryProjectPath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', {
    key: 'Enter',
  })
  await waitForFolderPathReady(control, secondaryProjectPath)
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="local-project-create-root-1"]', {
    text: 'secondary-project-root',
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="confirm-local-project-create-button"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const reopenedProjectSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.some(
        testId => testId.startsWith('project-menu-') && testId !== projectMenuTestId
      ),
    'The reopened folder project was not shown with its current identity'
  )
  const reopenedProjectMenuTestId = reopenedProjectSnapshot.testIds.find(
    testId => testId.startsWith('project-menu-') && testId !== projectMenuTestId
  )
  assert.ok(reopenedProjectMenuTestId, 'The reopened folder project identity was not found')
  projectMenuTestId = reopenedProjectMenuTestId
  projectId = projectMenuTestId.slice('project-menu-'.length)
  projectRowSelector = `[data-testid="project-row-${projectId}"]`
  await control.command('waitFor', projectRowSelector, {
    text: 'workspace',
    timeoutMs: UI_TIMEOUT_MS,
  })

  if (MEMORY_ONLY) {
    state.phase = 'memory-growth'
    await selectE2EModel(control)
    await verifyMemoryGrowth({ composerSelector, control })
    state.phase = 'concurrent-memory'
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', composerSelector, { timeoutMs: UI_TIMEOUT_MS })
    await verifyConcurrentTaskMemory({ composerSelector, control })
    console.log(`Wework desktop memory E2E passed. Evidence: ${resultDir}`)
    return { stop: true }
  }

  const activeModelSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="model-selector-button"]`
  const initialModelLabel = await control.command('waitFor', activeModelSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  return { stop: false, composerSelector, projectId, projectRowSelector }
}
