import { isContract } from '../../../../shared/generated/validator.mjs'
import type { AgentTaskBinding } from '../../../../shared/generated/contracts'
import type { RuntimeTaskAddress } from '@/types/api'

export function taskAgentBinding(
  address: RuntimeTaskAddress | null | undefined
): AgentTaskBinding | null {
  const value = address?.runtimeHandle?.agentDefinition
  return isContract('AgentTaskBinding', value) ? (value as AgentTaskBinding) : null
}
