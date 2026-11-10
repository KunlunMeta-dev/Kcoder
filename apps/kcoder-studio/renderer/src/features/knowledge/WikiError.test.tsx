import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { WikiError } from './WikiError'

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

test('explains capacity refusal without blaming the target connection and retains diagnostics', () => {
  render(<WikiError error="knowledge service is busy" />)
  expect(screen.getByRole('alert')).toHaveTextContent('知识服务当前繁忙，请稍后重试。')
  expect(screen.getByRole('alert')).not.toHaveTextContent('检查当前目标连接')
  expect(screen.getByText('knowledge service is busy')).toBeInTheDocument()
})

test('distinguishes transport failures from unclassified operation errors', () => {
  const view = render(<WikiError error="connect ECONNREFUSED 127.0.0.1" />)
  expect(screen.getByRole('alert')).toHaveTextContent('暂时无法与当前目标通信，请检查连接后重试。')
  view.rerender(<WikiError error="SQLite constraint failed" />)
  expect(screen.getByRole('alert')).toHaveTextContent('操作未完成，请查看详细原因。')
  expect(screen.getByRole('alert')).not.toHaveTextContent('检查连接')
})

test('reload requires an explicit click and remains disabled while reading', () => {
  const reload = vi.fn()
  const view = render(<WikiError error="knowledge service is busy" onReload={reload} reloading />)
  const button = screen.getByRole('button', { name: '重新加载' })
  expect(button).toBeDisabled()
  fireEvent.click(button)
  expect(reload).not.toHaveBeenCalled()
  view.rerender(<WikiError error="knowledge service is busy" onReload={reload} />)
  fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
  expect(reload).toHaveBeenCalledTimes(1)
})
