import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { LocalProjectCreateDialog } from './LocalProjectCreateDialog'

const pickerMocks = vi.hoisted(() => ({ open: vi.fn() }))
const automationMocks = vi.hoisted(() => ({ useNativePicker: true }))

vi.mock('@/e2e/automation', () => ({
  shouldUseNativeProjectDirectoryPicker: () => automationMocks.useNativePicker,
}))

vi.mock('@/lib/native-directory-picker', () => ({
  openNativeProjectDirectoryPickers: pickerMocks.open,
}))

const baseProps = {
  open: true,
  device: { device_id: 'local-device', name: 'Local' },
  initialRoots: ['/repo/web'],
  onGetDeviceHomeDirectory: vi.fn().mockResolvedValue('/repo'),
  onListDeviceDirectories: vi.fn().mockResolvedValue([]),
  onCreateDeviceDirectory: vi.fn().mockResolvedValue(undefined),
  onClose: vi.fn(),
}

describe('LocalProjectCreateDialog', () => {
  afterEach(() => {
    delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost
  })
  beforeEach(() => {
    automationMocks.useNativePicker = true
    vi.clearAllMocks()
  })

  test('uses the device folder picker when the Web client adds another root', async () => {
    automationMocks.useNativePicker = false
    render(<LocalProjectCreateDialog {...baseProps} onCreate={vi.fn()} />)

    await userEvent.click(screen.getByTestId('add-local-project-create-folders'))

    expect(screen.getByTestId('local-project-create-folder-picker')).toBeInTheDocument()
    expect(pickerMocks.open).not.toHaveBeenCalled()
  })

  test('creates one project from the selected source folders', async () => {
    pickerMocks.open.mockResolvedValue(['/repo/api'])
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(<LocalProjectCreateDialog {...baseProps} onCreate={onCreate} />)

    await userEvent.type(screen.getByTestId('local-project-create-name-input'), 'Product')
    await userEvent.click(screen.getByTestId('add-local-project-create-folders'))
    expect(await screen.findByText('api')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('confirm-local-project-create-button'))

    expect(onCreate).toHaveBeenCalledWith({
      deviceId: 'local-device',
      name: 'Product',
      roots: ['/repo/web', '/repo/api'],
    })
  })

  test('requires a name and at least one source folder', async () => {
    render(<LocalProjectCreateDialog {...baseProps} onCreate={vi.fn()} />)

    expect(screen.getByTestId('confirm-local-project-create-button')).toBeDisabled()
    await userEvent.type(screen.getByTestId('local-project-create-name-input'), 'Product')
    await userEvent.click(screen.getByTestId('remove-local-project-create-root-0'))
    expect(screen.getByTestId('confirm-local-project-create-button')).toBeDisabled()
  })

  test('local Electron cancellation preserves existing roots and the manual path entry remains available', async () => {
    const pickWorkspacePaths = vi.fn().mockResolvedValue([])
    Object.assign(window, { kcoderDesktopHost: { pickWorkspacePaths } })
    render(
      <LocalProjectCreateDialog
        {...baseProps}
        device={{ ...baseProps.device, capabilities: ['kcoder-gateway-local'] }}
        onCreate={vi.fn()}
      />
    )
    await userEvent.click(screen.getByTestId('add-local-project-create-folders'))
    expect(pickWorkspacePaths).toHaveBeenCalledWith({
      serverId: 'local-device',
      initialDirectory: '/repo/web',
      multiple: true,
    })
    expect(screen.getByTestId('local-project-create-root-0')).toHaveTextContent('web')
    expect(screen.queryByTestId('local-project-create-root-1')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('local-project-create-enter-path'))
    expect(screen.getByTestId('local-project-create-folder-picker')).toBeInTheDocument()
    expect(pickerMocks.open).not.toHaveBeenCalled()
  })

  test.each(['remote-local', 'ssh'])(
    'uses server directory browsing for %s instead of a client PC picker',
    async target => {
      const pickWorkspacePaths = vi.fn()
      Object.assign(window, { kcoderDesktopHost: target === 'ssh' ? { pickWorkspacePaths } : {} })
      render(
        <LocalProjectCreateDialog
          {...baseProps}
          device={{
            ...baseProps.device,
            device_type: 'remote',
            capabilities: target === 'remote-local' ? ['kcoder-gateway-local'] : [],
          }}
          onCreate={vi.fn()}
        />
      )
      await userEvent.click(screen.getByTestId('add-local-project-create-folders'))
      expect(screen.getByTestId('local-project-create-folder-picker')).toBeInTheDocument()
      expect(pickWorkspacePaths).not.toHaveBeenCalled()
      expect(pickerMocks.open).not.toHaveBeenCalled()
    }
  )
})
