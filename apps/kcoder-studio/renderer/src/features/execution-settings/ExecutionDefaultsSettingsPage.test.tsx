import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import { GatewayRpcError } from '@/kcoder/gatewayRpc'
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
    const instructionsByTarget = {
      'target-a': deferred<{ instructions: string; configPath: string | null }>(),
      'target-b': deferred<{ instructions: string; configPath: string | null }>(),
    }
    vi.mocked(requestLocalExecutor).mockImplementation((method, params) => {
      if (method === 'runtime.settings.request') {
        const serverId = params.serverId as keyof typeof defaultsByTarget
        return defaultsByTarget[serverId].promise
      }
      const deviceId = params.deviceId as keyof typeof instructionsByTarget
      return instructionsByTarget[deviceId].promise
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
    instructionsByTarget['target-b'].resolve({
      instructions: 'Target B instructions',
      configPath: null,
    })
    await waitFor(() =>
      expect(screen.getByTestId('target-custom-instructions-editor')).toHaveValue(
        'Target B instructions'
      )
    )
    expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('accept_edits')

    defaultsByTarget['target-a'].resolve(defaults('bypass'))
    instructionsByTarget['target-a'].resolve({
      instructions: 'Target A instructions',
      configPath: null,
    })
    await waitFor(() =>
      expect(screen.getByTestId('execution-settings-current-target')).toHaveTextContent('Target A')
    )
    expect(screen.getByTestId('execution-settings-target-select')).toHaveValue('target-b')
    expect(screen.getByTestId('target-custom-instructions-editor')).toHaveValue(
      'Target B instructions'
    )
    expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('accept_edits')
  })

  test('late target A saves stay on A after switching, and do not change an existing session permission', async () => {
    const user = userEvent.setup()
    const saveDefaultsA = deferred<ReturnType<typeof defaults>>()
    const saveInstructionsA = deferred<{ instructions: string; configPath: string | null }>()
    vi.mocked(requestLocalExecutor).mockImplementation((method, params) => {
      if (method === 'runtime.settings.request') {
        if ((params as { method?: string }).method === 'settings/execution-defaults/save') {
          return saveDefaultsA.promise
        }
        return Promise.resolve(defaults(params.serverId === 'target-a' ? 'ask' : 'accept_edits'))
      }
      if (method === 'runtime.instructions.write') return saveInstructionsA.promise
      return Promise.resolve({
        instructions:
          params.deviceId === 'target-a' ? 'Target A original' : 'Target B instructions',
        configPath: null,
      })
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
      expect(screen.getByTestId('target-custom-instructions-editor')).toHaveValue(
        'Target A original'
      )
    )

    fireEvent.change(screen.getByTestId('execution-default-permission-select'), {
      target: { value: 'bypass' },
    })
    fireEvent.change(screen.getByTestId('target-custom-instructions-editor'), {
      target: { value: 'Updated A instructions' },
    })
    fireEvent.click(screen.getByTestId('execution-default-permission-save'))
    fireEvent.click(screen.getByTestId('target-custom-instructions-save'))
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
    expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.instructions.write', {
      deviceId: 'target-a',
      instructions: 'Updated A instructions',
    })

    await user.selectOptions(targetSelect, 'target-b')
    await waitFor(() =>
      expect(screen.getByTestId('target-custom-instructions-editor')).toHaveValue(
        'Target B instructions'
      )
    )
    saveDefaultsA.resolve(defaults('bypass'))
    saveInstructionsA.resolve({ instructions: 'Updated A instructions', configPath: null })

    await waitFor(() =>
      expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('accept_edits')
    )
    expect(screen.getByTestId('target-custom-instructions-editor')).toHaveValue(
      'Target B instructions'
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
    vi.mocked(requestLocalExecutor).mockImplementation(method => {
      if (method === 'runtime.settings.request') return Promise.reject(unsupported)
      return Promise.resolve({ instructions: 'Target instructions', configPath: null })
    })

    renderPage()
    const targetSelect = screen.getByTestId('execution-settings-target-select')
    await waitFor(() =>
      expect(targetSelect.querySelector('option[value="target-a"]')).not.toBeNull()
    )
    await user.selectOptions(targetSelect, 'target-a')

    const permissionSection = await screen.findByTestId('execution-permission-defaults')
    await within(permissionSection).findByRole('alert')
    expect(within(permissionSection).getByRole('alert')).toHaveTextContent(/KCoder/)
    expect(await screen.findByTestId('target-custom-instructions-editor')).toHaveValue(
      'Target instructions'
    )
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
      if (method === 'runtime.instructions.read') {
        return Promise.resolve({ instructions: 'Target A original', configPath: null })
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

  test('keeps a newer custom-instructions draft after read reconciliation and only retries reads while outcome is unknown', async () => {
    const user = userEvent.setup()
    let instructionReads = 0
    let instructionWrites = 0
    vi.mocked(requestLocalExecutor).mockImplementation(method => {
      if (method === 'runtime.settings.request') return Promise.resolve(defaults('ask'))
      if (method === 'runtime.instructions.read') {
        instructionReads += 1
        if (instructionReads === 1) {
          return Promise.resolve({ instructions: 'stored', configPath: null })
        }
        if (instructionReads === 2) {
          return Promise.reject(
            new GatewayRpcError(
              'Gateway disconnected',
              -1,
              undefined,
              'runtime-session',
              'connection'
            )
          )
        }
        return Promise.resolve({ instructions: 'first draft', configPath: null })
      }
      instructionWrites += 1
      if (instructionWrites === 1) {
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
      return Promise.resolve({ instructions: 'newer draft', configPath: null })
    })

    renderPage()
    const targetSelect = screen.getByTestId('execution-settings-target-select')
    await waitFor(() =>
      expect(targetSelect.querySelector('option[value="target-a"]')).not.toBeNull()
    )
    await user.selectOptions(targetSelect, 'target-a')
    const initialEditor = await screen.findByTestId('target-custom-instructions-editor')
    await waitFor(() => expect(initialEditor).toHaveValue('stored'))

    fireEvent.change(initialEditor, { target: { value: 'first draft' } })
    const initialSaveButton = screen.getByTestId('target-custom-instructions-save')
    fireEvent.click(initialSaveButton)
    fireEvent.click(initialSaveButton)

    await screen.findByTestId('target-custom-instructions-outcome-unknown')
    await screen.findByTestId('target-custom-instructions-check-current')
    expect(instructionWrites).toBe(1)
    expect(screen.getByTestId('target-custom-instructions-save')).toBeDisabled()

    const reconciliationEditor = screen.getByTestId('target-custom-instructions-editor')
    fireEvent.change(reconciliationEditor, { target: { value: 'newer draft' } })
    fireEvent.click(screen.getByTestId('target-custom-instructions-check-current'))

    await screen.findByTestId('target-custom-instructions-saved-previous-draft')
    expect(instructionReads).toBe(3)
    expect(instructionWrites).toBe(1)
    expect(screen.getByTestId('target-custom-instructions-editor')).toHaveValue('newer draft')
    const saveButton = screen.getByTestId('target-custom-instructions-save')
    expect(saveButton).not.toBeDisabled()

    fireEvent.click(saveButton)
    await screen.findByTestId('target-custom-instructions-saved')
    expect(instructionWrites).toBe(2)
  })

  test('restores both target A drafts and unknown writes after read failure and switching away and back', async () => {
    const user = userEvent.setup()
    const permissionReads = new Map<string, number>()
    const instructionReads = new Map<string, number>()
    let permissionWrites = 0
    let instructionWrites = 0
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
      if (method === 'runtime.instructions.read') {
        const targetId = params.deviceId as string
        const reads = (instructionReads.get(targetId) ?? 0) + 1
        instructionReads.set(targetId, reads)
        if (targetId === 'target-a' && reads === 2) return Promise.reject(disconnected())
        return Promise.resolve({
          instructions: targetId === 'target-a' ? 'A stored value' : 'B stored value',
          configPath: null,
        })
      }
      instructionWrites += 1
      return Promise.reject(timedOut())
    })

    renderPage()
    const targetSelect = screen.getByTestId('execution-settings-target-select')
    await waitFor(() =>
      expect(targetSelect.querySelector('option[value="target-a"]')).not.toBeNull()
    )
    await user.selectOptions(targetSelect, 'target-a')

    const permissionSelect = await screen.findByTestId('execution-default-permission-select')
    const instructionsEditor = await screen.findByTestId('target-custom-instructions-editor')
    await waitFor(() => {
      expect(permissionSelect).toHaveValue('ask')
      expect(instructionsEditor).toHaveValue('A stored value')
    })

    fireEvent.change(permissionSelect, { target: { value: 'bypass' } })
    fireEvent.change(instructionsEditor, { target: { value: 'A pending draft' } })
    fireEvent.click(screen.getByTestId('execution-default-permission-save'))
    fireEvent.click(screen.getByTestId('target-custom-instructions-save'))

    await screen.findByTestId('execution-defaults-outcome-unknown')
    await screen.findByTestId('target-custom-instructions-outcome-unknown')
    expect(permissionWrites).toBe(1)
    expect(instructionWrites).toBe(1)

    await user.selectOptions(targetSelect, 'target-b')
    await waitFor(() => {
      expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('accept_edits')
      expect(screen.getByTestId('target-custom-instructions-editor')).toHaveValue('B stored value')
    })

    await user.selectOptions(targetSelect, 'target-a')
    await screen.findByTestId('execution-defaults-saved')
    await screen.findByTestId('target-custom-instructions-reconciled')
    expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('bypass')
    expect(screen.getByTestId('target-custom-instructions-editor')).toHaveValue('A pending draft')
    expect(permissionReads.get('target-a')).toBe(3)
    expect(instructionReads.get('target-a')).toBe(3)
    expect(permissionWrites).toBe(1)
    expect(instructionWrites).toBe(1)
  })
  test.each(['success', 'unknown'])(
    'keeps in-flight writes locked through A/B/A and observes late %s before fresh reads',
    async outcome => {
      const user = userEvent.setup()
      const permissionWrite = deferred<ReturnType<typeof defaults>>()
      const instructionsWrite = deferred<{ instructions: string; configPath: null }>()
      let permissionReads = 0
      let instructionReads = 0
      let permissionWrites = 0
      let instructionWrites = 0
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
        if (method === 'runtime.instructions.write') {
          instructionWrites += 1
          return instructionsWrite.promise
        }
        if (params.deviceId === 'target-b')
          return Promise.resolve({ instructions: 'B original', configPath: null })
        instructionReads += 1
        return Promise.resolve({
          instructions: instructionReads === 1 ? 'A original' : 'A latest external',
          configPath: null,
        })
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
      await waitFor(() =>
        expect(screen.getByTestId('target-custom-instructions-editor')).toHaveValue('A original')
      )
      fireEvent.change(screen.getByTestId('execution-default-permission-select'), {
        target: { value: 'bypass' },
      })
      fireEvent.change(screen.getByTestId('target-custom-instructions-editor'), {
        target: { value: 'A submitted' },
      })
      fireEvent.click(screen.getByTestId('execution-default-permission-save'))
      fireEvent.click(screen.getByTestId('target-custom-instructions-save'))
      await user.selectOptions(targetSelect, 'target-b')
      await waitFor(() =>
        expect(screen.getByTestId('target-custom-instructions-editor')).toHaveValue('B original')
      )
      await user.selectOptions(targetSelect, 'target-a')
      await waitFor(() => {
        expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('bypass')
        expect(screen.getByTestId('target-custom-instructions-editor')).toHaveValue('A submitted')
      })
      expect(screen.getByTestId('execution-default-permission-save')).toBeDisabled()
      expect(screen.getByTestId('target-custom-instructions-save')).toBeDisabled()
      expect(permissionReads).toBe(1)
      expect(instructionReads).toBe(1)
      if (outcome === 'success') {
        permissionWrite.resolve(defaults('bypass'))
        instructionsWrite.resolve({ instructions: 'A submitted', configPath: null })
      } else {
        const unknown = new GatewayRpcError(
          'Gateway disconnected',
          -1,
          undefined,
          'runtime-session',
          'connection'
        )
        permissionWrite.reject(unknown)
        instructionsWrite.reject(unknown)
      }
      await waitFor(() => {
        expect(permissionReads).toBe(2)
        expect(instructionReads).toBe(2)
      })
      if (outcome === 'success') {
        await waitFor(() => {
          expect(screen.getByTestId('execution-default-permission-select')).toHaveValue(
            'accept_edits'
          )
          expect(screen.getByTestId('target-custom-instructions-editor')).toHaveValue(
            'A latest external'
          )
        })
        expect(screen.getByTestId('execution-default-permission-save')).toBeDisabled()
        expect(screen.getByTestId('target-custom-instructions-save')).toBeDisabled()
      } else {
        await screen.findByTestId('execution-defaults-reconciled')
        await screen.findByTestId('target-custom-instructions-reconciled')
        expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('bypass')
        expect(screen.getByTestId('target-custom-instructions-editor')).toHaveValue('A submitted')
      }
      expect(permissionWrites).toBe(1)
      expect(instructionWrites).toBe(1)
    }
  )
  test('clears old mismatch notices when fresh target values equal retained drafts', async () => {
    const user = userEvent.setup()
    let savedMode: 'ask' | 'bypass' = 'ask'
    let savedInstructions = 'stored'
    vi.mocked(requestLocalExecutor).mockImplementation((method, params) => {
      if (method === 'runtime.settings.request') {
        if (params.method === 'settings/execution-defaults/save')
          return Promise.reject(new Error('lost receipt'))
        return Promise.resolve(defaults(savedMode))
      }
      if (method === 'runtime.instructions.write') return Promise.reject(new Error('lost receipt'))
      return Promise.resolve({ instructions: savedInstructions, configPath: null })
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
    await waitFor(() =>
      expect(screen.getByTestId('target-custom-instructions-editor')).toHaveValue('stored')
    )
    fireEvent.change(screen.getByTestId('execution-default-permission-select'), {
      target: { value: 'bypass' },
    })
    fireEvent.change(screen.getByTestId('target-custom-instructions-editor'), {
      target: { value: 'retained' },
    })
    fireEvent.click(screen.getByTestId('execution-default-permission-save'))
    fireEvent.click(screen.getByTestId('target-custom-instructions-save'))
    await screen.findByTestId('execution-defaults-reconciled')
    await screen.findByTestId('target-custom-instructions-reconciled')
    await user.selectOptions(targetSelect, 'target-b')
    await screen.findByTestId('target-custom-instructions-editor')
    savedMode = 'bypass'
    savedInstructions = 'retained'
    await user.selectOptions(targetSelect, 'target-a')
    await waitFor(() => {
      expect(screen.getByTestId('execution-default-permission-select')).toHaveValue('bypass')
      expect(screen.getByTestId('target-custom-instructions-editor')).toHaveValue('retained')
      expect(screen.queryByTestId('execution-defaults-reconciled')).toBeNull()
      expect(screen.queryByTestId('target-custom-instructions-reconciled')).toBeNull()
    })
    expect(screen.getByTestId('execution-default-permission-save')).toBeDisabled()
    expect(screen.getByTestId('target-custom-instructions-save')).toBeDisabled()
  })

  test('does not claim a mismatch when readback equals the newer custom instruction draft', async () => {
    const user = userEvent.setup()
    let reads = 0
    vi.mocked(requestLocalExecutor).mockImplementation(method => {
      if (method === 'runtime.settings.request') return Promise.resolve(defaults('ask'))
      if (method === 'runtime.instructions.write') return Promise.reject(new Error('lost receipt'))
      reads += 1
      if (reads === 2) return Promise.reject(new Error('read unavailable'))
      return Promise.resolve({ instructions: reads === 1 ? 'stored' : 'newer', configPath: null })
    })
    renderPage()
    const targetSelect = screen.getByTestId('execution-settings-target-select')
    await waitFor(() =>
      expect(targetSelect.querySelector('option[value="target-a"]')).not.toBeNull()
    )
    await user.selectOptions(targetSelect, 'target-a')
    await waitFor(() =>
      expect(screen.getByTestId('target-custom-instructions-editor')).toHaveValue('stored')
    )
    fireEvent.change(screen.getByTestId('target-custom-instructions-editor'), {
      target: { value: 'submitted' },
    })
    fireEvent.click(screen.getByTestId('target-custom-instructions-save'))
    await screen.findByTestId('target-custom-instructions-check-current')
    fireEvent.change(screen.getByTestId('target-custom-instructions-editor'), {
      target: { value: 'newer' },
    })
    fireEvent.click(screen.getByTestId('target-custom-instructions-check-current'))
    await waitFor(() => {
      expect(screen.queryByTestId('target-custom-instructions-outcome-unknown')).toBeNull()
      expect(screen.queryByTestId('target-custom-instructions-reconciled')).toBeNull()
    })
    expect(screen.getByTestId('target-custom-instructions-editor')).toHaveValue('newer')
    expect(screen.getByTestId('target-custom-instructions-save')).toBeDisabled()
  })
})
