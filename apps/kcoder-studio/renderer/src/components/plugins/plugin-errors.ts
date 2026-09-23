import { GatewayRpcError } from '@/kcoder/gatewayRpc'

/**
 * Stable identity for a failed plugin or marketplace operation.
 *
 * X4 requires the failure kinds a user can act on to be reported separately
 * rather than collapsed into one message, and D3 requires a stable code, the
 * phase, whether it can be retried, and a de-identified explanation. The
 * gateway already reports `reason`, an HTTP `code` and the `operation`, so
 * classification reads those instead of guessing from prose.
 *
 * Transport errors carry a local operation and the app-server plugin processor
 * supplies data.kind. Unknown kinds remain unknown instead of guessing from text.
 */
export type PluginFailureCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'unreachable'
  | 'server'
  | 'invalid-response'
  | 'folder-trust'
  | 'tls'
  | 'proxy'
  | 'source-access'
  | 'invalid-plugin'
  | 'cancelled'
  | 'scope-changed'
  | 'busy'
  | 'rollback-failed'
  | 'unknown'

export interface PluginFailure {
  code: PluginFailureCode
  /** Whether repeating the same action could plausibly succeed. */
  retryable: boolean
  /** The gateway operation that failed. Diagnostics only. */
  phase: string
  /** i18n key for the user-facing explanation. Never the raw server text. */
  messageKey: string
}

const RETRYABLE: Record<PluginFailureCode, boolean> = {
  unauthorized: false,
  forbidden: false,
  'not-found': false,
  unreachable: true,
  server: true,
  'invalid-response': false,
  'folder-trust': false,
  tls: false,
  proxy: false,
  'source-access': false,
  'invalid-plugin': false,
  cancelled: false,
  'scope-changed': false,
  busy: true,
  'rollback-failed': false,
  unknown: false,
}

const MESSAGE_KEYS: Record<PluginFailureCode, string> = {
  unauthorized: 'workbench.plugins_error_unauthorized',
  forbidden: 'workbench.plugins_error_forbidden',
  'not-found': 'workbench.plugins_error_not_found',
  unreachable: 'workbench.plugins_error_unreachable',
  server: 'workbench.plugins_error_server',
  'invalid-response': 'workbench.plugins_error_invalid_response',
  'folder-trust': 'workbench.plugins_error_folder_trust',
  tls: 'workbench.plugins_error_tls',
  proxy: 'workbench.plugins_error_proxy',
  'source-access': 'workbench.plugins_error_source_access',
  'invalid-plugin': 'workbench.plugins_error_invalid_plugin',
  cancelled: 'workbench.plugins_error_cancelled',
  'scope-changed': 'workbench.plugins_error_scope_changed',
  busy: 'workbench.plugins_error_busy',
  'rollback-failed': 'workbench.plugins_error_rollback_failed',
  unknown: 'workbench.plugins_error_unknown',
}

/**
 * The gateway reports an untrusted marketplace directory as prose rather than a
 * code — the renderer already branches on this exact substring when it offers
 * the trust instructions. Kept as narrow as the existing signal, not widened
 * into general message sniffing.
 */
const FOLDER_TRUST_SIGNAL = 'requires folder trust'

export class PluginInstallCancelledError extends Error {}

function failureCodeFor(error: unknown): PluginFailureCode {
  if (error instanceof PluginInstallCancelledError) return 'cancelled'
  if (error instanceof GatewayRpcError) {
    if (error.reason === 'unauthorized') return 'unauthorized'
    if (error.reason === 'connection') return 'unreachable'
    if (error.reason === 'invalid-response') return 'invalid-response'
    // app-server JSON-RPC errors are not HTTP status codes. Read the stable
    // plugin processor kind; never infer TLS/auth/network causes from prose.
    if (error.reason === 'remote') {
      const kind =
        error.data && typeof error.data === 'object' && 'kind' in error.data
          ? error.data.kind
          : undefined
      if (kind === 'network_tls') return 'tls'
      if (kind === 'proxy_invalid' || kind === 'proxy_failed') return 'proxy'
      if (kind === 'source_auth_or_missing') return 'source-access'
      if (kind === 'invalid_params' || kind === 'invalid_manifest' || kind === 'unsupported_schema')
        return 'invalid-plugin'
      if (kind === 'plugin_scope_changed') return 'scope-changed'
      if (kind === 'cancelled') return 'cancelled'
      if (kind === 'busy') return 'busy'
      if (kind === 'rollback_failed') return 'rollback-failed'
      if (kind === 'policy_denied') return 'forbidden'
      if (kind === 'not_found') return 'not-found'
      if (kind === 'folder_trust_required') return 'folder-trust'
      if (
        [
          'network_dns',
          'network_reset',
          'network_unreachable',
          'network_timeout',
          'timeout',
        ].includes(String(kind))
      )
        return 'unreachable'
      if (kind === 'infrastructure_error') return 'server'
      // Older servers used this exact signal without a structured kind.
      if (error.message.includes(FOLDER_TRUST_SIGNAL)) return 'folder-trust'
      return 'unknown'
    }
    if (error.reason === 'http') {
      if (error.code === 403) return 'forbidden'
      if (error.code === 404) return 'not-found'
      // 408 and 429 are temporary by definition; so is anything 5xx.
      if (error.code === 408 || error.code === 429 || error.code >= 500) return 'server'
    }
  }
  if (error instanceof Error && error.message.includes(FOLDER_TRUST_SIGNAL)) {
    return 'folder-trust'
  }
  return 'unknown'
}

export function classifyPluginFailure(error: unknown): PluginFailure {
  const code = failureCodeFor(error)
  return {
    code,
    retryable: RETRYABLE[code],
    phase: error instanceof GatewayRpcError ? error.operation : 'unknown',
    messageKey: MESSAGE_KEYS[code],
  }
}
