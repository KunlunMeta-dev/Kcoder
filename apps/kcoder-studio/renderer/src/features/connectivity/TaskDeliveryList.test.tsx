import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ChannelDelivery } from '@/kcoder/channels'
import { TaskDeliveryList } from './TaskDeliveryList'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

const rejected: ChannelDelivery = { deliveryId: 'original', deliveryState: 'failed', phase: 'result', code: 'WEIXIN_SEND_PREPARATION_FAILED' }

test('Weixin preparation rejection explains recovery without offering automatic resend or reauthorization', () => {
  render(<TaskDeliveryList deliveries={[rejected]} />)
  expect(screen.getByText('chatTasks.deliveries.weixinPrepareFailedHint')).toBeInTheDocument()
  expect(screen.getByText('WEIXIN_SEND_PREPARATION_FAILED')).toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

test('an uncertain send keeps its unknown-outcome guidance instead of claiming context rejection', () => {
  render(<TaskDeliveryList deliveries={[{ ...rejected, deliveryState: 'unknown' }]} />)
  expect(screen.getByText('chatTasks.deliveries.unknownHint')).toBeInTheDocument()
  expect(screen.queryByText('chatTasks.deliveries.weixinPrepareFailedHint')).not.toBeInTheDocument()
})
