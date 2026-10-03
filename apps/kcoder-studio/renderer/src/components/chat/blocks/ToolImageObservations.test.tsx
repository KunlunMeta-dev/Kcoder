import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ToolImageObservations } from './ToolImageObservations'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const output = { output: 'Screen state', images: [{ mimeType: 'image/png', data: 'YWJj' }] }
test('renders observation without JSON bytes and opens then closes preview', () => {
  render(<ToolImageObservations output={output} />)
  expect(screen.getByText('Screen state')).toBeVisible()
  expect(screen.queryByText('YWJj')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'toolImages.open' }))
  expect(screen.getByRole('dialog')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'toolImages.close' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
test('image decode failure becomes a readable status', () => {
  render(<ToolImageObservations output={output} />)
  fireEvent.error(screen.getByRole('img'))
  expect(screen.getByRole('status')).toHaveTextContent('toolImages.failed')
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})
test('rejects active image formats and reports omitted observations', () => {
  render(
    <ToolImageObservations
      output={{ output: 'Screen state', images: [{ mimeType: 'image/svg+xml', data: 'YWJj' }] }}
    />
  )
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('toolImages.omitted')
})

test('small image reports dimensions warning without replacing native image', () => {
  render(<ToolImageObservations output={output} />)
  const image = screen.getByRole('img')
  Object.defineProperty(image, 'naturalWidth', { value: 16 })
  Object.defineProperty(image, 'naturalHeight', { value: 16 })
  fireEvent.load(image)
  expect(screen.getByRole('status')).toHaveTextContent('imageFeedback.small')
  expect(screen.getByRole('img')).toBeVisible()
})
