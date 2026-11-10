type DiagnosticPreference =
  | 'debug-runtime'
  | 'debug-runtime-chat-stream'
  | 'debug-runtime-memory'
  | 'debug-composer'
  | 'perf-debug'

export function isDiagnosticEnabled(preference: DiagnosticPreference): boolean {
  const storage = globalThis.localStorage
  return (
    (storage?.getItem(`kcoder:${preference}`) ?? storage?.getItem(`wework:${preference}`)) === '1'
  )
}

export function setDiagnosticEnabled(preference: DiagnosticPreference, enabled: boolean): void {
  const storage = globalThis.localStorage
  if (enabled) {
    storage?.setItem(`kcoder:${preference}`, '1')
  } else {
    storage?.removeItem(`wework:${preference}`)
    storage?.removeItem(`kcoder:${preference}`)
  }
}

export function isRuntimeDebugEnabled(): boolean {
  return isDiagnosticEnabled('debug-runtime')
}
