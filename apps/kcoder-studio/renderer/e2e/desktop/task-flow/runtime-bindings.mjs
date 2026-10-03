// runtime bindings for the existing desktop runner.
import {
  ACTIVE_WORKBENCH_SELECTOR,
  COMPOSER_READY_STABILITY_MS,
  GOAL_IDLE_COMPLETION_TEXT,
  GOAL_IDLE_PROMPT,
  GOAL_RESTART_COMPLETION_TEXT,
  GOAL_RESTART_PROMPT,
  GOAL_RESTART_RESUME_PROMPT,
  RECONNECT_COMPLETION_TEXT,
  RECONNECT_PROMPT,
  UI_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
} from './config.mjs'
import {
  captureVerificationScreenshot,
  selectE2EModel,
  sendPrompt,
  sendPromptUntilScenarioRequest,
  waitForBlankConversation,
  waitForNewTaskRow,
  waitForSnapshot,
  waitForWorkbenchDebugState,
} from './ui-helpers.mjs'
import { withTimeout } from './runtime.mjs'
import { processIsAlive, waitForExecutorReadyEvidence } from './desktop-lifecycle.mjs'
import { createRuntimeScenarioHelpers } from '../task-flow-runtime-scenarios.mjs'

export const {
  verifyReconnectRecovery,
  verifyActiveGoalIdleUnreadLifecycle,
  verifyGoalRestartRecoveryLifecycle,
} = createRuntimeScenarioHelpers({
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
})
