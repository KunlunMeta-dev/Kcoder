export const GATEWAY_STARTUP_TIMEOUT_MS = 300_000

// Exact protocol methods only. A new or custom method is potentially mutating;
// names such as "read", "preview" or "list" alone do not prove otherwise.
const readOnlyMethods = new Set([
  'migration/batch/control/read',
  'migration/batch/resources/read',
  'migration/projects/discover', 'migration/projects/sources', 'migration/projects/source-roots',
  'migration/projects/targets', 'migration/projects/target-roots', 'migration/projects/report',
  'migration/agent/preview',
  'migration/definitions/discover', 'migration/definitions/report', 'migration/definitions/body',
  'migration/instructions/page', 'migration/instructions/body',
  'migration/source/upload/product/read',
  'migration/source/upload/read', 'migration/source/upload/files',
  'migration/source/bindings', 'migration/codex/layers/select', 'migration/codex/layers/read',
  'migration/configuration/layers',
  'migration/memory/discover', 'migration/memory/sources', 'migration/memory/list', 'migration/memory/read', 'migration/memory/control/read',
  'migration/plugin/discover','migration/plugin/read','migration/plugin/list',
  'migration/history/upload-collection/attachment',
  'migration/history/upload-collection/read','migration/history/upload-collection/list',
  'migration/history/local-attachment/read','migration/history/local-attachment/list','migration/history/local-attachment/chunk',
  'migration/history/reinterpret/preview',
  'migration/history/undo/lookup','migration/history/undo/preview','migration/history/undo/read',
  'migration/history/search',
  'migration/history/continuation/source',
  'migration/history/continuation/read',
  'webSearch/status/read',
  'webSearch/probe/read',
  'server/info',
  'server/resources/read',
  'thread/list',
  'thread/workspace/lookup',
  'thread/read',
  'thread/read/indexed',
  'thread/agentMessage/targets',
  'thread/agentMessage/get',
  'thread/agentMessage/receipts/list',
  'thread/agentMessage/resolve',
  'thread/agentMessage/policy/read',
  'thread/creation/read',
  'thread/goal/get',
  'thread/goal/history',
  'computerUse/turn/status',
  'turn/receipt/read',
  'turn/steer/receipt/read',
  'asyncQuestion/list',
  'agent/list',
  'agent/message/read',
  'agent/messages/list',
  'agent/live/read',
  'agent/artifact/read',
  'runtime.models.list',
  'runtime.providers.list',
  'runtime.providers.templates',
  'session/modes',
  'hooks/config/read',
  'skills/list',
  'extensions/inventory',
  'extensions/conflicts/preview',
  // Self-evolution reads create no storage; every other evolution method mutates.
  'evolution/status',
  'evolution/targets/list',
  'evolution/target/read',
  'evolution/preference/list',
  'evolution/ratings/list',
  'settings/evolution/read',
  'mcp/list',
  'migration/discover',
  'migration/history/discover',
  'migration/history/families/discover',
  'migration/history/transcript',
  'migration/history/branch/read',
  'migration/history/tool-attachments/read',
  'migration/history/tool-attachments/chunk',
  'migration/history/tool-attachments/items',
  'migration/history/attachment/read',
  'migration/history/attachment/chunk',
  'migration/history/branch/tools/read',
  'migration/history/branch/tools/page',
  'migration/history/branch/page',
  'migration/history/branch/blocks',
  'migration/history/branch/text',
  'migration/history/blocks',
  'migration/history/text',
  'migration/history/sources',
  'migration/history/read',
  'migration/history/jobs',
  'migration/read',
  'migration/batch/read',
  'migration/mcp/credential/read',
  'migration/batch/mcp/credential/read',
  'migration/items',
  'migration/asset/preview',
  'migration/jobs/list',
  'migration/batch/item/plan',
  'tools/catalog',
  'usage/stats',
  'cron/list',
  'cron/preview',
  'attachment/read',
  'attachment/read/chunk',
  'terminal/list',
  'plugin/list',
  'plugin/read',
  'plugin/activation/read',
  'plugin/proxy/status',
  'plugin/trust/list',
  'marketplace/list',
  'workflow/capabilities/read',
  'workflow/verification/read',
  'workflow/storage/read',
  'workflow/versions/references',
  'workflow/versions/history/read',
  'workflow/versions',
  'workflow/export',
  'workflow/runs/list',
  'workflow/runs/read',
  'workflow/runs/output',
  'workflow/runs/requests',
  'workflow/runs/archive/list',
  'workflow/runs/archive/read',
  'workflow/list',
  'workflow/read',
  'settings/tools/read',
  'settings/templates/list',
  'settings/templates/read',
  'computerUse/status',
  'knowledge/fileCapabilities',
  'knowledge/imageImport/list',
  'knowledge/archiveTransfer/capabilities',
  'knowledge/archiveTransfer/status',
  'knowledge/archiveTransfer/read',
  'knowledge/default/read',
  'knowledge/job/budget',
  'knowledge/job/overview',
  'knowledge/job/get',
  'knowledge/job/list',
  'knowledge/status',
  'knowledge/list',
  'knowledge/read',
  'knowledge/source/list',
  'knowledge/source/removed',
  'knowledge/source/read',
  'knowledge/page/list',
  'knowledge/page/read',
  'knowledge/page/history',
  'knowledge/page/links',
  'knowledge/review/read',
  'knowledge/review/page',
  'knowledge/search',
  'knowledge/citation/resolve',
  'knowledge/findings/list',
  'knowledge/pending/list',
  'knowledge/export/read',
])

// These operations may scan large trees, install packages or compact via a
// provider. Give them an explicit larger bound rather than removing deadlines.
const longRequestDeadlines = {
  initialize: GATEWAY_STARTUP_TIMEOUT_MS,
  'migration/history/undo/preview':60_000,
  'migration/history/discover': 180_000,
  'migration/history/families/discover': 180_000,
  'migration/mcp/credential/plan':180_000,
  'migration/mcp/credential/apply':180_000,
  'migration/mcp/credential/undo':180_000,
  'migration/credential/plan':180_000,
  'migration/credential/apply':180_000,
  'migration/credential/undo':180_000,
  'migration/batch/scan':300_000,
  'migration/batch/plan':300_000,
  'migration/batch/apply':600_000,
  'migration/batch/rollback':600_000,
  'thread/compact': 600_000,
  'plugin/install': 600_000,
  'marketplace/refresh': 300_000,
  'diagnostics/storage/read': 300_000,
  'diagnostics/storage/clean': 300_000,
  'knowledge/source/directoryStage': 300_000,
  'knowledge/source/importAttachment': 300_000,
  'knowledge/imageImport/resume': 300_000,
  'knowledge/importArchive': 300_000,
  'knowledge/archiveTransfer/importFinish': 300_000,
  'knowledge/reindex': 300_000,
}

export function gatewayRequestOutcome(method) {
  return readOnlyMethods.has(method) ? 'readOnly' : 'unknown'
}

export function gatewayRequestTimeoutMs(method, override) {
  if (override !== undefined) {
    if (!Number.isSafeInteger(override) || override <= 0 || override > 3_600_000)
      throw new RangeError('RPC timeout must be between 1 ms and 1 hour')
    return override
  }
  return Object.hasOwn(longRequestDeadlines, method)
    ? longRequestDeadlines[method]
    : gatewayRequestOutcome(method) === 'readOnly'
      ? 30_000
      : 120_000
}

// Rust JSON requires Unicode scalar strings in values and object keys.
const LONE_SURROGATE = /\p{Surrogate}/u
export function hasWellFormedJsonStrings(value) {
  const pending = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string' && LONE_SURROGATE.test(item)) return false
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (LONE_SURROGATE.test(key)) return false
        pending.push(child)
      }
    }
  }
  return true
}

/** Gateway expiration describes unanswered upstream work, never a definitive rejection. */
export const GATEWAY_EXPIRED_REQUEST_DATA = Object.freeze({ kind: 'gatewayRequestExpired', outcome: 'unknown' });
export function isGatewayUnknownOutcome(error, method) {
  const { code, data } = error
  const questionMutation = method === 'asyncQuestion/answer' || method === 'asyncQuestion/cancel';
  // -32045: Gateway dropped the upstream receipt after dispatch.
  // -32065: the app-server could not confirm the question ledger write.
  if (questionMutation && (code === -32045 || code === -32065)) return true;
  // Direct and legacy clients can receive a refusal before broker projection.
  // The entire refusal, including diagnostic metadata, must be valid Rust JSON.
  if ((questionMutation || method === 'asyncQuestion/list') &&
      (code === -32001 || !hasWellFormedJsonStrings(error))) return true;
  return data !== null && typeof data === 'object' && data.kind === 'gatewayRequestExpired' && data.outcome === 'unknown';
}
