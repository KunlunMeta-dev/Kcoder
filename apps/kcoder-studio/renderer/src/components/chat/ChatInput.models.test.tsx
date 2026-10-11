import { getKeyboardPlatform } from '@/lib/keyboard-platform'
import type { UnifiedModel } from '@/types/api'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { ChatInput } from './ChatInput'
import { projectChatControls } from './composer/ChatInput.test-support'
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
describe('ChatInput models', () => {
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
  test('distinguishes the active model from the next-turn model while streaming', async () => {
    const activeModel: UnifiedModel = {
      name: 'local-model:first',
      type: 'runtime',
      displayName: 'First Model',
      isActive: true,
    }
    const selectedModel: UnifiedModel = {
      name: 'local-model:second',
      type: 'runtime',
      displayName: 'Second Model',
      isActive: true,
    }

    const projectChat = projectChatControls({
      models: [activeModel, selectedModel],
      activeModel,
      selectedModel,
    })
    const { rerender } = render(
      <ChatInput
        value="换模型继续"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        isStreaming
        projectChat={projectChat}
      />
    )

    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('Models')
    await userEvent.click(screen.getByTestId('send-mode-menu-button'))
    expect(screen.getByTestId('guide-current-turn-option')).toHaveTextContent(
      'Guide current response · First Model'
    )
    expect(screen.getByTestId('interrupt-and-send-option')).toHaveTextContent(
      'Interrupt and use Second Model'
    )

    rerender(
      <ChatInput
        value="换模型继续"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        isStreaming={false}
        projectChat={projectChat}
      />
    )
    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('Models')
    expect(screen.getByTestId('model-selector-button')).not.toHaveTextContent('Next')
  })

  test('warns before switching away from the model that owns the conversation context', async () => {
    const activeModel: UnifiedModel = {
      name: 'local-model:first',
      type: 'runtime',
      displayName: 'First Model',
      isActive: true,
      config: { ui: { family: 'local' } },
    }
    const targetModel: UnifiedModel = {
      name: 'local-model:second',
      type: 'runtime',
      displayName: 'Second Model',
      isActive: true,
      config: { ui: { family: 'local' } },
    }
    const setSelectedModel = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [activeModel, targetModel],
          activeModel,
          selectedModel: activeModel,
          setSelectedModel,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))
    await userEvent.click(screen.getByTestId('model-option-local-model:second'))

    expect(screen.getByTestId('model-switch-warning-dialog')).toHaveTextContent(
      'Switching to Second Model may change how the existing context is understood.'
    )
    expect(setSelectedModel).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('model-switch-warning-cancel-button'))

    expect(screen.queryByTestId('model-switch-warning-dialog')).not.toBeInTheDocument()
    expect(setSelectedModel).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))
    await userEvent.click(screen.getByTestId('model-option-local-model:second'))
    await userEvent.click(screen.getByTestId('model-switch-warning-confirm-button'))

    expect(setSelectedModel).toHaveBeenCalledWith(targetModel)
    expect(screen.queryByTestId('model-switch-warning-dialog')).not.toBeInTheDocument()
  })

  test('does not warn when selecting a model before a conversation has an active model', async () => {
    const targetModel: UnifiedModel = {
      name: 'local-model:first',
      type: 'runtime',
      displayName: 'First Model',
      isActive: true,
      config: { ui: { family: 'local' } },
    }
    const setSelectedModel = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [targetModel],
          selectedModel: null,
          setSelectedModel,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))
    await userEvent.click(screen.getByTestId('model-option-local-model:first'))

    expect(setSelectedModel).toHaveBeenCalledWith(targetModel)
    expect(screen.queryByTestId('model-switch-warning-dialog')).not.toBeInTheDocument()
  })

  test('does not warn when reselecting the model already chosen for the next turn', async () => {
    const activeModel: UnifiedModel = {
      name: 'local-model:first',
      type: 'runtime',
      displayName: 'First Model',
      isActive: true,
      config: { ui: { family: 'local' } },
    }
    const selectedModel: UnifiedModel = {
      name: 'local-model:second',
      type: 'runtime',
      displayName: 'Second Model',
      isActive: true,
      config: { ui: { family: 'local' } },
    }
    const setSelectedModel = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [activeModel, selectedModel],
          activeModel,
          selectedModel,
          setSelectedModel,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))
    await userEvent.click(screen.getByTestId('model-option-local-model:second'))

    expect(setSelectedModel).toHaveBeenCalledWith(selectedModel)
    expect(screen.queryByTestId('model-switch-warning-dialog')).not.toBeInTheDocument()
  })

  test('opens the desktop model menu with real model options', async () => {
    const model: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
          controls: ['speed'],
        },
      },
    }
    const cloudModel: UnifiedModel = {
      ...model,
      name: 'cloud-gpt-5.5',
      displayName: '云端:gpt-5.5',
    }
    const setSelectedModel = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model, cloudModel],
          selectedModel: model,
          selectedModelOptions: { reasoning: 'high', speed: 'standard' },
          setSelectedModel,
        })}
      />
    )

    const selectorButton = screen.getByTestId('model-selector-button')
    expect(selectorButton).toHaveClass(
      'transition-[width,background-color,color,opacity]',
      'duration-200'
    )
    expect(screen.getByTestId('model-selector-tooltip')).toHaveTextContent('选择模型')
    expect(screen.getByTestId('model-selector-tooltip')).toHaveTextContent(
      getKeyboardPlatform() === 'mac' ? '⌃⇧M' : 'CtrlShiftM'
    )
    expect(screen.getByTestId('model-selector-tooltip')).toHaveClass('h-9')
    expect(screen.getByTestId('model-selector-tooltip')).toHaveClass(
      'group-hover/model-selector:opacity-100',
      'group-hover/model-selector:delay-[1500ms]'
    )
    expect(screen.getByTestId('model-selector-tooltip')).not.toHaveClass(
      'group-focus-within/model-selector:delay-0'
    )

    await userEvent.click(selectorButton)

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    expect(screen.getByTestId('model-selector-menu')).toHaveAttribute(
      'data-enter-animation',
      'main'
    )
    expect(selectorButton).toHaveStyle({ width: 'var(--model-selector-width, auto)' })
    expect(screen.queryByTestId('model-selector-tooltip')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-selector-menu').parentElement).toHaveClass(
      'fixed',
      'z-system-popover',
      'w-64'
    )
    expect(screen.getByTestId('model-selector-menu').parentElement?.parentElement).toBe(
      document.body
    )
    expect(screen.queryByTestId('model-selector-submenu')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-control-menu-model')).toBeInTheDocument()
    expect(screen.queryByTestId('model-control-menu-reasoning')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-menu-speed')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-reset-default-button')).toBeEnabled()
    expect(screen.queryByTestId('model-advanced-intelligence-icon')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-reasoning-slider')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-reasoning-high')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-collaborationMode-default')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-collaborationMode-plan')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-speed-fast')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-option-default')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('Models')
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    expect(screen.getByTestId('model-selector-submenu')).toHaveAttribute(
      'data-enter-animation',
      'submenu'
    )
    expect(screen.getByTestId('model-selector-submenu')).toHaveStyle({ left: '256px' })
    const modelOption = screen.getByTestId('model-option-overseas-gpt-5.5')
    expect(modelOption).toHaveTextContent('Overseas:gpt-5.5')
    expect(modelOption.querySelectorAll('span')).toHaveLength(2)
    expect(screen.getByTestId('model-option-cloud-gpt-5.5')).toHaveAccessibleName(/云端/)

    await userEvent.click(screen.getByTestId('model-option-overseas-gpt-5.5'))

    expect(setSelectedModel).toHaveBeenCalledWith(model)
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
  })

  test('shows an empty state when no desktop models are available', async () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ models: [], selectedModel: null })}
      />
    )

    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('Models')
    await userEvent.click(screen.getByTestId('model-selector-button'))
    expect(screen.queryByTestId('model-selector-submenu')).not.toBeInTheDocument()
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    expect(screen.getByTestId('model-selector-submenu')).toHaveTextContent('No models available')
  })

  test('closes the desktop model menu only from its trigger, outside click, or Escape', async () => {
    const model: UnifiedModel = {
      name: 'codex-gpt-5.5',
      type: 'user',
      displayName: 'Codex:gpt-5.5',
      config: { ui: { family: 'gpt', modelLabel: 'gpt-5.5', sortOrder: 10 } },
    }
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ models: [model], selectedModel: model })}
      />
    )

    const trigger = screen.getByTestId('model-selector-button')
    await userEvent.click(trigger)
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()

    await userEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()

    await userEvent.click(trigger)
    await userEvent.click(trigger)
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
  })

  test('suppresses the model tooltip after closing until the pointer re-enters', async () => {
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
    const trigger = screen.getByTestId('model-selector-button')

    await userEvent.click(trigger)
    await userEvent.click(trigger)

    expect(screen.queryByTestId('model-selector-tooltip')).not.toBeInTheDocument()

    await userEvent.unhover(trigger)
    await userEvent.hover(trigger)

    expect(screen.getByTestId('model-selector-tooltip')).toBeInTheDocument()
  })

  test('keeps the desktop model submenu open after the pointer leaves the menu', async () => {
    const model: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
        },
      },
    }
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
          selectedModelOptions: { reasoning: 'high' },
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    expect(screen.getByTestId('model-selector-submenu')).toBeInTheDocument()

    fireEvent.mouseLeave(screen.getByTestId('model-selector-menu').parentElement as HTMLElement)

    expect(screen.getByTestId('model-selector-submenu')).toBeInTheDocument()
  })

  test('keeps the desktop model menu in narrow Tauri windows', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 500,
    })
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    const model: UnifiedModel = {
      name: 'codex-gpt-5.5',
      type: 'user',
      displayName: '5.5',
      config: {
        ui: {
          family: 'gpt',
          modelLabel: '5.5',
          sortOrder: 10,
        },
      },
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    expect(screen.getByTestId('model-selector-menu')).not.toHaveAttribute('data-mobile')
    expect(screen.getByTestId('model-selector-menu')).not.toHaveAttribute('aria-modal')
    expect(screen.queryByTestId('model-selector-submenu')).not.toBeInTheDocument()
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))
    expect(screen.getByTestId('model-selector-submenu')).toBeInTheDocument()
  })

  test('opens the desktop model menu when the external open signal changes', async () => {
    const model: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
        },
      },
    }
    const { rerender } = render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
          modelSelectorOpenSignal: 0,
        })}
      />
    )

    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()

    rerender(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
          modelSelectorOpenSignal: 1,
        })}
      />
    )

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
  })

  test('keeps the desktop model menu open after selecting a model opened by external signal', async () => {
    const model: UnifiedModel = {
      name: 'ali-qwen3-coder-plus',
      type: 'user',
      displayName: 'ali-qwen3-coder-plus',
      config: {
        ui: {
          family: 'qwen',
          region: 'domestic',
          modelLabel: 'ali-qwen3-coder-plus',
          sortOrder: 10,
        },
      },
    }
    const setSelectedModel = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: null,
          modelSelectorOpenSignal: 1,
          setSelectedModel,
        })}
      />
    )

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    await userEvent.click(screen.getByTestId('model-option-ali-qwen3-coder-plus'))

    expect(setSelectedModel).toHaveBeenCalledWith(model)
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
  })

  test('keeps the desktop model submenu inside the viewport near the bottom edge', async () => {
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 1000,
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function getMockRect(this: HTMLElement) {
        const testId = this.getAttribute('data-testid')
        if (testId === 'model-selector-menu') {
          return {
            top: 760,
            bottom: 900,
            left: 480,
            right: 736,
            width: 256,
            height: 140,
          } as DOMRect
        }
        if (testId === 'model-control-menu-model') {
          return {
            top: 780,
            bottom: 812,
            left: 492,
            right: 724,
            width: 232,
            height: 32,
          } as DOMRect
        }
        if (testId === 'model-selector-submenu') {
          return {
            top: 0,
            bottom: 192,
            left: 0,
            right: 288,
            width: 288,
            height: 192,
          } as DOMRect
        }
        return {
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
        } as DOMRect
      }
    )

    const minimaxModel: UnifiedModel = {
      name: 'public-minimax-m2.7',
      type: 'user',
      displayName: '公网:minimax-m2.7',
      config: {
        ui: {
          family: 'minimax',
          region: 'public',
          modelLabel: 'minimax-m2.7',
          sortOrder: 10,
        },
      },
    }

    try {
      render(
        <ChatInput
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          disabled={false}
          variant="desktop"
          projectChat={projectChatControls({
            models: [minimaxModel],
            selectedModel: minimaxModel,
            selectedModelOptions: {},
          })}
        />
      )

      await userEvent.click(screen.getByTestId('model-selector-button'))
      await userEvent.hover(screen.getByTestId('model-control-menu-model'))

      await waitFor(() => {
        expect(screen.getByTestId('model-selector-submenu')).toHaveStyle({
          top: '20px',
        })
      })
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      })
    }
  })

  test('shows incompatible model options as disabled', async () => {
    const selectedModel: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
        },
      },
    }
    const incompatibleModel: UnifiedModel = {
      name: 'overseas-gpt-5.4',
      type: 'user',
      displayName: '海外:gpt-5.4',
      compatibilityDisabled: true,
      compatibilityDisabledReason: 'runtime_family_mismatch',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.4',
          sortOrder: 20,
        },
      },
    }
    const setSelectedModel = vi.fn()
    const onBlockedModelSelect = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [selectedModel, incompatibleModel],
          selectedModel,
          selectedModelOptions: {},
          setSelectedModel,
          onBlockedModelSelect,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    const disabledOption = screen.getByTestId('model-option-overseas-gpt-5.4')
    expect(disabledOption).not.toBeDisabled()
    expect(disabledOption).toHaveAttribute('aria-disabled', 'true')
    expect(disabledOption).toHaveAttribute('title', 'Incompatible with the current model protocol')
    expect(disabledOption).toHaveTextContent('Incompatible with the current model protocol')

    await userEvent.click(disabledOption)

    expect(setSelectedModel).not.toHaveBeenCalled()
    expect(onBlockedModelSelect).toHaveBeenCalledWith(
      incompatibleModel,
      'Incompatible with the current model protocol'
    )
  })

  test('shows cross-provider model options as greyed and blocks selection', async () => {
    const selectedModel: UnifiedModel = {
      name: 'gpt-5.6-sol',
      type: 'runtime',
      displayName: 'GPT 5.6 Sol',
      config: {
        weworkModelKind: 'codex-official',
        ui: {
          family: 'codex-official',
          modelLabel: 'GPT 5.6 Sol',
        },
      },
    }
    const thirdPartyModel: UnifiedModel = {
      name: 'kimi-k2.5',
      type: 'runtime',
      displayName: 'Kimi K2.5',
      compatibilityDisabled: true,
      compatibilityDisabledReason: 'provider_boundary_mismatch',
      config: {
        weworkModelKind: 'codex-provider',
        ui: {
          family: 'codex-provider',
          modelLabel: 'Kimi K2.5',
        },
      },
    }
    const setSelectedModel = vi.fn()
    const onBlockedModelSelect = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [selectedModel, thirdPartyModel],
          selectedModel,
          activeModel: selectedModel,
          selectedModelOptions: {},
          setSelectedModel,
          onBlockedModelSelect,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    const disabledOption = screen.getByTestId('model-option-kimi-k2.5')
    expect(disabledOption).toHaveAttribute('aria-disabled', 'true')
    expect(disabledOption).toHaveClass('cursor-not-allowed', 'text-text-muted')
    expect(disabledOption).toHaveAttribute(
      'title',
      'Official Codex and third-party models cannot be switched within one conversation. Start a new conversation and @mention this conversation to continue with its context.'
    )
    expect(disabledOption).toHaveTextContent(
      'Official Codex and third-party models cannot be switched within one conversation. Start a new conversation and @mention this conversation to continue with its context.'
    )

    await userEvent.click(disabledOption)

    expect(setSelectedModel).not.toHaveBeenCalled()
    expect(onBlockedModelSelect).toHaveBeenCalledWith(
      thirdPartyModel,
      'Official Codex and third-party models cannot be switched within one conversation. Start a new conversation and @mention this conversation to continue with its context.'
    )
    expect(screen.queryByTestId('model-switch-warning-dialog')).not.toBeInTheDocument()
  })

  test('omits Codex plan mode from the desktop model menu', async () => {
    const model: UnifiedModel = {
      name: 'codex-gpt-5.5',
      type: 'user',
      displayName: 'Codex:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
        },
      },
    }
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
          selectedModelOptions: { reasoning: 'high' },
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    const menu = within(screen.getByTestId('model-selector-menu'))
    expect(screen.queryByTestId('model-control-collaborationMode-default')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-collaborationMode-plan')).not.toBeInTheDocument()
    expect(menu.queryByText('运行模式')).not.toBeInTheDocument()
    expect(menu.queryByText('计划模式')).not.toBeInTheDocument()
  })

  test('lists models by family in the second-level menu while keeping selected controls', async () => {
    const gptModel: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
        },
      },
    }
    const claudeModel: UnifiedModel = {
      name: 'claude-opus',
      type: 'user',
      displayName: 'Claude Opus',
      config: {
        ui: {
          family: 'claude',
          modelLabel: 'claude-opus',
          sortOrder: 10,
        },
      },
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [claudeModel, gptModel],
          selectedModel: gptModel,
          selectedModelOptions: { reasoning: 'high' },
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    expect(screen.getByTestId('model-option-claude-opus')).toBeInTheDocument()
    expect(screen.getByTestId('model-option-overseas-gpt-5.5')).toBeInTheDocument()
    expect(screen.queryByTestId('model-control-menu-reasoning')).not.toBeInTheDocument()
  })

  test('keeps model selector enabled and omits skill selector when options are locked', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          selectedSkills: [
            {
              name: 'project-summary',
              namespace: 'default',
              is_public: false,
            },
          ],
          isOptionsLocked: true,
        })}
      />
    )

    expect(screen.getByTestId('model-selector-button')).not.toBeDisabled()
    expect(screen.queryByTestId('skill-selector-button')).not.toBeInTheDocument()
  })
})
