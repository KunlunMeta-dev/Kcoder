import { afterEach, expect, test, vi } from 'vitest'
import { installLocalWorkspaceOpenListener } from './localWorkspaceOpen'

let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost })
function hostFixture(take = vi.fn(async () => [] as Array<{ id: string; serverId?: string; path?: string; error?: string }>)) {
  let notify = () => {}
  const ack = vi.fn(async () => undefined), off = vi.fn()
  const host = { takeWorkspaceOpenRequests: take, acknowledgeWorkspaceOpen: ack,
    onWorkspaceOpen: (callback: () => void) => { notify = callback; return off } }
  Object.assign(window, { kcoderDesktopHost: host })
  return { take, ack, off, notify: () => notify() }
}

test('ordinary web and remote thin clients never claim local CLI delivery', () => {
  expect(installLocalWorkspaceOpenListener(vi.fn())).toBeNull()
})

test('startup intents use the verified target rather than a local-device alias', async () => {
  const f = hostFixture(vi.fn(async () => [{ id: 'initial', serverId: 'native-a', path: '/project' }]))
  const open = vi.fn(async () => undefined)
  dispose = await installLocalWorkspaceOpenListener(open)!
  await vi.waitFor(() => expect(f.ack).toHaveBeenCalledWith('initial'))
  expect(open).toHaveBeenCalledWith('native-a', '/project', undefined)
})

test('notifications during a pending read are coalesced without duplicate workspace opens', async () => {
  let release!: (value: Array<{ id: string; serverId: string; path: string }>) => void
  const take = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve })).mockResolvedValue([])
  const f = hostFixture(take), open = vi.fn(async () => undefined)
  dispose = await installLocalWorkspaceOpenListener(open)!
  f.notify(); f.notify()
  release([{ id: 'held', serverId: 'native-a', path: '/project' }])
  await vi.waitFor(() => expect(take).toHaveBeenCalledTimes(2))
  expect(open).toHaveBeenCalledTimes(1); expect(f.ack).toHaveBeenCalledTimes(1)
})

test('teardown during a pending read cannot deliver or acknowledge an old view intent', async () => {
  let release!: (value: Array<{ id: string; serverId: string; path: string }>) => void
  const f = hostFixture(vi.fn(() => new Promise(resolve => { release = resolve }))), open = vi.fn()
  dispose = await installLocalWorkspaceOpenListener(open)!
  dispose(); release([{ id: 'old', serverId: 'native-a', path: '/project' }]); await Promise.resolve()
  expect(open).not.toHaveBeenCalled(); expect(f.ack).not.toHaveBeenCalled(); expect(f.off).toHaveBeenCalledOnce()
  dispose = undefined
})

test('a preparation failure is reported and acknowledged without blocking later valid workspaces', async () => {
  const f = hostFixture(vi.fn(async () => [{ id: 'bad', error: 'Ambiguous local target' }, { id: 'valid', serverId: 'native-b', path: '/project' }]))
  const open = vi.fn(async () => undefined), error = vi.fn()
  dispose = await installLocalWorkspaceOpenListener(open, error)!
  await vi.waitFor(() => expect(f.ack).toHaveBeenCalledTimes(2))
  expect(error).toHaveBeenCalledWith('Ambiguous local target'); expect(open).toHaveBeenCalledTimes(1)
})

test('a failed workspace action is not acknowledged or blindly replayed', async () => {
  const f = hostFixture(vi.fn(async () => [{ id: 'unknown', serverId: 'native-a', path: '/project' }]))
  const error = vi.fn(), open = vi.fn(async () => { throw new Error('unknown outcome') })
  dispose = await installLocalWorkspaceOpenListener(open, error)!
  await vi.waitFor(() => expect(error).toHaveBeenCalledWith('unknown outcome'))
  f.notify(); await Promise.resolve(); await Promise.resolve()
  expect(open).toHaveBeenCalledTimes(1); expect(f.ack).not.toHaveBeenCalled()
})
