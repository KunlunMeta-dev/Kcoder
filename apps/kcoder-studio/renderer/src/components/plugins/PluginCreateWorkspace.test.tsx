import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Attachment } from '@/types/api'
import '@/i18n'
import { PluginCreateWorkspace } from './PluginCreateWorkspace'

const navigateTo = vi.hoisted(() => vi.fn())
const sendCurrentInput = vi.hoisted(() => vi.fn())
const projectChat = vi.hoisted(() => ({
  attachments: [] as Attachment[],
  uploadingFiles: new Map<string, { file: File; progress: number }>(),
  errors: new Map<string, string>(),
  handleFileSelect: vi.fn(),
  removeAttachment: vi.fn(),
  setSelectedSkills: vi.fn(),
}))

vi.mock('@/lib/navigation', () => ({ navigateTo }))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({ projectChat, sendCurrentInput }),
}))

function renderWorkspace() {
  return render(<PluginCreateWorkspace />)
}

function imageAttachment(): Attachment {
  return {
    id: 41,
    filename: 'plugin-context.png',
    file_size: 8,
    mime_type: 'image/png',
    status: 'ready',
    file_extension: 'png',
    created_at: '2026-08-05T00:00:00.000Z',
  }
}

describe('PluginCreateWorkspace', () => {
  beforeEach(() => {
    projectChat.attachments = []
    projectChat.uploadingFiles = new Map()
    projectChat.errors = new Map()
    projectChat.handleFileSelect.mockReset()
    projectChat.removeAttachment.mockReset()
    projectChat.setSelectedSkills.mockReset()
    sendCurrentInput.mockReset().mockResolvedValue(true)
    navigateTo.mockReset()
  })

  test('opens the image chooser from the plugin create plus button', async () => {
    const user = userEvent.setup()
    renderWorkspace()
    const input = screen.getByTestId('plugin-create-image-file-input') as HTMLInputElement
    const click = vi.spyOn(input, 'click')

    await user.click(screen.getByTestId('plugin-create-add-context-button'))

    expect(click).toHaveBeenCalledTimes(1)
    expect(input).toHaveAttribute('accept', 'image/*')
  })

  test('uploads a selected image and sends it with the plugin request', async () => {
    const user = userEvent.setup()
    const attachment = imageAttachment()
    projectChat.handleFileSelect.mockImplementation(async () => {
      projectChat.attachments = [attachment]
    })
    renderWorkspace()

    await user.click(screen.getByTestId('plugin-create-add-context-button'))
    await user.upload(
      screen.getByTestId('plugin-create-image-file-input'),
      new File(['png-data'], 'plugin-context.png', { type: 'image/png' })
    )
    await waitFor(() => expect(projectChat.handleFileSelect).toHaveBeenCalled())
    await user.type(screen.getByTestId('plugin-create-prompt-input'), '请创建带图片上下文的插件')
    await user.click(screen.getByTestId('plugin-create-submit-button'))

    await waitFor(() =>
      expect(sendCurrentInput).toHaveBeenCalledWith(
        expect.stringContaining('请创建带图片上下文的插件')
      )
    )
    expect(projectChat.setSelectedSkills).toHaveBeenCalledWith([
      { name: 'plugin-creator', namespace: 'codex', is_public: false },
    ])
    expect(navigateTo).toHaveBeenCalledWith('/')
    const request = sendCurrentInput.mock.calls[0][0] as string
    expect(request).toContain('KCoder Studio')
    expect(request).toContain('.codex-plugin/plugin.json')
    expect(request).not.toMatch(/Wegent|WeWork|Codex/)
    expect(screen.queryByText('5.5')).not.toBeInTheDocument()
    expect(screen.queryByText('完全访问')).not.toBeInTheDocument()
  })

  test('blocks submit while the image upload has failed', async () => {
    const user = userEvent.setup()
    projectChat.errors = new Map([['plugin-context.png', '上传失败']])
    renderWorkspace()
    await user.type(screen.getByTestId('plugin-create-prompt-input'), '插件需求')

    expect(screen.getByTestId('plugin-create-submit-button')).toBeDisabled()
    expect(screen.getByTestId('attachment-error-badge')).toHaveTextContent('plugin-context.png')
    await user.click(screen.getByTestId('plugin-create-submit-button'))
    expect(sendCurrentInput).not.toHaveBeenCalled()
  })

  test('allows creating a plugin with only an uploaded image', async () => {
    const user = userEvent.setup()
    projectChat.attachments = [imageAttachment()]
    renderWorkspace()

    expect(screen.getByTestId('plugin-create-submit-button')).toBeEnabled()
    await user.click(screen.getByTestId('plugin-create-submit-button'))

    await waitFor(() =>
      expect(sendCurrentInput).toHaveBeenCalledWith(
        expect.stringContaining('plugin-creator workflow')
      )
    )
    expect(navigateTo).toHaveBeenCalledWith('/')
  })
})
