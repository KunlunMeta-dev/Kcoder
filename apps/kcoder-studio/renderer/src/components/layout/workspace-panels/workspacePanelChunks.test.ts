import { createElement, Suspense, type ComponentType } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const loaded = vi.hoisted(() => [] as string[])
vi.mock('./EmbeddedLocalTerminal', () => {
  loaded.push('terminal')
  return { EmbeddedLocalTerminal: () => createElement('div', { 'data-testid': 'terminal' }) }
})
vi.mock('./RemoteTerminal', () => {
  loaded.push('remoteTerminal')
  return { RemoteTerminal: () => createElement('div', { 'data-testid': 'remoteTerminal' }) }
})
vi.mock('@/kcoder/SshTerminalPane', () => {
  loaded.push('sshTerminal')
  return { SshTerminalPane: () => createElement('div', { 'data-testid': 'sshTerminal' }) }
})
vi.mock('./FileWorkspacePanel', () => {
  loaded.push('files')
  return { FileWorkspacePanel: () => createElement('div', { 'data-testid': 'files' }) }
})
vi.mock('@/components/chat/FileChangesReviewPanel', () => {
  loaded.push('changes')
  return { FileChangesReviewPanel: () => createElement('div', { 'data-testid': 'changes' }) }
})

beforeEach(() => {
  vi.resetModules()
  loaded.length = 0
})
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

test.each([false, true])('panel entries do not load unrequested code in production=%s', async production => {
  vi.stubEnv('PROD', production)
  const idle = vi.fn()
  vi.stubGlobal('requestIdleCallback', idle)
  await import('./workspacePanelChunks')
  expect(idle).not.toHaveBeenCalled()
  expect(loaded).toEqual([])
})

test.each([
  ['terminal', 'LazyEmbeddedLocalTerminal'],
  ['remoteTerminal', 'LazyRemoteTerminal'],
  ['sshTerminal', 'LazySshTerminalPane'],
  ['files', 'LazyFileWorkspacePanel'],
  ['changes', 'LazyFileChangesReviewPanel'],
] as const)('rendering %s loads only that panel and reuses its loaded module', async (name, entry) => {
  vi.stubEnv('PROD', true)
  const chunks = await import('./workspacePanelChunks')
  // Mock leaves accept no props; the real panel contracts are covered by their consumer tests.
  const Panel = chunks[entry] as ComponentType
  const view = render(createElement(Suspense, { fallback: null }, createElement(Panel)))
  await screen.findByTestId(name)
  expect(loaded).toEqual([name])
  view.unmount()
  render(createElement(Suspense, { fallback: null }, createElement(Panel)))
  await screen.findByTestId(name)
  expect(loaded).toEqual([name])
})
