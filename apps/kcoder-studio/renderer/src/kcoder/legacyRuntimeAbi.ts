/**
 * Compatibility ABI for persisted Wework runtime method names.
 *
 * These strings receive IPC calls that have not migrated yet and do not describe
 * KCoder Studio's app-server protocol. KCoder domain objects and protocol messages
 * must use native names. New code calls KCODER_RUNTIME_METHODS; aliases can be
 * removed after every caller migrates.
 */

export const KCODER_RUNTIME_NAME = 'kcoder' as const

export const KCODER_RUNTIME_METHODS = {
  instructionsRead: 'runtime.instructions.read',
  instructionsWrite: 'runtime.instructions.write',
  personalityRead: 'runtime.personality.read',
  personalityWrite: 'runtime.personality.write',
  modelsList: 'runtime.models.list',
  homeMigrationStatus: 'runtime.home.migration_status',
  catalogCustomWrite: 'runtime.catalog.custom.write',
  appServerRestart: 'runtime.app_server.restart',
} as const

export type KCoderRuntimeMethodKey = keyof typeof KCODER_RUNTIME_METHODS

const LEGACY_KCODER_STUDIO_RUNTIME_METHODS: Record<KCoderRuntimeMethodKey, string> = {
  instructionsRead: 'runtime.codex.instructions.read',
  instructionsWrite: 'runtime.codex.instructions.write',
  personalityRead: 'runtime.codex.personality.read',
  personalityWrite: 'runtime.codex.personality.write',
  modelsList: 'runtime.codex.models.list',
  homeMigrationStatus: 'runtime.codex.home.migration_status',
  catalogCustomWrite: 'runtime.codex.catalog.custom.write',
  appServerRestart: 'runtime.codex.app_server.restart',
}

export function isKCoderRuntimeMethod(method: string, key: KCoderRuntimeMethodKey): boolean {
  return method === KCODER_RUNTIME_METHODS[key] || method === LEGACY_KCODER_STUDIO_RUNTIME_METHODS[key]
}

interface RuntimeHostDocument {
  querySelector(selectors: string): Element | null
}

/**
 * The standalone Wework Tauri build retains its native runtime, while KCoder Studio
 * gateway pages must produce KCoder domain objects. This module centralizes all
 * host-dependent compatibility runtime-name selection.
 */
export function runtimeNameForCurrentHost(
  documentLike: RuntimeHostDocument | undefined = globalThis.document
): 'kcoder' | 'codex' {
  const isKCoderHost = Boolean(documentLike?.querySelector('meta[name="kcoder-rpc-token"]'))
  return isKCoderHost ? KCODER_RUNTIME_NAME : 'codex'
}

export function runtimeMethodForCurrentHost(
  key: KCoderRuntimeMethodKey,
  documentLike: RuntimeHostDocument | undefined = globalThis.document
): string {
  return runtimeNameForCurrentHost(documentLike) === KCODER_RUNTIME_NAME
    ? KCODER_RUNTIME_METHODS[key]
    : LEGACY_KCODER_STUDIO_RUNTIME_METHODS[key]
}

export const LEGACY_KCODER_STUDIO_TAURI_COMMANDS = {
  readRuntimeConfig: 'local_executor_read_codex_local_config',
  updateRuntimeConfig: 'local_executor_update_codex_local_config',
} as const

export const LEGACY_KCODER_STUDIO_STORAGE_KEYS = {
  instructions: 'kcoder-studio:codex-instructions-v1',
  personality: 'kcoder-studio:codex-personality-v1',
  runtimeConfig: 'kcoder-studio:codex-local-config-v1',
} as const
