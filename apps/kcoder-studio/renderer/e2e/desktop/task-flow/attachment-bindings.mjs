// attachment bindings for the existing desktop runner.
import {
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
} from './config.mjs'
import { captureVerificationScreenshot, waitForSnapshot } from './ui-helpers.mjs'
import { reactivateMacApplication, waitForLogPattern } from './desktop-lifecycle.mjs'
import { withTimeout } from './runtime.mjs'
import { createAttachmentScenarioHelpers } from '../task-flow-attachment-scenarios.mjs'

export const {
  attachAndSendOnlyFile,
  verifyAttachmentOnlySidebarLifecycle,
  verifyPastedZipAttachment,
  verifySystemDragPanelLayout,
  verifyPastedWorkspacePaths,
  verifyDroppedWorkspacePaths,
  verifySideChatAttachmentIsolation,
} = createAttachmentScenarioHelpers({
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
  get resultDir() {
    return resultDir
  },
  captureVerificationScreenshot,
  waitForSnapshot,
  waitForLogPattern,
  reactivateMacApplication,
  withTimeout,
})
