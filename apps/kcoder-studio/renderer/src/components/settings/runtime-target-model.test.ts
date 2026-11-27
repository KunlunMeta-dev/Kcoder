import { describe, expect, test } from 'vitest'
import { createRuntimeTargetSession, editRuntimeTargetSession, runtimeTargetConfigFromDraft,
  updateRuntimeTargetSession, validateRuntimeTarget } from './runtime-target-model'

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

  test('accepts a Windows SSH drive path and preserves the target platform on edit', () => {
    const server = { id: 'win', label: 'Windows', description: 'SSH KCoder app-server', runtime: 'kcoder' as const,
      transport: 'ssh' as const, remotePlatform: 'windows' as const, host: 'win.example',
      workspacePath: String.raw`C:\Projects\My Project`, command: String.raw`C:\KCoder\kcoder.exe`,
      settingsFile: String.raw`C:\Users\worker\settings.json` }
    const session = editRuntimeTargetSession(server)
    expect(validateRuntimeTarget(session, [])).toEqual({})
    expect(runtimeTargetConfigFromDraft(session)).toMatchObject(server)
    expect(updateRuntimeTargetSession(session, 'remotePlatform', 'linux').draft.remotePlatform).toBe('linux')
  })

  test('rejects Windows network paths, drive-relative paths, and non-executable launch commands', () => {
    const session = createRuntimeTargetSession()
    Object.assign(session.draft, { id: 'win', label: 'Windows', host: 'win.example', remotePlatform: 'windows',
      workspacePath: String.raw`\\server\share\project`, command: 'kcoder', settingsFile: String.raw`C:settings.json` })
    expect(validateRuntimeTarget(session, [])).toMatchObject({ workspacePath: 'invalidWindowsWorkspace',
      command: 'invalidWindowsCommand', settingsFile: 'invalidWindowsSettingsFile' })
  })

  test('selecting Windows clears the unsupported KCoder account mode without altering paths', () => {
    const session = createRuntimeTargetSession()
    const account = updateRuntimeTargetSession(session, 'accountMode', true)
    const windows = updateRuntimeTargetSession(account, 'remotePlatform', 'windows')
    expect(windows.draft.accountMode).toBe(false)
    expect(windows.draft.command).toBe('kcoder')
    expect(windows.draft.remotePlatform).toBe('windows')
  })
})
