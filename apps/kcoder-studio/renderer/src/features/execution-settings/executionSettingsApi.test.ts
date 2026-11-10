import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { GatewayRpcError } from '@/kcoder/gatewayRpc'
import { requestLocalExecutor } from '@/host/localExecutor'
import {
  isExecutionDefaultsUnsupported,
  readExecutionDefaults,
  readTargetCustomInstructions,
  saveExecutionDefaults,
  saveTargetCustomInstructions,
} from './executionSettingsApi'

vi.mock('@/host/localExecutor', async original => {
  const actual = await original<typeof import('@/host/localExecutor')>()
  return { ...actual, requestLocalExecutor: vi.fn() }
})

describe('executionSettingsApi', () => {
  let marker: HTMLMetaElement

  beforeEach(() => {
    marker = document.createElement('meta')
    marker.name = 'kcoder-rpc-token'
    marker.content = 'execution-api-test'
    document.head.append(marker)
    vi.mocked(requestLocalExecutor).mockReset()
  })

  afterEach(() => marker.remove())

  test('reads and saves target profile defaults with the exact server id and nullable permission mode', async () => {
    vi.mocked(requestLocalExecutor).mockResolvedValue({
      persistedPermissionMode: null,
      effectivePermissionMode: 'ask',
      cliPermissionModeOverride: null,
    })

    await expect(readExecutionDefaults('target-b')).resolves.toEqual({
      persistedPermissionMode: null,
      effectivePermissionMode: 'ask',
      cliPermissionModeOverride: null,
    })
    expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.settings.request', {
      serverId: 'target-b',
      method: 'settings/execution-defaults/read',
      params: {},
    })

    await saveExecutionDefaults('target-b', null)
    expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.settings.request', {
      serverId: 'target-b',
      method: 'settings/execution-defaults/save',
      params: { permissionMode: null },
    })
  })

  test('routes custom instructions through target deviceId and never selects local Codex aliases', async () => {
    vi.mocked(requestLocalExecutor).mockResolvedValue({
      instructions: 'Target rules',
      configPath: null,
    })
    await expect(readTargetCustomInstructions('target-a')).resolves.toEqual({
      instructions: 'Target rules',
      configPath: null,
    })
    expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.instructions.read', {
      deviceId: 'target-a',
    })

    await saveTargetCustomInstructions('target-a', 'New rules')
    expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.instructions.write', {
      deviceId: 'target-a',
      instructions: 'New rules',
    })
  })

  test('requires a real instructions receipt and enforces the 64 KiB UTF-8 byte limit', async () => {
    vi.mocked(requestLocalExecutor).mockResolvedValue({})
    await expect(readTargetCustomInstructions('target-a')).rejects.toThrow(
      'Invalid custom instructions response'
    )
    await expect(saveTargetCustomInstructions('target-a', 'Submitted rules')).rejects.toThrow(
      'Invalid custom instructions response'
    )
    vi.mocked(requestLocalExecutor).mockResolvedValue({ instructions: '', configPath: null })
    await expect(readTargetCustomInstructions('target-a')).resolves.toEqual({
      instructions: '',
      configPath: null,
    })
    await expect(saveTargetCustomInstructions('target-a', 'A'.repeat(65_537))).rejects.toThrow(
      '64 KiB'
    )
    await expect(saveTargetCustomInstructions('target-a', '汉'.repeat(21_846))).rejects.toThrow(
      '64 KiB'
    )
    expect(requestLocalExecutor).toHaveBeenCalledTimes(3)
  })

  test('rejects target settings on a local host rather than falling back to local Codex', async () => {
    marker.remove()
    await expect(readExecutionDefaults('target-a')).rejects.toThrow(/KCoder Gateway/)
    await expect(readTargetCustomInstructions('target-a')).rejects.toThrow(/KCoder Gateway/)
    expect(requestLocalExecutor).not.toHaveBeenCalled()
  })

  test('detects capability data on an actual GatewayRpcError', async () => {
    const error = new GatewayRpcError(
      'Target requires execution default settings support',
      -32000,
      {
        kind: 'execution_defaults_unsupported',
        capability: 'executionDefaultsV1',
      }
    )
    expect(error.data).toEqual({
      kind: 'execution_defaults_unsupported',
      capability: 'executionDefaultsV1',
    })
    vi.mocked(requestLocalExecutor).mockRejectedValue(error)
    const received = await readExecutionDefaults('target-a').catch(reason => reason)
    expect(received).toBe(error)
    expect(isExecutionDefaultsUnsupported(received)).toBe(true)
    expect(isExecutionDefaultsUnsupported(new Error('unavailable'))).toBe(false)
  })
})
