import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REQUIRED_ATTACHMENT_SCENARIO_DEPS = [
  'ACTIVE_WORKBENCH_SELECTOR',
  'ATTACHMENT_ONLY_COMPLETION_TEXT',
  'ATTACHMENT_ONLY_FILENAME',
  'COMPLETION_TEXT',
  'COMPOSER_READY_STABILITY_MS',
  'DROPPED_PATH_COMPLETION_TEXT',
  'DROPPED_PATH_FILE_NAME',
  'DROPPED_PATH_FOLDER_NAME',
  'IMAGE_ARTIFACT_BASE64',
  'PASTED_PATH_COMPLETION_TEXT',
  'PASTED_PATH_FILE_NAME',
  'PASTED_PATH_FOLDER_NAME',
  'PASTED_ZIP_BASE64',
  'PASTED_ZIP_COMPLETION_TEXT',
  'PASTED_ZIP_FILENAME',
  'SIDE_CHAT_COMPLETION_TEXT',
  'SIDE_CHAT_FILENAME',
  'SIDE_CHAT_PROMPT',
  'UI_TIMEOUT_MS',
  'WORKBENCH_READY_TIMEOUT_MS',
  'resultDir',
  'captureVerificationScreenshot',
  'waitForSnapshot',
  'waitForLogPattern',
  'reactivateMacApplication',
  'withTimeout',
]

function requireAttachmentScenarioDependencies(deps) {
  const missing = REQUIRED_ATTACHMENT_SCENARIO_DEPS.filter(name => deps?.[name] == null)
  if (missing.length > 0) {
    throw new TypeError(
      `Attachment scenario factory is missing dependencies: ${missing.join(', ')}`
    )
  }
}

export function createAttachmentScenarioHelpers(deps) {
  requireAttachmentScenarioDependencies(deps)
  const {
    ACTIVE_WORKBENCH_SELECTOR,
    ATTACHMENT_ONLY_COMPLETION_TEXT,
    ATTACHMENT_ONLY_FILENAME,
    COMPLETION_TEXT,
    COMPOSER_READY_STABILITY_MS,
    DROPPED_PATH_COMPLETION_TEXT,
    DROPPED_PATH_FILE_NAME,
    DROPPED_PATH_FOLDER_NAME,
    IMAGE_ARTIFACT_BASE64,
    PASTED_PATH_COMPLETION_TEXT,
    PASTED_PATH_FILE_NAME,
    PASTED_PATH_FOLDER_NAME,
    PASTED_ZIP_BASE64,
    PASTED_ZIP_COMPLETION_TEXT,
    PASTED_ZIP_FILENAME,
    SIDE_CHAT_COMPLETION_TEXT,
    SIDE_CHAT_FILENAME,
    SIDE_CHAT_PROMPT,
    UI_TIMEOUT_MS,
    WORKBENCH_READY_TIMEOUT_MS,
    resultDir,
    captureVerificationScreenshot,
    waitForSnapshot,
    waitForLogPattern,
    reactivateMacApplication,
    withTimeout,
  } = deps

  async function attachAndSendOnlyFile(control, composerSelector) {
    await control.command('dropFile', composerSelector, {
      filename: ATTACHMENT_ONLY_FILENAME,
      mimeType: 'image/png',
      value: IMAGE_ARTIFACT_BASE64,
    })
    await control.command('waitFor', '[data-testid="attachment-badge"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-image-preview"]`,
      { timeoutMs: UI_TIMEOUT_MS }
    )
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  }

  async function verifyAttachmentOnlySidebarLifecycle({
    app,
    appIdentifier,
    composerSelector,
    control,
  }) {
    control.setScenario('attachment_only')
    const rowsBeforeAttachmentOnly = new Set(
      JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
        testId.startsWith('runtime-local-task-row-')
      )
    )

    await attachAndSendOnlyFile(control, composerSelector)
    await captureVerificationScreenshot(control, '01-attachment-only-first-submitted.png')
    await control.awaitScenarioRequestCount('attachment_only', 1)
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: `${ATTACHMENT_ONLY_COMPLETION_TEXT}_1`,
      timeoutMs: UI_TIMEOUT_MS,
    })
    const firstSnapshot = await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.some(
          testId =>
            testId.startsWith('runtime-local-task-row-') && !rowsBeforeAttachmentOnly.has(testId)
        ),
      'The first attachment-only task did not appear in the sidebar'
    )
    const firstTaskRow = firstSnapshot.testIds.find(
      testId =>
        testId.startsWith('runtime-local-task-row-') && !rowsBeforeAttachmentOnly.has(testId)
    )
    assert.ok(firstTaskRow, 'The first attachment-only task row was not found')
    await captureVerificationScreenshot(control, '02-attachment-only-first-completed.png')

    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
    await attachAndSendOnlyFile(control, composerSelector)
    await captureVerificationScreenshot(control, '03-attachment-only-second-submitted.png')
    await control.awaitScenarioRequestCount('attachment_only', 2)
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: `${ATTACHMENT_ONLY_COMPLETION_TEXT}_2`,
      timeoutMs: UI_TIMEOUT_MS,
    })

    const twoTaskSnapshot = await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes(firstTaskRow) &&
        snapshot.testIds.some(
          testId =>
            testId.startsWith('runtime-local-task-row-') &&
            testId !== firstTaskRow &&
            !rowsBeforeAttachmentOnly.has(testId)
        ),
      'A same-title attachment-only task disappeared after the authoritative sidebar refresh'
    )
    const secondTaskRow = twoTaskSnapshot.testIds.find(
      testId =>
        testId.startsWith('runtime-local-task-row-') &&
        testId !== firstTaskRow &&
        !rowsBeforeAttachmentOnly.has(testId)
    )
    assert.ok(secondTaskRow, 'The second attachment-only task row was not found')
    const expectedRows = [firstTaskRow, secondTaskRow]
    await captureVerificationScreenshot(control, '04-attachment-only-two-tasks-after-refresh.png')

    if (process.platform === 'darwin') {
      const readyCountBeforeClose = control.readyCount
      const tauriLogPath = join(resultDir, `kcoder-tauri-${app.pid}.log`)
      const tauriLogLengthBeforeClose = (await readFile(tauriLogPath, 'utf8').catch(() => ''))
        .length
      await control.command('closeMainWindowToTray', 'body')
      await waitForLogPattern(tauriLogPath, /windowWillClose:/, {
        fromOffset: tauriLogLengthBeforeClose,
      })
      await reactivateMacApplication(appIdentifier)
      await withTimeout(
        control.awaitReadyAfter(readyCountBeforeClose),
        WORKBENCH_READY_TIMEOUT_MS,
        'The reopened KCoder Studio WebView did not reconnect during attachment-only verification'
      )
    } else {
      await control.command('navigate', '/')
    }

    for (const testId of expectedRows) {
      await control.command('waitFor', `[data-testid="${testId}"]`, {
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
    }
    await control.command('clickWhenEnabled', `[data-testid="${secondTaskRow}"]`, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: `${ATTACHMENT_ONLY_COMPLETION_TEXT}_2`,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-image-preview"]`,
      { timeoutMs: UI_TIMEOUT_MS }
    )
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
    await captureVerificationScreenshot(
      control,
      '05-attachment-only-current-image-after-reopen.png'
    )

    await control.command('clickWhenEnabled', `[data-testid="${firstTaskRow}"]`, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: `${ATTACHMENT_ONLY_COMPLETION_TEXT}_1`,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-image-preview"]`,
      { timeoutMs: UI_TIMEOUT_MS }
    )
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
    await captureVerificationScreenshot(control, '06-attachment-only-first-image-after-reopen.png')

    const requests = control.scenarioRequests.get('attachment_only') ?? []
    assert.equal(requests.length, 2, 'Attachment-only flow did not send exactly two model requests')
    for (const request of requests) {
      const serialized = JSON.stringify(request.body)
      assert.ok(
        serialized.includes(ATTACHMENT_ONLY_FILENAME),
        'The attachment filename was not forwarded to the real Codex request'
      )
    }
  }

  async function verifyPastedZipAttachment({ composerSelector, control }) {
    control.setScenario('pasted_zip_attachment')
    await control.command('snapshot', 'body')
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
    await control.command('pasteFile', composerSelector, {
      filename: PASTED_ZIP_FILENAME,
      mimeType: 'application/zip',
      value: PASTED_ZIP_BASE64,
    })
    await control.command('waitFor', '[data-testid="attachment-badge"]', {
      text: PASTED_ZIP_FILENAME,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.awaitScenarioRequestCount('pasted_zip_attachment', 1)
    await control.command('waitFor', '[data-testid="message-document-attachment"]', {
      text: PASTED_ZIP_FILENAME,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: PASTED_ZIP_COMPLETION_TEXT,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await captureVerificationScreenshot(control, 'pasted-zip-attachment.png')
  }

  async function verifySystemDragPanelLayout(control) {
    await control.command('navigate', 'body', { value: '/system-drag' })
    await control.command('waitFor', '[data-testid="system-drag-panel"]', {
      timeoutMs: UI_TIMEOUT_MS,
      visible: true,
    })
    const [metrics] = JSON.parse(
      await control.command('getElementMetrics', '[data-testid="system-drag-panel"]')
    )
    assert.deepEqual(
      { height: metrics.height, width: metrics.width },
      { height: 60, width: 440 },
      'The system drag panel did not use the compact desktop dimensions'
    )
    const snapshot = JSON.parse(
      await control.command('snapshot', '[data-testid="system-drag-panel"]')
    )
    assert.match(
      snapshot.text,
      /Create new chat|创建新对话/,
      'The system drag panel did not expose the new-chat destination'
    )
    assert.match(
      snapshot.text,
      /Temporary stash|临时暂存/,
      'The system drag panel did not expose the stash destination'
    )
    await captureVerificationScreenshot(
      control,
      'system-drag-panel.png',
      '[data-testid="system-drag-panel"]'
    )
    await control.command('navigate', 'body', { value: '/' })
    await control.command('waitFor', '[data-testid="new-chat-button"]', {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
  }

  async function verifyPastedWorkspacePaths({ composerSelector, control, workspacePath }) {
    control.setScenario('pasted_workspace_paths')
    const folderPath = join(workspacePath, PASTED_PATH_FOLDER_NAME)
    const filePath = join(workspacePath, PASTED_PATH_FILE_NAME)
    await mkdir(folderPath, { recursive: true })
    await writeFile(join(folderPath, 'nested.txt'), 'nested path context\n')
    await writeFile(filePath, '# Pasted path context\n')

    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
    await control.command('pastePaths', composerSelector, {
      value: JSON.stringify([
        {
          uri: pathToFileURL(folderPath).href,
          name: PASTED_PATH_FOLDER_NAME,
          isDirectory: true,
        },
        {
          uri: pathToFileURL(filePath).href,
          name: PASTED_PATH_FILE_NAME,
          mimeType: 'text/markdown',
        },
      ]),
    })
    await control.command(
      'waitFor',
      `[data-testid="composer-path-chip-${PASTED_PATH_FOLDER_NAME}"]`,
      { timeoutMs: UI_TIMEOUT_MS }
    )
    await control.command('waitFor', '[data-testid="composer-path-chip-pasted-context-md"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
    assert.equal(
      snapshot.testIds.includes('attachment-badge'),
      false,
      'Pasted local paths were copied into attachment uploads'
    )
    await captureVerificationScreenshot(control, 'pasted-workspace-paths.png')
    await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.awaitScenarioRequestCount('pasted_workspace_paths', 1)
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: PASTED_PATH_COMPLETION_TEXT,
      timeoutMs: UI_TIMEOUT_MS,
    })
  }

  async function verifyDroppedWorkspacePaths({ composerSelector, control, workspacePath }) {
    control.setScenario('dropped_workspace_paths')
    const folderPath = join(workspacePath, DROPPED_PATH_FOLDER_NAME)
    const filePath = join(workspacePath, DROPPED_PATH_FILE_NAME)
    await mkdir(folderPath, { recursive: true })
    await writeFile(join(folderPath, 'nested.txt'), 'nested dropped path context\n')
    await writeFile(filePath, '# Dropped path context\n')

    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
    await control.command('dropPaths', composerSelector, {
      value: JSON.stringify([
        {
          uri: pathToFileURL(folderPath).href,
          name: DROPPED_PATH_FOLDER_NAME,
          isDirectory: true,
        },
        {
          uri: pathToFileURL(filePath).href,
          name: DROPPED_PATH_FILE_NAME,
          mimeType: 'text/markdown',
        },
      ]),
    })
    await control.command(
      'waitFor',
      `[data-testid="composer-path-chip-${DROPPED_PATH_FOLDER_NAME}"]`,
      { timeoutMs: UI_TIMEOUT_MS }
    )
    await control.command('waitFor', '[data-testid="composer-path-chip-dropped-context-md"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
    assert.equal(
      snapshot.testIds.includes('attachment-badge'),
      false,
      'Dropped local paths were copied into attachment uploads'
    )
    await captureVerificationScreenshot(control, 'dropped-workspace-paths.png')
    await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.awaitScenarioRequestCount('dropped_workspace_paths', 1)
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: DROPPED_PATH_COMPLETION_TEXT,
      timeoutMs: UI_TIMEOUT_MS,
    })
  }

  async function verifySideChatAttachmentIsolation({ control, taskRowTestId }) {
    const sideChatSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-chat-panel"]`
    const rightPanelShellSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-panel-shell"]`
    const mainComposerSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-floating-composer-card"]`
    const sideComposerSelector = `${sideChatSelector} [data-testid="chat-message-input"]`

    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-empty-composer-frame"]`,
      { timeoutMs: UI_TIMEOUT_MS }
    )
    await control.command('click', `[data-testid="${taskRowTestId}"]`)
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
      {
        text: COMPLETION_TEXT,
        timeoutMs: UI_TIMEOUT_MS,
      }
    )
    control.setScenario('side_chat_attachment')
    await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
    await control.command('click', '[data-testid="right-workspace-chat-option"]')
    await control.command('waitFor', sideComposerSelector, { timeoutMs: UI_TIMEOUT_MS })

    const workbenchWidth = Number.parseFloat(
      await control.command('getStyle', ACTIVE_WORKBENCH_SELECTOR, { value: 'width' })
    )
    const panelWidthStyle = await control.command('getInlineStyle', rightPanelShellSelector, {
      value: 'width',
    })
    const chatWidthMatch = panelWidthStyle.match(/^calc\(100% - ([\d.]+)px\)$/)
    assert.ok(chatWidthMatch, `Unexpected right-panel width style: ${panelWidthStyle}`)
    const panelWidth = workbenchWidth - Number.parseFloat(chatWidthMatch[1])
    assert.ok(
      panelWidth >= 400 && panelWidth <= 440,
      `The temporary-chat-only right panel was ${panelWidth}px wide instead of about 420px`
    )
    await captureVerificationScreenshot(control, '01-side-chat-compact-width.png')

    await control.command('dropFile', sideComposerSelector, {
      filename: SIDE_CHAT_FILENAME,
      mimeType: 'image/png',
      value: IMAGE_ARTIFACT_BASE64,
    })
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes('attachment-badge') &&
        !snapshot.testIds.includes('uploading-attachment-badge'),
      'The side-chat attachment did not finish uploading',
      UI_TIMEOUT_MS,
      sideChatSelector
    )
    const mainBeforeSend = JSON.parse(await control.command('snapshot', mainComposerSelector))
    assert.equal(
      mainBeforeSend.testIds.includes('attachment-badge'),
      false,
      'Uploading in the side chat leaked an attachment into the main composer'
    )
    await captureVerificationScreenshot(control, '02-side-chat-attachment-isolated.png')

    await control.command('fill', sideComposerSelector, { value: SIDE_CHAT_PROMPT })
    assert.equal(
      await control.command('getValue', sideComposerSelector),
      SIDE_CHAT_PROMPT,
      'The side-chat prompt did not reach the isolated composer'
    )
    await new Promise(resolvePromise => setTimeout(resolvePromise, COMPOSER_READY_STABILITY_MS))
    await control.command('click', `${sideChatSelector} [data-testid="send-message-button"]`)
    await control.awaitScenarioRequestCount('side_chat_attachment', 1)
    await control.command('waitFor', `${sideChatSelector} [data-testid="message-assistant"]`, {
      text: SIDE_CHAT_COMPLETION_TEXT,
      timeoutMs: UI_TIMEOUT_MS,
    })
    const sideAfterSend = JSON.parse(await control.command('snapshot', sideChatSelector))
    assert.equal(
      sideAfterSend.testIds.includes('attachment-badge'),
      false,
      'The sent side-chat attachment was not cleared from its composer'
    )
    const mainAfterSend = JSON.parse(await control.command('snapshot', mainComposerSelector))
    assert.equal(
      mainAfterSend.testIds.includes('attachment-badge'),
      false,
      'Sending the side chat leaked an attachment into the main composer'
    )
    await captureVerificationScreenshot(control, '03-side-chat-sent-main-clean.png')
    await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')

    const requests = control.scenarioRequests.get('side_chat_attachment') ?? []
    assert.equal(requests.length, 1, 'The side chat did not send exactly one model request')
    const requestText = JSON.stringify(requests[0].body)
    assert.ok(requestText.includes(SIDE_CHAT_PROMPT), 'The side-chat prompt was not forwarded')
    assert.ok(
      requestText.includes(SIDE_CHAT_FILENAME),
      'The side-chat attachment was not forwarded'
    )
  }

  return {
    attachAndSendOnlyFile,
    verifyAttachmentOnlySidebarLifecycle,
    verifyPastedZipAttachment,
    verifySystemDragPanelLayout,
    verifyPastedWorkspacePaths,
    verifyDroppedWorkspacePaths,
    verifySideChatAttachmentIsolation,
  }
}
