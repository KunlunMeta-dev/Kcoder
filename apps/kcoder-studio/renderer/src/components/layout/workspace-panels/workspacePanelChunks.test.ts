import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const loaded = vi.hoisted(() => [] as string[])
vi.mock('./EmbeddedLocalTerminal', () => {
  loaded.push('terminal')
  return { EmbeddedLocalTerminal: () => null }
})
vi.mock('./RemoteTerminal', () => {
  loaded.push('remoteTerminal')
  return { RemoteTerminal: () => null }
})
vi.mock('@/kcoder/SshTerminalPane', () => {
  loaded.push('sshTerminal')
  return { SshTerminalPane: () => null }
})
vi.mock('./FileWorkspacePanel', () => {
  loaded.push('files')
  return { FileWorkspacePanel: () => null }
})
vi.mock('@/components/chat/FileChangesReviewPanel', () => {
  loaded.push('changes')
  return { FileChangesReviewPanel: () => null }
})

beforeEach(() => {
  vi.resetModules()
  loaded.length = 0
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

test('Vite startup does not schedule the unrequested panel dependency graph', async () => {
  vi.stubEnv('PROD', false)
  const idle = vi.fn()
  vi.stubGlobal('requestIdleCallback', idle)
  const { prefetchWorkspacePanelChunks } = await import('./workspacePanelChunks')
  prefetchWorkspacePanelChunks()()
  expect(idle).not.toHaveBeenCalled()
  expect(loaded).toEqual([])
})

test('closing a packaged layout cancels its pending idle prefetch', async () => {
  vi.stubEnv('PROD', true)
  const cancel = vi.fn()
  vi.stubGlobal('requestIdleCallback', vi.fn(() => 17))
  vi.stubGlobal('cancelIdleCallback', cancel)
  const { prefetchWorkspacePanelChunks } = await import('./workspacePanelChunks')
  prefetchWorkspacePanelChunks()()
  expect(cancel).toHaveBeenCalledWith(17)
  expect(loaded).toEqual([])
})

test('packaged panels still prefetch once after idle', async () => {
  vi.stubEnv('PROD', true)
  let run: IdleRequestCallback | undefined
  const idle = vi.fn((callback: IdleRequestCallback) => {
    run = callback
    return 18
  })
  vi.stubGlobal('requestIdleCallback', idle)
  const { prefetchWorkspacePanelChunks } = await import('./workspacePanelChunks')
  prefetchWorkspacePanelChunks()
  run!({ didTimeout: false, timeRemaining: () => 10 })
  await vi.waitFor(() => expect(loaded.sort()).toEqual([
    'changes', 'files', 'remoteTerminal', 'sshTerminal', 'terminal',
  ]))
  prefetchWorkspacePanelChunks()
  expect(idle).toHaveBeenCalledTimes(1)
})
