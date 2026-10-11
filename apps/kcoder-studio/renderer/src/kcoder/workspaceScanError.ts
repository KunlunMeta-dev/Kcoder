export const WORKSPACE_SCAN_CANCELLED = 'KCODER_WORKSPACE_SCAN_CANCELLED'

export class WorkspaceScanCancelledError extends Error {
  readonly code = WORKSPACE_SCAN_CANCELLED

  constructor() {
    super('Workspace scan invalidated')
    this.name = 'AbortError'
  }
}

// The stable code also survives transports that preserve structured errors without prototypes.
export function isWorkspaceScanCancelled(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === WORKSPACE_SCAN_CANCELLED
  )
}
