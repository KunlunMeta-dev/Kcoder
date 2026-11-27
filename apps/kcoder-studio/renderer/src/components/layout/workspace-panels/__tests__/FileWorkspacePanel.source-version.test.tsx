import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { FileWorkspacePanel } from '../FileWorkspacePanel'

vi.mock('@/lib/local-terminal', () => ({ isLocalTerminalAvailable: () => false, listLocalFileOpeners: async () => ({ applications: [], default_path: null }) }))
vi.mock('../WorkspaceFileTree', () => ({ WorkspaceFileTree: () => null }))
vi.mock('../WorkspaceFilePreview', () => ({ WorkspaceFilePreview: (props: { file: { revision: string } | null; sourceRevision?: string }) => <div>{props.file && <span data-testid="version-forwarded">{props.sourceRevision}</span>}</div> }))

test('carries the task revision through the normal open request while the read revision stays authoritative', async () => {
  const read = vi.fn(async () => ({ path: '/workspace/report.txt', name: 'report.txt', content: 'new', revision: 'native-current', editable: true, truncated: false, size: 3 }))
  render(<FileWorkspacePanel target={{ deviceId: 'device', path: '/workspace', source: 'runtime', workspaceSource: 'remote' }}
    workspaceFileApi={{ listWorkspaceEntries: vi.fn(async () => ({ path: '/workspace', entries: [] })), readWorkspaceTextFile: read }}
    openFileRequest={{ id: 1, path: 'report.txt', isDirectory: false, sourceRevision: 'native-original' }} onAddCodeComment={vi.fn()} />)
  expect(await screen.findByTestId('version-forwarded')).toHaveTextContent('native-original')
  expect(read).toHaveBeenCalledWith('device', '/workspace/report.txt')
})
