import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  credentialNames,
  mcpActivationReason,
  normalizePluginActivation,
  type PluginActivationSnapshot,
  type PluginLifecycleApi,
} from './pluginLifecycle'

const phaseLabels = {
  installed: 'Installed',
  disabled: 'Disabled',
  credentials_required: 'Credentials required',
  authorization_required: 'Authorization required',
  loading: 'Loading components',
  mounted: 'Components mounted; read-only availability check pending',
  usable: 'Available; read-only check passed',
  failed: 'Component failed',
  unknown: 'Runtime availability has not been checked',
}

const mcpReasonLabels: Record<string, string> = {
  connectionFailed:
    'MCP connection failed. Check the server command or endpoint, then retry on the next turn.',
  protocolFailed:
    'MCP protocol negotiation or tool discovery failed. Check server compatibility and retry on the next turn.',
  authorizationRequired:
    'MCP authorization is incomplete or rejected. Complete authorization for this server in MCP settings, then retry on the next turn.',
  noTools:
    'MCP connected but no tools are mounted. Check the server tool list and plugin tool policy.',
  timedOut: 'MCP connection timed out. Check server availability and retry on the next turn.',
  unavailable: 'MCP is unavailable. Check the server configuration and retry on the next turn.',
}

interface PluginActivationPanelProps {
  pluginId: string | number
  enabled: boolean
  api: PluginLifecycleApi
  initial?: unknown
  onConfigured?: () => void
}

export function PluginActivationPanel(props: PluginActivationPanelProps) {
  const initial = normalizePluginActivation(props.initial)
  // Runtime identity changes discard transient forms and outstanding UI updates.
  return (
    <ScopedPluginActivationPanel
      key={JSON.stringify([props.pluginId, initial])}
      {...props}
      initial={initial}
    />
  )
}

function ScopedPluginActivationPanel({
  pluginId,
  enabled,
  api,
  initial,
  onConfigured,
}: PluginActivationPanelProps) {
  const { t } = useTranslation('common')
  const [snapshot, setSnapshot] = useState<PluginActivationSnapshot | null>(
    normalizePluginActivation(initial)
  )
  const [conversations, setConversations] = useState<Array<{ taskId: string; title: string }>>([])
  const [taskId, setTaskId] = useState('')
  useEffect(() => {
    let alive = true
    if (api.listActivationConversations)
      void api
        .listActivationConversations()
        .then(items => {
          if (alive) setConversations(items)
        })
        .catch(() => {})
    return () => {
      alive = false
    }
  }, [api])
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [nextTurn, setNextTurn] = useState(false)
  const scope = useRef(0)
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => {
    scope.current += 1
    const currentForm = form.current
    return () => {
      scope.current += 1
      currentForm?.reset()
    }
  }, [api])

  const check = async () => {
    if (!api.readPluginActivation || pending) return
    const current = scope.current
    setPending(true)
    setFailed(false)
    try {
      const response = await (taskId
        ? api.readPluginActivation(pluginId, { taskId })
        : api.readPluginActivation(pluginId))
      if (current === scope.current) setSnapshot(normalizePluginActivation(response))
    } catch {
      if (current === scope.current) setFailed(true)
    } finally {
      if (current === scope.current) setPending(false)
    }
  }

  const missing = credentialNames(
    snapshot?.components.flatMap(item => item.missingNames ?? []) ?? []
  )
  const configure = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (
      !api.configurePluginCredentials ||
      pending ||
      !missing.length ||
      !(snapshot?.operationId || snapshot?.credentialScope)
    )
      return
    const fields = new FormData(event.currentTarget)
    const values: Record<string, string> = Object.create(null)
    for (const name of missing) {
      const value = fields.get(name)
      fields.delete(name)
      if (typeof value === 'string' && value.trim()) values[name] = value
    }
    // Clear browser controls before the request. Values never enter React state,
    // chat, storage, diagnostic text, or the model's conversation.
    event.currentTarget.reset()
    const current = scope.current
    setPending(true)
    setFailed(false)
    try {
      const result = await api.configurePluginCredentials(pluginId, values, {
        ...(snapshot.operationId
          ? { expectedOperationId: snapshot.operationId, expectedGeneration: snapshot.generation }
          : {}),
        ...(snapshot.credentialScope ? { expectedCredentialScope: snapshot.credentialScope } : {}),
      })
      if (current !== scope.current) return
      setNextTurn(result.effectiveFrom === 'next_turn')
      onConfigured?.()
      if (api.readPluginActivation) {
        const response = await (taskId
          ? api.readPluginActivation(pluginId, { taskId })
          : api.readPluginActivation(pluginId))
        if (current === scope.current) setSnapshot(normalizePluginActivation(response))
      }
    } catch {
      // Never display raw private credential RPC errors, which may echo values.
      if (current === scope.current) setFailed(true)
    } finally {
      for (const name of Object.keys(values)) delete values[name]
      if (current === scope.current) setPending(false)
    }
  }

  const phase = !enabled ? 'disabled' : (snapshot?.phase ?? 'unknown')
  return (
    <section
      className="space-y-3 border-t border-border py-4"
      data-testid="plugin-activation-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-secondary" role="status">
          {t(`pluginActivation.phase.${phase}`, { defaultValue: phaseLabels[phase] })}
        </p>
        <button
          type="button"
          className="min-h-11 rounded-lg border border-border px-3 text-sm text-text-primary disabled:opacity-50 md:min-h-8"
          data-testid="plugin-activation-check"
          disabled={pending || !enabled || !api.readPluginActivation}
          onClick={() => void check()}
        >
          {t('pluginActivation.check', 'Check availability')}
        </button>
      </div>
      {conversations.length > 0 && (
        <label className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
          {t('pluginActivation.conversation', 'Check in conversation')}
          <select
            data-testid="plugin-activation-conversation"
            className="min-h-11 max-w-full rounded-lg border border-border bg-surface px-2 md:min-h-8"
            value={taskId}
            disabled={pending}
            onChange={event => {
              setTaskId(event.target.value)
              setSnapshot(null)
            }}
          >
            <option value="">{t('pluginActivation.profileOnly', 'Configuration only')}</option>
            {conversations.map(item => (
              <option key={item.taskId} value={item.taskId}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {!api.readPluginActivation && (
        <p className="text-xs text-text-muted">
          {t(
            'pluginActivation.unsupported',
            'This execution target does not report runtime activation yet.'
          )}
        </p>
      )}
      {snapshot?.components.map((component, index) => (
        <p
          key={`${component.kind}:${component.name}:${index}`}
          className="text-sm text-text-secondary"
        >
          {component.name}:{' '}
          {t(`pluginActivation.phase.${component.phase}`, {
            defaultValue: phaseLabels[component.phase],
          })}
          {component.kind === 'mcp' && component.toolCount !== undefined
            ? ` · ${t('pluginActivation.tools', { count: component.toolCount, defaultValue: '{{count}} mounted tools' })}`
            : ''}
          {component.errorCode && component.kind === 'mcp' && (
            <span
              className="block text-xs text-text-muted"
              data-testid="plugin-activation-mcp-reason"
            >
              {t(`pluginActivation.mcpReason.${mcpActivationReason(component.errorCode)}`, {
                defaultValue:
                  mcpReasonLabels[mcpActivationReason(component.errorCode) ?? 'unavailable'],
              })}
            </span>
          )}
          {component.errorCode && component.kind !== 'mcp' ? ` · ${component.errorCode}` : ''}
        </p>
      ))}
      {missing.length > 0 &&
        (api.configurePluginCredentials ? (
          <form
            ref={form}
            onSubmit={event => void configure(event)}
            className="space-y-3"
            data-testid="plugin-private-credentials"
          >
            <p className="text-xs text-text-secondary">
              {t(
                'pluginActivation.privateHint',
                'Credentials go directly to private storage on this execution target. Do not paste them into chat.'
              )}
            </p>
            {!(snapshot?.operationId || snapshot?.credentialScope) && (
              <p className="text-xs text-text-secondary">
                {t(
                  'pluginActivation.identityRequired',
                  'Check availability before entering credentials to confirm the current plugin source.'
                )}
              </p>
            )}
            {missing.map(name => (
              <label key={name} className="block space-y-1 text-sm text-text-primary">
                <span>{name}</span>
                <input
                  name={name}
                  type="password"
                  autoComplete="off"
                  required
                  disabled={pending || !(snapshot?.operationId || snapshot?.credentialScope)}
                  className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm md:min-h-8"
                />
              </label>
            ))}
            <button
              type="submit"
              disabled={pending || !(snapshot?.operationId || snapshot?.credentialScope)}
              className="min-h-11 rounded-lg bg-text-primary px-3 text-sm text-background disabled:opacity-50 md:min-h-8"
            >
              {t('pluginActivation.savePrivate', 'Save privately and check')}
            </button>
          </form>
        ) : (
          <p className="text-xs text-text-secondary">
            {t(
              'pluginActivation.privateUnsupported',
              'Private credential setup is unavailable on this target. Update the target before configuring credentials here.'
            )}
          </p>
        ))}
      {nextTurn && (
        <p className="text-xs text-text-secondary" role="status">
          {t(
            'pluginActivation.nextTurn',
            'Saved. These credentials take effect on the next turn or connection.'
          )}
        </p>
      )}
      {failed && (
        <p className="text-sm text-destructive" role="alert">
          {t(
            'pluginActivation.failed',
            'The check failed. Verify the target configuration and try again.'
          )}
        </p>
      )}
    </section>
  )
}
