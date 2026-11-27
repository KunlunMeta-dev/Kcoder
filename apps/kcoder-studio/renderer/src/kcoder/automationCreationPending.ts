import type { IntegrationOwner } from '../../../shared/generated/contracts'
import { isIntegrationOwner } from '../../../shared/generated/contractGuards.mjs'
import { hookTargetScope } from './gatewayHookConfiguration'
import type { GatewayServer } from './gatewayRpc'

/** Only an operation locator; no prompt, model, credentials or execution authority. */
export function automationPendingKey(server: GatewayServer, workspacePath: string) {
  return `kcoder.automation.pending:${JSON.stringify([hookTargetScope({ ...server, workspacePath }), workspacePath])}`
}

export const LEGACY_AUTOMATION_PENDING = 'legacy'

const PREFIX = 'kcoder.automation.pending:'

export interface WorkflowCreationLocator {
  kind: 'workflow'
  operationId: string
  subscriptionId: string
  owner: IntegrationOwner
}

export function workflowCreationLocator(value: string): WorkflowCreationLocator | null {
  try {
    const locator = JSON.parse(value)
    return locator?.kind === 'workflow' &&
      typeof locator.operationId === 'string' &&
      locator.operationId.trim() &&
      typeof locator.subscriptionId === 'string' &&
      locator.subscriptionId.trim() &&
      isIntegrationOwner(locator.owner)
      ? locator
      : null
  } catch {
    return null
  }
}

// Earlier keys included a registered default that the explicit project overrides.
function canonicalKey(key: string): string {
  if (!key.startsWith(PREFIX)) return key
  try {
    const [scope, workspace] = JSON.parse(key.slice(PREFIX.length))
    const descriptor = JSON.parse(scope)
    if (!Array.isArray(descriptor) || descriptor.length !== 12 || typeof workspace !== 'string')
      return key
    descriptor[6] = workspace
    return PREFIX + JSON.stringify([JSON.stringify(descriptor), workspace])
  } catch {
    return key
  }
}
function storedKey(key: string): string | undefined {
  if (sessionStorage.getItem(key) !== null) return key
  const canonical = canonicalKey(key)
  return Object.keys(sessionStorage).find(
    candidate => candidate.startsWith(PREFIX) && canonicalKey(candidate) === canonical
  )
}

export function readAutomationPending(key: string): string | null {
  try {
    const stored = storedKey(key)
    return stored ? sessionStorage.getItem(stored) : null
  } catch {
    return null
  }
}

export function saveAutomationPending(key: string, id?: string | WorkflowCreationLocator): string {
  const value = typeof id === 'object' ? JSON.stringify(id) : (id ?? LEGACY_AUTOMATION_PENDING)
  if (readAutomationPending(key) !== null)
    throw new Error('Reconcile the original scheduled task creation first')
  sessionStorage.setItem(key, value)
  return value
}

export function clearAutomationPending(key: string, id: string): boolean {
  try {
    const stored = storedKey(key)
    if (!stored || sessionStorage.getItem(stored) !== id) return false
    sessionStorage.removeItem(stored)
    return true
  } catch {
    return false
  }
}
