import { afterEach, expect, test, vi } from 'vitest'
import { createGatewayIpcHandler } from './gatewayRuntimeInstall'
import { createGatewayPageIpcHandler } from './gateway/install/ipc'
import { registerRuntimeTransport } from '@/lib/runtime-transport'
import { resolveDataTransferWorkspacePaths } from '@/lib/workspace-path-transfer'
import { canOpenNativeWorkspacePathPicker } from '@/lib/native-workspace-path-picker'
import { isLocalTerminalAvailable } from '@/lib/local-terminal'

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost
})

for (const factory of [createGatewayIpcHandler, createGatewayPageIpcHandler]) {
  test(`${factory.name}: a real command adapter preserves ordinary dropped and pasted files`, async () => {
    const invoke = factory({} as never)
    dispose = registerRuntimeTransport(invoke)
    const file = new File(['# context'], 'context.md', { type: 'text/markdown' })
    const data = { files: [file], getData: () => '' } as unknown as DataTransfer
    for (const source of ['drop', 'clipboard'] as const) {
      await expect(resolveDataTransferWorkspacePaths(data, source, 'local')).resolves.toEqual({ attachmentFiles: [file], referenceEntries: [] })
    }
    expect(canOpenNativeWorkspacePathPicker()).toBe(false)
    expect(isLocalTerminalAvailable()).toBe(false)
  })

  test(`${factory.name}: diagnostics use the current host and never fabricate a measurement`, async () => {
    const invoke = factory({ status: async () => ({ running: true, ready: false }) } as never)
    await expect(invoke('local_executor_read_log')).rejects.toThrow(/unavailable/)
    await expect(invoke('get_process_diagnostics_snapshot')).resolves.toBeNull()
    const windowAction = vi.fn()
    Object.assign(window, { kcoderDesktopHost: {
      readFeedbackDiagnostics: vi.fn(async () => ({ runtimeLogs: 'owned gateway output\n', systemInfo: null })), windowAction,
    } })
    await expect(invoke('local_executor_read_log')).resolves.toMatchObject({ content: 'owned gateway output\n', transportConnected: false })
    await invoke('open_main_webview_devtools')
    expect(windowAction).toHaveBeenCalledWith('devtools')
  })
}

test('a failed runtime handshake does not discard the owned Gateway logs', async () => {
  const invoke = createGatewayPageIpcHandler({ status: async () => { throw new Error('handshake failed') } } as never)
  Object.assign(window, { kcoderDesktopHost: { readFeedbackDiagnostics: async () => ({ runtimeLogs: 'failure details', systemInfo: null }) } })
  await expect(invoke('local_executor_read_log')).resolves.toMatchObject({ content: 'failure details', transportConnected: false, status: { error: 'handshake failed' } })
})
