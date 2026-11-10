import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { requestLocalExecutor } from '@/host/localExecutor'
import { KCODER_RUNTIME_METHODS } from '@/kcoder/legacyRuntimeAbi'
import { isKnowledgeSettingsReadResult } from '../../../../shared/generated/contractGuards.mjs'
import type {
  KnowledgeSettingsFeature,
  KnowledgeSettingsReadResult,
} from '../../../../shared/generated/contracts'

function settingsError(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object') return fallback
  const value = error as { reason?: unknown; message?: unknown; code?: unknown }
  if (value.reason === 'unauthorized') return 'authenticationRequired'
  if (value.reason === 'connection' || value.reason === 'timeout') return 'connectionUnavailable'
  if (value.message === 'KNOWLEDGE_SETTINGS_REVISION_CONFLICT') return 'conflict'
  if (value.message === 'KNOWLEDGE_SETTINGS_TARGET_CHANGED') return 'ownerChanged'
  return fallback
}

const fields = {
  memoryCenter: 'memoryCenterEnabled',
  sharedKnowledge: 'publicationsEnabled',
  subscriptions: 'businessAutomationEnabled',
} as const

/** Feature setup reads authority first and never starts domain work while disabled. */
function OwnedKnowledgeFeatureSetup({
  serverId,
  workspacePath,
  feature,
  isCurrent,
  onReconnect,
  onAvailable,
  children,
  connection,
}: {
  serverId: string
  workspacePath?: string
  feature: KnowledgeSettingsFeature
  isCurrent: () => boolean
  onReconnect: () => void
  onAvailable?: () => void
  connection?: { readonly ownerKey: string }
  children: () => ReactNode
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const owner = JSON.stringify([serverId, workspacePath, feature])
  const [revision, setRevision] = useState(0)
  const [observation, setObservation] = useState<{
    owner: string
    connection?: object
    value?: KnowledgeSettingsReadResult
    error?: string
  }>()
  const [busyState, setBusy] = useState<{ connection?: object; value: boolean }>()
  const busy = busyState?.connection === connection && busyState?.value === true
  const [retainedContent, setRetainedContent] = useState(false)
  const pending = useRef<AbortController | undefined>(undefined)
  const active = useRef({ owner, connection })
  useLayoutEffect(() => {
    active.current = { owner, connection }
  }, [owner, connection])
  useEffect(() => {
    const cancel = new AbortController()
    pending.current = cancel
    void requestLocalExecutor(
      'runtime.settings.request',
      {
        serverId,
        workspacePath,
        method: 'settings/integrations/knowledge/read',
        params: {},
      },
      { signal: cancel.signal }
    )
      .then(value => {
        if (cancel.signal.aborted || !isCurrent() || active.current.connection !== connection)
          return
        if (!isKnowledgeSettingsReadResult(value))
          throw new Error('KNOWLEDGE_SETTINGS_REPLY_INVALID')
        setObservation({ owner, connection, value })
      })
      .catch(error => {
        if (cancel.signal.aborted || !isCurrent() || active.current.connection !== connection)
          return
        const unsupported =
          error &&
          typeof error === 'object' &&
          'data' in error &&
          error.data &&
          typeof error.data === 'object' &&
          'kind' in error.data &&
          error.data.kind === 'knowledge_settings_unsupported'
        setObservation({
          owner,
          connection,
          error: unsupported ? 'targetUnsupported' : settingsError(error, 'setupUnavailable'),
        })
      })
    return () => {
      cancel.abort()
      pending.current?.abort()
    }
  }, [serverId, workspacePath, owner, revision, isCurrent, connection])
  const settings =
    observation?.owner === owner && observation.connection === connection
      ? observation.value
      : undefined
  const field = fields[feature]
  const available =
    settings?.effective[field] === true &&
    settings.connection[field] === true &&
    !settings.restartRequired
  useEffect(() => {
    if (available) onAvailable?.()
  }, [available, onAvailable])
  if (available && !retainedContent) setRetainedContent(true)
  const run = async () => {
    if (busy || !settings) return
    const cancel = new AbortController()
    pending.current = cancel
    setBusy({ connection, value: true })
    try {
      const result = settings.effective[field]
        ? settings
        : await requestLocalExecutor(
            'runtime.settings.request',
            {
              serverId,
              workspacePath,
              method: 'settings/integrations/knowledge/save',
              params: { feature, enabled: true, expectedRevision: settings.revision },
            },
            { signal: cancel.signal }
          )
      if (
        cancel.signal.aborted ||
        !isCurrent() ||
        active.current.connection !== connection ||
        active.current.owner !== owner
      )
        return
      if (!isKnowledgeSettingsReadResult(result))
        throw new Error('KNOWLEDGE_SETTINGS_REPLY_INVALID')
      setObservation({ owner, connection, value: result })
      if (!result.effective[field]) {
        setObservation({ owner, connection, value: result, error: 'setupOverridden' })
        return
      }
      if (result.restartRequired) {
        const applied = await requestLocalExecutor<{
          restarted?: boolean
          requiresConfirmation?: boolean
        }>(
          KCODER_RUNTIME_METHODS.appServerRestart,
          { serverId, ifIdle: true },
          { signal: cancel.signal }
        )
        if (
          cancel.signal.aborted ||
          !isCurrent() ||
          active.current.connection !== connection ||
          active.current.owner !== owner
        )
          return
        if (applied.restarted === true && applied.requiresConfirmation === false) onReconnect()
        else setObservation({ owner, connection, value: result, error: 'setupBusy' })
      } else onReconnect()
    } catch (error) {
      if (
        !cancel.signal.aborted &&
        isCurrent() &&
        active.current.owner === owner &&
        active.current.connection === connection
      )
        setObservation({ owner, connection, error: settingsError(error, 'setupUnconfirmed') })
    } finally {
      if (
        !cancel.signal.aborted &&
        isCurrent() &&
        active.current.owner === owner &&
        active.current.connection === connection
      )
        setBusy({ connection, value: false })
    }
  }
  const error =
    observation?.owner === owner && observation.connection === connection
      ? observation.error
      : undefined
  return (
    <div>
      {retainedContent && (
        <fieldset
          className="min-w-0"
          disabled={!available}
          hidden={!!settings && !available}
          data-testid="knowledge-feature-content"
        >
          {children()}
        </fieldset>
      )}
      {!available && (
        <section
          className="studio-card-spacing workbench-card mx-auto w-full max-w-5xl space-y-3"
          data-testid="knowledge-feature-setup"
        >
          {feature === 'subscriptions' && (
            <h3 className="font-medium">{t('workflowSchedulingSetup')}</h3>
          )}
          <p className="text-sm text-text-secondary">{t('setupTarget')}</p>
          <p role={error ? 'alert' : 'status'}>
            {t(
              error ??
                (!settings
                  ? 'loading'
                  : settings.effective[field]
                    ? 'setupPending'
                    : 'setupDisabled')
            )}
          </p>
          {settings && (
            <Button
              disabled={busy}
              onClick={() => void run()}
              data-testid="knowledge-feature-enable"
            >
              {t(
                busy
                  ? 'loading'
                  : settings.effective[field]
                    ? 'setupReconnect'
                    : feature === 'subscriptions'
                      ? 'enableWorkflowSchedules'
                      : 'setupEnable'
              )}
            </Button>
          )}
          {!settings && error && (
            <Button variant="outline" onClick={() => setRevision(value => value + 1)}>
              {t('refresh')}
            </Button>
          )}
        </section>
      )}
    </div>
  )
}

export function KnowledgeFeatureSetup(props: Parameters<typeof OwnedKnowledgeFeatureSetup>[0]) {
  return (
    <OwnedKnowledgeFeatureSetup
      key={JSON.stringify([
        props.serverId,
        props.workspacePath,
        props.feature,
        props.connection?.ownerKey,
      ])}
      {...props}
    />
  )
}
