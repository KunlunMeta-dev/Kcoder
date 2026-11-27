import { useEffect, useRef, useState } from 'react'
import { UsersRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import {
  CollaborationAuthoringError,
  createCollaborationAuthoringTransport,
  type CollaborationAuthoringTransport,
} from '@/kcoder/collaborationAuthoringTransport'
import type { TaskWorkspaceTarget } from '@/kcoder/taskWorkspaceTransport'
import type { WorkflowCollaborationCatalogResult } from '../../../../../shared/generated/contracts'
import type { WorkflowDefinition } from '@/features/workflows/workflowApi'
import { buildCollaborationPlan, type CollaborationForm } from './buildPlan'

export interface CollaborationCreatorProps {
  target: TaskWorkspaceTarget
  originalThreadId?: string
  onSaved?: (definition: WorkflowDefinition, target: TaskWorkspaceTarget) => void
  onOpenLibrary?: (target: TaskWorkspaceTarget) => void
}
export function CollaborationCreator(props: CollaborationCreatorProps) {
  const scope = usePluginTargetScope(props.target.serverId, props.target.workspacePath)
  const owner = JSON.stringify([
    scope.key,
    props.target.serverId,
    props.target.workspacePath,
    props.originalThreadId,
  ])
  return <CollaborationSession key={owner} {...props} isCurrent={scope.isCurrent} />
}
function CollaborationSession({
  target,
  originalThreadId,
  onSaved,
  onOpenLibrary,
  isCurrent,
}: CollaborationCreatorProps & { isCurrent: () => boolean }) {
  const { t } = useTranslation('taskCollaboration')
  const [catalog, setCatalog] = useState<WorkflowCollaborationCatalogResult>()
  const [form, setForm] = useState<CollaborationForm & { title: string; inherit: boolean }>({
    title: '',
    objective: '',
    criteria: '',
    path: '',
    scheme: 'research_review',
    inherit: false,
  })
  const [draft, setDraft] = useState<WorkflowDefinition>()
  const [phase, setPhase] = useState<'loading' | 'ready' | 'preparing' | 'saving' | 'reading'>(
    'loading'
  )
  const [error, setError] = useState<string>()
  const [unknown, setUnknown] = useState(false)
  const transport = useRef<CollaborationAuthoringTransport | undefined>(undefined)
  const pending = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    const owned = createCollaborationAuthoringTransport(
      { serverId: target.serverId, workspacePath: target.workspacePath },
      isCurrent
    )
    const cancel = new AbortController()
    transport.current = owned
    void owned
      .catalog(originalThreadId, cancel.signal)
      .then(value => {
        if (owned.isCurrent() && !cancel.signal.aborted) {
          setCatalog(value)
          setPhase('ready')
        }
      })
      .catch(error => {
        if (owned.isCurrent() && !cancel.signal.aborted) {
          setError(
            error instanceof CollaborationAuthoringError && error.code === 'scope_changed'
              ? 'scopeChanged'
              : 'unavailable'
          )
          setPhase('ready')
        }
      })
    return () => {
      cancel.abort()
      owned.dispose()
      if (transport.current === owned) transport.current = undefined
    }
  }, [target.serverId, target.workspacePath, originalThreadId, isCurrent])
  const busy = phase !== 'ready'
  const act = async (action: 'prepare' | 'save' | 'read') => {
    const owned = transport.current
    if (!owned?.isCurrent() || busy) return
    const cancel = new AbortController()
    pending.current = cancel
    let known = draft
    setError(undefined)
    try {
      if (action === 'prepare') {
        if (unknown || !catalog || !form.title.trim() || !form.inherit) {
          setError('required')
          return
        }
        let plan
        try {
          plan = buildCollaborationPlan(form, catalog, {
            researcher: t('roleNames.researcher'),
            planner: t('roleNames.planner'),
            writer: t('roleNames.writer'),
            reviewer: t('roleNames.reviewer'),
            verifier: t('roleNames.verifier'),
          })
        } catch (error) {
          setError(error instanceof Error && error.message === 'path' ? 'invalidPath' : 'required')
          return
        }
        setPhase('preparing')
        if (!known) {
          known = await owned.create(form.title.trim(), cancel.signal)
          if (!owned.isCurrent()) return
          setDraft(known)
        }
        known = await owned.apply(known, plan, cancel.signal)
        if (owned.isCurrent()) {
          setDraft(known)
          setUnknown(false)
        }
      } else if (action === 'save' && known && !unknown) {
        setPhase('saving')
        const saved = await owned.save(known, cancel.signal)
        if (owned.isCurrent()) {
          setDraft(saved)
          onSaved?.(saved, { ...target })
        }
      } else if (action === 'read' && known) {
        setPhase('reading')
        const actual = await owned.read(known.id, cancel.signal)
        if (owned.isCurrent()) {
          setDraft(actual)
          // A library read observes content, not this action's semantic receipt.
          // A peer may have changed the same original draft in the meantime.
          if (unknown || actual.revision !== known.revision) {
            setUnknown(true)
            setError('unknown')
          }
        }
      }
    } catch (error) {
      if (!owned.isCurrent()) return
      const code = error instanceof CollaborationAuthoringError ? error.code : 'unavailable'
      if (code === 'unknown' || code === 'invalid_reply') {
        setUnknown(true)
        setError('unknown')
      } else
        setError(
          code === 'scope_changed'
            ? 'scopeChanged'
            : code === 'cancelled'
              ? 'cancelled'
              : 'unavailable'
        )
    } finally {
      if (owned.isCurrent()) setPhase('ready')
      if (pending.current === cancel) pending.current = undefined
    }
  }
  const locked = busy || Boolean(draft) || unknown
  return (
    <section
      className="min-w-0 space-y-5"
      data-testid="collaboration-creator"
      aria-label={t('title')}
    >
      <header>
        <h2 className="flex items-center gap-2 text-lg font-medium text-text-primary">
          <UsersRound className="size-5" aria-hidden="true" />
          {t('title')}
        </h2>
        <p className="mt-2 text-sm text-text-secondary">{t('description')}</p>
      </header>
      <p className="break-words text-sm text-text-secondary">
        {t('target')}: {target.serverId}
        {target.workspacePath ? ` · ${target.workspacePath}` : ''}
      </p>
      <fieldset disabled={locked} className="min-w-0 space-y-4">
        <label className="block space-y-2 text-sm text-text-secondary">
          {t('scheme')}
          <SettingsSelect
            data-testid="collaboration-scheme"
            aria-label={t('scheme')}
            icon={<UsersRound className="size-4" aria-hidden="true" />}
            value={form.scheme}
            onChange={event =>
              setForm(previous => ({
                ...previous,
                scheme: event.target.value as CollaborationForm['scheme'],
              }))
            }
          >
            <option value="research_review">{t('research')}</option>
            <option value="draft_verify">{t('drafting')}</option>
          </SettingsSelect>
        </label>
        <p className="text-sm text-text-secondary">{t('roleSummary')}</p>
        <label className="block space-y-2 text-sm text-text-secondary">
          {t('name')}
          <input
            data-testid="collaboration-title"
            className="block min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-base text-text-primary focus:outline-none focus:ring-2 focus:ring-focus/30"
            value={form.title}
            maxLength={512}
            onChange={event => setForm(previous => ({ ...previous, title: event.target.value }))}
          />
        </label>
        <label className="block space-y-2 text-sm text-text-secondary">
          {t('objective')}
          <textarea
            data-testid="collaboration-objective"
            className="block min-h-24 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-base text-text-primary focus:outline-none focus:ring-2 focus:ring-focus/30"
            value={form.objective}
            maxLength={4000}
            onChange={event =>
              setForm(previous => ({ ...previous, objective: event.target.value }))
            }
          />
        </label>
        <label className="block space-y-2 text-sm text-text-secondary">
          {t('criteria')}
          <textarea
            data-testid="collaboration-criteria"
            className="block min-h-24 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-base text-text-primary focus:outline-none focus:ring-2 focus:ring-focus/30"
            value={form.criteria}
            maxLength={4000}
            onChange={event => setForm(previous => ({ ...previous, criteria: event.target.value }))}
          />
        </label>
        {form.scheme === 'draft_verify' && (
          <label className="block space-y-2 text-sm text-text-secondary">
            {t('path')}
            <input
              data-testid="collaboration-path"
              className="block min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-base text-text-primary focus:outline-none focus:ring-2 focus:ring-focus/30"
              value={form.path}
              maxLength={1024}
              onChange={event => setForm(previous => ({ ...previous, path: event.target.value }))}
            />
          </label>
        )}
        <div className="space-y-2">
          <h3 className="text-sm text-text-secondary">{t('executionModel')}</h3>
          <p className="text-sm text-text-secondary">
            {catalog?.modelOrigin === 'thread_snapshot' && catalog.modelSnapshot
              ? `${t('taskModel')}: ${catalog.modelSnapshot.providerId ?? ''} / ${catalog.modelSnapshot.modelId}`
              : originalThreadId
                ? t('taskUnobserved')
                : t('futureParent')}
          </p>
          <label className="flex min-h-11 items-start gap-2 text-sm text-text-primary">
            <Checkbox
              data-testid="collaboration-inherit-model"
              className="mt-1"
              checked={form.inherit}
              onChange={event =>
                setForm(previous => ({ ...previous, inherit: event.target.checked }))
              }
            />
            {t('inherit')}
          </label>
        </div>
      </fieldset>
      {error && (
        <p role="alert" data-testid="collaboration-error" className="text-sm text-destructive">
          {t(error)}
        </p>
      )}
      {draft && (
        <div className="space-y-2 text-sm text-text-secondary">
          <p data-testid="collaboration-original-draft">
            {t('original')}: {draft.title} · {draft.id}
          </p>
          <p role="status" data-testid="collaboration-authoring-status">
            {unknown
              ? t('unknown')
              : draft.status === 'saved' && draft.savedVersion
                ? t('saved', { version: draft.savedVersion })
                : t('draft')}
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {(!draft || draft.nodes.length === 0) && (
          <Button
            data-testid="collaboration-prepare"
            className="min-h-11 md:min-h-0"
            disabled={busy || !catalog || unknown}
            onClick={() => void act('prepare')}
          >
            {busy ? t('working') : t('prepare')}
          </Button>
        )}
        {draft && draft.nodes.length > 0 && draft.status !== 'saved' && (
          <Button
            data-testid="collaboration-save"
            className="min-h-11 md:min-h-0"
            disabled={busy || unknown}
            onClick={() => void act('save')}
          >
            {t('save')}
          </Button>
        )}
        {draft && (
          <Button
            data-testid="collaboration-read-original"
            className="min-h-11 md:min-h-0"
            variant="outline"
            disabled={busy}
            onClick={() => void act('read')}
          >
            {t('read')}
          </Button>
        )}
        {busy && phase !== 'loading' && (
          <Button
            data-testid="collaboration-cancel-wait"
            className="min-h-11 md:min-h-0"
            variant="ghost"
            onClick={() => pending.current?.abort()}
          >
            {t('cancel')}
          </Button>
        )}
        {onOpenLibrary && (
          <Button
            data-testid="collaboration-open-library"
            className="min-h-11 md:min-h-0"
            variant="ghost"
            onClick={() => {
              if (transport.current?.isCurrent()) onOpenLibrary({ ...target })
            }}
          >
            {t('openLibrary')}
          </Button>
        )}
      </div>
      <p className="text-sm text-text-secondary">{t('noModelCalls')}</p>
    </section>
  )
}
