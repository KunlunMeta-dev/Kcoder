// session scenarios for the existing desktop runner.
import {
  captureVerificationScreenshot,
  ensureTaskRowVisible,
  sendPromptUntilScenarioRequest,
  waitForNewTaskRow,
} from './ui-helpers.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  COMPLETION_TEXT,
  COMPOSER_READY_STABILITY_MS,
  EARLIER_TOOL_BLOCK_ID,
  FORK_FOLLOW_UP_COMPLETION_TEXT,
  FORK_FOLLOW_UP_PROMPT,
  LATER_TOOL_BLOCK_ID,
  RUNNING_FORK_COMPLETION_TEXT,
  RUNNING_FORK_FOLLOW_UP_PROMPT,
  TOOL_BLOCK_ORDER_COMPLETION_TEXT,
  TOOL_BLOCK_ORDER_TASK_ID,
  TOOL_BLOCK_ORDER_TASK_TITLE,
  UI_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
} from './config.mjs'
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export async function verifyRunningFollowUpFork({
  composerSelector,
  control,
  executorHome,
  sourceTaskRowTestId,
}) {
  const taskRowsBeforeFork = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  control.setScenario('running_fork_follow_up')
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    RUNNING_FORK_FOLLOW_UP_PROMPT,
    'running_fork_follow_up'
  )
  await control.command('waitFor', '[data-testid="pause-response-button"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('scrollIntoView', '[data-testid="fork-message-button"]')
  await captureVerificationScreenshot(control, 'running-follow-up-fork-01-streaming.png')

  try {
    await control.command('clickWhenEnabled', '[data-testid="fork-message-button"]')
    const forkTaskRowTestId = await waitForNewTaskRow(control, taskRowsBeforeFork, '', 15_000)
    assert.notEqual(
      forkTaskRowTestId,
      sourceTaskRowTestId,
      'Forking the first turn reused the running source task'
    )

    const sourceTaskId = sourceTaskRowTestId.replace('runtime-local-task-row-', '')
    const forkTaskId = forkTaskRowTestId.replace('runtime-local-task-row-', '')
    const runtimeIndex = JSON.parse(
      await readFile(join(executorHome, 'runtime-work', 'index.json'), 'utf8')
    )
    assert.equal(
      runtimeIndex.tasks[forkTaskId]?.parent?.taskId,
      sourceTaskId,
      'Forking during a follow-up did not persist the source task relationship'
    )
    assert.ok(
      runtimeIndex.tasks[forkTaskId]?.parent?.lastTurnId,
      'Forking during a follow-up did not persist the selected first turn'
    )
    assert.equal(
      runtimeIndex.tasks[sourceTaskId]?.running,
      true,
      'Forking the first turn stopped the source follow-up'
    )
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: COMPLETION_TEXT,
      timeoutMs: UI_TIMEOUT_MS,
    })
    const forkSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
    assert.equal(
      forkSnapshot.text.includes(RUNNING_FORK_FOLLOW_UP_PROMPT),
      false,
      'The forked task included the in-flight follow-up after the selected turn'
    )
    await captureVerificationScreenshot(control, 'running-follow-up-fork-02-target-open.png')
  } finally {
    control.releaseRunningForkFollowUpResponse()
  }

  await ensureTaskRowVisible(control, sourceTaskRowTestId)
  await control.command('click', `[data-testid="${sourceTaskRowTestId}"]`)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: RUNNING_FORK_COMPLETION_TEXT,
    timeoutMs: UI_TIMEOUT_MS,
  })
  const completedRuntimeIndex = JSON.parse(
    await readFile(join(executorHome, 'runtime-work', 'index.json'), 'utf8')
  )
  const sourceTaskId = sourceTaskRowTestId.replace('runtime-local-task-row-', '')
  assert.equal(
    completedRuntimeIndex.tasks[sourceTaskId]?.turn_status,
    'completed',
    'The source follow-up was interrupted instead of completing after the fork'
  )
}

export async function verifyCompletedTurnFork({
  composerSelector,
  control,
  executorHome,
  sourceTaskRowTestId,
  workspacePath,
}) {
  const taskRowsBeforeFork = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  await control.command('scrollIntoView', '[data-testid="fork-message-button"]')
  await control.command('waitFor', '[data-testid="fork-message-button"]', {
    visible: true,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'completed-turn-fork-01-source-ready.png')
  await control.command('clickWhenEnabled', '[data-testid="fork-message-button"]')
  const forkTaskRowTestId = await waitForNewTaskRow(control, taskRowsBeforeFork, '')
  assert.notEqual(
    forkTaskRowTestId,
    sourceTaskRowTestId,
    'Forking reused the source task instead of creating an independent task'
  )
  const sourceTaskId = sourceTaskRowTestId.replace('runtime-local-task-row-', '')
  const forkTaskId = forkTaskRowTestId.replace('runtime-local-task-row-', '')
  const runtimeIndex = JSON.parse(
    await readFile(join(executorHome, 'runtime-work', 'index.json'), 'utf8')
  )
  assert.equal(
    runtimeIndex.tasks[sourceTaskId]?.workspace_path,
    workspacePath,
    'The source task did not use the selected project workspace'
  )
  assert.equal(
    runtimeIndex.tasks[forkTaskId]?.workspace_path,
    workspacePath,
    'The forked task did not inherit the source workspace'
  )
  assert.equal(
    runtimeIndex.tasks[forkTaskId]?.parent?.taskId,
    sourceTaskId,
    'The backend did not persist the fork parent relationship'
  )
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: COMPLETION_TEXT,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'completed-turn-fork-02-target-open.png')

  control.setScenario('fork_follow_up')
  const forkFollowUpRequest = await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    FORK_FOLLOW_UP_PROMPT,
    'fork_follow_up'
  )
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: FORK_FOLLOW_UP_COMPLETION_TEXT,
    timeoutMs: UI_TIMEOUT_MS,
  })
  assert.ok(
    JSON.stringify(forkFollowUpRequest.body).includes(FORK_FOLLOW_UP_PROMPT),
    'The forked task did not accept an independent follow-up'
  )
  await captureVerificationScreenshot(control, 'completed-turn-fork-03-follow-up-complete.png')

  await control.command('click', `[data-testid="${sourceTaskRowTestId}"]`)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: COMPLETION_TEXT,
    timeoutMs: UI_TIMEOUT_MS,
  })
  const sourceSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.ok(
    !sourceSnapshot.text.includes(FORK_FOLLOW_UP_PROMPT) &&
      !sourceSnapshot.text.includes(FORK_FOLLOW_UP_COMPLETION_TEXT),
    'The fork follow-up mutated the source task transcript'
  )
  await captureVerificationScreenshot(control, 'completed-turn-fork-04-source-unchanged.png')
}

export async function seedToolBlockOrderTask(executorHome, workspacePath) {
  const indexPath = join(executorHome, 'runtime-work', 'index.json')
  await mkdir(dirname(indexPath), { recursive: true })
  const runtimeIndex = await readFile(indexPath, 'utf8')
    .then(content => JSON.parse(content))
    .catch(error => {
      if (error?.code !== 'ENOENT') throw error
      return {
        version: 1,
        tasks: {},
        workspaces: {},
        deleted_archived_task_ids: {},
      }
    })
  const messageCreatedAt = Date.now()
  const earlierCreatedAt = messageCreatedAt + 1_000
  const laterCreatedAt = messageCreatedAt + 2_000

  runtimeIndex.tasks ??= {}
  runtimeIndex.tasks[TOOL_BLOCK_ORDER_TASK_ID] = {
    local_task_id: TOOL_BLOCK_ORDER_TASK_ID,
    thread_id: null,
    workspace_path: workspacePath,
    title: TOOL_BLOCK_ORDER_TASK_TITLE,
    runtime: 'claude_code',
    status: 'done',
    running: false,
    continuable: true,
    thread_status: 'idle',
    turn_status: 'completed',
    created_at: messageCreatedAt,
    updated_at: laterCreatedAt,
    completed_at: laterCreatedAt,
    runtime_handle: {
      messages: [
        {
          id: 'assistant-tool-block-order',
          role: 'assistant',
          subtaskId: TOOL_BLOCK_ORDER_TASK_ID,
          turnId: TOOL_BLOCK_ORDER_TASK_ID,
          content: TOOL_BLOCK_ORDER_COMPLETION_TEXT,
          status: 'done',
          createdAt: new Date(messageCreatedAt).toISOString(),
          blocks: [
            {
              id: LATER_TOOL_BLOCK_ID,
              subtaskId: TOOL_BLOCK_ORDER_TASK_ID,
              type: 'tool',
              toolName: 'exec_command',
              toolInput: { cmd: 'printf later-created-tool' },
              toolOutput: 'later-created-tool',
              status: 'done',
              createdAt: laterCreatedAt,
              completedAt: laterCreatedAt + 100,
            },
            {
              id: EARLIER_TOOL_BLOCK_ID,
              subtaskId: TOOL_BLOCK_ORDER_TASK_ID,
              type: 'tool',
              toolName: 'exec_command',
              toolInput: { cmd: 'printf earlier-created-tool' },
              toolOutput: 'earlier-created-tool',
              status: 'done',
              createdAt: earlierCreatedAt,
              completedAt: earlierCreatedAt + 100,
            },
          ],
        },
      ],
    },
    parent: null,
    ephemeral: false,
    runtime_project_key: null,
    runtime_workspace_roots: [],
  }

  await writeFile(indexPath, `${JSON.stringify(runtimeIndex, null, 2)}\n`, 'utf8')
}

export async function verifyToolBlockChronologicalOrder({
  control,
  executorHome,
  restartDesktopApp,
  workspacePath,
}) {
  await seedToolBlockOrderTask(executorHome, workspacePath)
  await restartDesktopApp()

  const taskRowTestId = `runtime-local-task-row-${TOOL_BLOCK_ORDER_TASK_ID}`
  await ensureTaskRowVisible(control, taskRowTestId)
  await control.command('waitFor', `[data-testid="${taskRowTestId}"]`, {
    text: TOOL_BLOCK_ORDER_TASK_TITLE,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: TOOL_BLOCK_ORDER_COMPLETION_TEXT,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="final-processing-toggle"]')
  await control.command('click', '[data-testid="processing-summary-toggle"]')

  const earlierSelector = `[data-processing-block-id="${EARLIER_TOOL_BLOCK_ID}"]`
  const laterSelector = `[data-processing-block-id="${LATER_TOOL_BLOCK_ID}"]`
  await control.command('waitFor', earlierSelector, {
    visible: true,
    stableMs: 500,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('waitFor', laterSelector, {
    visible: true,
    stableMs: 500,
    timeoutMs: UI_TIMEOUT_MS,
  })
  const [earlierMetrics] = JSON.parse(await control.command('getElementMetrics', earlierSelector))
  const [laterMetrics] = JSON.parse(await control.command('getElementMetrics', laterSelector))
  assert.ok(
    earlierMetrics.top < laterMetrics.top,
    `The later-created tool appeared above the earlier tool (${laterMetrics.top} <= ${earlierMetrics.top})`
  )
  await captureVerificationScreenshot(
    control,
    'tool-block-order-01-chronological.png',
    '[data-testid="message-assistant"]'
  )
}
