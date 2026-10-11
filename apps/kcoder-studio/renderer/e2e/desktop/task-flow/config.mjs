// config for the existing desktop runner.
import { parseTaskFlowArgs } from '../task-flow-args.mjs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DESKTOP_READY_TIMEOUT_MS = 60_000

export const WORKBENCH_READY_TIMEOUT_MS = 180_000

export const UI_TIMEOUT_MS = 120_000

export const MODEL_PROTOCOL_MATRIX_TIMEOUT_MS = 10_000

export const COMPOSER_READY_STABILITY_MS = 750

export const TASK_PROMPT = 'KCODER_STUDIO_DESKTOP_E2E_TASK: create the requested verification file.'

export const COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_COMPLETE'

export const FOLLOW_UP_PROMPT = 'KCODER_STUDIO_DESKTOP_E2E_FOLLOW_UP: confirm the completed task.'

export const FOLLOW_UP_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_FOLLOW_UP_COMPLETE'

export const RUNNING_FORK_FOLLOW_UP_PROMPT =
  'KCODER_STUDIO_DESKTOP_E2E_RUNNING_FORK: keep streaming while the first turn is forked.'

export const RUNNING_FORK_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_RUNNING_FORK_COMPLETE'

export const FORK_FOLLOW_UP_PROMPT =
  'KCODER_STUDIO_DESKTOP_E2E_FORK_FOLLOW_UP: continue only in the forked task.'

export const FORK_FOLLOW_UP_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_FORK_FOLLOW_UP_COMPLETE'

export const REQUEST_USER_INPUT_PROMPT =
  'KCODER_STUDIO_DESKTOP_E2E_REQUEST_INPUT: ask which implementation direction to use.'

export const REQUEST_USER_INPUT_QUESTION = 'Which implementation direction should be used?'

export const REQUEST_USER_INPUT_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_REQUEST_INPUT_COMPLETE'

export const SEND_MODE_DRAFT = 'KCODER_STUDIO_DESKTOP_E2E_SEND_MODE_DRAFT'

export const QUEUED_FOLLOW_UP = 'KCODER_STUDIO_DESKTOP_E2E_QUEUED_FOLLOW_UP'

export const UNSENT_BLANK_TASK_DRAFT = 'KCODER_STUDIO_DESKTOP_E2E_UNSENT_BLANK_TASK_DRAFT'

export const UNSENT_FIRST_TASK_DRAFT = 'KCODER_STUDIO_DESKTOP_E2E_UNSENT_FIRST_TASK_DRAFT'

export const UNSENT_SECOND_TASK_DRAFT = 'KCODER_STUDIO_DESKTOP_E2E_UNSENT_SECOND_TASK_DRAFT'

export const WINDOW_LIFECYCLE_PROMPT =
  'KCODER_STUDIO_DESKTOP_E2E_WINDOW_LIFECYCLE: keep this response running until released.'

export const WINDOW_LIFECYCLE_COMPLETION_TEXT =
  'KCODER_STUDIO_DESKTOP_E2E_WINDOW_LIFECYCLE_COMPLETE'

export const WINDOW_LIFECYCLE_SCROLL_MARKER = 'KCODER_STUDIO_DESKTOP_E2E_SCROLL_POSITION_MARKER'

export const GOAL_IDLE_PROMPT =
  'KCODER_STUDIO_DESKTOP_E2E_GOAL_IDLE: create an active goal and keep it active for one continuation.'

export const GOAL_IDLE_INITIAL_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_GOAL_IDLE_INITIAL_COMPLETE'

export const GOAL_IDLE_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_GOAL_IDLE_COMPLETE'

export const GOAL_RESTART_PROMPT =
  'KCODER_STUDIO_DESKTOP_E2E_GOAL_RESTART: keep this active goal running until the app restarts.'

export const GOAL_RESTART_INITIAL_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_GOAL_RESTART_INITIAL_COMPLETE'

export const GOAL_RESTART_RESUME_PROMPT = 'KCODER_STUDIO_DESKTOP_E2E_GOAL_RESTART_RESUME'

export const GOAL_RESTART_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_GOAL_RESTART_COMPLETE'

export const WINDOW_LIFECYCLE_COMPLETION_RESPONSE = [
  WINDOW_LIFECYCLE_COMPLETION_TEXT,
  ...Array.from({ length: 24 }, (_, index) =>
    index === 12
      ? WINDOW_LIFECYCLE_SCROLL_MARKER
      : `Persisted transcript verification paragraph ${String(index + 1).padStart(2, '0')}. ${'Scrollable content '.repeat(8)}`
  ),
].join('\n\n')

export const TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX = 'KCODER_STUDIO_DESKTOP_E2E_TURN_NAVIGATION'

export const TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX =
  'KCODER_STUDIO_DESKTOP_E2E_TURN_NAVIGATION_COMPLETE'

export const TURN_NAVIGATION_REGRESSION_TURN_COUNT = 10

export const CANCELLATION_PROMPT =
  'KCODER_STUDIO_DESKTOP_E2E_CANCEL: wait until the response is cancelled.'

export const CANCELLATION_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_CANCEL_COMPLETE'

export const RETRY_PROMPT =
  'KCODER_STUDIO_DESKTOP_E2E_RETRY: fail once and then succeed after retry.'

export const RETRY_FAILURE_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_RETRY_FAILURE'

export const RETRY_CODEX_ERROR_TEXT = "Codex ran out of room in the model's context window."

export const RETRY_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_RETRY_COMPLETE'

export const RECONNECT_PROMPT =
  'KCODER_STUDIO_DESKTOP_E2E_RECONNECT: recover after the stream disconnects.'

export const RECONNECT_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_RECONNECT_COMPLETE'

export const MEMORY_PROMPT = 'KCODER_STUDIO_DESKTOP_E2E_MEMORY: run a tool and stream the report.'

export const MEMORY_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_MEMORY_COMPLETE'

export const CONCURRENT_MEMORY_TASK_COUNT = 10

export const MEMORY_SAMPLE_INTERVAL_MS = 500

export const MEMORY_MIN_BASELINE_SAMPLES = 5

export const MEMORY_MAX_BASELINE_SAMPLES = 15

export const MEMORY_MIN_SETTLED_SAMPLES = 5

export const MEMORY_MAX_SETTLED_SAMPLES = 15

export const MEMORY_MAX_SAMPLE_RANGE_KIB = 16 * 1024

export const MEMORY_SAMPLE_WINDOW_SIZE = 3

export const ARTIFACT_NAME = 'studio-e2e-result.txt'

export const ARTIFACT_CONTENT = 'CODEX_EXECUTED_REAL_TOOL'

export const IMAGE_ARTIFACT_NAME = 'studio-e2e-image.png'

export const IMAGE_ARTIFACT_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC'

export const GIT_SEED_NAME = 'README.md'

export const GIT_SEED_CONTENT = '# Desktop E2E workspace\n'

export const MODEL_API_KEY = 'studio-e2e-test-key'

export const MODEL_PROVIDER_ID = 'studio-e2e'

export const MODEL_ID = 'gpt-5.4'

export const MODEL_LABEL = 'GPT 5.4'

export const CUSTOM_TOOL_INPUT_DESCRIPTION =
  'Raw string input for the original custom tool. Put only the tool input in this field, preserve every character exactly, and follow the original definition embedded in the function description. Do not add Markdown fences or explanatory text.'

export const DEFAULT_MODEL_ID = 'gpt-5.4-mini'

export const DEFAULT_MODEL_LABEL = 'GPT 5.4 Mini'

export const LOCAL_MODEL_CASES = [
  {
    protocol: 'responses',
    optionId: 'local-model:desktop-e2e-responses',
    label: 'Desktop E2E Responses',
    modelId: 'desktop-e2e-responses-model',
  },
  {
    protocol: 'chat',
    optionId: 'local-model:desktop-e2e-chat',
    label: 'Desktop E2E Chat',
    modelId: 'desktop-e2e-chat-model',
  },
  {
    protocol: 'anthropic',
    optionId: 'local-model:desktop-e2e-anthropic',
    label: 'Desktop E2E Anthropic',
    modelId: 'desktop-e2e-anthropic-model',
  },
]

export const MODEL_PROTOCOLS = ['responses', 'chat', 'anthropic']

export const CLOUD_MODEL_CASES = MODEL_PROTOCOLS.map(protocol => ({
  source: 'cloud',
  protocol,
  optionId: `desktop-e2e-cloud-${protocol}`,
  label: `desktop-e2e-cloud-${protocol}`,
  modelId: `desktop-e2e-cloud-${protocol}-upstream`,
}))

export const MODEL_PROTOCOL_MATRIX_CASES = [
  ...LOCAL_MODEL_CASES.map(model => ({ ...model, source: 'local' })),
  ...MODEL_PROTOCOLS.map(protocol => ({
    source: 'codex',
    protocol,
    optionId: DEFAULT_MODEL_ID,
    label: DEFAULT_MODEL_LABEL,
    modelId: DEFAULT_MODEL_ID,
  })),
  ...CLOUD_MODEL_CASES,
]

export const LOCAL_MODEL_SWITCH_CASES = MODEL_PROTOCOLS.flatMap(sourceProtocol =>
  MODEL_PROTOCOLS.filter(targetProtocol => targetProtocol !== sourceProtocol).map(
    targetProtocol => ({
      sourceProtocol,
      targetProtocol,
      id: `${sourceProtocol}-to-${targetProtocol}`,
    })
  )
)

export const LOCAL_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES = MODEL_PROTOCOL_MATRIX_CASES.map(
  model => ({
    ...model,
    execution: 'local',
  })
)

export const CLOUD_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES = MODEL_PROTOCOL_MATRIX_CASES.map(
  model => ({
    ...model,
    execution: 'cloud',
  })
)

export const LOCAL_CUSTOM_MODEL_PROTOCOL_MATRIX_CASES =
  LOCAL_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES.filter(model => model.source === 'local')

export const LOCAL_CONNECTED_MODEL_PROTOCOL_MATRIX_CASES =
  LOCAL_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES.filter(model => model.source !== 'local')

export const HIDDEN_CLOUD_MODEL_PROTOCOL_MATRIX_CASES =
  CLOUD_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES.filter(model => model.source === 'local')

export const REMOTE_MODEL_PROTOCOL_MATRIX_CASES =
  CLOUD_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES.filter(model => model.source !== 'local')

export const MODEL_PROTOCOL_MATRIX_TOTAL = MODEL_PROTOCOL_MATRIX_CASES.length * 2

export const MODEL_PROTOCOL_MATRIX_TEXT_PREFIX = 'KCODER_STUDIO_MODEL_PROTOCOL_MATRIX_TEXT'

export const MODEL_PROTOCOL_MATRIX_TOOL_PREFIX = 'KCODER_STUDIO_MODEL_PROTOCOL_MATRIX_TOOL'

export const LOCAL_MODEL_SWITCH_INITIAL_PROMPT =
  'KCODER_STUDIO_LOCAL_MODEL_SWITCH_INITIAL: establish context with the first custom model.'

export const LOCAL_MODEL_SWITCH_INITIAL_COMPLETE =
  'KCODER_STUDIO_LOCAL_MODEL_SWITCH_INITIAL_COMPLETE'

export const LOCAL_MODEL_SWITCH_FOLLOW_UP_PROMPT =
  'KCODER_STUDIO_LOCAL_MODEL_SWITCH_FOLLOW_UP: continue this conversation with the second custom model.'

export const LOCAL_MODEL_SWITCH_COMPLETE = 'KCODER_STUDIO_LOCAL_MODEL_SWITCH_COMPLETE'

export const LOCAL_MODEL_SWITCH_INVALID_CALL_ID = 'functions.exec_command:0'

export const LOCAL_MODEL_SWITCH_ARTIFACT = 'studio-model-switch-protocol.txt'

export const LOCAL_MODEL_SWITCH_ARTIFACT_CONTENT =
  'KCODER_STUDIO_MODEL_SWITCH_PROTOCOL_EXEC_COMMAND'

export const PROVIDER_SWITCH_LUNA_OPTION_ID = 'local-model:desktop-e2e-luna-overseas'

export const PROVIDER_SWITCH_LUNA_LABEL = 'GPT 5.6 Luna (海外)'

export const PROVIDER_SWITCH_LUNA_MODEL_ID = 'gpt-5.6-luna'

export const PROVIDER_SWITCH_SOL_OPTION_ID = 'gpt-5.6-sol'

export const PROVIDER_SWITCH_SOL_LABEL = 'GPT 5.6 Sol'

export const PROVIDER_SWITCH_PROMPT =
  'KCODER_STUDIO_DESKTOP_E2E_PROVIDER_SWITCH: fail on Luna, then retry this turn with Sol.'

export const PROVIDER_SWITCH_FAILURE = 'KCODER_STUDIO_DESKTOP_E2E_LUNA_INTENTIONAL_FAILURE'

export const PROVIDER_SWITCH_COMPLETION = 'KCODER_STUDIO_DESKTOP_E2E_PROVIDER_SWITCH_SOL_COMPLETE'

export const BLOCKED_CLOUD_MODEL_PATH = '/api/models/unified'

export const CLOUD_PUBLIC_MODEL_NAME = 'desktop-e2e-public-model'

export const CLOUD_PUBLIC_MODEL_LABEL = 'Desktop E2E Public Model'

export const CLOUD_DEVICE_ID = 'studio-e2e-cloud-device'

export const FRESH_CHAT_PROMPT =
  'KCODER_STUDIO_DESKTOP_E2E_FRESH_CHAT: confirm this is a new conversation.'

export const FRESH_CHAT_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_FRESH_CHAT_COMPLETE'

export const SHORT_CONVERSATION_MAX_MESSAGE_TOP_OFFSET = 160

export const COMPOSER_PROJECT_NAME = 'Composer Flow Project'

export const ATTACHMENT_ONLY_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_ATTACHMENT_ONLY_COMPLETE'

export const ATTACHMENT_ONLY_FILENAME = 'same-name-attachment.png'

export const PASTED_ZIP_FILENAME = 'pasted-feedback.zip'

export const PASTED_ZIP_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_PASTED_ZIP_COMPLETE'

export const PASTED_ZIP_BASE64 = Buffer.from('PK\x03\x04KCODER_STUDIO_E2E_ZIP').toString('base64')

export const PASTED_PATH_FOLDER_NAME = 'pasted-context-folder'

export const PASTED_PATH_FILE_NAME = 'pasted-context.md'

export const PASTED_PATH_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_PASTED_PATHS_COMPLETE'

export const DROPPED_PATH_FOLDER_NAME = 'dropped-context-folder'

export const DROPPED_PATH_FILE_NAME = 'dropped-context.md'

export const DROPPED_PATH_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_DROPPED_PATHS_COMPLETE'

export const TOOL_BLOCK_ORDER_TASK_ID = 'studio-e2e-tool-block-order'

export const TOOL_BLOCK_ORDER_TASK_TITLE = 'Tool block chronological order'

export const TOOL_BLOCK_ORDER_COMPLETION_TEXT =
  'KCODER_STUDIO_DESKTOP_E2E_TOOL_BLOCK_ORDER_COMPLETE'

export const EARLIER_TOOL_BLOCK_ID = 'studio-e2e-tool-earlier'

export const LATER_TOOL_BLOCK_ID = 'studio-e2e-tool-later'

export const SIDE_CHAT_PROMPT = 'KCODER_STUDIO_DESKTOP_E2E_SIDE_CHAT: verify isolated attachments.'

export const SIDE_CHAT_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_SIDE_CHAT_COMPLETE'

export const SIDE_CHAT_FILENAME = 'side-chat-only.png'

export const CLOUD_TASK_PROMPT =
  'KCODER_STUDIO_DESKTOP_E2E_CLOUD_TASK: create the requested cloud verification file.'

export const CLOUD_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_CLOUD_COMPLETE'

export const CLOUD_FOLLOW_UP_PROMPT =
  'KCODER_STUDIO_DESKTOP_E2E_CLOUD_FOLLOW_UP: confirm the cloud task remains available.'

export const CLOUD_FOLLOW_UP_COMPLETION_TEXT = 'KCODER_STUDIO_DESKTOP_E2E_CLOUD_FOLLOW_UP_COMPLETE'

export const CLOUD_ARTIFACT_NAME = 'studio-cloud-e2e-result.txt'

export const CLOUD_ARTIFACT_CONTENT = 'CODEX_EXECUTED_REAL_CLOUD_TOOL'

export const ACTIVE_WORKBENCH_SELECTOR = '[data-testid="desktop-workbench-main"]'

export const ACTIVE_COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`

export const ACTIVE_SEND_BUTTON_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`

export const ACTIVE_SWITCH_MODEL_RETRY_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-switch-model-retry"]`

export const MACOS_LAUNCH_SERVICES_REGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

export const taskFlowArgs = parseTaskFlowArgs()

export const {
  requestInputOnly: REQUEST_INPUT_ONLY,
  viewImageOnly: VIEW_IMAGE_ONLY,
  shortConversationOnly: SHORT_CONVERSATION_ONLY,
  retryOnly: RETRY_ONLY,
  runningForkOnly: RUNNING_FORK_ONLY,
  sideChatOnly: SIDE_CHAT_ONLY,
  goalIdleOnly: GOAL_IDLE_ONLY,
  goalRestartOnly: GOAL_RESTART_ONLY,
  turnNavigationOnly: TURN_NAVIGATION_ONLY,
  attachmentOnly: ATTACHMENT_ONLY,
  pastedWorkspacePathsOnly: PASTED_WORKSPACE_PATHS_ONLY,
  droppedWorkspacePathsOnly: DROPPED_WORKSPACE_PATHS_ONLY,
  systemDragPanelOnly: SYSTEM_DRAG_PANEL_ONLY,
  modelSwitchOnly: MODEL_SWITCH_ONLY,
  cloudOnly: CLOUD_ONLY,
  pluginsOnly: PLUGINS_ONLY,
  memoryOnly: MEMORY_ONLY,
  toolBlockOrderOnly: TOOL_BLOCK_ORDER_ONLY,
  queueNavigationOnly: QUEUE_NAVIGATION_ONLY,
  desktopScenarioOnly: DESKTOP_SCENARIO_ONLY,
} = taskFlowArgs

export const {
  concurrentPhysicalFootprintKiB: CONCURRENT_MEMORY_MAX_PHYSICAL_FOOTPRINT_KIB,
  peakGrowthKiB: MEMORY_MAX_PEAK_GROWTH_KIB,
  settledGrowthKiB: MEMORY_MAX_SETTLED_GROWTH_KIB,
  settledDomNodeCount: MEMORY_MAX_SETTLED_DOM_NODE_COUNT,
} = taskFlowArgs.memoryLimits

export const scriptDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const rendererDir = resolve(scriptDir, '..', '..')

export const repoDir = resolve(rendererDir, '..')

export const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`

export let resultDir = join(rendererDir, 'test-results', 'desktop-e2e', runId)

export let stateDir = resultDir

export function setOwnedPaths(artifacts, state) {
  resultDir = artifacts
  stateDir = state
}
