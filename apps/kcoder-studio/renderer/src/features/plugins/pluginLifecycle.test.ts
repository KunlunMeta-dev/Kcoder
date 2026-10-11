import { describe, expect, it } from 'vitest'
import {
  canRevalidatePlugin,
  credentialNames,
  normalizePluginActivation,
  mcpActivationReason,
} from './pluginLifecycle'

describe('plugin activation evidence', () => {
  it('does not infer usability from package declarations or missing observation', () => {
    expect(normalizePluginActivation({ components: [{ kind: 'mcp', name: 'demo' }] })).toBeNull()
    expect(
      normalizePluginActivation({ generation: 1, phase: 'installed', components: [] })?.phase
    ).toBe('installed')
  })
  it('requires registered tools before treating MCP as usable', () => {
    const snapshot = (toolCount?: number) =>
      normalizePluginActivation({
        generation: 1,
        threadId: 'thread-example',
        phase: 'mounted',
        components: [{ kind: 'mcp', name: 'demo', phase: 'usable', toolCount }],
      })
    expect(snapshot(0)?.components[0].phase).toBe('mounted')
    expect(snapshot()?.components[0].phase).toBe('mounted')
    expect(snapshot(3)?.components[0]).toMatchObject({ phase: 'usable', toolCount: 3 })
    expect(
      normalizePluginActivation({
        generation: 1,
        phase: 'usable',
        components: [{ kind: 'mcp', name: 'demo', phase: 'usable', toolCount: 3 }],
      })?.phase
    ).toBe('unknown')
  })
  it('offers retry only for network failures and preserves all hard blocks', () => {
    const manifest = (codes: string[]) => ({
      installationAvailability: { retryable: true },
      compatibility: { issues: codes.map(code => ({ code })) },
    })
    expect(canRevalidatePlugin(manifest(['installation_download_unverified']))).toBe(true)
    expect(canRevalidatePlugin(manifest([]))).toBe(false)
    for (const code of [
      'installation_credentials',
      'installation_package_integrity',
      'installation_unsupported',
      'installation_unavailable',
    ])
      expect(canRevalidatePlugin(manifest(['installation_download_unverified', code]))).toBe(false)
  })
  it('keeps secret values and free-form diagnostics out of activation projection', () => {
    expect(
      credentialNames([
        'TOKEN',
        'connector.demo.ACCESS_TOKEN',
        'TOKEN',
        'key=value',
        '',
        { key: 'secret' },
      ])
    ).toEqual(['TOKEN', 'connector.demo.ACCESS_TOKEN'])
    const snapshot = normalizePluginActivation({
      generation: 1,
      phase: 'credentials_required',
      components: [
        {
          kind: 'mcp',
          name: 'demo',
          phase: 'credentials_required',
          errorCode: 'Bearer private-secret',
          missingNames: ['TOKEN', 'TOKEN=private-secret'],
          credentialValue: 'private-secret',
        },
      ],
    })
    expect(JSON.stringify(snapshot)).not.toContain('private-secret')
  })
})

it('maps known MCP reasons and preserves safe older-peer fallback', () => {
  expect(mcpActivationReason('mcp_protocol_failed')).toBe('protocolFailed')
  expect(mcpActivationReason('mcp_authorization_required')).toBe('authorizationRequired')
  expect(mcpActivationReason('mcp_connection_failed')).toBe('connectionFailed')
  expect(mcpActivationReason('mcp_no_tools')).toBe('noTools')
  expect(mcpActivationReason('mcp_timeout')).toBe('timedOut')
  expect(mcpActivationReason('future_error')).toBe('unavailable')
  expect(mcpActivationReason()).toBeNull()
  const value = normalizePluginActivation({
    generation: 1,
    threadId: 't',
    phase: 'authorization_required',
    components: [
      {
        kind: 'mcp',
        name: 'fixture',
        phase: 'authorization_required',
        errorCode: 'mcp_authorization_required',
        authorization: 'notAuthorized',
      },
    ],
  })
  expect(value?.components[0].authorization).toBe('notAuthorized')
})

it('never promotes MCP failure metadata to usable even when stale tools are reported', () => {
  const normalized = normalizePluginActivation({
    generation: 1,
    threadId: 't',
    phase: 'usable',
    components: [
      {
        kind: 'mcp',
        name: 'fixture',
        phase: 'usable',
        toolCount: 3,
        errorCode: 'mcp_protocol_failed',
      },
    ],
  })
  expect(normalized?.phase).toBe('failed')
  expect(normalized?.components[0].phase).toBe('failed')
})
