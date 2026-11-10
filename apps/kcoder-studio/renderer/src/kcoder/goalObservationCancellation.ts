/** A native Goal read proved its original owner/target retired; no operation was stopped. */
export const RUNTIME_GOAL_SCOPE_RETIRED = 'KCODER_RUNTIME_GOAL_SCOPE_RETIRED'
export class RuntimeGoalScopeRetiredError extends Error {
  readonly code = RUNTIME_GOAL_SCOPE_RETIRED
  constructor() {
    super('Runtime Goal observation scope retired')
    this.name = 'AbortError'
  }
}
/** Stable code survives a structured error transport without relying on localized text. */
export function isRuntimeGoalScopeRetired(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && error.code === RUNTIME_GOAL_SCOPE_RETIRED
}
