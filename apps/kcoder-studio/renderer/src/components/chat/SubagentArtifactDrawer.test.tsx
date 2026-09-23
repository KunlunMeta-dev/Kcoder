import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { SubagentArtifactDrawer } from './SubagentArtifactDrawer'

function renderDrawer(overrides: Partial<Parameters<typeof SubagentArtifactDrawer>[0]> = {}) {
  const onClose = vi.fn()
  const view = render(
    <SubagentArtifactDrawer
      open
      title="output.md"
      content={'# report\nline two'}
      truncated={false}
      loading={false}
      error={null}
      onClose={onClose}
      {...overrides}
    />
  )
  return { onClose, view }
}

describe('SubagentArtifactDrawer', () => {
  test('renders the report as read-only preformatted text', () => {
    renderDrawer()

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByTestId('subagent-artifact-drawer').className).toContain('w-[560px]')
    expect(screen.getByText('output.md')).toBeInTheDocument()
    const content = screen.getByTestId('subagent-artifact-content')
    expect(content.tagName).toBe('PRE')
    expect(content.className).toContain('whitespace-pre-wrap')
    expect(content).toHaveTextContent('line two')
    expect(screen.queryByTestId('subagent-artifact-truncated')).not.toBeInTheDocument()
    expect(screen.queryByTestId('subagent-artifact-loading')).not.toBeInTheDocument()
    expect(screen.queryByTestId('subagent-artifact-error')).not.toBeInTheDocument()
  })

  test('announces a truncated report instead of pretending it is complete', () => {
    renderDrawer({ truncated: true })

    expect(screen.getByTestId('subagent-artifact-truncated')).toHaveTextContent(
      /subagent_artifact_truncated|报告过大/
    )
  })

  test('renders loading and failure states without the report text', () => {
    const loadingRender = renderDrawer({ loading: true })
    expect(screen.getByTestId('subagent-artifact-loading')).toHaveTextContent(
      /subagent_artifact_loading|正在加载报告/
    )
    expect(screen.queryByTestId('subagent-artifact-content')).not.toBeInTheDocument()

    loadingRender.view.unmount()
    const errorRender = renderDrawer({ error: 'server exploded' })
    expect(screen.getByTestId('subagent-artifact-error')).toHaveTextContent('server exploded')
    expect(screen.queryByTestId('subagent-artifact-content')).not.toBeInTheDocument()

    errorRender.view.unmount()
    renderDrawer({ error: '' })
    expect(screen.getByTestId('subagent-artifact-error')).toHaveTextContent(
      /subagent_artifact_error|报告读取失败/
    )
  })

  test('closes through the close button, the overlay, and Escape', () => {
    const { onClose, view } = renderDrawer()

    fireEvent.click(screen.getByTestId('subagent-artifact-close'))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('subagent-artifact-overlay'))
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(3)

    view.unmount()
    renderDrawer()
    fireEvent.click(screen.getByTestId('subagent-artifact-content'))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  test('renders nothing while closed', () => {
    renderDrawer({ open: false })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByTestId('subagent-artifact-overlay')).not.toBeInTheDocument()
  })
})
