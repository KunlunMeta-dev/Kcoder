import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ChannelFeatureSettings } from './ChannelFeatureSettings'
import { channelPlatforms, type ChannelPlatform } from '@/kcoder/channelPlatforms'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

for (const platform of Object.keys(channelPlatforms) as ChannelPlatform[]) test(`${platform} shows only its declared features, collapsed by default`, () => {
  const change = vi.fn()
  render(<ChannelFeatureSettings platform={platform} value={{}} disabled={false} onChange={change} />)
  expect(screen.getByTestId('channel-feature-settings')).not.toHaveAttribute('open')
  expect(screen.getByText('channelFeatures.values.final')).toBeInTheDocument()
  expect(screen.queryByText('channelFeatures.values.stream')).not.toBeInTheDocument()
  expect(screen.queryByRole('switch', { name: 'channelFeatures.fields.showTyping' }) !== null).toBe(platform === 'feishu')
  expect(screen.queryByRole('spinbutton') !== null).toBe(platform === 'github')
  expect(change).not.toHaveBeenCalled()
})

test('the shared boolean control changes only this draft and preserves its other fields', () => {
  const change = vi.fn()
  render(<ChannelFeatureSettings platform="feishu" value={{ showTyping: true, messageFormat: 'plain' }} disabled={false} onChange={change} />)
  fireEvent.click(screen.getByRole('switch'))
  expect(change).toHaveBeenCalledWith({ showTyping: false, messageFormat: 'plain' })
})

test('active connections cannot edit any functional control', () => {
  render(<ChannelFeatureSettings platform="github" value={{}} disabled onChange={vi.fn()} />)
  expect(screen.getByRole('spinbutton')).toBeDisabled()
  expect(screen.getByRole('combobox')).toBeDisabled()
})
