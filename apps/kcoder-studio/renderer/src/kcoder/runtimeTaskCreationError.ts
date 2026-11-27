import i18n from '@/i18n'

export interface RuntimeInputRecovery {
  kind: 'configure-model' | 'creation-rejected'
  deviceId: string
}

export interface RuntimeInputError {
  message: string
  recovery?: RuntimeInputRecovery
}

// kcoder_app_protocol::PROVIDER_CONFIGURATION_REQUIRED. Only thread/start
// emits this code before reserving or creating a thread.
export const PROVIDER_CONFIGURATION_REQUIRED = -32075
export const THREAD_MCP_SETUP_FAILED = -32062

const definitionRejectionMessages = {
  AGENT_DEFINITION_DISABLED: 'workbench.expert_definition_disabled',
  AGENT_RESOURCE_ADMISSION_REQUIRED: 'workbench.expert_definition_task_unsupported',
  AGENT_EXPLICIT_MODEL_RESOLUTION_REQUIRED: 'workbench.expert_definition_model_policy_unsupported',
  AGENT_MODEL_SELECTION_UNAVAILABLE: 'workbench.expert_model_unavailable',
} as const

export function taskDefinitionRejectionMessage(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error)
  const code = Object.keys(definitionRejectionMessages).find(value => message.includes(value)) as
    | keyof typeof definitionRejectionMessages
    | undefined
  return code ? i18n.t(definitionRejectionMessages[code]) : undefined
}

export class TaskCreationRejectedError extends Error {
  readonly recovery?: RuntimeInputRecovery
  constructor(message: string, cause: unknown, recovery?: RuntimeInputRecovery) {
    super(message, { cause })
    this.recovery = recovery
    this.name = 'TaskCreationRejectedError'
  }
}

export class ModelConfigurationRequiredError extends TaskCreationRejectedError {
  constructor(deviceId: string, cause: unknown) {
    super(i18n.t('workbench.model_configuration_required'), cause, { kind: 'configure-model', deviceId })
    this.name = 'ModelConfigurationRequiredError'
  }
}
