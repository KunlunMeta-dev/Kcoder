// Exact protocol methods only. A new or custom method is potentially mutating;
// names such as "read", "preview" or "list" alone do not prove otherwise.
const readOnlyMethods = new Set([
  'server/info',
  'server/resources/read',
  'thread/list',
  'thread/read',
  'thread/read/indexed',
  'thread/creation/read',
  'thread/goal/get',
  'thread/goal/history',
  'turn/receipt/read',
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
  'mcp/list',
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
  'knowledge/export/read',
])

// These operations may scan large trees, install packages or compact via a
// provider. Give them an explicit larger bound rather than removing deadlines.
const longRequestDeadlines = {
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

/** Gateway expiration describes unanswered upstream work, never a definitive rejection. */
export const GATEWAY_EXPIRED_REQUEST_DATA = Object.freeze({ kind: 'gatewayRequestExpired', outcome: 'unknown' });
export function isGatewayUnknownOutcome(value) {
  return value !== null && typeof value === 'object' && value.kind === 'gatewayRequestExpired' && value.outcome === 'unknown';
}
