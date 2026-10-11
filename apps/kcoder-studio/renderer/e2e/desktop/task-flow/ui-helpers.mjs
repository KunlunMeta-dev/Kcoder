// ui helpers for the existing desktop runner.
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_SEND_BUTTON_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  COMPOSER_READY_STABILITY_MS,
  HIDDEN_CLOUD_MODEL_PROTOCOL_MATRIX_CASES,
  MODEL_ID,
  MODEL_LABEL,
  MODEL_PROTOCOL_MATRIX_TIMEOUT_MS,
  MODEL_PROTOCOL_MATRIX_TOTAL,
  UI_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  resultDir,
} from './config.mjs'
import { delay, runChecked, withTimeout } from './runtime.mjs'
import { matrixCaseId } from './model-bindings.mjs'
import assert from 'node:assert/strict'
import { distanceFromBottom } from '../task-flow-evidence.mjs'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'

export async function sendPrompt(control, selector, prompt) {
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('pause-response-button'),
    'The active task did not become idle before sending the next prompt'
  )
  await control.command('fill', selector, { value: prompt })
  await control.command('press', selector, { key: 'Enter' })
}

export async function sendPromptWithButton(
  control,
  selector,
  prompt,
  timeoutMs = MODEL_PROTOCOL_MATRIX_TIMEOUT_MS
) {
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('pause-response-button'),
    'The active task did not become idle before sending the next prompt'
  )
  await control.command('fill', selector, { value: prompt })
  await control.command('waitFor', selector, {
    text: prompt,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs,
  })
  await control.command('press', selector, { key: 'Enter', timeoutMs })
  await waitForSuccessfulMatrixSubmission(control, selector, prompt, timeoutMs)
}

export async function waitForSuccessfulMatrixSubmission(control, selector, prompt, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (control.fatalError) throw control.fatalError
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    if (snapshot.testIds.includes('chat-input-error')) {
      const error = await control.command('getText', '[data-testid="chat-input-error"]')
      throw new Error(`The UI rejected ${prompt}: ${error}`)
    }
    const composerValue = await control.command('getValue', selector)
    if (composerValue === '' && snapshot.text.includes(prompt)) return
    await delay(50)
  }
  throw new Error(`The composer did not submit ${prompt} within ${timeoutMs}ms`)
}

export async function prepareCompletedTurnScreenshot(control) {
  await control.command('waitFor', ACTIVE_SEND_BUTTON_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })

  const startedAt = Date.now()
  let menuClosedAt = null
  while (Date.now() - startedAt < UI_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    if (snapshot.testIds.includes('model-selector-menu')) {
      menuClosedAt = null
      await control.command('pointerDown', ACTIVE_COMPOSER_SELECTOR)
    } else {
      menuClosedAt ??= Date.now()
      if (Date.now() - menuClosedAt >= COMPOSER_READY_STABILITY_MS) return
    }
    await delay(100)
  }
  throw new Error('The model selector menu remained open before the verification screenshot')
}

export async function waitForSnapshot(
  control,
  predicate,
  message,
  timeoutMs = UI_TIMEOUT_MS,
  selector = 'body'
) {
  const startedAt = Date.now()
  let lastSnapshot = null
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', selector))
    lastSnapshot = snapshot
    if (predicate(snapshot)) return snapshot
    await delay(100)
  }
  const relevantTestIds = (lastSnapshot?.testIds ?? []).filter(
    testId =>
      testId.startsWith('runtime-local-task-') ||
      [
        'goal-status-bar',
        'pause-response-button',
        'send-message-button',
        'thinking-indicator',
      ].includes(testId)
  )
  throw new Error(`${message}; relevant test IDs: ${JSON.stringify(relevantTestIds)}`)
}

export async function getElementMetrics(control, selector) {
  return JSON.parse(await control.command('getElementMetrics', selector))
}

export async function getSingleElementMetrics(control, selector, description) {
  const metrics = await getElementMetrics(control, selector)
  assert.equal(metrics.length, 1, `${description} rendered ${metrics.length} matching elements`)
  return metrics[0]
}

export async function waitForBottomMetrics(control, selector, description, timeoutMs = 1_500) {
  const startedAt = Date.now()
  let metrics
  while (Date.now() - startedAt < timeoutMs) {
    metrics = await getSingleElementMetrics(control, selector, description)
    if (distanceFromBottom(metrics) <= 2) return metrics
    await delay(50)
  }
  throw new Error(
    `${description} remained ${distanceFromBottom(metrics)}px from the bottom after ${timeoutMs}ms`
  )
}

export async function waitForTopMetrics(control, selector, description, timeoutMs = 3_000) {
  const startedAt = Date.now()
  let metrics
  while (Date.now() - startedAt < timeoutMs) {
    metrics = await getSingleElementMetrics(control, selector, description)
    if (metrics.scrollTop <= 2) return metrics
    await delay(50)
  }
  throw new Error(
    `${description} remained ${metrics.scrollTop}px from the top after ${timeoutMs}ms`
  )
}

export async function openBottomWorkspaceTerminal(control, description) {
  await control.command('click', '[data-testid="toggle-bottom-workspace-panel-button"]')
  const snapshot = await waitForSnapshot(
    control,
    value =>
      value.testIds.includes('workspace-terminal-window') &&
      value.testIds.includes('remote-terminal') &&
      !value.testIds.includes('workspace-tool-launcher'),
    `${description} did not start the terminal directly`,
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  assert.equal(
    snapshot.testIds.includes('workspace-ide-card'),
    false,
    `${description} exposed IDE in the bottom panel`
  )
  return snapshot
}

export async function closeBottomWorkspacePanel(control) {
  await control.command('click', '[data-testid="close-bottom-workspace-panel-button"]')
  await waitForSnapshot(
    control,
    value =>
      !value.testIds.includes('workspace-tool-launcher') &&
      !value.testIds.includes('workspace-terminal-window'),
    'The bottom workspace panel did not close',
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
}

export async function waitForNewTaskRow(
  control,
  knownTaskRows,
  expectedText,
  timeoutMs = UI_TIMEOUT_MS
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const candidates = snapshot.testIds.filter(
      testId => testId.startsWith('runtime-local-task-row-') && !knownTaskRows.has(testId)
    )
    for (const testId of candidates) {
      const rowText = await control.command('getText', `[data-testid="${testId}"]`)
      if (rowText.includes(expectedText)) return testId
    }
    await delay(100)
  }
  throw new Error(`The sidebar did not expose a task row for ${expectedText}`)
}

export async function waitForTaskRowByText(control, expectedText) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < UI_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const candidates = snapshot.testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
    for (const testId of candidates) {
      const rowText = await control.command('getText', `[data-testid="${testId}"]`)
      if (rowText.includes(expectedText)) return testId
    }
    await delay(100)
  }
  throw new Error(`The sidebar did not expose a task row containing ${expectedText}`)
}

export async function ensureTaskRowVisible(control, taskRowTestId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = await waitForSnapshot(
      control,
      value =>
        value.testIds.includes(taskRowTestId) ||
        value.testIds.some(testId => testId.startsWith('project-runtime-tasks-expand-')),
      `Unable to find task row ${taskRowTestId} or a project task expansion control`,
      WORKBENCH_READY_TIMEOUT_MS
    )
    if (snapshot.testIds.includes(taskRowTestId)) return
    const expandTasksButton = snapshot.testIds.find(testId =>
      testId.startsWith('project-runtime-tasks-expand-')
    )
    assert.ok(expandTasksButton)
    await control.command('click', `[data-testid="${expandTasksButton}"]`)
  }
  await control.command('waitFor', `[data-testid="${taskRowTestId}"]`, {
    timeoutMs: UI_TIMEOUT_MS,
  })
}

export async function waitForBlankConversation(control, composerSelector) {
  await control.command('waitFor', composerSelector, { timeoutMs: UI_TIMEOUT_MS })
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes('message-user') && !snapshot.testIds.includes('message-assistant'),
    'The new task did not activate a blank conversation before input',
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
}

export async function waitForScenarioRequestCount(control, scenario, expectedCount) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < UI_TIMEOUT_MS) {
    const requestCount = control.scenarioRequests.get(scenario)?.length ?? 0
    if (requestCount >= expectedCount) return
    await delay(100)
  }
  throw new Error(`The model service did not receive ${expectedCount} ${scenario} requests`)
}

export async function waitForFolderPathReady(control, expectedPath) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < UI_TIMEOUT_MS) {
    const inputValue = await control.command('getValue', '[data-testid="device-folder-path-input"]')
    const directoryText = await control.command(
      'getText',
      '[data-testid="device-folder-directory-list"]'
    )
    if (inputValue === expectedPath && !/Loading directories|正在加载目录/.test(directoryText)) {
      return
    }
    await delay(100)
  }
  throw new Error(`The device folder picker did not finish loading ${expectedPath}`)
}

export async function waitForFolderPickerInitialized(control) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < UI_TIMEOUT_MS) {
    const inputValue = await control.command('getValue', '[data-testid="device-folder-path-input"]')
    const directoryText = await control.command(
      'getText',
      '[data-testid="device-folder-directory-list"]'
    )
    if (inputValue.length > 0 && !/Loading directories|正在加载目录/.test(directoryText)) {
      return
    }
    await delay(100)
  }
  throw new Error('The device folder picker did not finish loading its initial path')
}

export async function waitForControlValue(
  control,
  selector,
  expected,
  message,
  timeoutMs = UI_TIMEOUT_MS
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if ((await control.command('getValue', selector)) === expected) return
    await delay(100)
  }
  throw new Error(message)
}

export async function waitForControlSelectionOffset(control, selector, expected, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < UI_TIMEOUT_MS) {
    if (Number(await control.command('getSelectionOffset', selector)) === expected) return
    await delay(100)
  }
  throw new Error(message)
}

export async function waitForPersistedComposerInput(control, expected, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < UI_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    if (snapshot.workbench?.composer?.currentInputLength === expected.length) return
    await delay(100)
  }
  throw new Error(message)
}

export async function waitForWorkbenchTask(control, taskId, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < UI_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    if (snapshot.workbench?.currentRuntimeTask?.taskId === taskId) return
    await delay(100)
  }
  throw new Error(message)
}

export async function waitForWorkbenchDebugState(control, predicate, message) {
  const startedAt = Date.now()
  let lastSnapshot = null
  while (Date.now() - startedAt < UI_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    lastSnapshot = snapshot
    if (predicate(snapshot)) return snapshot
    await delay(100)
  }
  throw new Error(`${message}: ${JSON.stringify(lastSnapshot)}`)
}

export async function assertConfiguredLocalModelsHidden(control, startIndex) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < MODEL_PROTOCOL_MATRIX_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    const modelNames = snapshot.workbench?.composer?.availableModelNames
    if (Array.isArray(modelNames) && modelNames.length > 0) {
      for (const [caseIndex, model] of HIDDEN_CLOUD_MODEL_PROTOCOL_MATRIX_CASES.entries()) {
        const matrixIndex = startIndex + caseIndex
        console.log(
          `Model protocol matrix ${matrixIndex + 1}/${MODEL_PROTOCOL_MATRIX_TOTAL} started: ${matrixCaseId(model)}`
        )
        assert.equal(
          modelNames.includes(model.optionId),
          false,
          `${model.optionId} was visible for cloud execution`
        )
        console.log(`Model protocol matrix passed: ${matrixCaseId(model)} hidden`)
      }
      return
    }
    await delay(50)
  }
  throw new Error('The cloud execution model catalog did not become ready')
}

export async function captureVerificationScreenshot(control, name, selector = 'body') {
  if (
    process.env.KCODER_STUDIO_E2E_SCREENSHOTS === 'final' &&
    !name.endsWith('04-task-completed-after-reopen.png')
  ) {
    return null
  }
  const screenshotPath = join(resultDir, name)
  if (process.platform === 'linux') {
    await runChecked('import', ['-window', 'root', screenshotPath])
    return screenshotPath
  }
  let dataUrl
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      dataUrl = await control.command('capture', selector, { timeoutMs: 90_000 })
      break
    } catch (error) {
      if (attempt === 2) throw error
      await delay(1_000)
    }
  }
  const prefix = 'data:image/png;base64,'
  assert.ok(dataUrl.startsWith(prefix), 'Desktop screenshot did not return PNG data')
  await writeFile(screenshotPath, Buffer.from(dataUrl.slice(prefix.length), 'base64'))
  return screenshotPath
}

export async function triggerModelReloadUntilCloudFailure(control) {
  const failedCloudModelRequest = control.awaitFailedCloudModelRequest()
  for (let attempt = 0; attempt < 10 && control.failedCloudModelRequests === 0; attempt += 1) {
    await control.command('dispatchLocalModelSettingsChanged', '')
    await Promise.race([failedCloudModelRequest, delay(1_000)])
  }
  await withTimeout(
    failedCloudModelRequest,
    UI_TIMEOUT_MS,
    'The connected desktop app did not retry models after the cloud endpoint began failing'
  )
}

export async function sendPromptUntilScenarioRequest(control, selector, prompt, scenario) {
  const scenarioRequest = control.awaitScenarioRequest(scenario)
  await sendPrompt(control, selector, prompt)
  return withTimeout(
    scenarioRequest,
    UI_TIMEOUT_MS,
    `The model service did not receive the ${scenario} request`
  )
}

export async function revealGroupedModelOption(control, targetOptionId) {
  const menu = JSON.parse(await control.command('snapshot', 'body'))
  if (menu.testIds.includes(targetOptionId)) return true
  const familyTestIds = menu.testIds.filter(testId => testId.startsWith('model-family-'))

  for (const familyTestId of familyTestIds) {
    await control.command('hover', `[data-testid="${familyTestId}"]`, {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await delay(150)
    const familyMenu = JSON.parse(await control.command('snapshot', 'body'))
    if (familyMenu.testIds.includes(targetOptionId)) return true
  }

  return false
}

export async function ensureModelOptionVisible(control, targetOptionId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let menu = JSON.parse(await control.command('snapshot', 'body'))
    if (menu.testIds.includes(targetOptionId)) return menu
    if (menu.testIds.includes('model-control-menu-model')) {
      await control
        .command('hover', '[data-testid="model-control-menu-model"]', {
          timeoutMs: UI_TIMEOUT_MS,
        })
        .catch(() => undefined)
    } else {
      await control
        .command('hover', '[data-testid="model-selector-button"]', {
          timeoutMs: UI_TIMEOUT_MS,
        })
        .catch(() => undefined)
      menu = JSON.parse(await control.command('snapshot', 'body'))
      if (!menu.testIds.includes('model-selector-menu')) {
        await control.command('clickWhenEnabled', '[data-testid="model-selector-button"]', {
          stableMs: 100,
          timeoutMs: UI_TIMEOUT_MS,
        })
      }
    }
    await delay(150)
    menu = JSON.parse(await control.command('snapshot', 'body'))
    if (menu.testIds.includes(targetOptionId)) return menu
    if (await revealGroupedModelOption(control, targetOptionId)) {
      return JSON.parse(await control.command('snapshot', 'body'))
    }
  }

  throw new Error(`Model option ${targetOptionId} did not become visible`)
}

export async function confirmLocalProjectName(control, name) {
  await control.command('waitFor', '[data-testid="local-project-create-dialog"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="local-project-create-name-input"]', {
    value: name,
  })
  await control.command('clickWhenEnabled', '[data-testid="confirm-local-project-create-button"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('local-project-create-dialog'),
    'The local project create dialog did not close after confirmation'
  )
}

export async function selectE2EModel(control, modelId = MODEL_ID, modelLabel = MODEL_LABEL) {
  await control.command('waitFor', '[data-testid="model-selector-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  const targetOptionId = `model-option-${modelId}`
  await ensureModelOptionVisible(control, targetOptionId)
  await control.command('waitFor', `[data-testid="model-option-${modelId}"]`, {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('click', `[data-testid="model-option-${modelId}"]`)
  const selectionSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (selectionSnapshot.testIds.includes('model-switch-warning-dialog')) {
    await control.command(
      'clickWhenEnabled',
      '[data-testid="model-switch-warning-confirm-button"]',
      {
        timeoutMs: UI_TIMEOUT_MS,
      }
    )
  }
  await control.command('waitFor', '[data-testid="model-selector-button"]', {
    text: modelLabel,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('press', 'body', { key: 'Escape' })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('model-selector-menu'),
    'The model selector menu did not close after selecting the E2E model'
  )
}
