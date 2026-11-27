import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createLocalAppServices } from './local/localServices'
import { registerRuntimeTransport } from '@/lib/runtime-transport'
import { loadProjectEnvironment, pushProjectChanges } from './environment'

let ordinal = 0
const stops: (() => void)[] = []
let meta: HTMLMetaElement
let overrides: typeof window.__KCODER_STUDIO_RUNTIME_CONFIG__
beforeEach(() => {
  overrides = window.__KCODER_STUDIO_RUNTIME_CONFIG__
  meta = document.createElement('meta')
  meta.name = 'kcoder-rpc-token'
  meta.content = 'owned-fixture'
  document.head.append(meta)
})
afterEach(() => {
  while (stops.length) stops.pop()?.()
  meta.remove()
  vi.restoreAllMocks()
  localStorage.clear()
  if (overrides === undefined) delete window.__KCODER_STUDIO_RUNTIME_CONFIG__
  else window.__KCODER_STUDIO_RUNTIME_CONFIG__ = overrides
})
const summary = {
  additions: 1,
  deletions: 0,
  fileCount: 1,
  binaryFiles: 0,
  comparison: { kind: 'head', reference: 'HEAD', commit: 'a'.repeat(40) },
}
function fixture(kind: 'device' | 'executor' = 'device') {
  const deviceId = `owned-source-${++ordinal}`
  vi.spyOn(globalThis, 'fetch').mockImplementation(async request =>
    Response.json(
      String(request).endsWith('/api/servers/status')
        ? { statuses: [{ id: deviceId, status: 'online' }] }
        : {
            servers: [
              {
                id: deviceId,
                label: 'Owned source',
                transport: 'local',
                workspacePath: '/workspace',
              },
            ],
          }
    )
  )
  const commands: Record<string, string[]> = {}
  const install = (
    name: string,
    gate?: { command: string; wait: Promise<void>; failed?: boolean }
  ) => {
    commands[name] = []
    const stop = registerRuntimeTransport(async (command, raw) => {
      if (command === 'local_executor_ensure_started')
        return { ready: true, running: true, deviceId }
      const args = raw as { method: string; params: { command_key: string } }
      if (command !== 'local_executor_request' || args.method !== 'device.execute_command')
        throw new Error('unexpected owned command')
      const key = args.params.command_key
      commands[name].push(key)
      if (gate?.command === key) await gate.wait
      return {
        success: !(gate?.failed && gate.command === key),
        stderr: '',
        stdout:
          key === 'project_workspace_root'
            ? '/workspace'
            : key === 'git_branch'
              ? name
              : key === 'git_branch_diff_shortstat'
                ? summary
                : '',
      }
    })
    stops.push(stop)
    return stop
  }
  const services = createLocalAppServices()
  const api = kind === 'device' ? services.deviceApi : services.executorClient!.commands
  return { api, deviceId, target: { deviceId, path: '/workspace' }, commands, install }
}

test.each(['device', 'executor'] as const)(
  'a cached %s observation cannot survive replacement of its actual Runtime',
  async kind => {
    const f = fixture(kind),
      stop = f.install('original')
    expect(await loadProjectEnvironment(f.api, null, f.target)).toMatchObject({
      branchName: 'original',
    })
    stop()
    f.install('replacement')
    expect(await loadProjectEnvironment(f.api, null, f.target)).toMatchObject({
      branchName: 'replacement',
    })
    expect(f.commands.replacement).toHaveLength(3)
  }
)

test.each(['device', 'executor'] as const)(
  'a %s path reply cannot dispatch the old observation into a new Runtime',
  async kind => {
    const f = fixture(kind)
    let finish!: () => void
    const stop = f.install('original', {
      command: 'project_workspace_root',
      wait: new Promise<void>(resolve => {
        finish = resolve
      }),
    })
    const old = loadProjectEnvironment(f.api, {
      id: 9,
      name: 'owned source',
      config: {
        execution: { deviceId: f.deviceId },
        workspace: { source: 'git', checkoutPath: 'repo' },
      },
    }).then(
      value => value,
      error => error
    )
    try {
      await vi.waitFor(() => expect(f.commands.original).toContain('project_workspace_root'))
      stop()
      f.install('replacement')
      finish()
      expect(await old).toMatchObject({ name: 'AbortError' })
      expect(f.commands.replacement).toEqual([])
    } finally {
      finish()
      await old
    }
  }
)

test.each([false, true])(
  'late old success/failure failed=%s cannot wait, publish or erase a replacement observation',
  async failed => {
    const f = fixture()
    let finish!: () => void
    const stop = f.install('original', {
      command: 'git_branch',
      failed,
      wait: new Promise<void>(resolve => {
        finish = resolve
      }),
    })
    const old = loadProjectEnvironment(f.api, null, f.target).then(
      value => value,
      error => error
    )
    await vi.waitFor(() => expect(f.commands.original).toContain('git_branch'))
    stop()
    f.install('replacement')
    const fresh = loadProjectEnvironment(f.api, null, f.target)
    try {
      await vi.waitFor(() => expect(f.commands.replacement).toHaveLength(3))
      expect(await fresh).toMatchObject({ branchName: 'replacement' })
      finish()
      expect(await old).toMatchObject({ name: 'AbortError' })
      await loadProjectEnvironment(f.api, null, f.target)
      expect(f.commands.replacement).toHaveLength(3)
    } finally {
      finish()
      await Promise.allSettled([old, fresh])
    }
  }
)

test('a changed Gateway mount retires cached facts even if the command transport remains registered', async () => {
  const f = fixture(),
    stop = f.install('original')
  await loadProjectEnvironment(f.api, null, f.target)
  window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { ...overrides, appBasePath: '/replacement-mount' }
  const before = f.commands.original.length
  await loadProjectEnvironment(f.api, null, f.target)
  expect(f.commands.original.length - before).toBe(3)
  stop()
})

test('an independent command API is not coupled to an unrelated Native transport', async () => {
  const f = fixture(),
    stop = f.install('original')
  const executeCommand = vi.fn(async (_deviceId: string, data: { command_key: string }) => ({
    success: true,
    stderr: '',
    stdout:
      data.command_key === 'git_branch'
        ? 'independent'
        : data.command_key === 'git_branch_diff_shortstat'
          ? summary
          : '',
  }))
  const api = { executeCommand }
  await loadProjectEnvironment(api, null, f.target)
  stop()
  f.install('replacement')
  expect(await loadProjectEnvironment(api, null, f.target)).toMatchObject({
    branchName: 'independent',
  })
  expect(executeCommand).toHaveBeenCalledTimes(3)
})

test('a directory reply cannot publish an old preflight status after source replacement', async () => {
  const f = fixture(),
    stop = f.install('original')
  let finish!: (response: Response) => void
  const directory = new Promise<Response>(resolve => {
    finish = resolve
  })
  vi.mocked(fetch).mockReturnValueOnce(directory)
  const services = createLocalAppServices({
    ensure: async () => ({ ready: true, running: true, deviceId: f.deviceId }),
  })
  const old = services.deviceApi.listDevices({ health: 'selected' }).then(
    value => value,
    error => error
  )
  stop()
  f.install('replacement')
  finish(
    Response.json({ servers: [{ id: f.deviceId, label: 'Old metadata', transport: 'local' }] })
  )
  expect(await old).toMatchObject({ name: 'AbortError' })
})

test('a settled old write keeps its receipt but cannot retire the new source Git cache', async () => {
  const f = fixture()
  let finish!: () => void
  const stop = f.install('original', {
    command: 'git_push',
    wait: new Promise<void>(resolve => {
      finish = resolve
    }),
  })
  const write = pushProjectChanges(f.api, null, f.target)
  try {
    await vi.waitFor(() => expect(f.commands.original).toContain('git_push'))
    stop()
    f.install('replacement')
    await loadProjectEnvironment(f.api, null, f.target)
    finish()
    await expect(write).resolves.toBeUndefined()
    await loadProjectEnvironment(f.api, null, f.target)
    expect(f.commands.replacement).toHaveLength(3)
    expect(f.commands.original.filter(key => key === 'git_push')).toHaveLength(1)
  } finally {
    finish()
    await write
  }
})

test('the Native adapter retires its warm registry and discovers the replacement only once', async () => {
  const f = fixture()
  const services = createLocalAppServices()
  const executor = services.executorClient!
  const stop = f.install('original')
  await executor.commands.listDevices()
  expect(executor.registry.list()).toHaveLength(1)
  stop()
  f.install('replacement')
  expect(executor.registry.list()).toEqual([])
  const response = await executor.commands.executeCommand(f.deviceId, { command_key: 'git_branch' })
  expect(response.stdout).toBe('replacement')
  const discovered = vi.mocked(fetch).mock.calls.length
  await executor.commands.executeCommand(f.deviceId, { command_key: 'git_branch' })
  expect(vi.mocked(fetch).mock.calls).toHaveLength(discovered)
  expect(f.commands.replacement).toEqual(['git_branch', 'git_branch'])
})
