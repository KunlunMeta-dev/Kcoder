import { act, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { downloadLink } from './downloadLink'
import { DesktopDownloadStatus } from './DesktopDownloadStatus'

beforeEach(() => {
  delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost
})
test('browser exports preserve link download behavior', () => {
  const link = document.createElement('a')
  link.href = 'blob:owned'
  link.download = 'owned.txt'
  link.click = vi.fn()
  downloadLink(link)
  expect(link.click).toHaveBeenCalledOnce()
})
test('native cancelled save remains observable and is displayed', async () => {
  const download = vi.fn(async () => ({ status: 'cancelled', filename: 'owned.txt' }))
  Object.assign(window, { kcoderDesktopHost: { download } })
  render(<DesktopDownloadStatus />)
  const link = document.createElement('a')
  link.href = 'blob:owned'
  link.download = 'owned.txt'
  link.click = vi.fn()
  await act(async () => {
    downloadLink(link)
  })
  expect(download).toHaveBeenCalledWith({ url: 'blob:owned', filename: 'owned.txt' })
  expect(link.click).not.toHaveBeenCalled()
  expect(screen.getByRole('status')).toHaveTextContent(/Download cancelled|下载已取消/)
})

test('a rejected Native file read is visible even when a caller consumes the error', () => {
  render(<DesktopDownloadStatus />)
  act(() => {
    window.dispatchEvent(
      new CustomEvent('kcoder:native-file-read-error', {
        detail: { upgrade: true, message: 'Native upgrade required' },
      })
    )
  })
  expect(screen.getByRole('status')).toHaveTextContent(
    /Update the desktop application|请更新桌面应用/
  )
})
