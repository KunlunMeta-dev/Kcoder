import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { SettingsDirectory } from './SettingsDirectory'
import { availableSettings, settingsFromPath, settingsPath } from './settingsNavigation'

vi.mock('@/config/runtime', () => ({ stripAppBasePath: (path: string) => path }))

describe('self-evolution settings entry', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
  })

  test('sits right after Context in the conversation group with the same availability', () => {
    for (const [layout, gateway, titlebar] of [
      ['desktop', true, true],
      ['desktop', false, false],
      ['mobile', true, false],
    ] as const) {
      const entries = availableSettings(layout, gateway, titlebar)
      const keys = entries.filter(item => item.group === 'conversation').map(item => item.key)
      expect(keys.indexOf('self-evolution')).toBe(keys.indexOf('context') + 1)
    }
    const entry = availableSettings('desktop', true, false).find(item => item.key === 'self-evolution')!
    expect(settingsPath(entry)).toBe('/settings/personal/self-evolution')
    expect(settingsFromPath('/settings/personal/self-evolution/', [entry])?.key).toBe('self-evolution')
  })

  test.each(['自进化', '学习', '技能', '偏好', '反馈', '评分'])('search finds it by “%s”', async word => {
    const onChoose = vi.fn()
    render(<SettingsDirectory entries={availableSettings('desktop', true, false)} onChoose={onChoose} />)
    fireEvent.change(screen.getByTestId('settings-search'), { target: { value: word } })
    const button = screen.getByText('自进化').closest('button')!
    expect(button).toBeVisible()
    fireEvent.click(button)
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ key: 'self-evolution' }))
  })

  test('has English labels and search terms', async () => {
    await i18n.changeLanguage('en')
    render(<SettingsDirectory entries={availableSettings('desktop', true, false)} onChoose={vi.fn()} />)
    fireEvent.change(screen.getByTestId('settings-search'), { target: { value: 'rating' } })
    expect(screen.getByText('Self-evolution')).toBeVisible()
  })
})
