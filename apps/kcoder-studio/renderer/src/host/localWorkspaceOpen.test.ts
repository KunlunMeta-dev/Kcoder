import { beforeEach, describe, expect, test, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())
const isGatewayRuntimeMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/runtime-commands', () => ({
  invoke: invokeMock,
}))

vi.mock('@/lib/runtime-events', () => ({
  listen: listenMock,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isGatewayRuntime: isGatewayRuntimeMock,
}))

describe('localWorkspaceOpen', () => {
  beforeEach(() => {
    vi.resetModules()
    invokeMock.mockReset()
    listenMock.mockReset()
    isGatewayRuntimeMock.mockReset()
  })

  test('does not subscribe outside Gateway', async () => {
    isGatewayRuntimeMock.mockReturnValue(false)

    const { installLocalWorkspaceOpenListener } = await import('./localWorkspaceOpen')
    const openWorkspace = vi.fn()

    expect(installLocalWorkspaceOpenListener(openWorkspace)).toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
    expect(listenMock).not.toHaveBeenCalled()
  })

  test('opens pending local workspace requests on install', async () => {
    isGatewayRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue([
      { path: '  /Users/alice/project  ', label: ' Project ' },
      { path: '   ' },
    ])
    listenMock.mockResolvedValue(vi.fn())

    const {
      installLocalWorkspaceOpenListener,
      LOCAL_WORKSPACE_OPEN_DEVICE_ID,
      LOCAL_WORKSPACE_OPEN_REQUESTED_EVENT,
      TAKE_PENDING_LOCAL_WORKSPACE_OPEN_REQUESTS_COMMAND,
    } = await import('./localWorkspaceOpen')
    const openWorkspace = vi.fn().mockResolvedValue(undefined)

    installLocalWorkspaceOpenListener(openWorkspace)
    await vi.waitFor(() => expect(openWorkspace).toHaveBeenCalledTimes(1))

    expect(invokeMock).toHaveBeenCalledWith(TAKE_PENDING_LOCAL_WORKSPACE_OPEN_REQUESTS_COMMAND)
    expect(listenMock).toHaveBeenCalledWith(
      LOCAL_WORKSPACE_OPEN_REQUESTED_EVENT,
      expect.any(Function)
    )
    expect(openWorkspace).toHaveBeenCalledWith(
      LOCAL_WORKSPACE_OPEN_DEVICE_ID,
      '/Users/alice/project',
      'Project'
    )
  })

  test('drains pending requests when the Gateway event is received', async () => {
    const handlers = new Map<string, () => void>()
    isGatewayRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ path: '/repo/Wegent' }])
    listenMock.mockImplementation((eventName: string, handler: unknown) => {
      handlers.set(eventName, handler as () => void)
      return Promise.resolve(vi.fn())
    })

    const { installLocalWorkspaceOpenListener, LOCAL_WORKSPACE_OPEN_REQUESTED_EVENT } =
      await import('./localWorkspaceOpen')
    const openWorkspace = vi.fn().mockResolvedValue(undefined)

    installLocalWorkspaceOpenListener(openWorkspace)
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))

    handlers.get(LOCAL_WORKSPACE_OPEN_REQUESTED_EVENT)?.()

    await vi.waitFor(() =>
      expect(openWorkspace).toHaveBeenCalledWith('local-device', '/repo/Wegent', undefined)
    )
  })
})
