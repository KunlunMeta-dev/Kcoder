import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import fixtures from '../../../../../shared/generated/examples.web-sources.json'
import { normalizeWebSources, type WebSourcesV1 } from '../../../../../shared/webSources'
import { NativeWebSources } from './NativeWebSources'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/lib/external-links', () => ({ openExternalUrl: vi.fn(async () => {}) }))
const receipt = normalizeWebSources(
  fixtures.WebSourcesToolResultV1.find(value => value.name === 'native-summary')!.value.webSources,
  { toolCallId: 'search-1' }
)!
const attempts: WebSourcesV1['attempts'] = [
  { provider: 'exa-public', status: 'failed', elapsedMs: 20, error: 'network', requestSent: true },
  { provider: 'searxng-bundled', status: 'failed', elapsedMs: 2, error: 'component_unavailable', requestSent: false },
  { provider: 'bing-html', status: 'success', elapsedMs: 10, requestSent: true },
]

test('terminal source switching is visible while real attempts remain in the same disclosure', () => {
  const sources = Array.from({ length: 4 }, (_, index) => ({ ...receipt.sources[0], sourceId: 'native-large-' + index }))
  const fallback = normalizeWebSources({ ...receipt, sources, status: 'success', provider: 'bing-html', attempts }, { toolCallId: 'search-1' })!
  render(<NativeWebSources receipt={fallback} />)
  expect(screen.getByTestId('native-source-switch')).toHaveTextContent('web_sources.switched')
  expect(screen.queryByTestId('native-source-attempts')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  expect(screen.getAllByTestId('native-source-attempt')).toHaveLength(3)
  expect(screen.getByTestId('native-source-attempts')).toHaveTextContent('exa-public · web_sources.failed')
  expect(screen.getByTestId('native-source-attempts')).toHaveTextContent('searxng-bundled · web_sources.failed')
  expect(screen.getByTestId('native-source-attempts')).toHaveTextContent('bing-html · web_sources.success')
})

test('one attempt and older missing attempts do not add switching chrome', () => {
  const legacy = Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'attempts'))
  for (const value of [receipt, legacy]) {
    const compatible = normalizeWebSources(value, { toolCallId: 'search-1' })!
    const view = render(<NativeWebSources receipt={compatible} />)
    expect(screen.queryByTestId('native-source-switch')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument()
    expect(screen.queryByTestId('native-source-attempts')).not.toBeInTheDocument()
    view.unmount()
  }
})

test('small sources start visible while larger cards remain folded and unknown states do not claim a past switch', () => {
  const small = render(<NativeWebSources receipt={receipt} />)
  expect(screen.getByRole('link')).toBeVisible()
  small.unmount()
  const sources = Array.from({ length: 4 }, (_, index) => ({ ...receipt.sources[0], sourceId: 'native-large-' + index }))
  const large = render(<NativeWebSources receipt={{ ...receipt, sources }} />)
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  large.unmount()
  render(<NativeWebSources receipt={{ ...receipt, attempts, status: 'running' as never }} />)
  expect(screen.queryByTestId('native-source-switch')).not.toBeInTheDocument()
})

test('switching does not turn empty or cancelled receipts into success', () => {
  for (const status of ['empty', 'cancelled'] as const) {
    const value = { ...receipt, status, sources: [], attempts: [...attempts.slice(0, 2), { ...attempts[2], status }] }
    const view = render(<NativeWebSources receipt={value} />)
    expect(screen.getByRole('button')).toHaveTextContent('web_sources.search · web_sources.' + status)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByTestId('native-source-attempts')).not.toHaveTextContent('web_sources.success')
    view.unmount()
  }
})

test('source pages use ten rows and preserve native reading facts', () => {
  const sources = Array.from({ length: 11 }, (_, index) => ({
    ...receipt.sources[0],
    sourceId: `native-${index}`,
    title: `Source ${index}`,
    cacheHit: true,
  }))
  render(<NativeWebSources receipt={{ ...receipt, sources }} />)
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  expect(screen.getAllByRole('link')).toHaveLength(10)
  expect(
    screen.getAllByText('example.com · web_sources.read_summary_only · web_sources.cached')
  ).toHaveLength(10)
  expect(screen.getAllByText('web_sources.published 2026-10-30')).toHaveLength(10)
  expect(screen.getAllByTitle('2026-10-31T00:00:00Z')).toHaveLength(10)
  for (const value of screen.getAllByTitle('2026-10-31T00:00:00Z')) expect(value).not.toHaveTextContent('T00:00:00Z')
  fireEvent.click(screen.getByRole('button', { name: 'web_sources.next' }))
  expect(screen.getAllByRole('link')).toHaveLength(1)
  expect(screen.getByRole('link')).toHaveTextContent('Source 10')
})
test('small and cancelled results have no empty pagination or running spinner', () => {
  const { container } = render(
    <NativeWebSources
      receipt={{ ...receipt, status: 'cancelled', sources: receipt.sources.slice(0, 1) }}
    />
  )
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  expect(screen.getByText('web_sources.search · web_sources.cancelled (1)')).toBeInTheDocument()
  expect(container.querySelector('.animate-spin')).toBeNull()
})

test('reading and unreadable observations stay distinct from search summaries', () => {
  render(<NativeWebSources receipt={{ ...receipt, operation: 'fetch', sources: ['summary_only', 'read', 'partial', 'unreadable'].map((readStatus, index) => ({ ...receipt.sources[0], sourceId: `native-status-${index}`, readStatus: readStatus as 'summary_only' | 'read' | 'partial' | 'unreadable' })) }} />)
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  for (const status of ['summary_only', 'read', 'partial', 'unreadable']) expect(screen.getByText(`example.com · web_sources.read_${status}`)).toBeInTheDocument()
})

test('ordinary result text remains separate from trusted source cards', async () => {
  const { NativeWebToolOutput } = await import('./NativeWebToolOutput')
  render(<NativeWebToolOutput block={{ id: 'fetch', subtaskId: 'turn', type: 'tool', toolName: 'WebFetch', status: 'error', createdAt: 1, toolOutput: JSON.stringify({ webSources: { ...receipt, attempts }, error: 'Page requires login' }) }} />)
  expect(screen.getByTestId('web-tool-output')).toHaveTextContent('Page requires login')
  expect(screen.queryByTestId('native-web-sources')).not.toBeInTheDocument()
  expect(screen.queryByTestId('native-source-switch')).not.toBeInTheDocument()
})
