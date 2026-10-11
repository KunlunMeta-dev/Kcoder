import { describe, expect, it } from 'vitest'
import { safeErrorDiagnostic } from './error-diagnostics'
import { runtimeTranscriptDebug } from '@/features/workbench/runtimePaneMessages'

describe('default diagnostic privacy', () => {
  it('retains only stable error kind and numeric code', () => {
    const error = Object.assign(new TypeError('private prompt'), { code: -32001, headers: { Authorization: 'secret' }, response: 'private answer' })
    expect(safeErrorDiagnostic(error)).toEqual({ kind: 'type-error', code: -32001 })
    expect(safeErrorDiagnostic({ code: 'secret', message: 'private' })).toEqual({ kind: 'unknown' })
    expect(safeErrorDiagnostic(Object.defineProperty({}, 'code', { get() { throw new Error('secret') } }))).toEqual({ kind: 'unknown' })
  })
  it('describes malformed transcript shape without copying response text or cursors', () => {
    const output = runtimeTranscriptDebug({ messages: [{ content: 'private answer' }], error: 'private prompt', runtime: 'secret', beforeCursor: 'private-cursor', afterCursor: 'secret-cursor', success: 'private', rangeStart: 'secret', privateKeyName: 'secret' })
    expect(output).toMatchObject({ messageCount: 1, hasError: true, runtime: 'unknown', hasBeforeCursor: true, hasAfterCursor: true })
    expect(JSON.stringify(output)).not.toMatch(/private|secret|answer|prompt/)
  })
})
