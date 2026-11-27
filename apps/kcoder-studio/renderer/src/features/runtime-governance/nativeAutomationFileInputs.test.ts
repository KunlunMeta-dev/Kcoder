import { afterEach, expect, test, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: fixture.request }))
vi.mock('@/kcoder/accountContextEvents', () => ({
  captureAccountContextRevision: () => () => true,
}))
import { nativeAutomationFileInputs } from './nativeAutomationFileInputs'
afterEach(() => fixture.request.mockReset())
const entry = {
  name: 'evidence.txt',
  path: '/workspace/evidence.txt',
  size: 12,
  is_directory: false,
}
const response = (path = '/workspace', entries = [entry]) => ({
  success: true,
  stdout: { path, entries },
})
test('uses the original metadata command with a fixed workspace and separate child path', async () => {
  fixture.request.mockResolvedValue(
    response('/workspace/child', [{ ...entry, path: '/workspace/child/evidence.txt' }])
  )
  const provider = nativeAutomationFileInputs({
    ownerKey: 'native-owner',
    serverId: 'target',
    workspacePath: '/workspace',
    isCurrent: () => true,
  })!
  const signal = new AbortController().signal
  expect(await provider.listDirectory({ relativeDirectory: 'child', signal })).toEqual([
    { name: 'evidence.txt', size: 12, isDirectory: false },
  ])
  expect(fixture.request).toHaveBeenCalledExactlyOnceWith(
    'device.execute_command',
    {
      deviceId: 'target',
      command_key: 'workspace_tree',
      workspacePath: '/workspace',
      path: '/workspace/child',
      timeout_seconds: 15,
      max_output_bytes: 512 * 1024,
    },
    { signal }
  )
  expect(provider).not.toHaveProperty('authorized')
})
test('resolves actual default workspace and rejects replacement before any further listing', async () => {
  let root = '/workspace'
  fixture.request.mockResolvedValue(response())
  const provider = nativeAutomationFileInputs({
    ownerKey: 'native-owner',
    serverId: 'target',
    isCurrent: () => true,
    getProjectWorkspaceRoot: async () => root,
  })!
  await provider.listDirectory({ relativeDirectory: '.', signal: new AbortController().signal })
  expect(provider.workspaceLabel).toBe('/workspace')
  root = '/other-workspace'
  await expect(
    provider.listDirectory({ relativeDirectory: '.', signal: new AbortController().signal })
  ).rejects.toMatchObject({ code: 'KNOWLEDGE_OWNER_CHANGED' })
  expect(fixture.request).toHaveBeenCalledTimes(1)
})
test('rejects traversal and cross-directory metadata without reading file content', async () => {
  fixture.request.mockResolvedValue(
    response('/workspace', [{ ...entry, path: '/other/evidence.txt' }])
  )
  const provider = nativeAutomationFileInputs({
    ownerKey: 'native-owner',
    serverId: 'target',
    workspacePath: '/workspace',
    isCurrent: () => true,
  })!
  await expect(
    provider.listDirectory({ relativeDirectory: '../other', signal: new AbortController().signal })
  ).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID_PAYLOAD' })
  expect(fixture.request).not.toHaveBeenCalled()
  await expect(
    provider.listDirectory({ relativeDirectory: '.', signal: new AbortController().signal })
  ).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID_RECEIPT' })
})
test('drops delayed metadata after owner change and aborts before another request', async () => {
  let current = true,
    settle!: (value: unknown) => void
  fixture.request.mockImplementation(
    () =>
      new Promise(resolve => {
        settle = resolve
      })
  )
  const provider = nativeAutomationFileInputs({
    ownerKey: 'native-owner',
    serverId: 'target',
    workspacePath: '/workspace',
    isCurrent: () => current,
  })!
  const pending = provider.listDirectory({
    relativeDirectory: '.',
    signal: new AbortController().signal,
  })
  current = false
  settle(response())
  await expect(pending).rejects.toMatchObject({ code: 'KNOWLEDGE_OWNER_CHANGED' })
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(
    provider.listDirectory({ relativeDirectory: '.', signal: cancelled.signal })
  ).rejects.toBeDefined()
  expect(fixture.request).toHaveBeenCalledTimes(1)
})
