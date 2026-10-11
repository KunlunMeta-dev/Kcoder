// phases / forks navigation for the existing desktop runner.
import { verifyCompletedTurnFork, verifyRunningFollowUpFork } from '../session-scenarios.mjs'
import {
  ACTIVE_SWITCH_MODEL_RETRY_SELECTOR,
  COMPLETION_TEXT,
  COMPOSER_READY_STABILITY_MS,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  FOLLOW_UP_COMPLETION_TEXT,
  FOLLOW_UP_PROMPT,
  LOCAL_CUSTOM_MODEL_PROTOCOL_MATRIX_CASES,
  LOCAL_MODEL_CASES,
  LOCAL_MODEL_SWITCH_ARTIFACT,
  LOCAL_MODEL_SWITCH_ARTIFACT_CONTENT,
  LOCAL_MODEL_SWITCH_CASES,
  LOCAL_MODEL_SWITCH_COMPLETE,
  LOCAL_MODEL_SWITCH_FOLLOW_UP_PROMPT,
  LOCAL_MODEL_SWITCH_INITIAL_COMPLETE,
  LOCAL_MODEL_SWITCH_INITIAL_PROMPT,
  MODEL_API_KEY,
  MODEL_LABEL,
  MODEL_SWITCH_ONLY,
  REQUEST_INPUT_ONLY,
  RUNNING_FORK_ONLY,
  UI_TIMEOUT_MS,
  UNSENT_BLANK_TASK_DRAFT,
  WORKBENCH_READY_TIMEOUT_MS,
  resultDir,
} from '../config.mjs'
import { artifactSink, writeRedactedJson } from '../runtime.mjs'
import {
  captureVerificationScreenshot,
  ensureTaskRowVisible,
  prepareCompletedTurnScreenshot,
  selectE2EModel,
  sendPrompt,
  sendPromptUntilScenarioRequest,
  waitForControlSelectionOffset,
  waitForControlValue,
  waitForPersistedComposerInput,
} from '../ui-helpers.mjs'
import { verifyProviderBoundaryRestriction } from '../conversation-scenarios.mjs'
import { verifyModelProtocolMatrix } from '../model-scenarios.mjs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { rm, readFile } from 'node:fs/promises'

export async function runForksNavigationPhase(
  {
    workspacePath,
    executorHome,
    control,
    modelSwitchVerification,
    cloudEnvironment,
    composerSelector,
    projectRowSelector,
    taskRowTestId,
  },
  state
) {
  state.phase = 'running-follow-up-fork'
  await verifyRunningFollowUpFork({
    composerSelector,
    control,
    executorHome,
    sourceTaskRowTestId: taskRowTestId,
  })
  if (RUNNING_FORK_ONLY) {
    await writeRedactedJson(join(resultDir, 'model-requests.json'), control.modelRequests, [
      MODEL_API_KEY,
      cloudEnvironment?.authToken,
    ])
    console.log(`Wework running-fork desktop E2E passed. Evidence: ${resultDir}`)
    return { stop: true }
  }

  state.phase = 'completed-turn-fork'
  await verifyCompletedTurnFork({
    composerSelector,
    control,
    executorHome,
    sourceTaskRowTestId: taskRowTestId,
    workspacePath,
  })

  state.phase = 'blank-task-draft-restoration'
  await control.command(
    'clickWhenEnabled',
    `${projectRowSelector} [data-testid="project-new-conversation-button"]`
  )
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('fill', composerSelector, { value: UNSENT_BLANK_TASK_DRAFT })
  await waitForPersistedComposerInput(
    control,
    UNSENT_BLANK_TASK_DRAFT,
    'The blank task composer did not persist its draft before switching tasks'
  )
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: COMPLETION_TEXT,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command(
    'clickWhenEnabled',
    `${projectRowSelector} [data-testid="project-new-conversation-button"]`
  )
  await waitForControlValue(
    control,
    composerSelector,
    UNSENT_BLANK_TASK_DRAFT,
    'The blank task lost its unsent composer draft after switching tasks'
  )
  await waitForControlSelectionOffset(
    control,
    composerSelector,
    UNSENT_BLANK_TASK_DRAFT.length,
    'The restored blank task draft did not place the caret at the end'
  )
  await control.command('fill', composerSelector, { value: '' })

  if (!REQUEST_INPUT_ONLY) {
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
    await ensureTaskRowVisible(control, taskRowTestId)
    await control.command('click', `[data-testid="${taskRowTestId}"]`)
    await control.command('waitFor', '[data-testid="model-selector-button"]', {
      text: MODEL_LABEL,
      timeoutMs: UI_TIMEOUT_MS,
    })

    state.phase = 'follow-up'
    control.setScenario('follow_up')
    const followUpRequest = await sendPromptUntilScenarioRequest(
      control,
      composerSelector,
      FOLLOW_UP_PROMPT,
      'follow_up'
    )
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: FOLLOW_UP_COMPLETION_TEXT,
      timeoutMs: UI_TIMEOUT_MS,
    })
    assert.ok(
      JSON.stringify(followUpRequest.body).includes(FOLLOW_UP_PROMPT),
      'The follow-up request did not preserve the user prompt'
    )

    for (const [switchIndex, switchCase] of LOCAL_MODEL_SWITCH_CASES.entries()) {
      state.phase = `local-model-switch-${switchCase.id}`
      const sourceModel = LOCAL_MODEL_CASES.find(
        model => model.protocol === switchCase.sourceProtocol
      )
      const targetModel = LOCAL_MODEL_CASES.find(
        model => model.protocol === switchCase.targetProtocol
      )
      assert.ok(sourceModel, `Missing ${switchCase.sourceProtocol} local switch source`)
      assert.ok(targetModel, `Missing ${switchCase.targetProtocol} local switch target`)
      for (const model of LOCAL_MODEL_CASES) {
        control.localProtocolStates.set(model.protocol, { stage: 'initial', requests: [] })
      }
      control.localProtocolStates.set(sourceModel.protocol, {
        stage: 'model_switch_source',
        requests: [],
      })
      control.localProtocolStates.set(targetModel.protocol, {
        stage: 'model_switch_target',
        requests: [],
      })
      await rm(join(workspacePath, LOCAL_MODEL_SWITCH_ARTIFACT), { force: true })
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', composerSelector, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, sourceModel.optionId, sourceModel.label)
      await sendPrompt(control, composerSelector, LOCAL_MODEL_SWITCH_INITIAL_PROMPT)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: LOCAL_MODEL_SWITCH_INITIAL_COMPLETE,
        timeoutMs: UI_TIMEOUT_MS,
      })
      await sendPrompt(control, composerSelector, LOCAL_MODEL_SWITCH_FOLLOW_UP_PROMPT)
      await control.command('waitFor', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR, {
        visible: true,
        timeoutMs: UI_TIMEOUT_MS,
      })
      const sourceRequestsBeforeSwitch = control.localProtocolStates.get(sourceModel.protocol)
        ?.requests.length
      assert.ok(
        sourceRequestsBeforeSwitch && sourceRequestsBeforeSwitch >= 3,
        `${switchCase.id} did not complete its source tool loop and failed follow-up`
      )
      if (switchIndex === 0) {
        await prepareCompletedTurnScreenshot(control)
        await captureVerificationScreenshot(control, 'model-switch-retry-01-failed.png')
      }
      await control.command('scrollIntoView', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR)
      await control.command('clickWhenEnabled', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR, {
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: UI_TIMEOUT_MS,
      })
      await control.command('waitFor', '[data-testid="model-selector-menu"]', {
        timeoutMs: UI_TIMEOUT_MS,
      })
      if (switchIndex === 0) {
        await captureVerificationScreenshot(
          control,
          'model-switch-retry-02-picker-open.png',
          '[data-testid="model-selector-menu"]'
        )
      }
      await selectE2EModel(control, targetModel.optionId, targetModel.label)
      if (switchIndex === 0) {
        await captureVerificationScreenshot(control, 'model-switch-retry-03-target-selected.png')
      }
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: LOCAL_MODEL_SWITCH_COMPLETE,
        timeoutMs: UI_TIMEOUT_MS,
      })
      assert.equal(
        await readFile(join(workspacePath, LOCAL_MODEL_SWITCH_ARTIFACT), 'utf8'),
        LOCAL_MODEL_SWITCH_ARTIFACT_CONTENT,
        `${switchCase.id} did not execute its source tool call before switching`
      )
      const sourceSwitchState = control.localProtocolStates.get(sourceModel.protocol)
      const targetSwitchState = control.localProtocolStates.get(targetModel.protocol)
      assert.equal(
        sourceSwitchState?.requests.length,
        sourceRequestsBeforeSwitch,
        `${switchCase.id} retried through the old custom model`
      )
      assert.equal(
        targetSwitchState?.stage,
        'model_switch_target_complete',
        `${switchCase.id} did not complete the automatic same-conversation retry`
      )
      await control.command('waitFor', '[data-testid="model-selector-button"]', {
        text: targetModel.label,
        timeoutMs: UI_TIMEOUT_MS,
      })
      const appliedModelLabel = await control.command(
        'getText',
        '[data-testid="model-selector-button"]'
      )
      assert.doesNotMatch(
        appliedModelLabel,
        /下一轮|Next/,
        `${switchCase.id} left the applied model marked as next-turn only`
      )
      modelSwitchVerification.push({
        direction: switchCase.id,
        sourceProtocol: sourceModel.protocol,
        targetProtocol: targetModel.protocol,
        sourceRequestCount: sourceSwitchState.requests.length,
        targetRequestCount: targetSwitchState.requests.length,
        targetHistoryVerified: targetSwitchState.historyVerified === true,
        toolArtifactVerified: true,
        completed: true,
      })
      if (switchIndex === 0) {
        await prepareCompletedTurnScreenshot(control)
        await captureVerificationScreenshot(control, 'model-switch-retry-04-completed.png')
      }
    }
    state.phase = 'provider-switch-retry'
    await verifyProviderBoundaryRestriction(control, composerSelector)
    await artifactSink.writeJson(
      join(resultDir, 'model-switch-protocol-verification.json'),
      modelSwitchVerification
    )
    if (MODEL_SWITCH_ONLY) {
      assert.deepEqual(
        modelSwitchVerification.map(result => result.direction),
        LOCAL_MODEL_SWITCH_CASES.map(result => result.id),
        'The focused model-switch E2E did not verify all six protocol directions'
      )
      await writeRedactedJson(join(resultDir, 'model-requests.json'), control.modelRequests, [
        MODEL_API_KEY,
        cloudEnvironment?.authToken,
      ])
      console.log(`Wework desktop six-way model-switch E2E passed. Evidence: ${resultDir}`)
      return { stop: true }
    }

    state.phase = 'local-model-protocol-matrix'
    await verifyModelProtocolMatrix({
      cases: LOCAL_CUSTOM_MODEL_PROTOCOL_MATRIX_CASES,
      composerSelector,
      control,
      newConversationSelector: `${projectRowSelector} [data-testid="project-new-conversation-button"]`,
      screenshotPrefix: 'local-matrix',
      workspacePath,
    })

    await ensureTaskRowVisible(control, taskRowTestId)
    await control.command('click', `[data-testid="${taskRowTestId}"]`)
    await control.command('waitFor', '[data-testid="model-selector-button"]', {
      text: MODEL_LABEL,
      timeoutMs: UI_TIMEOUT_MS,
    })
  }
  return { stop: false }
}
