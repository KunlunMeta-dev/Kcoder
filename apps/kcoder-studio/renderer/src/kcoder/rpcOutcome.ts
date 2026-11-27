import { GatewayRpcError } from './gatewayRpc'

/** Transport failure is ambiguous; an explicit remote error is handled by its domain. */
export function isUnconfirmedRpcFailure(error: unknown): boolean {
  return error instanceof GatewayRpcError && error.code === -1 && error.reason !== 'remote'
}

/** Preparation failed before an input could be submitted to the runtime. */
export class RuntimeInputRejectedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'RuntimeInputRejectedError'
  }
}

export function isRuntimeInputRejected(error: unknown): boolean {
  return (
    error instanceof RuntimeInputRejectedError ||
    (error instanceof GatewayRpcError &&
      error.reason === 'remote' &&
      [-32700, -32600, -32601, -32602].includes(error.code))
  )
}
