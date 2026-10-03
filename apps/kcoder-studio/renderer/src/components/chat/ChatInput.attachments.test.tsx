import type { Attachment } from '@/types/api'
import type { QueuedWorkbenchMessage } from '@/types/workbench'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { ChatInput } from './ChatInput'
import {
  projectChatControls,
  projectWorkControls,
  REMOTE_WORKSPACE_TARGET,
} from './composer/ChatInput.test-support'
import { ControlledChatInput } from './composer/ControlledChatInput.test-support'
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: string | { action?: string; count?: number; device?: string; location?: string },
      interpolation?: { model?: string }
    ) => {
      if (typeof options === 'string') {
        return interpolation?.model ? options.replace('{{model}}', interpolation.model) : options
      }
      if (key === 'workbench.goal_standard_label') return '普通目标（/goal）'
      if (key === 'workbench.goal_pro_label') return '严格目标（/goal-pro）'
      if (key === 'workbench.goal_pro_description') return '持续执行目标，并进行独立验证'
      if (key === 'workbench.code_comment_count') {
        return `${options?.count ?? 0} 个评论`
      }
      if (key === 'workbench.project_work_trigger_device_aria') {
        return `${options?.action ?? ''}，当前设备 ${options?.device ?? ''}`
      }
      if (key === 'workbench.environment_cloud_device') return '云设备'
      if (key === 'workbench.environment_local') return '本机'
      if (key === 'workbench.remove_code_comments') {
        return '移除代码评论'
      }
      return key
    },
  }),
}))
describe('ChatInput attachments', () => {
  const originalCreateObjectUrl = URL.createObjectURL
  const originalInnerWidth = window.innerWidth
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    localStorage.clear()
    URL.createObjectURL = originalCreateObjectUrl
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalInnerWidth,
    })
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })
  test('provides left-side drag handles to reorder multiple queued messages', () => {
    const queuedMessages: QueuedWorkbenchMessage[] = [
      {
        id: 'queued-first',
        content: '先执行检查',
        status: 'queued',
        createdAt: '2026-05-25T15:08:00.000+08:00',
      },
      {
        id: 'queued-second',
        content: '再执行修复',
        status: 'queued',
        createdAt: '2026-05-25T15:09:00.000+08:00',
      },
    ]
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={queuedMessages}
        guidanceMessages={[]}
      />
    )

    expect(screen.getByTestId('queue-drag-handle-queued-first')).toHaveAttribute(
      'aria-label',
      '拖拽调整消息顺序'
    )
    expect(screen.getByTestId('queue-drag-handle-queued-second')).toHaveAttribute(
      'aria-label',
      '拖拽调整消息顺序'
    )
  })

  test('hides drag handles when fewer than two messages are queued', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={[
          {
            id: 'queued-only',
            content: '执行检查',
            status: 'queued',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
        guidanceMessages={[]}
      />
    )

    expect(screen.queryByTestId('queue-drag-handle-queued-only')).not.toBeInTheDocument()
  })

  test('opens a mobile context sheet that uploads files without type restrictions', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const script = new File(['#!/bin/sh'], 'init_env.sh', {
      type: 'application/x-sh',
    })

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    await userEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('mobile-context-sheet')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-take-photo-button')).toHaveTextContent('拍照')
    expect(screen.getByTestId('mobile-upload-image-button')).toHaveTextContent('上传文件')
    expect(screen.queryByText('添加照片和文件')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-camera-file-input')).toHaveAttribute('accept', 'image/*')
    expect(screen.getByTestId('mobile-camera-file-input')).toHaveAttribute('capture', 'environment')
    expect(screen.getByTestId('mobile-image-file-input')).not.toHaveAttribute('accept')

    await userEvent.upload(screen.getByTestId('mobile-image-file-input'), script)

    expect(handleFileSelect).toHaveBeenCalledWith([script])
    expect(screen.queryByTestId('mobile-context-sheet')).not.toBeInTheDocument()
  })

  test('desktop file picker does not restrict attachment file types', async () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
      />
    )

    await userEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('attachment-file-input')).not.toHaveAttribute('accept')
  })

  test('uploads pasted images from the desktop message textbox', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const image = new File(['image'], 'clipboard.png', { type: 'image/png' })

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    fireEvent.paste(screen.getByTestId('chat-message-input'), {
      clipboardData: {
        files: [image],
      },
    })

    await waitFor(() => expect(handleFileSelect).toHaveBeenCalledWith([image]))
  })

  test('uploads pasted documents for a remote desktop workspace', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const documentFile = new File(['document'], 'requirements.pdf', {
      type: 'application/pdf',
    })

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ handleFileSelect })}
        workspaceTarget={REMOTE_WORKSPACE_TARGET}
      />
    )

    fireEvent.paste(screen.getByTestId('chat-message-input'), {
      clipboardData: {
        files: [documentFile],
      },
    })

    await waitFor(() => expect(handleFileSelect).toHaveBeenCalledWith([documentFile]))
  })

  test('turns long pasted text from the desktop message textbox into a text attachment', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const onChange = vi.fn()
    const longText = 'long pasted text\n'.repeat(400)

    render(
      <ChatInput
        value=""
        onChange={onChange}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    fireEvent.paste(screen.getByTestId('chat-message-input'), {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === 'text/plain' ? longText : ''),
      },
    })

    expect(onChange).not.toHaveBeenCalled()
    expect(handleFileSelect).toHaveBeenCalledTimes(1)
    const files = handleFileSelect.mock.calls[0][0] as File[]
    expect(files).toHaveLength(1)
    expect(files[0].name).toMatch(/^clipboard-text-\d+\.txt$/)
    expect(files[0].type).toBe('text/plain')
    expect(await files[0].text()).toBe(longText)
  })

  test('uploads dropped images from the desktop composer', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const imageFile = new File(['image'], 'drop-preview.png', {
      type: 'image/png',
    })

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    fireEvent.drop(screen.getByTestId('chat-message-input'), {
      dataTransfer: {
        types: ['Files'],
        files: [imageFile],
      },
    })

    await waitFor(() => expect(handleFileSelect).toHaveBeenCalledWith([imageFile]))
  })

  test('highlights the desktop composer while files are dragged over it', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
      />
    )

    const composer = screen.getByTestId('project-chat-composer-form')
    const dataTransfer = { types: ['Files'], dropEffect: 'none' }

    fireEvent.dragEnter(composer, { dataTransfer })

    expect(composer).toHaveClass('border-focus', 'ring-2', 'ring-focus/20')
    expect(dataTransfer.dropEffect).toBe('copy')

    fireEvent.dragLeave(composer, { dataTransfer, relatedTarget: document.body })

    expect(composer).toHaveClass('border-border/45')
  })

  test('uploads pasted images from the fullscreen compact textbox', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const image = new File(['image'], 'fullscreen-clipboard.png', { type: 'image/png' })

    render(
      <ChatInput
        value={'line 1\nline 2\nline 3\nline 4\nline 5'}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    await userEvent.click(screen.getByTestId('expand-input-button'))
    fireEvent.paste(screen.getByTestId('fullscreen-message-input'), {
      clipboardData: {
        files: [image],
      },
    })

    await waitFor(() => expect(handleFileSelect).toHaveBeenCalledWith([image]))
  })

  test('uploads pasted documents from a remote fullscreen compact textbox', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const documentFile = new File(['document'], 'fullscreen-requirements.pdf', {
      type: 'application/pdf',
    })

    render(
      <ChatInput
        value={'line 1\nline 2\nline 3\nline 4\nline 5'}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={projectChatControls({ handleFileSelect })}
        workspaceTarget={REMOTE_WORKSPACE_TARGET}
      />
    )

    await userEvent.click(screen.getByTestId('expand-input-button'))
    fireEvent.paste(screen.getByTestId('fullscreen-message-input'), {
      clipboardData: {
        files: [documentFile],
      },
    })

    await waitFor(() => expect(handleFileSelect).toHaveBeenCalledWith([documentFile]))
  })

  test('turns long pasted text from the fullscreen compact textbox into a text attachment', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const onChange = vi.fn()
    const longText = 'fullscreen pasted text\n'.repeat(400)

    render(
      <ChatInput
        value={'line 1\nline 2\nline 3\nline 4\nline 5'}
        onChange={onChange}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    await userEvent.click(screen.getByTestId('expand-input-button'))
    fireEvent.paste(screen.getByTestId('fullscreen-message-input'), {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === 'text/plain' ? longText : ''),
      },
    })

    expect(onChange).not.toHaveBeenCalled()
    expect(handleFileSelect).toHaveBeenCalledTimes(1)
    const files = handleFileSelect.mock.calls[0][0] as File[]
    expect(files).toHaveLength(1)
    expect(files[0].name).toMatch(/^clipboard-text-\d+\.txt$/)
    expect(files[0].type).toBe('text/plain')
    expect(await files[0].text()).toBe(longText)
  })

  test('enables compact send when only image attachments are present', async () => {
    const onSubmit = vi.fn()
    const attachment: Attachment = {
      id: 45,
      filename: 'photo.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    expect(screen.getByTestId('attachment-badge')).toBeInTheDocument()
    expect(screen.getByTestId('send-message-button')).toBeEnabled()
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('blocks compact send while an attachment upload has failed', async () => {
    const onSubmit = vi.fn()

    render(
      <ChatInput
        value="请检查这张图片"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        projectChat={projectChatControls({
          errors: new Map([['photo.png', 'KCoder 网关附件不能超过 256 KiB']]),
        })}
      />
    )

    expect(screen.getByTestId('attachment-error-badge')).toHaveTextContent('photo.png')
    expect(screen.getByTestId('attachment-error-badge')).toHaveAttribute(
      'title',
      'photo.png: KCoder 网关附件不能超过 256 KiB'
    )
    expect(screen.getByTestId('send-message-button')).toBeDisabled()
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('renders an upload placeholder with a cancel button', async () => {
    const cancelUpload = vi.fn()
    const file = new File(['image'], 'photo.png', { type: 'image/png' })

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={projectChatControls({
          uploadingFiles: new Map([['photo.png', { file, progress: 42 }]]),
          cancelUpload,
        })}
      />
    )

    expect(screen.getByTestId('uploading-attachment-badge')).toHaveAttribute(
      'aria-label',
      'photo.png 上传中 42%'
    )
    expect(screen.getByTestId('uploading-attachment-badge')).toHaveTextContent('42%')
    await userEvent.click(screen.getByTestId('cancel-upload-button'))
    expect(cancelUpload).toHaveBeenCalledWith('photo.png')
  })

  test('opens the desktop add context menu with file upload, plan, and goal actions', async () => {
    const setSelectedModelOption = vi.fn()
    const onSetGoal = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ setSelectedModelOption })}
        onSetGoal={onSetGoal}
      />
    )

    await userEvent.click(screen.getByTestId('add-context-button'))

    const menu = within(screen.getByTestId('add-context-menu'))
    expect(menu.getByText('添加照片和文件')).toBeInTheDocument()
    expect(menu.getByText('计划模式')).toBeInTheDocument()
    expect(menu.getByText('开启计划模式')).toBeInTheDocument()
    expect(menu.getByText('普通目标（/goal）')).toBeInTheDocument()
    expect(menu.getByText('严格目标（/goal-pro）')).toBeInTheDocument()
    expect(menu.getByText('设置 KCoder Studio 将持续努力实现的目标')).toBeInTheDocument()
    expect(menu.queryByText('Attach Google Chrome')).not.toBeInTheDocument()
    expect(menu.queryByText('插件')).not.toBeInTheDocument()
    expect(screen.getByTestId('attach-files-button')).toHaveClass(
      'font-normal',
      'text-text-primary'
    )
    expect(screen.getByTestId('set-plan-mode-button')).toHaveClass(
      'font-normal',
      'text-text-primary'
    )

    await userEvent.click(screen.getByTestId('set-plan-mode-button'))

    expect(setSelectedModelOption).toHaveBeenCalledWith('collaborationMode', 'plan')

    await userEvent.click(screen.getByTestId('add-context-button'))
    await userEvent.click(screen.getByTestId('set-goal-button'))

    expect(onSetGoal).toHaveBeenCalledTimes(1)
    expect(onSetGoal).toHaveBeenLastCalledWith('standard')
    await userEvent.click(screen.getByTestId('add-context-button'))
    await userEvent.click(screen.getByTestId('set-goal-pro-button'))
    expect(onSetGoal).toHaveBeenLastCalledWith('strict')
  })

  test('closes the desktop add context menu before opening the file picker', async () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls()}
      />
    )

    await userEvent.click(screen.getByTestId('add-context-button'))
    const fileInput = screen.getByTestId('attachment-file-input') as HTMLInputElement
    const clickFileInput = vi.spyOn(fileInput, 'click')

    await userEvent.click(screen.getByTestId('attach-files-button'))

    expect(clickFileInput).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('add-context-menu')).not.toBeInTheDocument()
  })

  test('renders attachment badges and removes an attachment', async () => {
    const removeAttachment = vi.fn().mockResolvedValue(undefined)
    const attachment: Attachment = {
      id: 42,
      filename: 'brief.pdf',
      file_size: 1200,
      mime_type: 'application/pdf',
      status: 'ready',
      file_extension: '.pdf',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          attachments: [attachment],
          removeAttachment,
        })}
      />
    )

    expect(screen.getByTestId('attachment-badge')).toHaveTextContent('brief.pdf')

    await userEvent.click(screen.getByTestId('remove-attachment-button'))

    expect(removeAttachment).toHaveBeenCalledWith(42)
  })

  test('renders document attachments as fixed two-line cards', () => {
    const attachment: Attachment = {
      id: 42,
      filename: 'brief.pdf',
      file_size: 1200,
      mime_type: 'application/pdf',
      status: 'ready',
      file_extension: '.pdf',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    expect(screen.getByTestId('attachment-badge')).toHaveClass('h-14', 'w-[220px]', 'rounded-xl')
    expect(screen.getByTestId('attachment-document-icon')).toHaveTextContent('PDF')
    expect(screen.getByText('brief.pdf')).toHaveClass('truncate')
    expect(screen.getAllByText('PDF')).toHaveLength(2)
  })

  test('renders pasted text attachments as compact preview cards', async () => {
    const removeAttachment = vi.fn().mockResolvedValue(undefined)
    const attachment: Attachment = {
      id: 45,
      filename: 'clipboard-text-1783070360990.txt',
      file_size: 1200,
      mime_type: 'text/plain',
      status: 'ready',
      file_extension: '.txt',
      created_at: '2026-05-27T00:00:00.000Z',
      text_preview: '{ "event_type": "http_exchange", "id": "e9972aac" }',
      text_content: '{\n  "event_type": "http_exchange",\n  "id": "e9972aac"\n}',
    }

    render(
      <ControlledChatInput
        variant="desktop"
        projectChat={projectChatControls({
          attachments: [attachment],
          removeAttachment,
        })}
      />
    )

    expect(screen.getByTestId('attachment-badge')).toHaveClass(
      'h-[72px]',
      'rounded-[20px]',
      'bg-muted'
    )
    expect(screen.getByTestId('attachment-text-preview')).toHaveTextContent(
      '{ "event_type": "http_exchange", "id": "e9972aac" }'
    )
    expect(screen.getByTestId('show-text-attachment-button')).toHaveTextContent(
      'workbench.show_text_attachment_in_composer'
    )

    await userEvent.click(screen.getByTestId('show-text-attachment-button'))

    expect(screen.getByTestId('chat-message-input')).toHaveValue(
      '{\n  "event_type": "http_exchange",\n  "id": "e9972aac"\n}'
    )
    expect(removeAttachment).toHaveBeenCalledWith(45)
  })

  test('renders an image preview for image attachments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob(['image'], { type: 'image/png' })),
      })
    )
    URL.createObjectURL = vi.fn(() => 'blob:attachment-preview')
    const attachment: Attachment = {
      id: 43,
      filename: 'screenshot.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('attachment-image-preview')).toHaveAttribute(
        'src',
        'blob:attachment-preview'
      )
    })
  })

  test('renders an Appshot image and its text context as one attachment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob(['image'], { type: 'image/png' })),
      })
    )
    URL.createObjectURL = vi.fn(() => 'blob:appshot-preview')
    const appshot: Attachment = {
      id: -10,
      filename: 'appshot.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-07-15T00:00:00.000Z',
      ui_group_id: 'appshot-capture-1',
      ui_group_role: 'primary',
      ui_kind: 'appshot',
    }
    const textContext: Attachment = {
      ...appshot,
      id: -11,
      filename: 'appshot-context.txt',
      mime_type: 'text/plain',
      file_extension: '.txt',
      ui_group_role: 'companion',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [appshot, textContext] })}
      />
    )

    expect(screen.getAllByTestId('attachment-badge')).toHaveLength(1)
    expect(screen.getByTestId('attachment-appshot-label')).toHaveTextContent('应用快照')
    expect(screen.queryByTestId('attachment-text-icon')).not.toBeInTheDocument()
  })

  test('opens an enlarged image from the composer attachment preview', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob(['image'], { type: 'image/png' })),
      })
    )
    URL.createObjectURL = vi.fn(() => 'blob:attachment-preview')
    const attachment: Attachment = {
      id: 43,
      filename: 'screenshot.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    await userEvent.click(await screen.findByTestId('attachment-image-preview'))

    const lightbox = screen.getByTestId('attachment-image-lightbox')

    expect(lightbox).toBeInTheDocument()
    expect(lightbox.parentElement).toBe(document.body)
    expect(screen.getByTestId('attachment-image-lightbox-image')).toHaveAttribute(
      'src',
      'blob:attachment-preview'
    )
    expect(screen.getByTestId('attachment-image-lightbox-image')).toHaveAttribute(
      'alt',
      'screenshot.png'
    )
  })

  test('loads image previews with the auth token from local storage', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['image'], { type: 'image/png' })),
    })
    vi.stubGlobal('fetch', fetchMock)
    URL.createObjectURL = vi.fn(() => 'blob:attachment-preview')
    localStorage.setItem('auth_token', 'token-123')

    const attachment: Attachment = {
      id: 43,
      filename: 'screenshot.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('attachment-image-preview')).toHaveAttribute(
        'src',
        'blob:attachment-preview'
      )
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/attachments/43/download', {
      headers: { Authorization: 'Bearer token-123' },
    })
  })

  test('uses matching overlay remove buttons for image and document attachments', () => {
    const attachments: Attachment[] = [
      {
        id: 43,
        filename: 'screenshot.png',
        file_size: 1200,
        mime_type: 'image/png',
        status: 'ready',
        file_extension: '.png',
        created_at: '2026-05-27T00:00:00.000Z',
      },
      {
        id: 44,
        filename: 'brief.pdf',
        file_size: 1200,
        mime_type: 'application/pdf',
        status: 'ready',
        file_extension: '.pdf',
        created_at: '2026-05-27T00:00:00.000Z',
      },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments })}
      />
    )

    const removeButtons = screen.getAllByTestId('remove-attachment-button')

    expect(removeButtons).toHaveLength(2)
    removeButtons.forEach(button => {
      expect(button).toHaveClass('absolute', '-right-1.5', '-top-1.5')
      expect(button).toHaveClass('rounded-full', 'bg-text-primary', 'text-white')
    })
  })

  test('enables send when only attachments are present', async () => {
    const onSubmit = vi.fn()
    const attachment: Attachment = {
      id: 44,
      filename: 'brief.pdf',
      file_size: 1200,
      mime_type: 'application/pdf',
      status: 'ready',
      file_extension: '.pdf',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    expect(screen.getByTestId('send-message-button')).toBeEnabled()
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['model selector', 'model-selector-button', 'model-selector-menu'],
    ['add context menu', 'add-context-button', 'add-context-menu'],
    ['project work menu', 'project-work-button', 'project-work-menu'],
  ])(
    'closes the desktop %s when clicking outside the dropdown',
    async (_, buttonTestId, menuTestId) => {
      render(
        <ChatInput
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          disabled={false}
          variant="desktop"
          projectWork={projectWorkControls({
            projects: [{ id: 7, name: 'Wegent', tasks: [] }],
          })}
        />
      )

      await userEvent.click(screen.getByTestId(buttonTestId))
      expect(screen.getByTestId(menuTestId)).toBeInTheDocument()

      await userEvent.click(screen.getByTestId('chat-message-input'))

      expect(screen.queryByTestId(menuTestId)).not.toBeInTheDocument()
    }
  )
})
