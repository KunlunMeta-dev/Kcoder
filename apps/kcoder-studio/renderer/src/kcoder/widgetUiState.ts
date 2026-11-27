import type { WidgetJson } from '@/features/widgets/types'

const PREFIX = 'kcoder-studio:widget-ui-v1:'
const bytes = (value: string) => new TextEncoder().encode(value).byteLength
const scopePrefix = (scope: string) => `${PREFIX}${encodeURIComponent(scope)}:`
const stateKey = (scope: string, widgetId: string, revision: number, sha256: string) =>
  `${scopePrefix(scope)}${widgetId}:${revision}:${sha256}`

export function readWidgetUiState(
  scope: string,
  widgetId: string,
  revision: number,
  sha256: string
): WidgetJson | undefined {
  try {
    const raw = localStorage.getItem(stateKey(scope, widgetId, revision, sha256))
    if (!raw || bytes(raw) > 17 * 1024) return undefined
    const saved = JSON.parse(raw)
    return saved.version === 1 &&
      saved.state &&
      typeof saved.state === 'object' &&
      !Array.isArray(saved.state)
      ? (saved.state as WidgetJson)
      : undefined
  } catch {
    return undefined
  }
}

export function writeWidgetUiState(
  scope: string,
  widgetId: string,
  revision: number,
  sha256: string,
  state: WidgetJson
) {
  try {
    const rawState = JSON.stringify(state)
    if (!state || typeof state !== 'object' || Array.isArray(state) || bytes(rawState) > 16 * 1024)
      return
    localStorage.setItem(
      stateKey(scope, widgetId, revision, sha256),
      JSON.stringify({ version: 1, updatedAt: Date.now(), state })
    )
    const keys = Object.keys(localStorage).filter(key => key.startsWith(PREFIX))
    if (keys.length > 100)
      keys
        .sort((a, b) => {
          try {
            return (
              Number(JSON.parse(localStorage.getItem(a)!).updatedAt) -
              Number(JSON.parse(localStorage.getItem(b)!).updatedAt)
            )
          } catch {
            return 0
          }
        })
        .slice(0, keys.length - 100)
        .forEach(key => localStorage.removeItem(key))
  } catch {
    /* Local UI state is optional; artifacts remain target-owned. */
  }
}

export function clearWidgetUiState(scope: string) {
  try {
    Object.keys(localStorage)
      .filter(key => key.startsWith(scopePrefix(scope)))
      .forEach(key => localStorage.removeItem(key))
  } catch {
    /* Storage can be unavailable. */
  }
}

export function clearWidgetUiStateForTarget(targetId: string) {
  try {
    const prefix = `${PREFIX}${encodeURIComponent(`${targetId}:`)}`
    Object.keys(localStorage)
      .filter(key => key.startsWith(prefix))
      .forEach(key => localStorage.removeItem(key))
  } catch {
    /* Storage can be unavailable. */
  }
}
