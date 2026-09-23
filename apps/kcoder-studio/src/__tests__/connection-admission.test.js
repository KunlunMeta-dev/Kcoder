import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONNECTION_REFUSAL,
  connectionCapacityRefusal,
  connectionRefusalDiagnostic,
} from '../connection-admission.js'

function capacity(overrides = {}) {
  return {
    channel: 'browser',
    browserSessionsAvailable: true,
    activeConnections: 1,
    maxConnections: 256,
    activeBrowserConnections: 0,
    maxBrowserConnections: 4,
    ...overrides,
  }
}

test('admits a connection while every limit still has room', () => {
  assert.equal(connectionCapacityRefusal(capacity()), null)
  assert.equal(
    connectionCapacityRefusal(capacity({ activeBrowserConnections: 3 })),
    null
  );
})

test('reports the browser-class limit separately from the global limit', () => {
  const refusal = connectionCapacityRefusal(capacity({ activeBrowserConnections: 4 }))
  assert.equal(refusal.reason, CONNECTION_REFUSAL.BROWSER_LIMIT)
  // The counts travel with the reason so a browser-class cap is never reported
  // as global connection exhaustion.
  assert.equal(refusal.activeBrowserConnections, 4)
  assert.equal(refusal.maxBrowserConnections, 4)
  assert.equal(refusal.activeConnections, 1)
  assert.equal(refusal.maxConnections, 256)
})

test('reports true global exhaustion and keeps the browser limit visible', () => {
  const refusal = connectionCapacityRefusal(
    capacity({ activeConnections: 256, activeBrowserConnections: 4 })
  )
  assert.equal(refusal.reason, CONNECTION_REFUSAL.GLOBAL_LIMIT)
  assert.equal(refusal.activeConnections, 256)
  assert.equal(refusal.activeBrowserConnections, 4)
})

test('separates a runtime without browser sessions from a capacity limit', () => {
  const refusal = connectionCapacityRefusal(
    capacity({ browserSessionsAvailable: false, activeConnections: 256 })
  )
  assert.equal(refusal.reason, CONNECTION_REFUSAL.RUNTIME_UNSUPPORTED)
  // A non-browser channel is unaffected by the browser capability.
  assert.equal(
    connectionCapacityRefusal(
      capacity({ channel: 'runtime', browserSessionsAvailable: false })
    ),
    null
  );
})

test('diagnostics name the limit and carry the counts for each class', () => {
  const refusal = connectionCapacityRefusal(capacity({ activeBrowserConnections: 4 }))
  const diagnostic = connectionRefusalDiagnostic(refusal, {
    [CONNECTION_REFUSAL.RUNTIME_UNSUPPORTED]: 0,
    [CONNECTION_REFUSAL.GLOBAL_LIMIT]: 1,
    [CONNECTION_REFUSAL.BROWSER_LIMIT]: 2,
  })
  assert.equal(diagnostic.event, 'connection-refused')
  assert.equal(diagnostic.reason, CONNECTION_REFUSAL.BROWSER_LIMIT)
  // Both limits stay visible, so a browser-class cap cannot be read as global
  // connection exhaustion.
  assert.equal(diagnostic.activeConnections, 1)
  assert.equal(diagnostic.maxConnections, 256)
  assert.equal(diagnostic.activeBrowserConnections, 4)
  assert.equal(diagnostic.maxBrowserConnections, 4)
  // Cumulative counts per reason, without tokens, sessions or account data.
  assert.deepEqual(diagnostic.refusals, {
    runtime_unsupported: 0,
    global_limit: 1,
    browser_limit: 2,
  })
  assert.deepEqual(Object.keys(diagnostic).sort(), [
    'activeBrowserConnections',
    'activeConnections',
    'channel',
    'event',
    'maxBrowserConnections',
    'maxConnections',
    'reason',
    'refusals',
  ])
})
