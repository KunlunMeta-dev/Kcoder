import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import { GatewayRpcError } from '@/kcoder/gatewayRpc'
import { hookTargetScope } from '@/kcoder/gatewayHookConfiguration'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import { requestLocalExecutor } from '@/host/localExecutor'
import { ExecutionDefaultsSettingsPage } from './ExecutionDefaultsSettingsPage'
import '@/i18n'

vi.mock('@/kcoder/gatewayRpc', async original => {
  const actual = await original<typeof import('@/kcoder/gatewayRpc')>()
  return { ...actual, fetchGatewayServers: vi.fn() }
})

vi.mock('@/host/localExecutor', async original => {
  const actual = await original<typeof import('@/host/localExecutor')>()
  return { ...actual, requestLocalExecutor: vi.fn() }
})

const servers = [
  {
    id: 'target-a',
    label: 'Target A',
    description: 'A',
    runtime: 'kcoder' as const,
    transport: 'local' as const,
  },
  {
    id: 'target-b',
    label: 'Target B',
    description: 'B',
    runtime: 'kcoder' as const,
    transport: 'ssh' as const,
  },
]

function gatewayMarker() {
  const marker = document.createElement('meta')
  marker.name = 'kcoder-rpc-token'
  marker.content = 'execution-settings-test'
  document.head.append(marker)
  return marker
}

function workbenchValue(): WorkbenchContextValue {
  return {
    state: {
      currentRuntimeTask: { deviceId: 'target-a', taskId: 'existing-task' },
      currentProject: null,
      runtimeWork: null,
      selectedDeviceWorkspaceId: null,
      standaloneDeviceId: null,
      standaloneWorkspacePath: null,
    },
  } as WorkbenchContextValue
}

function renderPage(value = workbenchValue()) {
  return render(
    <WorkbenchContext.Provider value={value}>
      <ExecutionDefaultsSettingsPage />
    </WorkbenchContext.Provider>
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const defaults = (persistedPermissionMode: 'ask' | 'accept_edits' | 'bypass') => ({
  persistedPermissionMode,
  effectivePermissionMode: persistedPermissionMode,
  cliPermissionModeOverride: null,
})

describe('ExecutionDefaultsSettingsPage', () => {
  let marker: HTMLMetaElement

  beforeEach(() => {
    marker = gatewayMarker()
    vi.mocked(fetchGatewayServers).mockClear()
    vi.mocked(fetchGatewayServers).mockResolvedValue(servers)
    vi.mocked(requestLocalExecutor).mockReset()
  })

  afterEach(() => marker.remove())

  test('late target A reads cannot replace target B settings', async () => {
    const user = userEvent.setup()
    const defaultsByTarget = {
      'target-a': deferred<ReturnType<typeof defaults>>(),
      'target-b': deferred<ReturnType<typeof defaults>>(),
    }
    vi.mocked(requestLocalExecutor).mockImplementation((method, params) => {
      expect(method).toBe('runtime.settings.request')
      return defaultsByTarget[params.serverId as keyof typeof defaultsByTarget].promise
    })

    renderPage()
    const targetSelect = screen.getByTestId('execution-settings-target-select')
    await waitFor(() =>
      expect(targetSelect.querySelector('option[value="target-a"]')).not.toBeNull()
    )
    await user.selectOptions(targetSelect, 'target-a')
    await waitFor(() =>
      expect(requestLocalExecutor).toHaveBeenCalledWith(
        'runtime.settings.request',
        expect.objectContaining({
          serverId: 'target-a',
          method: 'settings/execution-defaults/read',
        })
      )
    )

    await user.selectOptions(targetSelect, 'target-b')
    await waitFor(() =>
      expect(requestLocalExecutor).toHaveBeenCalledWith(
        'runtime.settings.request',
        expect.objectContaining({
          serverId: 'target-b',
          method: 'settings/execution-defaults/read',
        })
      )
    )

    defaultsByTarget['target-b'].resolve(defaults('accept_edits'))
    await waitFor(() =>
      expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('accept_edits')
    )
    expect(screen.queryByTestId('target-custom-instructions')).toBeNull()

    defaultsByTarget['target-a'].resolve(defaults('bypass'))
    await waitFor(() =>
      expect(screen.getByTestId('execution-settings-current-target')).toHaveTextContent('Target A')
    )
    expect(screen.getByTestId('execution-settings-target-select')).toHaveValue('target-b')
    expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('accept_edits')
  })

  test('late target A saves stay on A after switching, and do not change an existing session permission', async () => {
    const user = userEvent.setup()
    const saveDefaultsA = deferred<ReturnType<typeof defaults>>()
    vi.mocked(requestLocalExecutor).mockImplementation((method, params) => {
      expect(method).toBe('runtime.settings.request')
      if ((params as { method?: string }).method === 'settings/execution-defaults/save') {
        return saveDefaultsA.promise
      }
      return Promise.resolve(defaults(params.serverId === 'target-a' ? 'ask' : 'accept_edits'))
    })

    const context = workbenchValue()
    const existingTask = context.state.currentRuntimeTask
    renderPage(context)
    const targetSelect = screen.getByTestId('execution-settings-target-select')
    await waitFor(() =>
      expect(targetSelect.querySelector('option[value="target-a"]')).not.toBeNull()
    )
    await user.selectOptions(targetSelect, 'target-a')
    await waitFor(() =>
      expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('ask')
    )

    fireEvent.change(screen.getByTestId('execution-default-permission-select'), {
      target: { value: 'bypass' },
    })
    fireEvent.click(screen.getByTestId('execution-default-permission-save'))
    await waitFor(() =>
      expect(requestLocalExecutor).toHaveBeenCalledWith(
        'runtime.settings.request',
        expect.objectContaining({
          serverId: 'target-a',
          method: 'settings/execution-defaults/save',
          params: { permissionMode: 'bypass' },
        })
      )
    )

    await user.selectOptions(targetSelect, 'target-b')
    await waitFor(() =>
      expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('accept_edits')
    )
    saveDefaultsA.resolve(defaults('bypass'))

    await waitFor(() =>
      expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('accept_edits')
    )
    expect(context.state.currentRuntimeTask).toBe(existingTask)
    expect(context.state.currentRuntimeTask).toEqual({
      deviceId: 'target-a',
      taskId: 'existing-task',
    })
    expect(requestLocalExecutor).not.toHaveBeenCalledWith(
      expect.stringMatching(/task|thread|permission/i),
      expect.anything()
    )
  })

  test('shows an explicit unsupported explanation on a non-Gateway host', () => {
    marker.remove()
    renderPage()
    expect(screen.getByTestId('execution-defaults-unsupported-page')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/Codex/)
    expect(fetchGatewayServers).not.toHaveBeenCalled()
  })

  test('shows target upgrade guidance when execution defaults capability is unsupported', async () => {
    const user = userEvent.setup()
    const unsupported = new GatewayRpcError(
      'Target requires execution default settings support',
      -32000,
      { kind: 'execution_defaults_unsupported', capability: 'executionDefaultsV1' }
    )
    vi.mocked(requestLocalExecutor).mockRejectedValue(unsupported)

    renderPage()
    const targetSelect = screen.getByTestId('execution-settings-target-select')
    await waitFor(() =>
      expect(targetSelect.querySelector('option[value="target-a"]')).not.toBeNull()
    )
    await user.selectOptions(targetSelect, 'target-a')

    const permissionSection = await screen.findByTestId('execution-permission-defaults')
    await within(permissionSection).findByRole('alert')
    expect(within(permissionSection).getByRole('alert')).toHaveTextContent(/KCoder/)
  })

  test('reads permission defaults after an unknown write and requires an explicit retry when the value differs', async () => {
    const user = userEvent.setup()
    let permissionReads = 0
    let permissionWrites = 0
    vi.mocked(requestLocalExecutor).mockImplementation((method, params) => {
      if (method === 'runtime.settings.request') {
        if (params.method === 'settings/execution-defaults/read') {
          permissionReads += 1
          return Promise.resolve(defaults('ask'))
        }
        permissionWrites += 1
        if (permissionWrites === 1) {
          return Promise.reject(
            new GatewayRpcError(
              'Gateway request timed out',
              -1,
              undefined,
              'runtime-session',
              'timeout'
            )
          )
        }
        return Promise.resolve(defaults('bypass'))
      }
      return Promise.resolve(undefined)
    })

    renderPage()
    const targetSelect = screen.getByTestId('execution-settings-target-select')
    await waitFor(() =>
      expect(targetSelect.querySelector('option[value="target-a"]')).not.toBeNull()
    )
    await user.selectOptions(targetSelect, 'target-a')
    const initialModeSelect = await screen.findByTestId('execution-default-permission-select')
    await waitFor(() => expect(initialModeSelect).toHaveValue('ask'))

    fireEvent.change(initialModeSelect, { target: { value: 'bypass' } })
    const initialSaveButton = screen.getByTestId('execution-default-permission-save')
    fireEvent.click(initialSaveButton)
    fireEvent.click(initialSaveButton)

    await screen.findByTestId('execution-defaults-reconciled')
    expect(permissionWrites).toBe(1)
    expect(permissionReads).toBe(2)
    expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('bypass')
    const saveButton = screen.getByTestId('execution-default-permission-save')
    expect(saveButton).not.toBeDisabled()

    fireEvent.click(saveButton)
    await screen.findByTestId('execution-defaults-saved')
    expect(permissionWrites).toBe(2)
  })

  test('restores the target A permission draft and unknown write after read failure and switching away and back', async () => {
    const user = userEvent.setup()
    const permissionReads = new Map<string, number>()
    let permissionWrites = 0
    const disconnected = () =>
      new GatewayRpcError('Gateway disconnected', -1, undefined, 'runtime-session', 'connection')
    const timedOut = () =>
      new GatewayRpcError('Gateway request timed out', -1, undefined, 'runtime-session', 'timeout')

    vi.mocked(requestLocalExecutor).mockImplementation((method, params) => {
      if (method === 'runtime.settings.request') {
        const serverId = params.serverId as string
        if (params.method === 'settings/execution-defaults/read') {
          const reads = (permissionReads.get(serverId) ?? 0) + 1
          permissionReads.set(serverId, reads)
          if (serverId === 'target-a' && reads === 2) return Promise.reject(disconnected())
          if (serverId === 'target-a' && reads >= 3) return Promise.resolve(defaults('bypass'))
          return Promise.resolve(defaults(serverId === 'target-a' ? 'ask' : 'accept_edits'))
        }
        permissionWrites += 1
        return Promise.reject(timedOut())
      }
      throw new Error('Unexpected request: ' + method)
    })

    renderPage()
    const targetSelect = screen.getByTestId('execution-settings-target-select')
    await waitFor(() =>
      expect(targetSelect.querySelector('option[value="target-a"]')).not.toBeNull()
    )
    await user.selectOptions(targetSelect, 'target-a')

    const permissionSelect = await screen.findByTestId('execution-default-permission-select')
    await waitFor(() => {
      expect(permissionSelect).toHaveValue('ask')
    })

    fireEvent.change(permissionSelect, { target: { value: 'bypass' } })
    fireEvent.click(screen.getByTestId('execution-default-permission-save'))

    await screen.findByTestId('execution-defaults-outcome-unknown')
    expect(permissionWrites).toBe(1)

    await user.selectOptions(targetSelect, 'target-b')
    await waitFor(() => {
      expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('accept_edits')
    })

    await user.selectOptions(targetSelect, 'target-a')
    await screen.findByTestId('execution-defaults-saved')
    expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('bypass')
    expect(permissionReads.get('target-a')).toBe(3)
    expect(permissionWrites).toBe(1)
  })
  test.each(['success', 'unknown'])(
    'keeps in-flight writes locked through A/B/A and observes late %s before fresh reads',
    async outcome => {
      const user = userEvent.setup()
      const permissionWrite = deferred<ReturnType<typeof defaults>>()
      let permissionReads = 0
      let permissionWrites = 0
      vi.mocked(requestLocalExecutor).mockImplementation((method, params) => {
        if (method === 'runtime.settings.request') {
          if (params.method === 'settings/execution-defaults/save') {
            permissionWrites += 1
            return permissionWrite.promise
          }
          if (params.serverId === 'target-b') return Promise.resolve(defaults('accept_edits'))
          permissionReads += 1
          return Promise.resolve(defaults(permissionReads === 1 ? 'ask' : 'accept_edits'))
        }
        throw new Error('Unexpected request: ' + method)
      })
      renderPage()
      const targetSelect = screen.getByTestId('execution-settings-target-select')
      await waitFor(() =>
        expect(targetSelect.querySelector('option[value="target-a"]')).not.toBeNull()
      )
      await user.selectOptions(targetSelect, 'target-a')
      await waitFor(() =>
        expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('ask')
      )
      fireEvent.change(screen.getByTestId('execution-default-permission-select'), {
        target: { value: 'bypass' },
      })
      fireEvent.click(screen.getByTestId('execution-default-permission-save'))
      await user.selectOptions(targetSelect, 'target-b')
      await waitFor(() =>
        expect(screen.getByTestId('execution-default-permission-select')).toHaveValue(
          'accept_edits'
        )
      )
      await user.selectOptions(targetSelect, 'target-a')
      await waitFor(() => {
        expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('bypass')
      })
      expect(screen.getByTestId('execution-default-permission-save')).toBeDisabled()
      expect(permissionReads).toBe(1)
      if (outcome === 'success') {
        permissionWrite.resolve(defaults('bypass'))
      } else {
        const unknown = new GatewayRpcError(
          'Gateway disconnected',
          -1,
          undefined,
          'runtime-session',
          'connection'
        )
        permissionWrite.reject(unknown)
      }
      await waitFor(() => {
        expect(permissionReads).toBe(2)
      })
      if (outcome === 'success') {
        await waitFor(() => {
          expect(screen.getByTestId('execution-default-permission-select')).toHaveValue(
            'accept_edits'
          )
        })
        expect(screen.getByTestId('execution-default-permission-save')).toBeDisabled()
      } else {
        await screen.findByTestId('execution-defaults-reconciled')
        expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('bypass')
      }
      expect(permissionWrites).toBe(1)
    }
  )
  test('clears old mismatch notices when fresh target values equal retained drafts', async () => {
    const user = userEvent.setup()
    let savedMode: 'ask' | 'bypass' = 'ask'
    vi.mocked(requestLocalExecutor).mockImplementation((method, params) => {
      if (method === 'runtime.settings.request') {
        if (params.method === 'settings/execution-defaults/save')
          return Promise.reject(new Error('lost receipt'))
        return Promise.resolve(defaults(savedMode))
      }
      throw new Error('Unexpected request: ' + method)
    })
    renderPage()
    const targetSelect = screen.getByTestId('execution-settings-target-select')
    await waitFor(() =>
      expect(targetSelect.querySelector('option[value="target-a"]')).not.toBeNull()
    )
    await user.selectOptions(targetSelect, 'target-a')
    await waitFor(() =>
      expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('ask')
    )
    fireEvent.change(screen.getByTestId('execution-default-permission-select'), {
      target: { value: 'bypass' },
    })
    fireEvent.click(screen.getByTestId('execution-default-permission-save'))
    await screen.findByTestId('execution-defaults-reconciled')
    await user.selectOptions(targetSelect, 'target-b')
    await waitFor(() =>
      expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('ask')
    )
    savedMode = 'bypass'
    await user.selectOptions(targetSelect, 'target-a')
    await waitFor(() => {
      expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('bypass')
      expect(screen.queryByTestId('execution-defaults-reconciled')).toBeNull()
    })
    expect(screen.getByTestId('execution-default-permission-save')).toBeDisabled()
  })

  test.each(['account', 'profile'] as const)('same-ID %s changes isolate drafts and restore them only to their original owner', async boundary => {
    let owner = 'a'
    vi.mocked(fetchGatewayServers).mockImplementation(async () => [{
      ...servers[0],
      profile: boundary === 'profile' ? owner : 'default',
      accountIdentity: { principalId: boundary === 'account' ? owner : 'same-account', username: 'fixture', role: 'user' },
    }])
    vi.mocked(requestLocalExecutor).mockImplementation(async (_method, params) => {
      expect(params.method).toBe('settings/execution-defaults/read')
      expect(params.targetScope).toBe(hookTargetScope({
        ...servers[0], profile: boundary === 'profile' ? owner : 'default',
        accountIdentity: { principalId: boundary === 'account' ? owner : 'same-account', username: 'fixture', role: 'user' },
      }))
      return defaults(owner === 'a' ? 'ask' : 'accept_edits')
    })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('ask'))
    fireEvent.change(screen.getByTestId('execution-default-permission-select'), { target: { value: 'bypass' } })
    const changeOwner = async (next: string) => {
      await act(async () => {
        owner = next
        if (boundary === 'account') notifyAccountContextChange('target-a')
        else window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: 'target-a' } }))
      })
    }
    await changeOwner('b')
    await waitFor(() => expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('accept_edits'))
    expect(screen.getByTestId('execution-default-permission-save')).toBeDisabled()
    await changeOwner('a')
    await waitFor(() => expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('bypass'))
    expect(screen.getByTestId('execution-default-permission-save')).not.toBeDisabled()
    expect(requestLocalExecutor).toHaveBeenCalledTimes(3)
  })

  test.each(['success', 'unknown'] as const)('same-ID account writes keep their own late %s and never settle the replacement account', async outcome => {
    let owner: 'a' | 'b' = 'a'
    let writes = 0
    const reads = { a: 0, b: 0 }
    const readModes = { a: ['ask', 'bypass'], b: ['accept_edits', 'ask'] } as const
    const firstWrite = deferred<ReturnType<typeof defaults>>()
    const secondWrite = deferred<ReturnType<typeof defaults>>()
    vi.mocked(fetchGatewayServers).mockImplementation(async () => [{
      ...servers[0], accountIdentity: { principalId: owner, username: 'fixture', role: 'user' },
    }])
    vi.mocked(requestLocalExecutor).mockImplementation((_method, params) => {
      expect(params.targetScope).toBe(hookTargetScope({
        ...servers[0], accountIdentity: { principalId: owner, username: 'fixture', role: 'user' },
      }))
      if (params.method === 'settings/execution-defaults/save') {
        writes++
        return owner === 'a' ? firstWrite.promise : secondWrite.promise
      }
      expect(params.method).toBe('settings/execution-defaults/read')
      const attempt = ++reads[owner]
      return Promise.resolve(defaults(readModes[owner][attempt === 1 ? 0 : 1]))
    })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('ask'))
    fireEvent.change(screen.getByTestId('execution-default-permission-select'), { target: { value: 'bypass' } })
    fireEvent.click(screen.getByTestId('execution-default-permission-save'))
    await waitFor(() => expect(writes).toBe(1))
    const changeOwner = async (next: 'a' | 'b') => {
      await act(async () => { owner = next; notifyAccountContextChange('target-a') })
    }
    await changeOwner('b')
    await waitFor(() => expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('accept_edits'))
    fireEvent.change(screen.getByTestId('execution-default-permission-select'), { target: { value: 'ask' } })
    fireEvent.click(screen.getByTestId('execution-default-permission-save'))
    await waitFor(() => expect(writes).toBe(2))
    await act(async () => {
      if (outcome === 'success') firstWrite.resolve(defaults('bypass'))
      else firstWrite.reject(new GatewayRpcError('Lost original receipt', -1, undefined, 'runtime-session', 'connection'))
    })
    expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('ask')
    expect(screen.getByTestId('execution-default-permission-save')).toBeDisabled()
    expect(screen.queryByTestId('execution-defaults-saved')).toBeNull()
    expect(screen.queryByTestId('execution-defaults-outcome-unknown')).toBeNull()
    expect(reads.b).toBe(1)
    await changeOwner('a')
    await waitFor(() => expect(reads.a).toBe(2))
    await waitFor(() => expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('bypass'))
    await changeOwner('b')
    await waitFor(() => expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('ask'))
    expect(reads.b).toBe(1)
    await act(async () => { secondWrite.resolve(defaults('ask')) })
    await waitFor(() => expect(reads.b).toBe(2))
    await waitFor(() => expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('ask'))
    expect(writes).toBe(2)
  })
})
