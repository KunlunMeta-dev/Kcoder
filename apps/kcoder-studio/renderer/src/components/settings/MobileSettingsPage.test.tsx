import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import './../../../src/i18n'
import { MobileSettingsPage } from './MobileSettingsPage'
import { AppearanceProvider } from '@/features/appearance'

vi.mock('@/features/model-settings/localCodexSettings', () => ({
  DEFAULT_CODEX_PERSONALITY: 'pragmatic',
  getLocalCodexPersonality: vi.fn().mockResolvedValue('pragmatic'),
  saveLocalCodexPersonality: vi.fn().mockImplementation(value => Promise.resolve(value)),
}))

describe('MobileSettingsPage', () => {
  test('exposes target-owned model and usage settings on a KCoder Gateway mobile layout', async () => {
    const meta = document.createElement('meta')
    meta.name = 'kcoder-rpc-token'
    meta.content = 'test-token'
    document.head.append(meta)

    try {
      render(
        <AppearanceProvider>
          <MobileSettingsPage onBack={vi.fn()} />
        </AppearanceProvider>
      )
      await userEvent.click(screen.getByTestId('mobile-settings-personal-button'))
      expect(screen.getByTestId('mobile-settings-model-settings-button')).toBeVisible()
      expect(screen.getByTestId('mobile-settings-usage-button')).toBeVisible()
      await userEvent.click(screen.getByTestId('mobile-settings-model-settings-button'))
      expect(screen.getByTestId('provider-form')).toBeVisible()
      await userEvent.click(screen.getByTestId('mobile-model-settings-back-button'))
      await userEvent.click(screen.getByTestId('mobile-settings-usage-button'))
      expect(screen.getByTestId('usage-settings-page')).toBeVisible()
      await userEvent.click(screen.getByTestId('mobile-usage-back-button'))
      await userEvent.click(screen.getByTestId('mobile-personal-back-button'))
      expect(screen.queryByTestId('mobile-settings-plugins-button')).not.toBeInTheDocument()
      expect(screen.queryByTestId('mobile-settings-plugins-config-button')).not.toBeInTheDocument()
    } finally {
      meta.remove()
    }
  })

  test('renders mobile settings actions with plugins navigation', async () => {
    const onBack = vi.fn()
    const onOpenPlugins = vi.fn()

    render(
      <AppearanceProvider>
        <MobileSettingsPage onBack={onBack} onOpenPlugins={onOpenPlugins} />
      </AppearanceProvider>
    )

    expect(screen.getByTestId('mobile-settings-page')).toBeInTheDocument()
    expect(screen.queryByTestId('mobile-settings-general-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mobile-settings-appearance-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mobile-settings-context-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mobile-settings-about-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-settings-plugins-button')).toHaveTextContent('插件')
    expect(screen.getByTestId('mobile-settings-personal-button')).toHaveTextContent('个人')
    expect(screen.getAllByTestId('mobile-settings-worktrees-button')).toHaveLength(1)
    expect(screen.getByTestId('mobile-settings-worktrees-button')).toHaveTextContent('工作树')
    expect(screen.getByTestId('mobile-settings-worktrees-button')).toHaveClass('min-h-[56px]')
    expect(screen.getByTestId('mobile-settings-archived-conversations-button')).toHaveTextContent(
      '已归档任务'
    )
    expect(screen.getByTestId('mobile-settings-plugins-config-button')).toHaveTextContent('插件')

    await userEvent.click(screen.getByTestId('mobile-settings-personal-button'))
    expect(screen.getByTestId('mobile-personal-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-settings-general-button')).toHaveTextContent('通用')
    expect(screen.getByTestId('mobile-settings-appearance-button')).toHaveTextContent('外观')
    expect(screen.getByTestId('mobile-settings-about-button')).toHaveTextContent('关于')
    expect(screen.getByTestId('mobile-settings-context-button')).toHaveTextContent('上下文')
    expect(screen.getByTestId('mobile-settings-model-settings-button')).toHaveTextContent('模型')

    await userEvent.click(screen.getByTestId('mobile-personal-back-button'))
    expect(screen.getByTestId('mobile-settings-page')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-settings-back-button'))
    expect(onBack).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('mobile-settings-plugins-button'))
    expect(onOpenPlugins).toHaveBeenCalledTimes(1)
  })

  test('opens appearance settings on mobile', async () => {
    render(
      <AppearanceProvider>
        <MobileSettingsPage onBack={vi.fn()} />
      </AppearanceProvider>
    )

    await userEvent.click(screen.getByTestId('mobile-settings-personal-button'))
    await userEvent.click(screen.getByTestId('mobile-settings-appearance-button'))

    expect(screen.getByTestId('mobile-appearance-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('appearance-settings-page')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-appearance-back-button'))
    expect(screen.getByTestId('mobile-personal-settings-page')).toBeInTheDocument()
  })

  test('opens context settings on mobile', async () => {
    render(
      <AppearanceProvider>
        <MobileSettingsPage
          onBack={vi.fn()}
          devices={[
            {
              id: 1,
              device_id: 'server-a',
              name: 'Server A',
              status: 'online',
              is_default: true,
            },
            {
              id: 2,
              device_id: 'server-b',
              name: 'Server B',
              status: 'online',
              is_default: false,
            },
          ]}
        />
      </AppearanceProvider>
    )

    await userEvent.click(screen.getByTestId('mobile-settings-personal-button'))
    await userEvent.click(screen.getByTestId('mobile-settings-context-button'))

    expect(screen.getByTestId('mobile-context-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('context-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('context-runtime-target-select')).toHaveValue('server-a')
    expect(screen.getByTestId('codex-personality-select')).toHaveTextContent('务实')
    await userEvent.click(screen.getByTestId('codex-personality-select'))
    await userEvent.click(screen.getByTestId('codex-personality-option-friendly'))
    expect(screen.getByTestId('codex-personality-select')).toHaveTextContent('亲和')

    await userEvent.click(screen.getByTestId('mobile-context-back-button'))
    expect(screen.getByTestId('mobile-personal-settings-page')).toBeInTheDocument()
  })

  test('opens about settings on mobile', async () => {
    render(
      <AppearanceProvider>
        <MobileSettingsPage onBack={vi.fn()} />
      </AppearanceProvider>
    )

    await userEvent.click(screen.getByTestId('mobile-settings-personal-button'))
    await userEvent.click(screen.getByTestId('mobile-settings-about-button'))

    expect(screen.getByTestId('mobile-about-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('about-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('about-check-update-button')).toBeInTheDocument()
    expect(screen.getByTestId('about-link-github')).toBeInTheDocument()
    expect(screen.queryByTestId('about-link-discord')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-about-back-button'))
    expect(screen.getByTestId('mobile-personal-settings-page')).toBeInTheDocument()
  })
})
