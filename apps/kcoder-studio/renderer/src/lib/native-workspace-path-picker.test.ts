import { expect, test } from 'vitest'
import { canOpenNativeWorkspacePathPicker, openNativeWorkspacePathPicker } from './native-workspace-path-picker'
import { registerRuntimeTransport } from './runtime-transport'

test('Gateway presence never advertises the removed native file path reader', async () => {
  const dispose = registerRuntimeTransport(() => { throw new Error('Retired IPC must not run') })
  try {
    expect(canOpenNativeWorkspacePathPicker()).toBe(false)
    await expect(openNativeWorkspacePathPicker('/Users/alice', { directoriesOnly: true })).rejects.toThrow(/server-side browsing or file upload/)
  } finally { dispose() }
})
