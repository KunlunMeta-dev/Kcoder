import { describe, expect, test } from 'vitest'
import en from '@/i18n/locales/en/common.json'
import zh from '@/i18n/locales/zh-CN/common.json'
import { GatewayRpcError } from '@/kcoder/gatewayRpc'
import { classifyPluginFailure } from './plugin-errors'

/**
 * X4 requires the failure kinds a user can act on to be told apart, and D3
 * requires a stable code, the phase, retryability and a de-identified message.
 * These tests pin the classification and, separately, that every code actually
 * resolves to copy in both locales — a code without copy would render a raw
 * i18n key, which is the leak the U-C rule forbids.
 */

describe('classifyPluginFailure', () => {
  test('reads an expired session from the gateway reason, not the prose', () => {
    const failure = classifyPluginFailure(
      new GatewayRpcError('anything at all', 401, undefined, 'runtime-session', 'unauthorized')
    )

    expect(failure.code).toBe('unauthorized')
    expect(failure.retryable).toBe(false)
    expect(failure.phase).toBe('runtime-session')
  })

  test.each([
    [403, 'forbidden'],
    [404, 'not-found'],
    [408, 'server'],
    [429, 'server'],
    [500, 'server'],
    [503, 'server'],
  ])('maps HTTP %i to %s', (status, code) => {
    const failure = classifyPluginFailure(
      new GatewayRpcError(`HTTP ${status}`, status, undefined, 'save-target', 'http')
    )
    expect(failure.code).toBe(code)
  })

  test('treats a connection failure as retryable and a bad payload as not', () => {
    const unreachable = classifyPluginFailure(
      new GatewayRpcError('offline', -1, undefined, 'target-health', 'connection')
    )
    expect(unreachable.code).toBe('unreachable')
    expect(unreachable.retryable).toBe(true)

    const invalid = classifyPluginFailure(
      new GatewayRpcError('garbage', -1, undefined, 'list-targets', 'invalid-response')
    )
    expect(invalid.code).toBe('invalid-response')
    expect(invalid.retryable).toBe(false)
  })

  test('still recognises the untrusted-directory signal the renderer already branches on', () => {
    const failure = classifyPluginFailure(
      new Error('marketplace at /srv/m requires folder trust before it can be read')
    )
    expect(failure.code).toBe('folder-trust')
  })

  test('falls back to unknown for anything it cannot identify', () => {
    const failure = classifyPluginFailure(new Error('something new'))
    expect(failure.code).toBe('unknown')
    expect(failure.phase).toBe('unknown')
    expect(failure.retryable).toBe(false)
  })

  test('handles a non-Error rejection without throwing', () => {
    expect(classifyPluginFailure('boom').code).toBe('unknown')
    expect(classifyPluginFailure(undefined).code).toBe('unknown')
  })

  test('never returns the raw message as the user-facing string', () => {
    const failure = classifyPluginFailure(new Error('internal detail: secret-token-abc'))
    // The caller renders the i18n key, so raw text cannot reach the UI.
    expect(failure.messageKey.startsWith('workbench.plugins_error_')).toBe(true)
  })
})

describe('plugin failure copy', () => {
  const codes = [
    'unauthorized',
    'forbidden',
    'not_found',
    'unreachable',
    'server',
    'invalid_response',
    'folder_trust',
    'tls',
    'proxy',
    'source_access',
    'invalid_plugin',
    'cancelled',
    'busy',
    'rollback_failed',
    'unknown',
  ]

  test.each(codes)('every failure code has copy in both locales: %s', code => {
    const key = `plugins_error_${code}` as keyof typeof en.workbench
    expect(en.workbench[key]).toBeTruthy()
    expect(zh.workbench[key]).toBeTruthy()
  })

  test('the codes the classifier can return all map to existing copy', () => {
    for (const error of [
      new GatewayRpcError('x', 401, undefined, 'unknown', 'unauthorized'),
      new GatewayRpcError('x', 403, undefined, 'unknown', 'http'),
      new GatewayRpcError('x', 404, undefined, 'unknown', 'http'),
      new GatewayRpcError('x', 500, undefined, 'unknown', 'http'),
      new GatewayRpcError('x', -1, undefined, 'unknown', 'connection'),
      new GatewayRpcError('x', -1, undefined, 'unknown', 'invalid-response'),
      new Error('requires folder trust'),
      new Error('other'),
    ]) {
      const { messageKey } = classifyPluginFailure(error)
      const shortKey = messageKey.replace(
        'workbench.plugins_error_',
        ''
      ) as keyof typeof en.workbench
      expect(en.workbench[`plugins_error_${shortKey}`]).toBeTruthy()
      expect(zh.workbench[`plugins_error_${shortKey}`]).toBeTruthy()
    }
  })
})
