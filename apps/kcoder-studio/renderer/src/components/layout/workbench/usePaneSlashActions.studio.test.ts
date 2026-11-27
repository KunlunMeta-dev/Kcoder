import { renderHook } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { SlashCommand } from '@/components/chat/composer/composerAutocomplete'
import { kcoderSlashCatalog } from '@/components/chat/composer/slashCatalog'
import type { RuntimeTaskAddress } from '@/types/api'
import type { RuntimeSubagentStatus } from '@/types/workbench'
import type { WorkbenchPaneSession } from '../useWorkbenchPaneSession'
import type { PaneSlashIntegrations } from './paneSlashDesktopCommands'
import { studioSlashDisposition } from './studioSlashPolicy'
import { usePaneSlashActions } from './usePaneSlashActions'

const mocks = vi.hoisted(() => ({
  navigateTo: vi.fn(),
  terminalRun: vi.fn(),
}))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    openStandaloneWorkspace: vi.fn(),
    renameRuntimeTask: vi.fn(),
    selectProjectWorkspace: vi.fn(),
    openRuntimeTask: vi.fn(),
    searchRuntimeWork: vi.fn(),
  }),
}))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/lib/navigation', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/navigation')>()),
  navigateTo: mocks.navigateTo,
}))
vi.mock('./useNativeSlashTerminal', () => ({
  useNativeSlashTerminal: () => ({
    run: mocks.terminalRun, launch: null, close: vi.fn(), markExited: vi.fn(),
  }),
}))

const address: RuntimeTaskAddress = {
  deviceId: 'remote-b', taskId: 'task-1', threadId: 'thread-1', workspacePath: '/work/b',
}
const agents: RuntimeSubagentStatus[] = [
  { id: 'a1', agentId: 'agent-1', agentPath: '/a1', agentName: 'Reviewer', status: 'running' },
  { id: 'a2', agentId: 'agent-2', agentPath: '/a2', agentName: 'Writer', status: 'done' },
]

function makeSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    status: { isBusy: false },
    messages: [],
    queuedMessages: [],
    subagentStatuses: agents,
    transcriptHasMoreBefore: false,
    taskPlan: null,
    steerSubagent: vi.fn(async () => true),
    pauseCurrentResponse: vi.fn(async () => undefined),
    clearQueuedMessages: vi.fn(),
    loadFullTranscriptForExport: vi.fn(async () => []),
    ...overrides,
  } as unknown as WorkbenchPaneSession
}

function render(
  integrations: PaneSlashIntegrations = {},
  session: WorkbenchPaneSession = makeSession(),
  layout: 'desktop' | 'mobile' = 'desktop'
) {
  return renderHook(() => usePaneSlashActions(address, undefined, undefined, true, {
    session, isGateway: true, layout, integrations,
  })).result.current.commands
}

/** Mirrors ComposerTextarea: the first entry that accepts the arguments wins. */
function resolve(commands: SlashCommand[], name: string, args = '') {
  const matches = commands.filter(command => command.title === name || command.aliases?.includes(name))
  return matches.find(command => (!args || command.acceptsArguments) &&
    (command.matchesArguments?.(args) ?? true) && (!command.requiresArguments || args))
}

beforeEach(() => {
  vi.clearAllMocks()
})

test('every REPL catalog command has a Studio disposition', () => {
  for (const command of kcoderSlashCatalog) {
    expect(studioSlashDisposition[command.name], command.name).toBeDefined()
  }
  expect(Object.keys(studioSlashDisposition).sort())
    .toEqual(kcoderSlashCatalog.map(command => command.name).sort())
})

test('/btw opens the temporary chat and submits the question instead of the terminal', async () => {
  const openTemporaryChat = vi.fn()
  const commands = render({ openTemporaryChat })
  expect(commands.filter(command => command.title === '/btw')).toHaveLength(1)
  const btw = resolve(commands, '/btw', 'what changed?')
  expect(btw?.group).toBeUndefined()
  expect(btw?.requiresArguments).toBeFalsy()
  await btw?.run?.('what changed?')
  expect(openTemporaryChat).toHaveBeenCalledWith('what changed?', { submit: true })
  await resolve(commands, '/btw')?.run?.('')
  expect(openTemporaryChat).toHaveBeenLastCalledWith(undefined, { submit: false })
  expect(mocks.terminalRun).not.toHaveBeenCalled()
})

test('Studio handlers precede terminal fallbacks for hybrid commands', async () => {
  const commands = render()
  const workflow = commands.filter(command => command.title === '/workflow')
  expect(workflow[0].group).toBeUndefined()
  expect(workflow.at(-1)?.metaLabel).toBe('workbench.slash_native_meta')
  expect(resolve(commands, '/workflow')).toBe(workflow[0])
  const fallback = resolve(commands, '/workflow', 'run build')
  expect(fallback).toBe(workflow.at(-1))
  await fallback?.run?.('run build')
  // `/workflow` is workspace-scoped in the REPL registry, so no thread is attached.
  expect(mocks.terminalRun).toHaveBeenCalledWith('/workflow run build', undefined)

  const mcp = resolve(commands, '/mcp', 'verbose')
  await mcp?.run?.('verbose')
  expect(mocks.navigateTo).toHaveBeenCalledWith('/plugins/manage?view=mcp')
  expect(commands.filter(command => command.title === '/mcp')).toHaveLength(1)
  await resolve(commands, '/migration')?.run?.('')
  expect(mocks.navigateTo).toHaveBeenLastCalledWith('/settings/general?migration=open')
  expect(resolve(commands, '/migration', 'scan')?.metaLabel).toBe('workbench.slash_native_meta')
})

test('mobile layouts omit terminal fallbacks and desktop-only integrations', () => {
  const commands = render({}, makeSession(), 'mobile')
  for (const name of ['/spec', '/undo', '/btw', '/debug']) {
    expect(commands.some(command => command.title === name), name).toBe(false)
  }
  expect(commands.some(command => command.metaLabel)).toBe(false)
  expect(resolve(commands, '/stop')).toBeDefined()
})
