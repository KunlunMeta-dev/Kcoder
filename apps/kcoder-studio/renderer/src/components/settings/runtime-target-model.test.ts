import { describe, expect, test } from 'vitest'
import { createRuntimeTargetSession, validateRuntimeTarget } from './runtime-target-model'

describe('runtime target platform paths', () => {
  test.each([
    String.raw`C:\Users\测试用户\My Project`,
    String.raw`\\server\share\Project`,
    '/srv/project',
  ])('accepts an absolute local workspace and settings path: %s', path => {
    const session = createRuntimeTargetSession()
    Object.assign(session.draft, {
      id: 'local',
      label: 'Local',
      transport: 'local',
      workspacePath: path,
      settingsFile: `${path}/settings.json`,
    })
    expect(validateRuntimeTarget(session, [])).toEqual({})
  })

  test('keeps SSH paths POSIX and rejects drive-relative local paths', () => {
    const session = createRuntimeTargetSession()
    Object.assign(session.draft, {
      id: 'remote',
      label: 'Remote',
      host: 'build',
      workspacePath: String.raw`C:\project`,
    })
    expect(validateRuntimeTarget(session, []).workspacePath).toBe('invalidWorkspace')
    Object.assign(session.draft, { transport: 'local', workspacePath: 'C:relative' })
    expect(validateRuntimeTarget(session, []).workspacePath).toBe('invalidWorkspace')
  })
})
