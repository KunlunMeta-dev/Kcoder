// desktop lifecycle for the existing desktop runner.
import {
  artifactSink,
  commandOutput,
  delay,
  operationSignal,
  retainedLogRefreshers,
  runChecked,
  withTimeout,
} from './runtime.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  COMPOSER_READY_STABILITY_MS,
  FRESH_CHAT_COMPLETION_TEXT,
  FRESH_CHAT_PROMPT,
  TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX,
  TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX,
  TURN_NAVIGATION_REGRESSION_TURN_COUNT,
  UI_TIMEOUT_MS,
  WINDOW_LIFECYCLE_COMPLETION_TEXT,
  WINDOW_LIFECYCLE_PROMPT,
  WINDOW_LIFECYCLE_SCROLL_MARKER,
  WORKBENCH_READY_TIMEOUT_MS,
  resultDir,
} from './config.mjs'
import {
  captureVerificationScreenshot,
  getSingleElementMetrics,
  selectE2EModel,
  sendPrompt,
  sendPromptUntilScenarioRequest,
  waitForBlankConversation,
  waitForBottomMetrics,
  waitForNewTaskRow,
  waitForSnapshot,
  waitForTopMetrics,
} from './ui-helpers.mjs'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { distanceFromBottom } from '../task-flow-evidence.mjs'

export function processIsAlive(processId) {
  try {
    process.kill(processId, 0)
    return true
  } catch {
    return false
  }
}

export async function macosSleepInhibitorProcessIds(appProcessId) {
  if (process.platform !== 'darwin') return []
  const output = await commandOutput('/bin/ps', ['-axo', 'pid=,ppid=,command='])
  return output.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match || Number(match[2]) !== appProcessId || match[3] !== '/usr/bin/caffeinate -i') {
      return []
    }
    return [Number(match[1])]
  })
}

export async function waitForMacosSleepInhibitor(appProcessId, expectedRunning) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < UI_TIMEOUT_MS) {
    const processIds = await macosSleepInhibitorProcessIds(appProcessId)
    if (processIds.length > 0 === expectedRunning) return processIds
    await delay(100)
  }
  throw new Error(
    `Timed out waiting for the macOS sleep inhibitor to be ${expectedRunning ? 'running' : 'stopped'}`
  )
}

export async function waitForExecutorReadyEvidence(
  logPath,
  timeoutMs = UI_TIMEOUT_MS,
  minimumProcessCount = 1
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    await retainedLogRefreshers.get(logPath)?.sync()
    const content = await readFile(logPath, 'utf8').catch(() => '')
    const processIds = [...content.matchAll(/app IPC stdio ready[^\n]*process_id=(\d+)/g)].map(
      match => Number(match[1])
    )
    if (processIds.length >= minimumProcessCount) return { processIds, content }
    await delay(100)
  }
  throw new Error(`Timed out waiting for executor stdio-ready evidence in ${logPath}`)
}

export async function waitForLogPattern(
  logPath,
  pattern,
  { fromOffset = 0, timeoutMs = UI_TIMEOUT_MS } = {}
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    await retainedLogRefreshers.get(logPath)?.sync()
    const content = await readFile(logPath, 'utf8').catch(() => '')
    if (pattern.test(content.slice(fromOffset))) return content
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${pattern} in ${logPath} after offset ${fromOffset}`)
}

export async function reactivateMacApplication(appIdentifier) {
  await runChecked('open', ['-b', appIdentifier])
}

export async function verifyBackgroundTaskWindowLifecycle({
  app,
  appIdentifier,
  composerSelector,
  control,
  executorLogPath,
  setPhase,
}) {
  const lifecycleScreenshotName = name => `window-lifecycle-${name}`
  setPhase('background-streaming-task')
  control.setScenario('window_lifecycle')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control)
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    WINDOW_LIFECYCLE_PROMPT,
    'window_lifecycle'
  )
  await withTimeout(
    control.awaitWindowLifecycleResponseStarted(),
    UI_TIMEOUT_MS,
    'Timed out waiting for the streaming response to start'
  )
  const sleepInhibitorEvidence = []
  if (process.platform === 'darwin') {
    const processIds = await waitForMacosSleepInhibitor(app.pid, true)
    sleepInhibitorEvidence.push({ stage: 'task-running', processIds })
  }
  const runningTaskSnapshot = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.some(testId => testId.startsWith('runtime-local-task-running-')),
    'The running task was not available before closing the window'
  )
  const runningTaskTestId = runningTaskSnapshot.testIds.find(testId =>
    testId.startsWith('runtime-local-task-running-')
  )
  assert.ok(runningTaskTestId, 'The running task indicator was not found')
  const taskRowTestId = runningTaskTestId.replace(
    'runtime-local-task-running-',
    'runtime-local-task-row-'
  )

  await getSingleElementMetrics(control, ACTIVE_WORKBENCH_SELECTOR, 'The running conversation pane')
  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)

  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('01-task-running-in-background-before-window-close.png')
  )

  if (process.platform === 'darwin') {
    setPhase('close-to-tray-and-reopen')
    const readyCountBeforeClose = control.readyCount
    const controlClientIdBeforeClose = control.ready?.clientId
    assert.ok(
      controlClientIdBeforeClose,
      'The original WebView did not register a control client ID'
    )
    const readyEvidenceBeforeClose = await waitForExecutorReadyEvidence(executorLogPath)
    const executorProcessId = readyEvidenceBeforeClose.processIds.at(-1)
    assert.ok(executorProcessId, 'The executor stdio-ready log did not include a process ID')
    assert.equal(processIsAlive(app.pid), true, 'The app process was not alive before close')
    assert.equal(
      processIsAlive(executorProcessId),
      true,
      'The executor process was not alive before close'
    )

    await control.command('closeMainWindowToTray', 'body')
    await waitForLogPattern(join(resultDir, `kcoder-tauri-${app.pid}.log`), /windowWillClose:/)
    assert.equal(processIsAlive(app.pid), true, 'Closing to tray terminated the app process')
    assert.equal(
      processIsAlive(executorProcessId),
      true,
      'Closing to tray terminated the executor process'
    )
    const backgroundProcessIds = await waitForMacosSleepInhibitor(app.pid, true)
    sleepInhibitorEvidence.push({
      stage: 'window-closed-to-tray',
      processIds: backgroundProcessIds,
    })

    await reactivateMacApplication(appIdentifier)
    await withTimeout(
      control.awaitReadyAfter(readyCountBeforeClose),
      WORKBENCH_READY_TIMEOUT_MS,
      'The reopened KCoder Studio WebView did not reconnect to the desktop controller'
    )
    assert.notEqual(
      control.ready?.clientId,
      controlClientIdBeforeClose,
      'The reopened WebView reused the closed control client identity'
    )
    const reopenedTaskWait = control.command('waitFor', `[data-testid="${taskRowTestId}"]`, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    const staleClientPoll = await fetch(
      `${control.controlUrl}/commands?clientId=${encodeURIComponent(controlClientIdBeforeClose)}`,
      { signal: operationSignal }
    )
    assert.equal(
      staleClientPoll.status,
      204,
      'A closed WebView control client was able to steal a replacement WebView command'
    )
    await reopenedTaskWait
    const readyEvidenceAfterReopen = await waitForExecutorReadyEvidence(executorLogPath)
    assert.deepEqual(
      readyEvidenceAfterReopen.processIds,
      [executorProcessId],
      'Reopening the window spawned or attached to a different executor process'
    )
    assert.equal(
      processIsAlive(executorProcessId),
      true,
      'The original executor process was not alive after reopening the window'
    )
    await artifactSink.writeJson(join(resultDir, 'stdio-lifecycle-verification.json'), {
      appProcessId: app.pid,
      executorProcessId,
      executorReadyLogCount: readyEvidenceAfterReopen.processIds.length,
      webviewReadyCountBeforeClose: readyCountBeforeClose,
      webviewReadyCountAfterReopen: control.readyCount,
      appAliveAfterReopen: processIsAlive(app.pid),
      executorAliveAfterReopen: processIsAlive(executorProcessId),
    })
    await captureVerificationScreenshot(
      control,
      lifecycleScreenshotName('02-window-reopened-task-still-running.png')
    )
  }

  await waitForBlankConversation(control, composerSelector)
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('03-background-task-after-reopen.png')
  )
  control.releaseWindowLifecycleResponse()
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(runningTaskTestId),
    'The background task did not settle while another pane was active'
  )
  const unreadTaskTestId = taskRowTestId.replace(
    'runtime-local-task-row-',
    'runtime-local-task-unread-dot-'
  )
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.includes(unreadTaskTestId),
    'The settled background task did not become unread'
  )
  await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('message-assistant') &&
      snapshot.text.includes(WINDOW_LIFECYCLE_COMPLETION_TEXT) &&
      !snapshot.testIds.includes(unreadTaskTestId) &&
      !snapshot.testIds.includes('thinking-indicator'),
    'Switching to the completed background task did not show its latest read state',
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  const initiallyOpenedMetrics = await waitForBottomMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The initially opened completed conversation scroll container'
  )
  assert.ok(
    distanceFromBottom(initiallyOpenedMetrics) <= 2,
    'A previously unopened completed conversation did not open at the bottom'
  )
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('04-background-task-latest-state-after-switch.png')
  )
  if (process.platform === 'darwin') {
    const processIds = await waitForMacosSleepInhibitor(app.pid, false)
    sleepInhibitorEvidence.push({ stage: 'task-completed', processIds })
    await artifactSink.writeJson(join(resultDir, 'sleep-inhibitor-lifecycle-verification.json'), {
      appProcessId: app.pid,
      stages: sleepInhibitorEvidence,
    })
  }

  setPhase('completed-task-reopen')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(WINDOW_LIFECYCLE_COMPLETION_TEXT) &&
      !snapshot.testIds.includes('pause-response-button') &&
      !snapshot.testIds.includes(runningTaskTestId) &&
      snapshot.testIds.includes('send-message-button'),
    'The completed task became busy again after reopening its continuable conversation',
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('05-completed-task-reopened-idle.png')
  )

  const reopenedBottomMetrics = await waitForBottomMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The reopened bottom-pinned conversation scroll container'
  )
  assert.ok(
    distanceFromBottom(reopenedBottomMetrics) <= 2,
    'A conversation that was previously at the bottom did not reopen at the bottom'
  )

  setPhase('completed-task-scroll-position')
  const middleParagraphSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"] [data-scroll-anchor]:nth-of-type(14)`
  await control.command('scrollIntoViewAsUser', middleParagraphSelector)
  await delay(1_000)
  const middlePositionBeforeSwitch = await getSingleElementMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The middle-position conversation scroll container before switching'
  )
  assert.ok(
    distanceFromBottom(middlePositionBeforeSwitch) > 100,
    'The long conversation did not leave the bottom before testing position restoration'
  )
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('06-task-middle-position-before-switch.png')
  )

  control.setScenario('fresh_chat')
  const taskRowsBeforeFreshChat = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  await control.command('click', '[data-testid="runtime-chat-section-new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control)
  await sendPrompt(control, composerSelector, FRESH_CHAT_PROMPT)
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: FRESH_CHAT_COMPLETION_TEXT,
      timeoutMs: UI_TIMEOUT_MS,
    }
  )
  const freshTaskRowTestId = await waitForNewTaskRow(
    control,
    taskRowsBeforeFreshChat,
    'KCODER_STUDIO_DESKTOP_E2E_FRESH_CHAT'
  )
  const shortConversationMetrics = await getSingleElementMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The short conversation scroll container'
  )
  assert.ok(
    shortConversationMetrics.scrollHeight <= shortConversationMetrics.clientHeight + 1,
    `The short conversation overflowed by ${shortConversationMetrics.scrollHeight - shortConversationMetrics.clientHeight}px`
  )
  await getSingleElementMetrics(
    control,
    ACTIVE_WORKBENCH_SELECTOR,
    'The switched conversation pane'
  )
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('07-switched-to-new-task.png')
  )

  await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', middleParagraphSelector, {
    text: WINDOW_LIFECYCLE_SCROLL_MARKER,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await delay(1_000)
  const middlePositionAfterSwitch = await getSingleElementMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The middle-position conversation scroll container after switching back'
  )
  assert.ok(
    Math.abs(middlePositionAfterSwitch.scrollTop - middlePositionBeforeSwitch.scrollTop) <= 32,
    `The middle scroll position moved from ${middlePositionBeforeSwitch.scrollTop}px to ${middlePositionAfterSwitch.scrollTop}px`
  )
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('08-task-middle-position-after-switch-back.png')
  )

  setPhase('turn-navigation-virtualized-anchor')
  control.setScenario('turn_navigation')
  for (let index = 0; index < TURN_NAVIGATION_REGRESSION_TURN_COUNT; index += 1) {
    const turnNumber = index + 1
    const completionText = `${TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX}_${turnNumber}`
    await sendPrompt(
      control,
      composerSelector,
      `${TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX}_${turnNumber}`
    )
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
      { text: completionText, timeoutMs: UI_TIMEOUT_MS }
    )
  }

  await control.command('waitFor', '[data-testid="message-turn-navigation-marker"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="message-turn-navigation-marker"]')
  await delay(2_000)
  const navigationTopMetrics = await waitForTopMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The conversation after jumping to the first virtualized turn'
  )
  assert.ok(
    navigationTopMetrics.scrollHeight > navigationTopMetrics.clientHeight * 4,
    'The turn navigation regression conversation was not long enough to exercise virtualization'
  )
  await control.command('waitFor', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`, {
    text: WINDOW_LIFECYCLE_PROMPT,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('09-first-virtualized-turn-navigation-target.png')
  )

  setPhase('archived-task-cache-eviction')
  const cacheBeforeArchive = JSON.parse(
    await control.command('performanceSnapshot', 'body')
  ).runtimeConversationCache
  const freshTaskId = freshTaskRowTestId.replace('runtime-local-task-row-', '')
  await control.command('click', `[data-testid="runtime-local-task-archive-${freshTaskId}"]`)
  await control.command(
    'waitFor',
    `[data-testid="runtime-local-task-archive-toast-${freshTaskId}"]`,
    {
      timeoutMs: UI_TIMEOUT_MS,
    }
  )
  const archivedTaskSelector = `[data-testid="${freshTaskRowTestId}"]`
  const archiveRowRemovalStartedAt = Date.now()
  let archivedTaskRowCount = 1
  while (Date.now() - archiveRowRemovalStartedAt < UI_TIMEOUT_MS) {
    archivedTaskRowCount = Number(await control.command('getElementCount', archivedTaskSelector))
    if (archivedTaskRowCount === 0) break
    await delay(100)
  }
  assert.equal(archivedTaskRowCount, 0, 'The archived task remained mounted in the sidebar')
  const archiveEvictionStartedAt = Date.now()
  let cacheAfterArchive = cacheBeforeArchive
  while (Date.now() - archiveEvictionStartedAt < UI_TIMEOUT_MS) {
    cacheAfterArchive = JSON.parse(
      await control.command('performanceSnapshot', 'body')
    ).runtimeConversationCache
    if (cacheAfterArchive.messageEntries < cacheBeforeArchive.messageEntries) break
    await delay(100)
  }
  assert.ok(
    cacheAfterArchive.messageEntries < cacheBeforeArchive.messageEntries,
    `Archiving retained conversation messages (${cacheBeforeArchive.messageEntries} -> ${cacheAfterArchive.messageEntries})`
  )
  assert.ok(
    cacheAfterArchive.scrollSnapshotEntries <= cacheBeforeArchive.scrollSnapshotEntries &&
      cacheAfterArchive.virtualMeasurementEntries <= cacheBeforeArchive.virtualMeasurementEntries,
    'Archiving increased retained conversation view state'
  )
  await artifactSink.writeJson(join(resultDir, 'conversation-switching-cache-eviction.json'), {
    before: cacheBeforeArchive,
    after: cacheAfterArchive,
  })
}
