import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { MarkdownMermaidBlock } from './MarkdownMermaidBlock'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./MarkdownMermaidRenderer', () => { throw new Error('Controlled diagram chunk failure') })

test('a failed diagram chunk stays inside the existing local error boundary', async () => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    render(<><p>Other conversation content remains usable.</p><MarkdownMermaidBlock chart={'graph TD\n  A --> B'} /></>)
    const failure = await screen.findByTestId('markdown-mermaid-error')
    expect(failure).toHaveTextContent('graph TD')
    expect(failure).toHaveTextContent('A --> B')
    expect(screen.getByText('Other conversation content remains usable.')).toBeInTheDocument()
    expect(screen.queryByTestId('markdown-mermaid-loading')).not.toBeInTheDocument()
    expect(diagnostic).toHaveBeenCalled()
  } finally {
    diagnostic.mockRestore()
  }
})
