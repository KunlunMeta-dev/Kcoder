/** Safe console metadata. User-facing error text belongs in the UI, never here. */
export function safeErrorDiagnostic(error: unknown): { kind: string; code?: number } {
  const kind = error instanceof TypeError ? 'type-error'
    : error instanceof RangeError ? 'range-error'
      : error instanceof SyntaxError ? 'syntax-error'
        : error instanceof Error ? 'error' : 'unknown'
  let code: unknown
  try { code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined }
  catch { /* A hostile getter is not diagnostic evidence. */ }
  return { kind, ...(typeof code === 'number' && Number.isSafeInteger(code) ? { code } : {}) }
}
