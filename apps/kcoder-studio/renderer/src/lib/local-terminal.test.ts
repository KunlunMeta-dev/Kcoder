import { afterEach, expect, test, vi } from 'vitest'
import { registerRuntimeTransport } from './runtime-transport'
import { getLocalExecutorDeviceId, getLocalPathKind, isLocalTerminalAvailable, localPathExists, openLocalFile, openLocalWorkspace, startLocalTerminal } from './local-terminal'

afterEach(() => vi.restoreAllMocks())
test.each(['MacIntel', 'Win32', 'Linux x86_64', 'iPhone'])('Gateway on %s never enables the removed Tauri terminal', async platform => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
  const handler = vi.fn()
  const dispose = registerRuntimeTransport(handler)
  try {
    expect(isLocalTerminalAvailable()).toBe(false)
    await expect(getLocalExecutorDeviceId()).resolves.toBeNull()
    await expect(localPathExists('/project')).resolves.toBe(false)
    await expect(getLocalPathKind('/project')).resolves.toBeNull()
    await expect(startLocalTerminal({ cwd: '/project' })).rejects.toThrow(/unavailable/)
    await expect(openLocalWorkspace({ opener: 'vscode', path: '/project' })).rejects.toThrow(/unavailable/)
    await expect(openLocalFile('/project/file.md')).rejects.toThrow(/unavailable/)
    expect(handler).not.toHaveBeenCalled()
  } finally { dispose() }
})
