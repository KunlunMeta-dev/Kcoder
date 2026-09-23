import { describe, expect, test, vi } from 'vitest'
import {
  resolveGatewaySessionFailure,
  resolveGatewayActionOutcome,
  applyGatewayShutdownFailure,
  resolveStartupTimeout,
  takeWritableCommandPoll,
} from './ai-verify.mjs'

test('startup deadline failure cannot be erased by a late ready registration', () => {
  const failure = applyGatewayShutdownFailure(null, { failure: 'startup-timeout' })
  expect(resolveGatewaySessionFailure({ location: 'late-ready' }, failure)?.message).toBe(
    'Gateway verification startup timed out'
  )
})

test('a suite can preserve an external business assertion failure when shutting down', () => {
  expect(applyGatewayShutdownFailure(null, { failure: 'verification-failed' })?.message).toBe('Gateway business verification failed')
})

test('ordinary action failures fail verification, while explicit expected negatives are audited', () => {
  const error = new Error('selector missing')
  const unexpected = resolveGatewayActionOutcome({ action: 'click' }, undefined, error)
  expect(unexpected.response.ok).toBe(false)
  expect(unexpected.failure).toBe(error)
  const expected = resolveGatewayActionOutcome(
    { action: 'click', expectedFailure: true, expectedError: 'selector missing' },
    undefined,
    error
  )
  expect(expected.response).toEqual({
    ok: true,
    value: { expectedFailure: true, error: 'selector missing' },
  })
  expect(expected.failure).toBeNull()
  const missingNegative = resolveGatewayActionOutcome(
    { action: 'click', expectedFailure: true, expectedError: 'selector missing' },
    'clicked',
    null
  )
  expect(missingNegative.response.ok).toBe(false)
  expect(missingNegative.failure.message).toContain('Expected click to fail')
})

test('an expected negative must match its declared error instead of hiding a transport timeout', () => {
  const result = resolveGatewayActionOutcome(
    { action: 'click', expectedFailure: true, expectedError: 'Unable to find selector' },
    undefined,
    new Error('Timed out running click')
  )
  expect(result.response.ok).toBe(false)
  expect(result.failure).toBeInstanceOf(Error)
})

test('direct control requests cannot declare an unrestricted expected failure', () => {
  for (const expectedError of [undefined, '', '  ']) {
    const result = resolveGatewayActionOutcome(
      { action: 'click', expectedFailure: true, expectedError },
      undefined,
      new Error('any error')
    )
    expect(result.response.ok).toBe(false)
  }
})

test('a Gateway session stopped before ready cannot report a successful verification', () => {
  expect(resolveGatewaySessionFailure(null, null)?.message).toBe(
    'Gateway WebView did not reach ready'
  )
  const failure = new Error('owned process failed')
  expect(resolveGatewaySessionFailure(null, failure)).toBe(failure)
  expect(resolveGatewaySessionFailure({ location: 'http://127.0.0.1:1234' }, null)).toBeNull()
})

function commandPoll(response) {
  return {
    response,
    timer: setTimeout(() => {}, 60_000),
    closed: false,
  }
}

describe('takeWritableCommandPoll', () => {
  test('skips disconnected responses and returns the next writable poll', () => {
    const disconnected = commandPoll({ destroyed: true, writableEnded: false })
    const closed = commandPoll({ destroyed: false, writableEnded: false })
    closed.closed = true
    const ended = commandPoll({ destroyed: false, writableEnded: true })
    const writable = commandPoll({ destroyed: false, writableEnded: false })
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')

    expect(takeWritableCommandPoll([disconnected, closed, ended, writable])).toBe(writable)
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(4)

    clearTimeoutSpy.mockRestore()
  })

  test('returns undefined when every pending response is stale', () => {
    const stalePolls = [
      commandPoll({ destroyed: true, writableEnded: false }),
      commandPoll({ destroyed: false, writableEnded: true }),
    ]

    expect(takeWritableCommandPoll(stalePolls)).toBeUndefined()
    expect(stalePolls).toHaveLength(0)
  })
})

describe('resolveStartupTimeout', () => {
  test('accepts finite positive timeout values', () => {
    expect(resolveStartupTimeout('120000')).toBe(120000)
    expect(resolveStartupTimeout(undefined)).toBe(60000)
  })

  test.each(['0', '-1', 'Infinity', 'not-a-number'])('rejects invalid timeout %s', timeout => {
    expect(() => resolveStartupTimeout(timeout)).toThrow(
      '--timeout must be a finite positive number'
    )
  })
})
