import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RetainedPageActive } from './retainedPageState'
import { DesktopSidebar } from './DesktopSidebar'
import { createSidebarProps, enableGateway } from './sidebar/DesktopSidebar.test-support'
import { clearTestTransports } from '@/test/runtime-transport'
import { RuntimeTaskLifecycleProvider, RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'

const directory = (name: string) => ({ servers: [{
  id: 'sidebar-owned', label: 'Owned target', transport: 'local',
  security: { identity: { mode: 'kcoder-account' } },
  accountIdentity: { principalId: name, username: name },
}] })
const product = { available: false, account: null }
const markers: HTMLElement[] = []
afterEach(() => {
  markers.splice(0).forEach(marker => marker.remove())
  vi.restoreAllMocks()
  clearTestTransports()
})

function setup(kind: 'collapsed' | 'retained', visible: boolean, hold = false) {
  localStorage.clear()
  enableGateway()
  const marker = document.createElement('meta')
  marker.name = 'kcoder-rpc-token'; marker.content = 'cookie'
  document.head.append(marker); markers.push(marker)
  const pending: Array<{ path: string; resolve: (response: Response) => void }> = []
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const path = String(input)
    if (!path.endsWith('/api/servers') && !path.endsWith('/api/kcoder-account'))
      throw new Error('Unexpected sidebar display request')
    if (hold) return new Promise<Response>(resolve => { pending.push({ path, resolve }) })
    return Response.json(path.endsWith('/api/servers') ? directory('current-account') : product)
  })
  const props = createSidebarProps()
  const store = new RuntimeTaskLifecycleStore('sidebar-read-demand')
  const view = (visible: boolean) => <RetainedPageActive.Provider value={kind === 'retained' ? visible : true}>
    <RuntimeTaskLifecycleProvider store={store}>
      <DesktopSidebar {...props} collapsed={kind === 'collapsed' && !visible} />
    </RuntimeTaskLifecycleProvider>
  </RetainedPageActive.Provider>
  const hook = render(view(visible))
  return { ...hook, fetcher, pending, visible: (shown: boolean) => hook.rerender(view(shown)) }
}

test.each(['collapsed', 'retained'] as const)('%s sidebars defer display reads until shown and ignore hidden configuration hints', async kind => {
  const hook = setup(kind, false)
  try {
    await act(async () => {})
    expect(hook.fetcher).not.toHaveBeenCalled()
    hook.visible(true)
    expect(await screen.findByText('current-account')).toBeInTheDocument()
    expect(hook.fetcher).toHaveBeenCalledTimes(2)
    hook.visible(false)
    await act(async () => { window.dispatchEvent(new Event('kcoder:servers-changed')) })
    expect(hook.fetcher).toHaveBeenCalledTimes(2)
    hook.visible(true)
    await waitFor(() => expect(hook.fetcher).toHaveBeenCalledTimes(3))
  } finally { hook.unmount() }
})

test('hidden account completion and a late directory reply cannot overwrite a new preview lifetime', async () => {
  const hook = setup('retained', true, true)
  try {
    await waitFor(() => expect(hook.pending).toHaveLength(2))
    hook.visible(false)
    // Product-account reads intentionally share an unfinished transport. Let the
    // old transport finish while no sidebar owns its display, then reopen it.
    await act(async () => {
      hook.pending.find(request => request.path.endsWith('/api/kcoder-account'))!.resolve(
        Response.json({ available: true, account: { id: 'old', username: 'old-account' } })
      )
    })
    hook.visible(true)
    await waitFor(() => expect(hook.pending).toHaveLength(4))
    await act(async () => {
      for (const request of hook.pending.slice(2))
        request.resolve(Response.json(request.path.endsWith('/api/servers') ? directory('new-account') : product))
    })
    expect(await screen.findByText('new-account')).toBeInTheDocument()
    await act(async () => {
      for (const request of hook.pending.slice(0, 2))
        request.resolve(Response.json(request.path.endsWith('/api/servers') ? directory('old-account')
          : { available: true, account: { id: 'old', username: 'old-account' } }))
    })
    expect(screen.queryByText('old-account')).not.toBeInTheDocument()
    expect(screen.getByText('new-account')).toBeInTheDocument()
  } finally {
    hook.unmount()
    await act(async () => { hook.pending.forEach(request => request.resolve(Response.json(product))) })
  }
})

test('browser-hidden sidebars defer initial and configuration display reads until foreground', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const hook = setup('retained', true)
  try {
    await act(async () => { window.dispatchEvent(new Event('kcoder:servers-changed')) })
    expect(hook.fetcher).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(await screen.findByText('current-account')).toBeInTheDocument()
    expect(hook.fetcher).toHaveBeenCalledTimes(2)
    visibility.mockReturnValue('hidden')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { window.dispatchEvent(new Event('kcoder:servers-changed')) })
    expect(hook.fetcher).toHaveBeenCalledTimes(2)
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(hook.fetcher).toHaveBeenCalledTimes(3))
    for (const state of ['hidden', 'visible'] as const) {
      visibility.mockReturnValue(state)
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    }
    expect(hook.fetcher).toHaveBeenCalledTimes(3)
  } finally { hook.unmount(); visibility.mockRestore() }
})
