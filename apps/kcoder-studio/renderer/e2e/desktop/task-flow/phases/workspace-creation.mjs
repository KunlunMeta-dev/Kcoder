// phases / workspace creation for the existing desktop runner.
import {
  confirmLocalProjectName,
  waitForFolderPathReady,
  waitForFolderPickerInitialized,
  waitForSnapshot,
} from '../ui-helpers.mjs'
import {
  COMPOSER_PROJECT_NAME,
  COMPOSER_READY_STABILITY_MS,
  MODEL_API_KEY,
  UI_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  resultDir,
} from '../config.mjs'
import {
  verifyAttachmentOnlySidebarLifecycle,
  verifyDroppedWorkspacePaths,
  verifyPastedWorkspacePaths,
  verifyPastedZipAttachment,
  verifySideChatAttachmentIsolation,
} from '../attachment-bindings.mjs'
import { verifyToolBlockChronologicalOrder } from '../session-scenarios.mjs'
import { writeRedactedJson } from '../runtime.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function runWorkspaceCreationPhase(
  {
    workspacePath,
    composerProjectPath,
    executorHome,
    desktopScenario,
    control,
    cloudEnvironment,
    appIdentifier,
    restartDesktopApp,
    composerSelector,
    projectId,
    taskRowTestId,
  },
  state
) {
  state.phase = 'standalone-new-task-state'
  await control.command('click', '[data-testid="runtime-chat-section-new-chat-button"]')
  const standaloneTaskSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('project-work-button') &&
      (snapshot.text.includes('请选择项目') || snapshot.text.includes('Select project')),
    'The task-section new-task action selected a project'
  )
  assert.ok(
    standaloneTaskSnapshot.testIds.includes('project-work-button'),
    'The standalone new task did not render the project selector'
  )

  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('project-work-button') &&
      (snapshot.text.includes('请选择项目') || snapshot.text.includes('Select project')),
    'The global new-task action did not preserve the standalone project state'
  )

  state.phase = 'permanent-worktree-create'
  const sourceProjectId = projectId
  const sourceProjectMenuTestId = `project-menu-${sourceProjectId}`
  await control.command('waitFor', `[data-testid="${sourceProjectMenuTestId}"]`, {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('click', `[data-testid="${sourceProjectMenuTestId}"]`)
  await control.command('click', `[data-testid="create-permanent-worktree-${sourceProjectId}"]`)
  await control.command('waitFor', `[data-testid="permanent-worktree-name-${sourceProjectId}"]`, {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('fill', `[data-testid="permanent-worktree-name-${sourceProjectId}"]`, {
    value: 'Permanent E2E',
  })
  await control.command(
    'click',
    `[data-testid="confirm-create-permanent-worktree-${sourceProjectId}"]`
  )
  await waitForSnapshot(
    control,
    snapshot => snapshot.text.includes('Permanent E2E'),
    'The permanent worktree was not added to the project list'
  )
  const worktreeState = JSON.parse(
    await readFile(join(executorHome, 'runtime-work', 'worktrees.json'), 'utf8')
  )
  assert.equal(
    Object.values(worktreeState.records ?? {}).some(record => record.permanent === true),
    true,
    'The created worktree was not marked permanent'
  )

  state.phase = 'composer-project-create-and-new-chat'
  const projectRowsBeforeComposerCreate = new Set(
    (
      await waitForSnapshot(
        control,
        snapshot => snapshot.testIds.includes('project-work-button'),
        'The project selector was not ready for composer project creation'
      )
    ).testIds.filter(testId => testId.startsWith('project-row-'))
  )
  await control.command('click', '[data-testid="project-work-button"]')
  await control.command('click', '[data-testid="add-local-project-option"]')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await waitForFolderPickerInitialized(control)
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: composerProjectPath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', {
    key: 'Enter',
  })
  await waitForFolderPathReady(control, composerProjectPath)
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await confirmLocalProjectName(control, COMPOSER_PROJECT_NAME)
  const createdComposerProjectSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(COMPOSER_PROJECT_NAME) &&
      snapshot.testIds.includes('project-work-button'),
    'The composer-created project was not selected after creation'
  )
  const createdComposerProjectRow = createdComposerProjectSnapshot.testIds.find(
    testId => testId.startsWith('project-row-') && !projectRowsBeforeComposerCreate.has(testId)
  )
  assert.ok(createdComposerProjectRow, 'The composer-created project was not added to the sidebar')

  await control.command('click', '[data-testid="runtime-chat-section-new-chat-button"]')
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('project-work-button') &&
      (snapshot.text.includes('请选择项目') || snapshot.text.includes('Select project')),
    'The standalone new task did not clear the composer-created project'
  )
  await control.command(
    'clickWhenEnabled',
    `[data-testid="${createdComposerProjectRow}"] [data-testid="project-new-conversation-button"]`
  )
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: COMPOSER_PROJECT_NAME,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })

  state.phase = 'side-chat-attachment-isolation'
  await verifySideChatAttachmentIsolation({ control, taskRowTestId })

  state.phase = 'attachment-only-sidebar'
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await verifyAttachmentOnlySidebarLifecycle({
    app: state.app,
    appIdentifier,
    composerSelector,
    control,
  })

  state.phase = 'pasted-zip-attachment'
  await verifyPastedZipAttachment({ composerSelector, control })

  state.phase = 'pasted-workspace-paths'
  await verifyPastedWorkspacePaths({ composerSelector, control, workspacePath })

  state.phase = 'dropped-workspace-paths'
  await verifyDroppedWorkspacePaths({ composerSelector, control, workspacePath })

  state.phase = 'tool-block-chronological-order'
  await verifyToolBlockChronologicalOrder({
    control,
    executorHome,
    restartDesktopApp,
    workspacePath,
  })

  if (desktopScenario) {
    state.phase = 'desktop-extension-scenario'
    await desktopScenario.verify(control)
  }

  await writeRedactedJson(join(resultDir, 'model-requests.json'), control.modelRequests, [
    MODEL_API_KEY,
    cloudEnvironment?.authToken,
  ])
  console.log(`Wework desktop task-flow E2E passed. Diagnostics: ${resultDir}`)
  return { stop: false }
}
