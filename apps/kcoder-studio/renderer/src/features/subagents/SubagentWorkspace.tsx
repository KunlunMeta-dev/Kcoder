import { ArrowLeft, RefreshCw, LoaderCircle, Square, ChevronDown } from 'lucide-react'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import { ProjectChatComposer } from '@/components/chat/composer/ProjectChatComposer'
import {
  DESKTOP_MESSAGE_LIST_CLASS,
  DESKTOP_STICKY_COMPOSER_FOOTER_CLASS,
  DESKTOP_STICKY_COMPOSER_LAYER_CLASS,
  DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS,
} from '@/components/layout/workbench/paneLayoutStyles'
import { subagentConversation } from './subagentConversation'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsMobile } from '@/hooks/useIsMobile'
import { createRandomUuid } from '@/lib/random-id'
import { subagentCommandDigest } from './subagentCommandJournal'
import type { RuntimeSubagentSteerResponse } from '@/types/api'
import type { RuntimeSubagentStatus, WorkbenchMessage } from '@/types/workbench'
import {
  appendArtifactPage,
  markCommandApplied,
  mergeCommandReceipt,
  type SubagentArtifactPage,
  type SubagentCommand,
} from './subagentWorkspaceState'

export interface SubagentWorkspaceProps {
  agent: RuntimeSubagentStatus
  parentLabel?: string
  role?: string
  goal?: string
  directory?: string
  currentTool?: string
  progress?: string
  workflowRunId?: string
  workflowNodeId?: string
  runId?: string
  connected: boolean
  /** The host's structured session projection; absence denotes an old read-only target. */
  conversationMessages?: WorkbenchMessage[]
  conversationActive?: boolean
  conversationLoading?: boolean
  conversationError?: string
  conversationKey?: string
  toolsCatalogTaskId?: string
  toolsCatalogServerId?: string
  draft?: string
  onDraftChange?: (value: string | ((current: string) => string)) => void
  /** Capability gated by the host. Older targets remain readable. */
  canSteer: boolean
  canReadTranscript?: boolean
  onReadArtifact: (
    agentId: string,
    kind: 'output' | 'transcript',
    offset: number
  ) => Promise<SubagentArtifactPage>
  onReadLatest?: (agentId: string, kind: 'output' | 'transcript') => Promise<SubagentArtifactPage>
  onSteer: (
    agentId: string,
    message: string,
    clientMessageId: string
  ) => Promise<RuntimeSubagentSteerResponse>
  /** Must query authority; never re-send an unknown command as a new message. */
  onLookupCommand?: (
    agentId: string,
    clientMessageId: string
  ) => Promise<RuntimeSubagentSteerResponse | null>
  /** Rebuilt from the target's bounded receipt journal, never browser authority. */
  commandHistory?: SubagentCommand[]
  commandEpoch?: number
  retainedCommandCount?: number
  commandLimit?: number
  canArchiveCommands?: boolean
  canStop?: boolean
  onStop?: (agentId: string) => Promise<{ stopped: boolean; status: string; reasonCode?: string }>
  /** The explicit action confirms the exact reviewed server message identities. */
  onArchiveCommands?: (messageIds: string[], expectedEpoch: number) => Promise<boolean>
  onCommandIntent?: (command: SubagentCommand) => void | Promise<void>
  onCommandUpdate?: (command: SubagentCommand) => void | Promise<void>
  /** Existing host question/approval UI, already scoped to this agent by the host. */
  interactions?: React.ReactNode
  onClose: () => void
}

const MAX_VISIBLE_BYTES = 256 * 1024
const controlClass =
  'flex min-h-11 items-center justify-center gap-1 rounded-lg px-3 text-sm text-text-secondary hover:bg-surface disabled:opacity-40 md:min-h-7'

/** A view of an existing worker: opening or closing never changes its lifecycle. */
export function SubagentWorkspace(props: SubagentWorkspaceProps) {
  const { t } = useTranslation('common')
  const mobile = useIsMobile()
  const { agent, connected, canSteer, onReadArtifact, onSteer, onLookupCommand, onClose } = props
  const [pageBounds, setPageBounds] = useState({ left: 0, top: 0 })
  useLayoutEffect(() => {
    const sidebar = document.querySelector('[data-testid="desktop-sidebar"]')
    const update = () => {
      const bounds = sidebar?.getBoundingClientRect()
      setPageBounds({
        left: window.innerWidth >= 1024 && bounds?.width ? bounds.right : 0,
        top: bounds?.top ?? 0,
      })
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    if (sidebar) observer?.observe(sidebar)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])
  const [kind, setKind] = useState<'output' | 'transcript'>(
    props.canReadTranscript === false ? 'output' : 'transcript'
  )
  const [page, setPage] = useState<SubagentArtifactPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [localDraft, setLocalDraft] = useState('')
  const draft = props.draft ?? localDraft
  const setDraft = (value: string | ((current: string) => string)) => {
    if (props.onDraftChange) props.onDraftChange(value)
    else setLocalDraft(value)
  }
  const [commands, setCommands] = useState<SubagentCommand[]>([])
  const [archiving, setArchiving] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopReceipt, setStopReceipt] = useState<{ runId?: string; status: string } | null>(null)
  const stopStatus = stopReceipt?.runId === props.runId ? stopReceipt?.status : null
  const [readingHistory, setReadingHistory] = useState(false)
  const structuredConversation = props.conversationMessages !== undefined
  const generation = useRef(0)
  const dialogRef = useRef<HTMLElement>(null)
  const conversation = useMemo(
    () =>
      props.conversationMessages ??
      (kind === 'transcript'
        ? subagentConversation(page?.content ?? '', agent.agentId, page?.offset)
        : [
            {
              id: `${agent.agentId}:output`,
              role: 'assistant' as const,
              content: page?.content ?? '',
              status: 'done' as const,
              createdAt: '',
            },
          ]),
    [props.conversationMessages, kind, page, agent.agentId]
  )
  const readRef = useRef(onReadArtifact)
  const latestRef = useRef(props.onReadLatest)
  useEffect(() => {
    readRef.current = onReadArtifact
  }, [onReadArtifact])
  useEffect(() => {
    latestRef.current = props.onReadLatest
  }, [props.onReadLatest])
  useEscapeKey(onClose, true)

  useEffect(() => {
    const previousFocus = document.activeElement
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus()
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])

  const read = async (
    offset = 0,
    mode: 'history' | 'latest' = readingHistory ? 'history' : 'latest'
  ) => {
    const request = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const isLatest = mode === 'latest' && latestRef.current !== undefined
      const incoming = isLatest
        ? await latestRef.current!(agent.agentId, kind)
        : await readRef.current(agent.agentId, kind, offset)
      if (request !== generation.current) return
      setPage(current => {
        if (isLatest) return incoming
        const combined = appendArtifactPage(current, incoming)
        if (!combined) return current
        return new TextEncoder().encode(combined.content).byteLength > MAX_VISIBLE_BYTES
          ? incoming
          : combined
      })
      if (!isLatest && offset > 0 && page?.revision !== incoming.revision) {
        setError(t('workbench.subagent_detail_snapshot_changed'))
      }
    } catch (failure) {
      if (request === generation.current) {
        setError(
          failure instanceof Error ? failure.message : t('workbench.subagent_artifact_error')
        )
      }
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }

  useEffect(() => {
    const initialRead =
      connected && !structuredConversation ? setTimeout(() => void read(), 0) : undefined
    return () => {
      clearTimeout(initialRead)
      generation.current += 1
    }
    // Callback identity changes do not reset history; the ref always uses the current host.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.agentId, kind, connected, structuredConversation])

  const knownCommands = new Map(
    (props.commandHistory ?? []).map(command => [command.clientMessageId, command])
  )
  for (const command of commands) {
    const historical = knownCommands.get(command.clientMessageId)
    knownCommands.set(
      command.clientMessageId,
      historical ? { ...historical, message: command.message } : command
    )
  }
  const displayedCommands = Array.from(knownCommands.values()).map(command =>
    markCommandApplied(
      command,
      agent.appliedSteerMessageIds ?? [],
      agent.steerStatus === 'applied' ? agent.clientMessageId : undefined
    )
  )
  const displayConversation = useMemo(() => {
    if (!structuredConversation || displayedCommands.length === 0) return conversation
    const knownMessageIds = new Set(
      conversation
        .filter(message => message.role === 'user')
        .flatMap(message => [
          message.id,
          ...(typeof message.source?.clientMessageId === 'string'
            ? [message.source.clientMessageId]
            : []),
        ])
    )
    const pending = displayedCommands.filter(
      command =>
        command.message &&
        !knownMessageIds.has(command.clientMessageId) &&
        (!command.messageId || !knownMessageIds.has(command.messageId)) &&
        command.status !== 'applied' &&
        command.status !== 'rejected' &&
        command.status !== 'superseded' &&
        command.status !== 'cancelled'
    )
    return pending.length
      ? [
          ...conversation,
          ...pending.map(command => ({
            id: command.messageId ?? command.clientMessageId,
            role: 'user' as const,
            content: command.message,
            status: 'done' as const,
            createdAt: command.createdAtMs ? new Date(command.createdAtMs).toISOString() : '',
          })),
        ]
      : conversation
  }, [conversation, displayedCommands, structuredConversation])
  const visibleCommandReceipts = structuredConversation
    ? displayedCommands.filter(command => command.status !== 'applied')
    : displayedCommands
  const draftDigest = useMemo(() => subagentCommandDigest(draft.trim()), [draft])
  const unresolvedDuplicate = displayedCommands.some(
    command =>
      (command.status === 'unknown' || command.status === 'sending') &&
      (command.message === draft.trim() || command.bodyDigest === draftDigest)
  )

  const submit = async (submittedValue = draft) => {
    const message = submittedValue.trim()
    if (
      !message ||
      !connected ||
      !canSteer ||
      archiving ||
      unresolvedDuplicate ||
      (props.retainedCommandCount ?? 0) >= (props.commandLimit ?? 256)
    )
      return
    if (new TextEncoder().encode(message).byteLength > 64 * 1024) {
      setError(t('workbench.subagent_detail_message_too_large'))
      return
    }
    const clientMessageId = `cmd:${props.commandEpoch ?? 0}:${createRandomUuid()}`
    const intent: SubagentCommand = {
      clientMessageId,
      message,
      status: 'sending',
      bodyDigest: subagentCommandDigest(message),
      createdAtMs: Date.now(),
    }
    setCommands(current => [...current, intent].slice(-256))
    setDraft('')
    try {
      await props.onCommandIntent?.(intent)
    } catch {
      setCommands(current =>
        current.map(command =>
          command.clientMessageId === clientMessageId
            ? { ...command, status: 'rejected', reasonCode: 'local_intent_unavailable' }
            : command
        )
      )
      setDraft(current => current || message)
      return
    }
    try {
      const receipt = await onSteer(agent.agentId, message, clientMessageId)
      setCommands(current => current.map(command => mergeCommandReceipt(command, receipt)))
      try {
        await props.onCommandUpdate?.(mergeCommandReceipt(intent, receipt))
      } catch {
        setError(t('workbench.subagent_detail_journal_unavailable'))
      }
    } catch {
      setCommands(current =>
        current.map(command =>
          command.clientMessageId === clientMessageId ? { ...command, status: 'unknown' } : command
        )
      )
      try {
        await props.onCommandUpdate?.({ ...intent, status: 'unknown' })
      } catch {
        setError(t('workbench.subagent_detail_journal_unavailable'))
      }
    }
  }

  const archive = async () => {
    if (!props.onArchiveCommands || archiving || !connected || !props.canArchiveCommands) return
    setArchiving(true)
    try {
      const ids = displayedCommands
        .map(command => command.messageId)
        .filter((id): id is string => Boolean(id))
      const success = await props.onArchiveCommands(ids, props.commandEpoch ?? 0)
      if (success) setCommands([])
    } catch {
      setError(t('workbench.subagent_detail_archive_unknown'))
    } finally {
      setArchiving(false)
    }
  }

  const stop = async () => {
    if (!props.onStop || !props.canStop || stopping || !connected) return
    setStopping(true)
    const runId = props.runId
    try {
      const result = await props.onStop(agent.agentId)
      setStopReceipt({ runId, status: result.status })
    } catch {
      setStopReceipt({ runId, status: 'cleanup_unknown' })
    } finally {
      setStopping(false)
    }
  }

  const lookup = async (command: SubagentCommand) => {
    if (!onLookupCommand || !connected) return
    try {
      const receipt = await onLookupCommand(agent.agentId, command.clientMessageId)
      if (receipt) {
        const updated = mergeCommandReceipt(command, receipt)
        setCommands(current =>
          current.some(item => item.clientMessageId === command.clientMessageId)
            ? current.map(item => mergeCommandReceipt(item, receipt))
            : [...current, updated]
        )
        try {
          await props.onCommandUpdate?.(updated)
        } catch {
          setError(t('workbench.subagent_detail_journal_unavailable'))
        }
      }
    } catch {
      // An observation failure cannot prove rejection and must keep the original identity.
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex bg-background"
      style={{ left: pageBounds.left, top: pageBounds.top }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="subagent-workspace-title"
        data-testid="subagent-workspace"
        className="flex h-full w-full min-w-0 flex-col bg-background text-text-primary"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key !== 'Tab') return
          const controls = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'button, textarea, input, select, summary, a[href], [contenteditable="true"], [tabindex]'
            ) ?? []
          ).filter(
            element =>
              element.tabIndex >= 0 &&
              !('disabled' in element && element.disabled) &&
              !element.closest('[hidden], [aria-hidden="true"]') &&
              (element.tagName === 'SUMMARY' || !element.closest('details:not([open])'))
          )
          if (!controls?.length) return
          const first = controls[0]
          const last = controls[controls.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/50 px-4 py-3 md:px-6">
          <button
            type="button"
            className={controlClass}
            onClick={onClose}
            data-testid="subagent-workspace-back"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('workbench.subagent_detail_back')}
          </button>
          <h2
            id="subagent-workspace-title"
            className="min-w-0 flex-1 truncate text-base font-medium"
          >
            {agent.agentName}
          </h2>
          <span className="flex items-center gap-2 text-xs text-text-secondary">
            {(structuredConversation
              ? props.conversationActive && agent.status === 'running'
              : agent.status === 'running') &&
              connected && <LoaderCircle className="size-3 animate-spin" />}
            {t(`workbench.subagent_${agent.status}`)}
          </span>
          {props.canStop && props.onStop && (
            <button
              type="button"
              data-testid="subagent-workspace-stop"
              className={controlClass}
              disabled={!connected || stopping}
              onClick={() => void stop()}
            >
              <Square className="size-4" />
              {t('workbench.subagent_detail_stop')}
            </button>
          )}
        </header>
        <div className="shrink-0 px-6">
          <div className="mx-auto w-full max-w-3xl">
            <details className="mb-3 text-xs text-text-muted">
              <summary className="flex w-fit cursor-pointer items-center gap-1 py-2">
                <ChevronDown className="size-3" />
                {t('workbench.subagent_detail_context')}
              </summary>
              <dl className="max-h-48 space-y-2 overflow-y-auto rounded-xl bg-surface/40 p-4 text-sm text-text-secondary">
                {[
                  ['identity', agent.agentId],
                  ['run', props.runId],
                  ['parent', props.parentLabel],
                  ['role', props.role],
                  ['goal', props.goal],
                  ['directory', props.directory],
                  ['tool', props.currentTool],
                  ['progress', props.progress],
                  [
                    'workflow',
                    [props.workflowRunId, props.workflowNodeId].filter(Boolean).join(' / '),
                  ],
                ]
                  .filter(([, value]) => value)
                  .map(([label, value]) => (
                    <div key={label} className="flex flex-wrap gap-x-2">
                      <dt>{t(`workbench.subagent_detail_${label}`)}</dt>
                      <dd className="break-all">{value}</dd>
                    </div>
                  ))}
              </dl>
            </details>
            {!connected && (
              <p role="status" className="mb-3 text-sm text-text-secondary">
                {t('workbench.subagent_detail_disconnected')}
              </p>
            )}
            {stopStatus && (
              <p
                role="status"
                data-testid="subagent-workspace-stop-status"
                className="mb-3 text-sm text-text-secondary"
              >
                {t(`workbench.subagent_stop_${stopStatus}`)}
              </p>
            )}
            {!structuredConversation && (
              <p className="mb-2 text-xs text-text-muted" role="status">
                {t('workbench.subagent_detail_legacy_history')}
              </p>
            )}
            {!structuredConversation && (
              <nav
                className="mb-2 flex flex-wrap items-center gap-1"
                aria-label={t('workbench.subagent_detail_records')}
              >
                {(['transcript', 'output'] as const)
                  .filter(tab => tab !== 'transcript' || props.canReadTranscript !== false)
                  .map(tab => (
                    <button
                      key={tab}
                      type="button"
                      className={controlClass}
                      aria-pressed={kind === tab}
                      onClick={() => {
                        setKind(tab)
                        setReadingHistory(false)
                        setPage(null)
                        setError(null)
                      }}
                    >
                      {t(`workbench.subagent_detail_${tab}`)}
                    </button>
                  ))}
                <button
                  type="button"
                  className={controlClass}
                  disabled={!connected || loading}
                  onClick={() => {
                    setReadingHistory(false)
                    void read(0, 'latest')
                  }}
                  data-testid="subagent-workspace-refresh"
                >
                  <RefreshCw className="h-4 w-4" />
                  {t('workbench.subagent_detail_refresh')}
                </button>
                {props.onReadLatest && (
                  <button
                    type="button"
                    data-testid="subagent-workspace-history"
                    className={controlClass}
                    disabled={!connected || loading}
                    onClick={() => {
                      setReadingHistory(true)
                      void read(0, 'history')
                    }}
                  >
                    {t('workbench.subagent_detail_history')}
                  </button>
                )}
              </nav>
            )}
            {props.conversationError && (
              <p role="status" className="mb-2 text-sm text-text-secondary">
                {t('workbench.subagent_detail_stream_error')}
              </p>
            )}
            {props.canReadTranscript === false && (
              <p className="mb-3 text-xs text-text-muted">
                {t('workbench.subagent_detail_public_history_unavailable')}
              </p>
            )}

            {error && (
              <p role="alert" className="mb-3 text-sm text-destructive">
                {error}
              </p>
            )}
            {loading && !page && (
              <p role="status" className="text-sm text-text-muted">
                {t('workbench.subagent_artifact_loading')}
              </p>
            )}
            {page?.truncated && page.nextOffset === undefined && (
              <p className="mt-3 text-xs text-text-muted">
                {t('workbench.subagent_artifact_truncated')}
              </p>
            )}
            {readingHistory && page && page.offset > 0 && (
              <p className="mt-3 text-xs text-text-muted">
                {t('workbench.subagent_detail_window')}
              </p>
            )}
            {page?.nextOffset !== undefined && (
              <button
                type="button"
                className={controlClass}
                disabled={loading || !connected}
                onClick={() => {
                  setReadingHistory(true)
                  void read(page.nextOffset, 'history')
                }}
              >
                {t('workbench.subagent_detail_more')}
              </button>
            )}
          </div>
        </div>
        <div data-testid="subagent-workspace-records" className="flex min-h-0 flex-1 flex-col">
          <ScrollableMessageArea
            messages={displayConversation}
            loading={structuredConversation ? props.conversationLoading : loading && !page}
            isWaitingForAssistant={Boolean(props.conversationActive && connected)}
            conversationKey={props.conversationKey ?? `${agent.agentId}:${kind}`}
            toolsCatalogTaskId={props.toolsCatalogTaskId}
            toolsCatalogServerId={props.toolsCatalogServerId}
            showTransientToolStatus={false}
            scrollTestId="subagent-workspace-scroll"
            messageListClassName={mobile ? undefined : DESKTOP_MESSAGE_LIST_CLASS}
            scrollButtonClassName={DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS}
            hideRequestUserInputBlocks={Boolean(props.interactions)}
            stickyFooterClassName={`${DESKTOP_STICKY_COMPOSER_FOOTER_CLASS} from-background via-background`}
            stickyFooter={
              <div className={mobile ? 'mx-auto w-full px-4' : DESKTOP_STICKY_COMPOSER_LAYER_CLASS}>
                {props.interactions}
                <div className="max-h-48 overflow-y-auto">
                  {visibleCommandReceipts.length > 0 && (
                    <ol data-testid="subagent-workspace-commands" className="space-y-2 pb-2">
                      {visibleCommandReceipts.map(command => (
                        <li
                          key={command.clientMessageId}
                          data-client-message-id={command.clientMessageId}
                          className="ml-auto max-w-[85%] text-sm"
                        >
                          {!structuredConversation && (
                            <p className="whitespace-pre-wrap break-words text-sm">
                              {command.message || command.clientMessageId}
                            </p>
                          )}
                          <span className="text-xs text-text-muted">
                            {t(`workbench.subagent_command_${command.status}`)}
                          </span>
                          {command.reasonCode && (
                            <p className="text-xs text-text-muted">
                              {t(`workbench.subagent_command_reason_${command.reasonCode}`)}
                            </p>
                          )}
                          {command.status === 'unknown' && onLookupCommand && (
                            <button
                              type="button"
                              className={controlClass}
                              disabled={!connected}
                              onClick={() => void lookup(command)}
                            >
                              {t('workbench.subagent_detail_check')}
                            </button>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                  {(props.retainedCommandCount ?? 0) >= (props.commandLimit ?? 256) && (
                    <p role="status" className="mt-3 text-sm text-text-secondary">
                      {t('workbench.subagent_detail_capacity')}
                    </p>
                  )}
                  {props.onArchiveCommands &&
                    (!structuredConversation ||
                      (props.retainedCommandCount ?? 0) >= (props.commandLimit ?? 256)) && (
                      <button
                        type="button"
                        data-testid="subagent-workspace-archive"
                        className={controlClass}
                        disabled={
                          !connected ||
                          archiving ||
                          unresolvedDuplicate ||
                          !props.canArchiveCommands ||
                          displayedCommands.some(
                            command => command.status === 'unknown' || command.status === 'sending'
                          ) ||
                          displayedCommands.length !== props.retainedCommandCount
                        }
                        onClick={() => void archive()}
                      >
                        {t('workbench.subagent_detail_archive')}
                      </button>
                    )}
                </div>
                <ProjectChatComposer
                  textOnly
                  inputTestId="subagent-workspace-input"
                  sendTestId="subagent-workspace-send"
                  pauseTestId="subagent-workspace-pause"
                  value={draft}
                  onChange={setDraft}
                  onSubmit={value => void submit(value)}
                  disabled={false}
                  submitDisabled={
                    !connected ||
                    !canSteer ||
                    archiving ||
                    unresolvedDuplicate ||
                    (props.retainedCommandCount ?? 0) >= (props.commandLimit ?? 256)
                  }
                  placeholder={t('workbench.subagent_steer_message')}
                  isStreaming={Boolean(props.conversationActive && connected)}
                  onPause={
                    props.canStop && props.onStop && !stopping ? () => void stop() : undefined
                  }
                  toolbarLeadingContext={
                    <span className="text-xs text-text-muted">
                      {t(
                        canSteer
                          ? 'workbench.subagent_detail_compose_hint'
                          : 'workbench.subagent_detail_read_only'
                      )}
                    </span>
                  }
                />
              </div>
            }
          />
        </div>
      </section>
    </div>,
    document.body
  )
}
