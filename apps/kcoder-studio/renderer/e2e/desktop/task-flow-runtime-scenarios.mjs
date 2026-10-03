import assert from 'node:assert/strict'

const REQUIRED_RUNTIME_SCENARIO_DEPS = [
  'ACTIVE_WORKBENCH_SELECTOR',
  'RECONNECT_COMPLETION_TEXT',
  'RECONNECT_PROMPT',
  'UI_TIMEOUT_MS',
  'COMPOSER_READY_STABILITY_MS',
  'GOAL_IDLE_COMPLETION_TEXT',
  'GOAL_IDLE_PROMPT',
  'GOAL_RESTART_COMPLETION_TEXT',
  'GOAL_RESTART_PROMPT',
  'GOAL_RESTART_RESUME_PROMPT',
  'WORKBENCH_READY_TIMEOUT_MS',
  'captureVerificationScreenshot',
  'sendPromptUntilScenarioRequest',
  'withTimeout',
  'selectE2EModel',
  'waitForNewTaskRow',
  'waitForSnapshot',
  'waitForWorkbenchDebugState',
  'waitForBlankConversation',
  'waitForExecutorReadyEvidence',
  'processIsAlive',
  'sendPrompt',
]

function requireRuntimeScenarioDependencies(deps) {
  const missing = REQUIRED_RUNTIME_SCENARIO_DEPS.filter(name => deps?.[name] == null)
  if (missing.length > 0) {
    throw new TypeError(`Runtime scenario factory is missing dependencies: ${missing.join(', ')}`)
  }
}

export function createRuntimeScenarioHelpers(deps) {
  requireRuntimeScenarioDependencies(deps)
  const {
    ACTIVE_WORKBENCH_SELECTOR,
    RECONNECT_COMPLETION_TEXT,
    RECONNECT_PROMPT,
    UI_TIMEOUT_MS,
    COMPOSER_READY_STABILITY_MS,
    GOAL_IDLE_COMPLETION_TEXT,
    GOAL_IDLE_PROMPT,
    GOAL_RESTART_COMPLETION_TEXT,
    GOAL_RESTART_PROMPT,
    GOAL_RESTART_RESUME_PROMPT,
    WORKBENCH_READY_TIMEOUT_MS,
    captureVerificationScreenshot,
    sendPromptUntilScenarioRequest,
    withTimeout,
    selectE2EModel,
    waitForNewTaskRow,
    waitForSnapshot,
    waitForWorkbenchDebugState,
    waitForBlankConversation,
    waitForExecutorReadyEvidence,
    processIsAlive,
    sendPrompt,
  } = deps

  async function verifyReconnectRecovery({ composerSelector, control }) {
    control.setScenario('reconnect')
    await sendPromptUntilScenarioRequest(control, composerSelector, RECONNECT_PROMPT, 'reconnect')
    await withTimeout(
      control.awaitReconnectResponseStarted(),
      UI_TIMEOUT_MS,
      'The reconnect response stream did not start'
    )
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="thinking-indicator"]`,
      { timeoutMs: UI_TIMEOUT_MS }
    )
    await captureVerificationScreenshot(
      control,
      'reconnect-01-streaming.png',
      ACTIVE_WORKBENCH_SELECTOR
    )

    control.disconnectReconnectResponse()
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="runtime-reconnecting-status"]`,
      { timeoutMs: UI_TIMEOUT_MS }
    )
    await captureVerificationScreenshot(
      control,
      'reconnect-02-reconnecting.png',
      ACTIVE_WORKBENCH_SELECTOR
    )

    await withTimeout(
      control.awaitScenarioRequestCount('reconnect', 2),
      UI_TIMEOUT_MS,
      'Codex did not retry the disconnected response stream'
    )
    control.releaseReconnectResponse()
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
      { text: RECONNECT_COMPLETION_TEXT, timeoutMs: UI_TIMEOUT_MS }
    )
    const recoveredSnapshot = JSON.parse(
      await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
    )
    assert.equal(
      recoveredSnapshot.testIds.includes('runtime-reconnecting-status'),
      false,
      'The reconnecting status remained after model output recovered'
    )
    await captureVerificationScreenshot(
      control,
      'reconnect-03-recovered.png',
      ACTIVE_WORKBENCH_SELECTOR
    )
  }

  async function verifyActiveGoalIdleUnreadLifecycle({ composerSelector, control }) {
    control.setScenario('goal_idle')
    const taskRowsBeforeGoal = new Set(
      JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
        testId.startsWith('runtime-local-task-row-')
      )
    )
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await selectE2EModel(control)
    await control.command('click', '[data-testid="add-context-button"]')
    await control.command('click', '[data-testid="set-goal-button"]')
    await control.command('waitFor', '[data-testid="goal-draft-pill"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await sendPromptUntilScenarioRequest(control, composerSelector, GOAL_IDLE_PROMPT, 'goal_idle')
    const goalTaskRowTestId = await waitForNewTaskRow(
      control,
      taskRowsBeforeGoal,
      'KCODER_STUDIO_DESKTOP_E2E_GOAL_IDLE'
    )
    const goalTaskId = goalTaskRowTestId.replace('runtime-local-task-row-', '')
    const goalUnreadTestId = `runtime-local-task-unread-dot-${goalTaskId}`
    const goalRunningTestId = `runtime-local-task-running-${goalTaskId}`
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes(goalRunningTestId) &&
        snapshot.testIds.includes('pause-response-button') &&
        snapshot.testIds.includes('thinking-indicator') &&
        !snapshot.testIds.includes('send-message-button') &&
        !snapshot.testIds.includes(goalUnreadTestId),
      'The running Goal turn did not render a consistent sidebar, composer, and message state'
    )
    const runningDebugSnapshot = await waitForWorkbenchDebugState(
      control,
      snapshot => snapshot.pane?.status?.isAssistantStreaming === true,
      'The running Goal turn never entered visible streaming state'
    )
    assert.equal(
      runningDebugSnapshot.workbench?.lifecycleCurrentTaskRunning,
      true,
      'The running Goal turn was not authoritative runtime work'
    )
    assert.equal(
      runningDebugSnapshot.pane?.status?.isAssistantStreaming,
      true,
      'The running Goal turn did not expose a streaming assistant message'
    )
    assert.equal(
      runningDebugSnapshot.pane?.status?.isBusy,
      true,
      'The running Goal turn did not keep the composer busy'
    )
    await captureVerificationScreenshot(control, 'goal-idle-01-running.png')

    control.releaseGoalIdleInitialResponse()
    await withTimeout(
      control.awaitScenarioRequestCount('goal_idle', 2),
      UI_TIMEOUT_MS,
      'The active Goal did not start its automatic continuation'
    )

    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes(goalTaskRowTestId) &&
        snapshot.testIds.includes('goal-status-bar') &&
        snapshot.testIds.includes(goalRunningTestId) &&
        snapshot.testIds.includes('pause-response-button') &&
        snapshot.testIds.includes('thinking-indicator') &&
        !snapshot.testIds.includes('send-message-button') &&
        !snapshot.testIds.includes(goalUnreadTestId) &&
        snapshot.text.includes(GOAL_IDLE_PROMPT),
      'The between-turn Goal gap did not preserve the sidebar, composer, message, and unread state',
      UI_TIMEOUT_MS
    )
    const continuationDebugSnapshot = await waitForWorkbenchDebugState(
      control,
      snapshot =>
        snapshot.pane?.status?.isAssistantStreaming === true &&
        snapshot.pane?.status?.taskExecution?.running === true,
      'The automatic Goal continuation never entered visible streaming state'
    )
    assert.equal(
      continuationDebugSnapshot.workbench?.lifecycleCurrentTaskRunning,
      true,
      'The active Goal stopped being visibly running during automatic continuation'
    )
    assert.equal(
      continuationDebugSnapshot.pane?.goal?.status,
      'active',
      'The Goal stopped being active during automatic continuation'
    )
    assert.equal(
      continuationDebugSnapshot.pane?.status?.taskExecution?.running,
      true,
      'The active Goal lost its unified running state during automatic continuation'
    )
    assert.equal(
      continuationDebugSnapshot.pane?.status?.isBusy,
      true,
      'The active Goal released the composer during automatic continuation'
    )
    await captureVerificationScreenshot(control, 'goal-idle-02-automatic-continuation.png')

    await control.command('click', '[data-testid="new-chat-button"]')
    await waitForBlankConversation(control, composerSelector)
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes(goalTaskRowTestId) &&
        !snapshot.testIds.includes(goalUnreadTestId) &&
        snapshot.testIds.includes(goalRunningTestId),
      'The background Goal continuation stopped running or became unread'
    )
    await captureVerificationScreenshot(control, 'goal-idle-03-background-unread-free.png')

    control.releaseGoalIdleResponse()
    await control.command('waitFor', `[data-testid="${goalUnreadTestId}"]`, {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await captureVerificationScreenshot(control, 'goal-idle-04-settled-unread.png')
    await control.command('clickWhenEnabled', `[data-testid="${goalTaskRowTestId}"]`, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: GOAL_IDLE_COMPLETION_TEXT,
      timeoutMs: UI_TIMEOUT_MS,
    })
    const completedDebugSnapshot = JSON.parse(
      await control.command('getWorkbenchDebugSnapshot', 'body')
    )
    assert.equal(
      completedDebugSnapshot.workbench?.lifecycleCurrentTaskRunning,
      false,
      `The completed Goal remained authoritative runtime work: ${JSON.stringify(
        completedDebugSnapshot.workbench?.runningState ?? null
      )}`
    )
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes('send-message-button') &&
        !snapshot.testIds.includes(goalUnreadTestId) &&
        !snapshot.testIds.includes(goalRunningTestId) &&
        !snapshot.testIds.includes('pause-response-button') &&
        !snapshot.testIds.includes('thinking-indicator') &&
        !snapshot.testIds.includes('goal-status-bar'),
      'Opening the completed Goal task did not render a consistent final state',
      UI_TIMEOUT_MS
    )
    const settledDebugSnapshot = JSON.parse(
      await control.command('getWorkbenchDebugSnapshot', 'body')
    )
    assert.equal(
      settledDebugSnapshot.pane?.goal ?? null,
      null,
      'The completed Goal remained visible as an active pane goal'
    )
    assert.equal(
      settledDebugSnapshot.pane?.status?.isBusy,
      false,
      'The completed Goal kept the composer busy'
    )
  }

  async function verifyGoalRestartRecoveryLifecycle({
    composerSelector,
    control,
    executorLogPath,
    restartDesktopApp,
  }) {
    control.setScenario('goal_restart')
    const taskRowsBeforeGoal = new Set(
      JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
        testId.startsWith('runtime-local-task-row-')
      )
    )
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await selectE2EModel(control)
    await control.command('click', '[data-testid="add-context-button"]')
    await control.command('click', '[data-testid="set-goal-button"]')
    await control.command('waitFor', '[data-testid="goal-draft-pill"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await sendPromptUntilScenarioRequest(
      control,
      composerSelector,
      GOAL_RESTART_PROMPT,
      'goal_restart'
    )
    const goalTaskRowTestId = await waitForNewTaskRow(
      control,
      taskRowsBeforeGoal,
      'KCODER_STUDIO_DESKTOP_E2E_GOAL_RESTART'
    )
    const goalTaskId = goalTaskRowTestId.replace('runtime-local-task-row-', '')
    const goalUnreadTestId = `runtime-local-task-unread-dot-${goalTaskId}`
    const goalRunningTestId = `runtime-local-task-running-${goalTaskId}`
    await withTimeout(
      control.awaitScenarioRequestCount('goal_restart', 2),
      UI_TIMEOUT_MS,
      'The active Goal did not enter automatic continuation before restart'
    )
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes(goalRunningTestId) &&
        snapshot.testIds.includes('pause-response-button') &&
        snapshot.testIds.includes('thinking-indicator') &&
        !snapshot.testIds.includes(goalUnreadTestId),
      'The user did not see the Goal working before the app restarted'
    )
    await captureVerificationScreenshot(control, 'goal-restart-01-working-before-restart.png')

    await control.command('click', '[data-testid="new-chat-button"]')
    await waitForBlankConversation(control, composerSelector)
    const executorReadyBeforeRestart = await waitForExecutorReadyEvidence(executorLogPath)
    const executorProcessIdBeforeRestart = executorReadyBeforeRestart.processIds.at(-1)
    assert.ok(executorProcessIdBeforeRestart, 'The original executor process ID was not recorded')

    await restartDesktopApp()

    const executorReadyAfterRestart = await waitForExecutorReadyEvidence(
      executorLogPath,
      UI_TIMEOUT_MS,
      executorReadyBeforeRestart.processIds.length + 1
    )
    const executorProcessIdAfterRestart = executorReadyAfterRestart.processIds.at(-1)
    assert.ok(executorProcessIdAfterRestart, 'The restarted executor process ID was not recorded')
    assert.notEqual(
      executorProcessIdAfterRestart,
      executorProcessIdBeforeRestart,
      'Restarting the app reused the executor process that owned the active Goal'
    )
    assert.equal(
      processIsAlive(executorProcessIdBeforeRestart),
      false,
      'The original executor remained alive after a full app restart'
    )

    await control.command('waitFor', `[data-testid="${goalTaskRowTestId}"]`, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes(goalTaskRowTestId) &&
        !snapshot.testIds.includes(goalRunningTestId) &&
        !snapshot.testIds.includes(goalUnreadTestId),
      'The interrupted Goal looked running or completed after the app restarted',
      WORKBENCH_READY_TIMEOUT_MS
    )
    await captureVerificationScreenshot(control, 'goal-restart-02-returned-not-running.png')

    await control.command('clickWhenEnabled', `[data-testid="${goalTaskRowTestId}"]`, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes('goal-status-bar') &&
        snapshot.testIds.includes('send-message-button') &&
        !snapshot.testIds.includes('pause-response-button') &&
        !snapshot.testIds.includes('thinking-indicator') &&
        !snapshot.testIds.includes(goalRunningTestId) &&
        !snapshot.testIds.includes(goalUnreadTestId) &&
        snapshot.text.includes(GOAL_RESTART_PROMPT),
      'Opening the interrupted Goal did not present a stable, user-controlled recovery state',
      WORKBENCH_READY_TIMEOUT_MS
    )
    const interruptedDebugSnapshot = JSON.parse(
      await control.command('getWorkbenchDebugSnapshot', 'body')
    )
    assert.equal(
      interruptedDebugSnapshot.workbench?.lifecycleCurrentTaskRunning,
      false,
      'Opening the interrupted Goal changed the executor-owned running state'
    )
    assert.equal(
      interruptedDebugSnapshot.pane?.goal?.status,
      'active',
      'Restarting the app discarded the persisted Goal'
    )
    await captureVerificationScreenshot(control, 'goal-restart-03-opened-waiting-for-user.png')

    const requestCountBeforeUserResume = control.scenarioRequests.get('goal_restart')?.length ?? 0
    await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))
    assert.equal(
      control.scenarioRequests.get('goal_restart')?.length ?? 0,
      requestCountBeforeUserResume,
      'The interrupted Goal resumed without an explicit user action'
    )

    control.markGoalRestartResumeRequested()
    await sendPrompt(control, composerSelector, GOAL_RESTART_RESUME_PROMPT)
    await withTimeout(
      control.awaitScenarioRequestCount('goal_restart', requestCountBeforeUserResume + 1),
      UI_TIMEOUT_MS,
      'The executor did not resume the Goal after explicit user input'
    )
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes(goalRunningTestId) &&
        snapshot.testIds.includes('pause-response-button') &&
        snapshot.testIds.includes('thinking-indicator') &&
        !snapshot.testIds.includes('send-message-button') &&
        !snapshot.testIds.includes(goalUnreadTestId),
      'The user did not see consistent running feedback after explicitly resuming the Goal'
    )
    await captureVerificationScreenshot(control, 'goal-restart-04-explicitly-resumed.png')

    await control.command('click', '[data-testid="new-chat-button"]')
    await waitForBlankConversation(control, composerSelector)
    control.releaseGoalRestartResponse()
    await control.command('waitFor', `[data-testid="${goalUnreadTestId}"]`, {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await captureVerificationScreenshot(control, 'goal-restart-05-completed-unread.png')

    await control.command('clickWhenEnabled', `[data-testid="${goalTaskRowTestId}"]`, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: GOAL_RESTART_COMPLETION_TEXT,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes('send-message-button') &&
        !snapshot.testIds.includes(goalUnreadTestId) &&
        !snapshot.testIds.includes(goalRunningTestId) &&
        !snapshot.testIds.includes('pause-response-button') &&
        !snapshot.testIds.includes('thinking-indicator') &&
        !snapshot.testIds.includes('goal-status-bar'),
      'The recovered Goal did not settle into a consistent final state',
      UI_TIMEOUT_MS
    )
    await captureVerificationScreenshot(control, 'goal-restart-06-completed-read.png')
  }

  return {
    verifyReconnectRecovery,
    verifyActiveGoalIdleUnreadLifecycle,
    verifyGoalRestartRecoveryLifecycle,
  }
}
