import type * as C from './generated/contracts'
import { INSTRUCTION_METHODS, validInstructionCall } from './migrationInstructions.mjs'
type Invoke = <T>(method: string, params: object, options?: { signal?: AbortSignal }) => Promise<T>
/** Target-owned received and saved previews share the Native implementation with source previews. */
export function createInstructionApi(invoke: Invoke) {
  const call = async <T>(method: string, params: object, options?: { signal?: AbortSignal }) => {
    if (!validInstructionCall(method, params)) throw new Error('migration_invalid_parameters')
    const result = await invoke<T>(method, params, options)
    if (!validInstructionCall(method, params, result)) throw new Error('migration_invalid_response')
    return result
  }
  return {
    instructionPage: (params: C.MigrationInstructionPageParams, options?: { signal?: AbortSignal }) => call<C.MigrationInstructionPageResult>(INSTRUCTION_METHODS.page, params, options),
    instructionBody: (params: C.MigrationInstructionBodyParams, options?: { signal?: AbortSignal }) => call<C.MigrationInstructionBodyResult>(INSTRUCTION_METHODS.body, params, options),
  }
}
