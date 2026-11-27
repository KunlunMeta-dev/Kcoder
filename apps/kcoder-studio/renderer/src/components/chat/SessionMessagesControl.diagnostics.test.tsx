import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import { SessionMessagesControl } from './SessionMessagesControl'

const store = vi.hoisted(() => ({ snapshot: {} as Record<string, unknown>, listeners: new Set<() => void>(), copy: vi.fn(async () => {}) }))
vi.mock('../../../../shared/agentMessageController', () => ({
  AgentMessageController: class {
    getSnapshot = () => store.snapshot
    subscribe = (listener: () => void) => { store.listeners.add(listener); return () => store.listeners.delete(listener) }
    activate() {} dispose() {} async load() {} canSend() { return false } retryCandidate() { return undefined }
  }, agentMessageTargetKey: () => 'unused',
}))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => ({ openRuntimeTask: vi.fn() }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({ usePluginTargetScope: () => ({ key: 'diagnostic-ui-owner', isCurrent: () => true }) }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
beforeAll(async () => { await createInstance().use(initReactI18next).init({ lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false } }) })
beforeEach(() => {
  store.listeners.clear(); store.copy.mockClear()
  store.snapshot = { loading: false, busy: false, targets: [], observations: [], absent: [], draft: '', mode: 'enqueue_only', error: 'read_failed',
    readDiagnostic: { stage: 'targets', reason: 'peer_source_permissions_busy' } }
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: store.copy } })
})
afterEach(cleanup)
async function open() {
  render(<SessionMessagesControl address={{ deviceId: 'fixture', taskId: 'fixture', threadId: 'fixture', workspacePath: '/fixture' }} />)
  fireEvent.click(screen.getByTestId('session-messages-open'))
  await waitFor(() => expect(screen.getByTestId('session-message-diagnostic-open')).toBeEnabled())
}
function publish(update: Record<string, unknown>) { store.snapshot = { ...store.snapshot, ...update }; store.listeners.forEach(listener => listener()) }

test('safe diagnostics open above the modal, support keyboard focus and copy only closed codes', async () => {
  await open()
  const trigger = screen.getByTestId('session-message-diagnostic-open')
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const menu = await screen.findByRole('menu')
  await waitFor(() => expect(menu.style.zIndex).toBe('var(--z-critical)'))
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByTestId('session-message-diagnostic-stage')).toHaveTextContent('Read visible sessions')
  expect(screen.getByTestId('session-message-diagnostic-reason')).toHaveTextContent('peer_source_permissions_busy')
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('session-message-diagnostic-copy')))
  fireEvent.click(screen.getByTestId('session-message-diagnostic-copy'))
  await waitFor(() => expect(store.copy).toHaveBeenCalledWith('session_messages_read\nstage: targets\nreason: peer_source_permissions_busy'))
})

test('loading and success hide diagnostics inside the same fixed responsive slot without replacing the dialog', async () => {
  await open()
  const dialog = screen.getByTestId('session-messages-dialog'), slot = screen.getByTestId('session-message-diagnostic-slot')
  expect(slot).toHaveClass('size-8', 'max-md:size-11')
  fireEvent.click(screen.getByTestId('session-message-diagnostic-open'))
  expect(await screen.findByRole('menu')).toBeInTheDocument()
  await act(async () => publish({ loading: true, error: undefined }))
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(screen.getByTestId('session-message-diagnostic-slot')).toBe(slot)
  expect(slot).toHaveClass('invisible')
  expect(slot).toHaveAttribute('aria-hidden', 'true')
  await act(async () => publish({ loading: false, readDiagnostic: undefined }))
  expect(screen.getByTestId('session-messages-dialog')).toBe(dialog)
  expect(screen.getByTestId('session-message-diagnostic-slot')).toBe(slot)
})

test('unrecognized or decorated diagnostic payloads never reach the DOM or clipboard', async () => {
  store.snapshot.readDiagnostic = { stage: 'targets', reason: 'PRIVATE_FIXTURE_IDENTITY_AND_CONTENT', rawError: 'PRIVATE_FIXTURE_TOKEN' }
  await open(); fireEvent.click(screen.getByTestId('session-message-diagnostic-open'))
  expect(await screen.findByRole('menu')).not.toHaveTextContent('PRIVATE_FIXTURE')
  fireEvent.click(screen.getByTestId('session-message-diagnostic-copy'))
  await waitFor(() => expect(store.copy).toHaveBeenCalledWith('session_messages_read\nstage: unknown\nreason: unknown'))
})
