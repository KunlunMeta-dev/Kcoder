import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { ArrowUpRight, Copy, Info, MessagesSquare, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { ActionMenu } from '@/components/common/ActionMenu'
import { useTranslation } from '@/hooks/useTranslation'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { requestLocalExecutor } from '@/host/localExecutor'
import { createRandomUuid } from '@/lib/random-id'
import { runtimeTaskAddressKey, runtimeThreadId } from '@/lib/runtime-thread-id'
import { resolveAgentMessageNavigation } from '@/kcoder/agentMessageNavigation'
import type { RuntimeTaskAddress } from '@/types/api'
import { AgentMessageController, agentMessageTargetKey, type AgentMessageSupport, type AddressedMessageTarget } from '../../../../shared/agentMessageController'
import { AgentMessageJournal } from '../../../../shared/agentMessageJournal'
import { isAgentMessageReadDiagnostic } from '../../../../shared/agentMessageReadDiagnostic.mjs'
import { validAgentMessageTargetQuery } from '../../../../shared/agentMessageMethods.mjs'

const panelErrors = ['read_failed', 'send_unknown', 'record_failed', 'receipt_failed', 'recovery_write_failed', 'resolve_first', 'policy_unknown'] as const

export function SessionMessagesControl({ address, className }: { address: RuntimeTaskAddress; className?: string }) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const scope = usePluginTargetScope(open ? address.deviceId : undefined, address.workspacePath ?? undefined)
  return <>
    <Button variant="ghost" size="icon" className={className} data-testid="session-messages-open"
      aria-label={t('peerMessages.title')} title={t('peerMessages.title')} disabled={!runtimeThreadId(address)} onClick={() => setOpen(true)}>
      <MessagesSquare className="size-4" aria-hidden="true" />
    </Button>
    {open && <SessionMessagesDialog key={JSON.stringify([scope.key, runtimeTaskAddressKey(address)])} address={address} current={scope.isCurrent} onClose={() => setOpen(false)} />}
  </>
}
// Mount lifetime of one dialog, shared by its controller adapter and handlers.
class DialogLifetime {
  private live = true
  get mounted() { return this.live }
  mount() { this.live = true }
  unmount() { this.live = false }
}

// The keyed dialog owns this exact displayed address and account lifetime, so
// the controller is created once and never rebound to another address.
function createDialogController(address: RuntimeTaskAddress, current: () => boolean) {
  const lifetime = new DialogLifetime()
  const controller = new AgentMessageController({
    current: () => lifetime.mounted && current(),
    support: () => requestLocalExecutor('runtime.agentMessages.request', { address, operation: 'supports' }) as Promise<AgentMessageSupport>,
    request: (operation, input, expectedScope) => requestLocalExecutor('runtime.agentMessages.request', { address, operation, expectedScope, ...input }),
    createId: () => { if (!globalThis.crypto?.getRandomValues) throw new Error('secure_request_identity_unavailable'); return createRandomUuid() },
    journal: scope => new AgentMessageJournal(window.localStorage, scope, async work => {
      if (!navigator.locks || !lifetime.mounted || !current()) throw new Error('agent_message_recovery_lock_unavailable')
      return navigator.locks.request(`kcoder.agent-messages:${scope}`, async () => {
        if (!lifetime.mounted || !current()) throw new Error('agent_message_owner_changed')
        return work()
      })
    }),
  })
  return { controller, lifetime }
}
function SessionMessagesDialog({ address, current, onClose }: { address: RuntimeTaskAddress; current(): boolean; onClose(): void }) {
  const { t } = useTranslation('chat')
  const { openRuntimeTask } = useWorkbench()
  const [navigationFailed, setNavigationFailed] = useState(false)
  const [diagnosticCopy, setDiagnosticCopy] = useState<'copied' | 'copyFailed'>()
  const [searchDraft, setSearchDraft] = useState('')
  const searchInputId = useId()
  const [{ controller, lifetime }] = useState(() => createDialogController(address, current))
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  // A new support scope starts with an empty title-search draft.
  const supportScope = state.support?.scope
  const [draftScope, setDraftScope] = useState(supportScope)
  if (draftScope !== supportScope) { setDraftScope(supportScope); setSearchDraft('') }
  useEffect(() => { lifetime.mount(); controller.activate(); void controller.load(); return () => { lifetime.unmount(); controller.dispose() } }, [controller, lifetime])
  const messagesSupported = state.support?.messages === true
  const complete = (state.page as { completeness?: string } | undefined)?.completeness === 'complete'
  const diagnosticAvailable = state.error === 'read_failed'
  const diagnostic = isAgentMessageReadDiagnostic(state.readDiagnostic) ? state.readDiagnostic : undefined
  const diagnosticText = `session_messages_read\nstage: ${diagnostic?.stage ?? 'unknown'}\nreason: ${diagnostic?.reason ?? 'unknown'}`
  const searchSupported = state.support?.search === true
  const invalidSearch = !!searchDraft.trim() && !validAgentMessageTargetQuery({ title: searchDraft.trim() })
  const submitSearch = () => { if (!state.busy && searchSupported && !invalidSearch) void controller.search(searchDraft) }
  const openTarget = async (target: AddressedMessageTarget) => {
    const before = controller.getSnapshot()
    const key = agentMessageTargetKey(target)
    if (!current() || before.loading || before.busy || !before.targets.some(row => agentMessageTargetKey(row) === key)) return
    setNavigationFailed(false)
    try {
      const destination = await resolveAgentMessageNavigation({ ...address }, target.address ?? undefined, target.threadId)
      const latest = controller.getSnapshot()
      if (!lifetime.mounted || !current() || latest.loading || latest.searchTitle !== before.searchTitle ||
          !latest.targets.some(row => agentMessageTargetKey(row) === key)) return
      await openRuntimeTask(destination)
      if (lifetime.mounted && current()) onClose()
    } catch { if (lifetime.mounted && current()) setNavigationFailed(true) }
  }
  return <ModalDialog title={t('peerMessages.title')} testId="session-messages-dialog" onClose={onClose} closeLabel={t('peerMessages.close')} wide>
    <div className="space-y-4 pt-4">
      <div className="grid" data-testid="session-message-feedback">
        <p aria-hidden={state.loading || !!state.error} className={`col-start-1 row-start-1 text-sm text-muted-foreground ${state.loading || state.error ? 'invisible' : ''}`}>{t('peerMessages.description')}</p>
        <p role={state.loading && !state.error ? 'status' : undefined} aria-hidden={!state.loading || !!state.error}
          className={`col-start-1 row-start-1 text-sm text-muted-foreground ${!state.loading || state.error ? 'invisible' : ''}`}>{t('peerMessages.loading')}</p>
        {panelErrors.map(error => <p key={error} role={state.error === error ? 'alert' : undefined} aria-hidden={state.error !== error}
          className={`col-start-1 row-start-1 text-sm text-destructive ${state.error !== error ? 'invisible' : ''}`}>{t(`peerMessages.error.${error}`)}</p>)}
      </div>
      <div className="space-y-2" data-testid="session-message-search">
        <label className="block text-sm font-medium" htmlFor={searchInputId}>{t('peerMessages.search.label')}</label>
        <div className="flex flex-wrap items-center gap-2">
          <input id={searchInputId} type="search" className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 max-md:h-11" data-testid="session-message-title-search"
            placeholder={t('peerMessages.search.placeholder')} value={searchDraft} maxLength={256}
            aria-invalid={invalidSearch} aria-describedby={`${searchInputId}-help`} disabled={state.busy || !searchSupported}
            onChange={event => setSearchDraft(event.target.value)} onKeyDown={event => {
              if (event.key !== 'Enter') return
              event.stopPropagation()
              if (event.nativeEvent.isComposing) return
              event.preventDefault(); submitSearch()
            }} />
          <Button type="button" variant="outline" size="sm" data-testid="session-message-search-submit"
            disabled={state.busy || !searchSupported || invalidSearch} onClick={submitSearch}>{t('peerMessages.search.submit')}</Button>
          <Button type="button" variant="ghost" size="sm" data-testid="session-message-search-clear"
            disabled={state.busy || !searchDraft && !state.searchTitle} onClick={() => { setSearchDraft(''); void controller.search('') }}>{t('peerMessages.search.clear')}</Button>
        </div>
        <p id={`${searchInputId}-help`} className="text-sm text-muted-foreground" data-testid="session-message-search-help">
          {invalidSearch ? t('peerMessages.search.invalid') : state.support?.discovery && !searchSupported ? t('peerMessages.search.unsupported') :
            state.searchTitle ? t('peerMessages.search.active', { title: state.searchTitle }) : t('peerMessages.search.default')}
        </p>
      </div>
      {messagesSupported && state.policy && <div className="space-y-2 rounded-lg border border-border/60 p-3" data-testid="session-message-policy">
        <p className="text-sm font-medium">{t('peerMessages.policyTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('peerMessages.policyDescription')}</p>
        <Button variant="outline" size="sm" disabled={state.busy || state.loading || state.error === 'policy_unknown'}
          data-testid="session-message-policy-enable" onClick={() => void controller.savePolicy(!state.policy?.enabled, state.policy?.wakeIdle ?? false)}>
          {t(state.policy.enabled ? 'peerMessages.policyDisable' : 'peerMessages.policyEnable')}</Button>
        {state.policy.enabled && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={state.policy.wakeIdle}
          data-testid="session-message-policy-wake" disabled={state.busy || state.loading || state.error === 'policy_unknown'} onChange={event => void controller.savePolicy(true, event.target.checked)} />{t('peerMessages.policyWake')}</label>}
      </div>}
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">{t(state.page?.coverage === 'resident_only' ? 'peerMessages.residentOnly' : 'peerMessages.visibleScope')}</span>
        <div className="flex shrink-0 items-center gap-2">
          <div className={`size-8 shrink-0 max-md:size-11 ${diagnosticAvailable ? '' : 'invisible'}`} aria-hidden={!diagnosticAvailable} data-testid="session-message-diagnostic-slot">
            <ActionMenu key={diagnosticAvailable ? 'available' : 'hidden'} icon={Info} placement="bottom-end"
              ariaLabel={t(diagnosticCopy ? `peerMessages.diagnostic.${diagnosticCopy}` : 'peerMessages.diagnostic.title')}
              testId="session-message-diagnostic-open" disabled={!diagnosticAvailable} items={[
                { label: t('peerMessages.diagnostic.stage', { stage: t(`peerMessages.diagnostic.stages.${diagnostic?.stage ?? 'unknown'}`) }), icon: Info, disabled: true, onSelect: () => {}, testId: 'session-message-diagnostic-stage' },
                { label: t('peerMessages.diagnostic.reason', { reason: diagnostic?.reason ?? 'unknown' }), icon: Info, disabled: true, onSelect: () => {}, testId: 'session-message-diagnostic-reason' },
                { label: t('peerMessages.diagnostic.copy'), icon: Copy, testId: 'session-message-diagnostic-copy', onSelect: async () => {
                  try { await navigator.clipboard.writeText(diagnosticText); if (lifetime.mounted && current()) setDiagnosticCopy('copied') }
                  catch { if (lifetime.mounted && current()) setDiagnosticCopy('copyFailed') }
                } },
              ]} />
          </div>
          <Button variant="ghost" size="sm" disabled={state.loading || state.busy} onClick={() => void controller.load()}><RefreshCw className="mr-1 size-4" />{t('peerMessages.refresh')}</Button>
        </div>
      </div>
      {state.support && !state.support.discovery && <p role="status" className="text-sm">{t('peerMessages.unsupported')}</p>}
      {state.page && !complete && <p role="status" className="text-sm text-muted-foreground">{t('peerMessages.partial')}</p>}
      {complete && state.targets.length === 0 && <p className="text-sm text-muted-foreground">{t('peerMessages.empty')}</p>}
      <div className="space-y-1" role="list" aria-label={t('peerMessages.targets')}>
        {state.targets.map(target => <div key={agentMessageTargetKey(target)} role="listitem" className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 p-3">
          <button type="button" className="min-w-0 flex-1 text-left" aria-pressed={!!state.selected && agentMessageTargetKey(state.selected) === agentMessageTargetKey(target)}
            disabled={state.loading || state.busy}
            data-testid="session-message-target" onClick={() => controller.select(agentMessageTargetKey(target))}>
            <span className="block truncate font-medium">{target.title || target.threadId}</span>
            <span className="block truncate text-sm text-muted-foreground">{t(`peerMessages.activity.${target.status}`)}
              {target.presence !== 'resident' ? ` · ${t('peerMessages.notResident')}` : ''}
              {target.lastTurn ? ` · ${t('peerMessages.lastTurn')}: ${t(`peerMessages.turn.${target.lastTurn.status}`)}` : ''}</span>
          </button>
          <Button variant="ghost" size="icon" disabled={state.loading || state.busy} title={t('peerMessages.openTarget')} aria-label={t('peerMessages.openTarget')} onClick={() => void openTarget(target)}><ArrowUpRight className="size-4" /></Button>
        </div>)}
      </div>
      {state.page?.nextCursor && <Button variant="outline" size="sm" disabled={state.loading || state.busy} onClick={() => void controller.load(state.page?.nextCursor ?? undefined)}>{t('peerMessages.more')}</Button>}
      {state.support?.discovery && !messagesSupported && <p className="text-sm text-muted-foreground">{t('peerMessages.sendUnsupported')}</p>}
      {messagesSupported && state.policy?.enabled && <div className="space-y-3 border-t border-border/60 pt-4">
        <p className="text-sm">{state.selected ? t('peerMessages.to', { title: state.selected.title || state.selected.threadId }) : t('peerMessages.chooseTarget')}</p>
        <label className="block space-y-1 text-sm"><span>{t('peerMessages.message')}</span>
          <textarea className="min-h-24 w-full resize-y rounded-lg border border-border bg-background p-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            value={state.draft} onChange={event => controller.setDraft(event.target.value)} maxLength={16384} data-testid="session-message-input" />
        </label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="session-message-wake"
          checked={state.mode === 'wake_if_idle'} onChange={event => controller.setMode(event.target.checked ? 'wake_if_idle' : 'enqueue_only')}
          disabled={state.busy || state.loading || !state.selected?.allowedModes.includes('enqueue_only') ||
            (state.mode !== 'wake_if_idle' && (!state.policy.wakeIdle || !state.selected?.allowedModes.includes('wake_if_idle')))} />{t('peerMessages.wake')}</label>
        <div className="flex items-center justify-end"><Button data-testid="session-message-send" disabled={!controller.canSend()}
          onClick={() => void controller.send()}>{t(state.sending ? 'peerMessages.sending' : controller.retryCandidate() ? 'peerMessages.retryOriginal' : 'peerMessages.send')}</Button></div>
      </div>}
      {navigationFailed && <p role="status" className="text-sm text-muted-foreground">{t('peerMessages.navigationUnavailable')}</p>}
      {state.observations.length > 0 && <div className="space-y-2 border-t border-border/60 pt-4"><p className="text-sm font-medium">{t('peerMessages.receipts')}</p>
        <p className="text-sm text-muted-foreground">{t('peerMessages.appliedMeaning')}</p>
        {[...state.observations].reverse().map(row => <div key={row.clientMessageId} className="flex min-w-0 items-center justify-between gap-2 text-sm">
          <span className="min-w-0 truncate" title={row.targetThreadId}>{row.targetThreadId} · {t(`peerMessages.receipt.${state.absent.includes(row.clientMessageId) ? 'notAccepted' : row.receipt?.status ?? 'unknown'}`)}</span>
          <Button variant="ghost" size="sm" disabled={state.busy || !messagesSupported} onClick={() => void controller.reconcile(row.clientMessageId)}>{t('peerMessages.lookup')}</Button>
        </div>)}
      </div>}
    </div>
  </ModalDialog>
}
