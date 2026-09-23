import { gatewayServerLabel } from '@/kcoder/gatewayServerLabel'
import { Checkbox } from '@/components/ui/checkbox'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { workbenchModelTarget } from '@/features/workbench/workbenchModelTarget'
import {
  Box,
  Code,
  Database,
  FileCode,
  Info,
  KeyRound,
  Layers,
  Link,
  Lock,
  RefreshCw,
  ShieldCheck,
  Star,
  User,
} from 'lucide-react'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { fetchGatewayServers, type GatewayServer } from '@/kcoder/gatewayRpc'
import {
  applyProviderSettings,
  deleteProviderSettings,
  readProviderSettings,
  readProviderTemplates,
  type ProviderTemplate,
  saveProviderSettings,
  type ProviderDraft,
  type ProviderSettings,
  type ProviderProfile,
  type ProviderModelCapabilities,
} from '@/kcoder/providerSettings'
import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
import { providerSaveErrorKey, providerSaveOutcomeUnknown } from '@/kcoder/providerValidationErrors'
import { isPlaintextRemoteEndpoint } from '@/lib/endpoint-security'

import { ConfigTemplatesSection } from './ConfigTemplatesSection'
import { ProviderConfigurationSources } from './ProviderConfigurationSources'
import { hasFileOverrides } from './providerSourceMetadata'
import {
  IconSelect,
  InfoBox,
  InputWithIcon,
  ModelMark,
  PasswordInput,
  SectionHeader,
  SettingsPage,
  SettingsPageHeader,
  StatusChip,
} from './settings-ui'
import { RuntimeTargetConfirmDialog } from './RuntimeTargetConfirmDialog'

const DEFAULT_MODEL_LIMITS = {
  contextWindowTokens: 100_000_000,
  maxOutputTokens: 65_536,
}

const emptyDraft = (revision?: string): ProviderDraft => ({
  ...(revision ? { expectedRevision: revision } : {}),
  id: '',
  apiFormat: 'openai_chat_completions',
  endpoint: '',
  model: '',
  ...DEFAULT_MODEL_LIMITS,
  apiKey: '',
  authentication: { mode: 'api_key' },
  makeDefault: true,
})

const conservativeCapabilities: ProviderModelCapabilities = {
  text: true,
  tools: false,
  vision: false,
  reasoning: false,
  structured_output: false,
}

function providerTargetScope(server?: GatewayServer): string {
  if (!server) return ''
  return JSON.stringify([
    server.id,
    server.transport,
    server.host,
    server.port,
    server.user,
    server.command,
    server.workspacePath,
    server.profile,
    server.settingsFile,
    server.security?.identity.mode,
    server.authorityId,
    server.accountIdentity?.principalId,
  ])
}

export function KCoderProviderSettingsPage() {
  const { t } = useTranslation('common')
  const { t: policyT } = useTranslation('localRuntime')
  const workbench = useContext(WorkbenchContext)
  const initialTarget = useRef(
    workbench ? workbenchModelTarget(workbench.state).deviceId : undefined
  )
  const [servers, setServers] = useState<GatewayServer[]>([])
  const [identityReady, setIdentityReady] = useState(false)
  const [serverId, setServerId] = useState('')
  const [settings, setSettings] = useState<ProviderSettings | null>(null)
  const [extraBodyText, setExtraBodyText] = useState('')
  const [draft, setDraft] = useState<ProviderDraft>(emptyDraft)
  const [draftMode, setDraftMode] = useState<'new-api' | 'new-model' | 'edit'>('new-api')
  const [templateState, setTemplateState] = useState<{
    serverId: string
    templates: ProviderTemplate[]
    error: boolean
    supportsAuthenticationPolicy: boolean
  } | null>(null)
  const templates = templateState?.serverId === serverId ? templateState.templates : []
  const templateError = templateState?.serverId === serverId && templateState.error
  const supportsAuthenticationPolicy =
    templateState?.serverId === serverId && templateState.supportsAuthenticationPolicy
  const [templateRefresh, setTemplateRefresh] = useState(0)
  const [scopeVersion, setScopeVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveRecovery, setSaveRecovery] = useState<'read' | 'review' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [plaintextConfirmation, setPlaintextConfirmation] = useState<string | null>(null)
  const generation = useRef(0)
  const [deleting, setDeleting] = useState<ProviderProfile | null>(null)
  const [deleteKind, setDeleteKind] = useState<'provider' | 'model'>('provider')
  const [replacement, setReplacement] = useState('')
  const [removeCredentials, setRemoveCredentials] = useState(false)
  const deleteTrigger = useRef<HTMLButtonElement | null>(null)
  const label = (name: string) =>
    name.startsWith('reasoningPolicy')
      ? policyT(`providerSettings.${name}`)
      : t(`providerSettings.${name}`)
  const target = identityReady ? servers.find(server => server.id === serverId) : undefined
  const accountName = target?.accountIdentity?.username
  const accountStatus = !target
    ? label('identityUnavailable')
    : accountName
      ? accountName
      : target.security?.identity.mode === 'kcoder-account'
        ? label('identitySignedOut')
        : label('identityShared')
  const multiple = settings?.supportsMultipleModels === true
  const rowId = (profile: ProviderProfile) =>
    multiple
      ? `${encodeURIComponent(profile.id)}::${encodeURIComponent(profile.model)}`
      : profile.id
  const providerRows = Array.from(
    new Map(settings?.profiles.map(profile => [profile.id, profile])).values()
  )
  const deletionNeedsReplacement = Boolean(
    deleting &&
    (deleteKind === 'model'
      ? (deleting.isProviderDefault ?? deleting.isDefault)
      : settings?.profiles.some(profile => profile.id === deleting.id && profile.isDefault))
  )
  const replacementRows = deleting
    ? deleteKind === 'model'
      ? (settings?.profiles.filter(
          profile => profile.id === deleting.id && profile.model !== deleting.model
        ) ?? [])
      : providerRows.filter(profile => profile.canDelete && profile.id !== deleting.id)
    : []
  const editProfile = (profile: ProviderProfile, addModel = false) => {
    if (saveRecovery === 'read') return
    setSaveRecovery(null)
    setNotice(null)
    setExtraBodyText(addModel ? '' : JSON.stringify(profile.extraBody ?? {}, null, 2))
    setDraftMode(addModel ? 'new-model' : 'edit')
    setError(null)
    setDraft({
      ...(settings?.supportsOptimisticConcurrency ? { expectedRevision: settings.revision } : {}),
      id: profile.id,
      apiFormat: profile.apiFormat,
      ...(settings?.supportsChatProtocol ? { chatProtocol: profile.chatProtocol ?? 'auto' } : {}),
      ...(settings?.supportsModelReasoning
        ? { reasoningEffort: addModel ? 'default' : (profile.reasoningEffort ?? 'default') }
        : {}),
      ...(settings?.supportsModelReasoningPolicy && !addModel && profile.reasoningPolicy
        ? { reasoningPolicy: profile.reasoningPolicy }
        : {}),
      endpoint: profile.endpoint,
      model: addModel ? '' : profile.model,
      contextWindowTokens: addModel
        ? DEFAULT_MODEL_LIMITS.contextWindowTokens
        : profile.contextWindowTokens,
      maxOutputTokens: addModel ? DEFAULT_MODEL_LIMITS.maxOutputTokens : profile.maxOutputTokens,
      apiKey: '',
      authentication: profile.authentication ?? { mode: 'api_key' },
      capabilities: addModel ? undefined : profile.capabilities,
      makeDefault: addModel ? false : profile.isDefault,
      ...(multiple && !addModel ? { originalModel: profile.model } : {}),
    })
  }

  useEffect(() => {
    let disposed = false
    void fetchGatewayServers()
      .then(items => {
        if (disposed) return
        setServers(items)
        setIdentityReady(true)
        setServerId(current =>
          items.some(item => item.id === current)
            ? current
            : (items.find(item => item.id === initialTarget.current)?.id ?? items[0]?.id ?? '')
        )
      })
      .catch(() => {
        if (!disposed) setError(t('providerSettings.loadFailed'))
      })
    return () => {
      disposed = true
    }
  }, [t])

  useEffect(() => {
    const changed = () => {
      const current = ++generation.current
      const oldScope = providerTargetScope(servers.find(server => server.id === serverId))
      setIdentityReady(false)
      // Quarantine the previous account's draft before awaiting identity discovery.
      setSettings(null)
      setDraft(emptyDraft())
      setExtraBodyText('')
      setDraftMode('new-api')
      setTemplateState(null)
      setDeleting(null)
      setPlaintextConfirmation(null)
      setNotice(null)
      setError(null)
      setBusy(true)
      setSaving(false)
      setScopeVersion(value => value + 1)
      void (async () => {
        try {
          const items = await fetchGatewayServers()
          if (current !== generation.current) return
          const selected = items.find(server => server.id === serverId)
          setServers(items)
          setIdentityReady(true)
          setSaveRecovery(null)
          if (!selected) {
            setServerId(items[0]?.id ?? '')
            return
          }
          const sameScope = oldScope !== '' && oldScope === providerTargetScope(selected)
          const next = await readProviderSettings(serverId)
          if (current !== generation.current) return
          setSettings(next)
          if (sameScope) {
            setDraft(draft)
            setExtraBodyText(extraBodyText)
            setDraftMode(draftMode)
            setSaveRecovery(saving ? 'review' : saveRecovery)
          } else {
            setDraft(emptyDraft(next.supportsOptimisticConcurrency ? next.revision : undefined))
          }
          setTemplateRefresh(value => value + 1)
        } catch {
          if (current === generation.current) setError(t('providerSettings.loadFailed'))
        } finally {
          if (current === generation.current) setBusy(false)
        }
      })()
    }
    window.addEventListener('kcoder:servers-changed', changed)
    return () => window.removeEventListener('kcoder:servers-changed', changed)
  }, [serverId, servers, draft, draftMode, extraBodyText, saving, saveRecovery, t])

  const refresh = useCallback(async () => {
    if (!serverId) return
    const current = ++generation.current
    setBusy(true)
    setError(null)
    try {
      const next = await readProviderSettings(serverId)
      if (current === generation.current) {
        setSettings(next)
        setSaveRecovery(value => (value ? 'review' : null))
        // Refreshing the list must not rebase an existing unsaved draft.
        setDraft(value =>
          next.supportsOptimisticConcurrency &&
          !value.expectedRevision &&
          !value.id &&
          !value.model &&
          !value.endpoint
            ? { ...value, expectedRevision: next.revision }
            : value
        )
      }
    } catch {
      if (current === generation.current) setError(t('providerSettings.loadFailed'))
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }, [serverId, t])

  useEffect(() => {
    let disposed = false
    if (serverId) {
      void readProviderTemplates(serverId)
        .then(result => {
          if (!disposed)
            setTemplateState({
              serverId,
              templates: result.templates,
              error: false,
              supportsAuthenticationPolicy: result.supportsAuthenticationPolicy === true,
            })
        })
        .catch(() => {
          if (!disposed)
            setTemplateState({
              serverId,
              templates: [],
              error: true,
              supportsAuthenticationPolicy: false,
            })
        })
    }
    return () => {
      disposed = true
    }
  }, [serverId, templateRefresh, scopeVersion])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => {
      window.clearTimeout(timer)
      generation.current += 1
    }
  }, [refresh])

  const save = async (approvedEndpoint?: string) => {
    if (busy || !serverId || !settings || saveRecovery) return
    if (settings.supportsOptimisticConcurrency && !draft.expectedRevision) {
      setError(label('validation_changed'))
      return
    }
    if (!multiple && (draftMode === 'new-model' || draft.originalModel !== undefined)) {
      setError(label('multipleModelsUnsupported'))
      return
    }
    if (
      draftMode === 'new-api' &&
      settings.profiles.some(profile => profile.id === draft.id.trim())
    ) {
      setError(label(multiple ? 'existingApi' : 'multipleModelsUnsupported'))
      return
    }
    if (
      multiple &&
      settings.profiles.some(
        profile =>
          profile.id === draft.id.trim() &&
          profile.model === draft.model.trim() &&
          (draftMode === 'new-model' ||
            (draftMode === 'edit' && draft.originalModel !== profile.model))
      )
    ) {
      setError(label('existingModel'))
      return
    }
    if (isPlaintextRemoteEndpoint(draft.endpoint) && approvedEndpoint !== draft.endpoint.trim()) {
      setPlaintextConfirmation(draft.endpoint.trim())
      return
    }
    if (!draft.model.trim()) {
      setError(t('providerSettings.modelRequired'))
      document.querySelector<HTMLInputElement>('[data-testid="provider-model"]')?.focus()
      return
    }
    let extraBody: Record<string, unknown> | undefined
    if (settings.supportsModelExtraBody) {
      try {
        const parsed: unknown = JSON.parse(extraBodyText.trim() || '{}')
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
        if (new TextEncoder().encode(JSON.stringify(parsed)).length > 65536) throw new Error()
        extraBody = parsed as Record<string, unknown>
      } catch {
        setError(label('extraBodyInvalid'))
        return
      }
    }
    const reservedField = [
      'model',
      'messages',
      'input',
      'system',
      'instructions',
      'tools',
      'stream',
    ].find(field => extraBody && Object.prototype.hasOwnProperty.call(extraBody, field))
    if (reservedField) {
      setError(t('providerSettings.extraBodyReserved', { field: reservedField }))
      window.requestAnimationFrame(() => {
        const input = document.querySelector<HTMLTextAreaElement>(
          '[data-testid="provider-extra-body"]'
        )
        input?.focus()
        input?.scrollIntoView({ block: 'center' })
      })
      return
    }
    const current = generation.current
    setBusy(true)
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const next = await saveProviderSettings(
        serverId,
        settings.supportsModelCapabilities
          ? {
              ...draft,
              ...(extraBody ? { extraBody } : {}),
              capabilities: draft.capabilities ?? conservativeCapabilities,
            }
          : { ...draft, ...(extraBody ? { extraBody } : {}) }
      )
      if (current !== generation.current) return
      setSettings(next)
      setDraftMode('edit')
      setDraft(value => ({
        ...value,
        apiKey: '',
        ...(next.supportsOptimisticConcurrency ? { expectedRevision: next.savedRevision } : {}),
        ...(next.supportsMultipleModels ? { originalModel: value.model.trim() } : {}),
      }))
      const savedProfile = next.profiles.find(
        profile => profile.id === draft.id.trim() && profile.model === draft.model.trim()
      )
      setNotice(
        label(
          savedProfile?.availableInCurrentConfig === false
            ? 'savedUnavailable'
            : hasFileOverrides(savedProfile)
              ? 'savedWithOverrides'
              : next.supportsTurnModelReload
                ? 'savedForNextTurn'
                : next.supportsNewSessionReload
                  ? 'savedForNewSessions'
                  : 'saved'
        )
      )
      if (next.supportsNewSessionReload)
        window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
    } catch (failure) {
      // Never echo a failed request that may contain an API key.
      if (current === generation.current) {
        if (providerSaveOutcomeUnknown(failure)) {
          setSaveRecovery('read')
          setError(null)
        } else setError(t(providerSaveErrorKey(failure)))
      }
    } finally {
      if (current === generation.current) {
        setBusy(false)
        setSaving(false)
      }
    }
  }

  const apply = async () => {
    if (busy || !serverId) return
    const current = generation.current
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await applyProviderSettings(serverId)
      if (current !== generation.current) return
      if (!result.restarted) throw new Error(t('providerSettings.applyBlocked'))
      const reloaded = await readProviderSettings(serverId)
      if (current !== generation.current) return
      setSettings(reloaded)
      window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
      if (reloaded.restartRequired) setError(t('providerSettings.overridden'))
      else setNotice(t('providerSettings.applied'))
    } catch {
      if (current === generation.current) setError(t('providerSettings.applyBlocked'))
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }

  const closeDeletion = () => {
    if (busy) return
    setDeleting(null)
    deleteTrigger.current?.focus()
  }
  const remove = async () => {
    if (busy || !serverId || !deleting) return
    if (deleteKind === 'model' && (!multiple || replacementRows.length === 0)) return
    const current = generation.current
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const next = await deleteProviderSettings(serverId, deleting.id, {
        ...(deleteKind === 'model'
          ? {
              model: deleting.model,
              ...(deletionNeedsReplacement && replacement ? { replacementModel: replacement } : {}),
            }
          : deletionNeedsReplacement && replacement
            ? { replacementProvider: replacement }
            : {}),
        removeCredentials: deleteKind === 'model' ? false : removeCredentials,
      })
      if (current !== generation.current) return
      setSettings(next)
      setDraft(value =>
        value.id === deleting.id
          ? emptyDraft(next.supportsOptimisticConcurrency ? next.revision : undefined)
          : value
      )
      if (draft.id === deleting.id) {
        setDraftMode('new-api')
        setExtraBodyText('')
      }
      setDeleting(null)
      const nextDefault = next.profiles.find(profile =>
        deleteKind === 'model'
          ? profile.id === deleting.id && profile.isProviderDefault
          : profile.isDefault
      )
      const defaultNotice = nextDefault
        ? `${label('defaultAfterDelete')} ${nextDefault.id} · ${nextDefault.model}`
        : next.profiles.length === 0
          ? label('emptyAfterDelete')
          : ''
      setNotice(
        next.warning
          ? label('credentialCleanupFailed')
          : `${label(next.supportsTurnModelReload ? 'deletedForNextTurn' : next.supportsNewSessionReload ? 'deletedForNewSessions' : deleteKind === 'model' ? 'modelDeleted' : 'deleted')} ${defaultNotice}`
      )
      if (next.supportsNewSessionReload)
        window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
      window.requestAnimationFrame(() => {
        if (current === generation.current)
          document.querySelector<HTMLButtonElement>('[data-testid="provider-new"]')?.focus()
      })
    } catch {
      if (current === generation.current) {
        setDeleting(null)
        setError(label('deleteFailed'))
        deleteTrigger.current?.focus()
      }
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }
  return (
    <SettingsPage data-testid="kcoder-provider-settings-page" className="space-y-4">
      <SettingsPageHeader title={label('title')} description={label('description')} />
      <InfoBox icon={<Info />}>{label('userScope')}</InfoBox>
      <ConfigTemplatesSection key={`${serverId}:${scopeVersion}`} serverId={serverId} />
      <SectionHeader
        icon={<Layers />}
        title={label('target')}
        description={label('targetSubtitle')}
      />
      <div className="flex flex-wrap items-center gap-2">
        <IconSelect
          icon={<Layers className="h-4 w-4" />}
          data-testid="provider-target"
          className="max-w-md min-w-0 flex-1"
          aria-label={label('target')}
          value={serverId}
          disabled={busy}
          onChange={event => {
            generation.current += 1
            setSettings(null)
            setSaveRecovery(null)
            setDraft(emptyDraft())
            setExtraBodyText('')
            setDraftMode('new-api')
            setNotice(null)
            setDeleting(null)
            setServerId(event.target.value)
          }}
        >
          {servers.map(server => (
            <option key={server.id} value={server.id}>
              {gatewayServerLabel(server, t)}
            </option>
          ))}
        </IconSelect>
        <Button
          data-testid="provider-refresh"
          variant="outline"
          disabled={busy || !serverId}
          onClick={() => {
            setTemplateRefresh(value => value + 1)
            void refresh()
          }}
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {label('refresh')}
        </Button>
        <Button
          data-testid="provider-new"
          variant="outline"
          disabled={busy || !settings || saveRecovery === 'read'}
          onClick={() => {
            setSaveRecovery(null)
            setDraft(
              emptyDraft(settings?.supportsOptimisticConcurrency ? settings.revision : undefined)
            )
            setExtraBodyText('')
            setDraftMode('new-api')
            setError(null)
          }}
        >
          {label('add')}
        </Button>
      </div>
      <div data-testid="provider-identity" className="space-y-1 text-sm" aria-live="polite">
        <p className="flex min-w-0 items-start gap-2">
          <User className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="shrink-0 text-muted-foreground">{label('identityLabel')}</span>
          <span className="min-w-0 break-all text-foreground">{accountStatus}</span>
        </p>
        {target && !accountName && target.security?.identity.mode !== 'kcoder-account' && (
          <p className="text-muted-foreground">{label('identitySharedHelp')}</p>
        )}
      </div>
      <ProviderConfigurationSources
        profile={
          draftMode === 'edit'
            ? settings?.profiles.find(
                profile =>
                  profile.id === draft.id && profile.model === (draft.originalModel ?? draft.model)
              )
            : undefined
        }
      />
      {settings?.supportsNewSessionReload && (
        <p data-testid="provider-session-reload" className="text-sm text-muted-foreground">
          {label(settings.supportsTurnModelReload ? 'nextTurnReloadHelp' : 'newSessionReloadHelp')}
        </p>
      )}
      {settings?.restartRequired && !settings.supportsNewSessionReload && (
        <section
          data-testid="provider-pending-apply"
          aria-label={label('pendingApplyTitle')}
          className="space-y-2 rounded-lg border border-border bg-muted/40 p-3"
        >
          <h2 className="text-sm font-medium">{label('pendingApplyTitle')}</h2>
          <p className="text-sm text-muted-foreground">{label('pendingApply')}</p>
          <Button data-testid="provider-apply" disabled={busy} onClick={() => void apply()}>
            {label('apply')}
          </Button>
        </section>
      )}
      {error && (
        <div role="alert" className="text-sm text-red-600">
          {error}
        </div>
      )}
      {saveRecovery && (
        <div
          role="status"
          data-testid="provider-save-recovery"
          className="text-sm text-muted-foreground"
        >
          {label(saveRecovery === 'read' ? 'saveOutcomeUnknown' : 'recoveredStateReview')}
        </div>
      )}
      {notice && (
        <div role="status" className="text-sm text-muted-foreground">
          {notice}
        </div>
      )}
      <div className="space-y-1">
        {settings?.profiles.map(profile => (
          <div
            key={JSON.stringify([profile.id, profile.model])}
            className="flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-stretch"
          >
            <button
              type="button"
              data-testid={`provider-edit-${rowId(profile)}`}
              className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-xl border border-transparent px-3 py-3 text-left text-sm transition-all hover:border-border/60 hover:bg-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              disabled={busy}
              onClick={() => editProfile(profile)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <ModelMark label={profile.id} />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="truncate font-medium">{profile.model}</span>
                  <span className="truncate text-xs text-text-secondary">{profile.id}</span>
                </span>
              </span>
              <span className="flex shrink-0 flex-wrap items-center gap-2">
                {profile.isProviderDefault && (
                  <StatusChip variant="neutral">{label('providerDefault')}</StatusChip>
                )}
                {profile.authentication?.mode === 'none' ? (
                  <StatusChip variant="neutral">{label('authenticationNone')}</StatusChip>
                ) : profile.apiKeyConfigured ? (
                  <StatusChip variant="success">{label('keyConfigured')}</StatusChip>
                ) : (
                  <StatusChip variant="neutral">{label('noKey')}</StatusChip>
                )}
              </span>
            </button>
            {multiple && providerRows.find(item => item.id === profile.id) === profile && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                data-testid={`provider-add-model-${profile.id}`}
                onClick={() => editProfile(profile, true)}
              >
                {label('addModel')}
              </Button>
            )}
            {multiple && profile.canDelete && (
              <Button
                type="button"
                variant="destructive"
                disabled={
                  busy || settings.profiles.filter(item => item.id === profile.id).length < 2
                }
                title={label('lastModelHelp')}
                data-testid={`provider-delete-model-${rowId(profile)}`}
                onClick={event => {
                  deleteTrigger.current = event.currentTarget
                  setDeleteKind('model')
                  setDeleting(profile)
                  setReplacement('')
                  setRemoveCredentials(false)
                }}
              >
                {label('deleteModel')}
              </Button>
            )}
            {profile.canDelete && providerRows.find(item => item.id === profile.id) === profile && (
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                data-testid={`provider-delete-${profile.id}`}
                onClick={event => {
                  deleteTrigger.current = event.currentTarget
                  setReplacement('')
                  setRemoveCredentials(false)
                  setDeleteKind('provider')
                  setDeleting(profile)
                }}
              >
                {label('delete')}
              </Button>
            )}
          </div>
        ))}
      </div>
      {plaintextConfirmation !== null && (
        <RuntimeTargetConfirmDialog
          testId="provider-plaintext-dialog"
          title={label('save')}
          description={t('providerSettings.plaintextEndpointConfirm', {
            endpoint: plaintextConfirmation,
          })}
          cancelLabel={label('cancel')}
          closeLabel={label('cancel')}
          confirmLabel={label('save')}
          onCancel={() => {
            setPlaintextConfirmation(null)
            setNotice(t('providerSettings.plaintextEndpointDeclined'))
          }}
          onConfirm={() => {
            const endpoint = plaintextConfirmation
            setPlaintextConfirmation(null)
            void save(endpoint)
          }}
        />
      )}
      {deleting && (
        <RuntimeTargetConfirmDialog
          testId="provider-delete-dialog"
          title={`${label(deleteKind === 'model' ? 'deleteModel' : 'delete')} ${deleting.id}${deleteKind === 'model' ? ` · ${deleting.model}` : ''}`}
          description={label(
            settings?.supportsTurnModelReload
              ? 'deleteForNextTurnDescription'
              : settings?.supportsNewSessionReload
                ? 'deleteForNewSessionsDescription'
                : deleteKind === 'model'
                  ? 'deleteModelDescription'
                  : 'deleteDescription'
          )}
          cancelLabel={label('cancel')}
          closeLabel={label('cancel')}
          confirmLabel={label('delete')}
          destructive
          pending={busy}
          onCancel={closeDeletion}
          onConfirm={() => void remove()}
        >
          {deletionNeedsReplacement && (
            <label className="block text-sm">
              {label(deleteKind === 'model' ? 'replacementModel' : 'replacement')}
              <IconSelect
                icon={<Link className="h-4 w-4" />}
                data-testid="provider-delete-replacement"
                value={replacement}
                disabled={busy}
                onChange={event => setReplacement(event.target.value)}
              >
                <option value="">
                  {label(replacementRows.length ? 'automaticReplacement' : 'emptyAfterDelete')}
                </option>
                {replacementRows.map(profile => (
                  <option
                    key={rowId(profile)}
                    value={deleteKind === 'model' ? profile.model : profile.id}
                  >
                    {profile.id} · {profile.model}
                  </option>
                ))}
              </IconSelect>
              {replacementRows.length === 0 && <p>{label('emptyAfterDelete')}</p>}
            </label>
          )}
          {deleteKind === 'provider' && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                data-testid="provider-delete-credentials"
                checked={removeCredentials}
                disabled={busy}
                onChange={event => setRemoveCredentials(event.target.checked)}
              />
              {label('removeCredentials')}
            </label>
          )}
        </RuntimeTargetConfirmDialog>
      )}
      <form
        data-testid="provider-form"
        className="space-y-5 rounded-2xl border border-border/60 bg-surface/30 p-5"
        onSubmit={event => {
          event.preventDefault()
          void save()
        }}
      >
        <fieldset disabled={busy || !settings || saveRecovery === 'read'} className="contents">
          <SectionHeader
            icon={<KeyRound />}
            title={label(
              draftMode === 'new-model' ? 'addModel' : draftMode === 'edit' ? 'editModel' : 'add'
            )}
          />
          {multiple && draftMode !== 'new-api' && (
            <p className="text-sm text-muted-foreground">{label('sharedConnection')}</p>
          )}
          <fieldset disabled={busy || !settings} className="grid gap-4 md:grid-cols-2">
            {templates.length > 0 && draftMode !== 'new-model' && (
              <label className="text-sm md:col-span-2">
                {label('template')}
                <IconSelect
                  icon={<FileCode className="h-4 w-4" />}
                  data-testid="provider-template"
                  aria-label={label('template')}
                  value=""
                  onChange={event => {
                    const template = templates.find(item => item.id === event.target.value)
                    if (template)
                      setDraft(value => ({
                        ...value,
                        id: value.id || template.id,
                        apiFormat: template.apiFormat,
                        endpoint: template.endpoint,
                        model: '',
                        capabilities: undefined,
                        authentication: template.authentication ?? { mode: 'api_key' },
                        apiKey: template.authentication?.mode === 'none' ? '' : value.apiKey,
                      }))
                  }}
                >
                  <option value="">{label('chooseTemplate')}</option>
                  {templates.map(template => (
                    <option
                      key={template.id}
                      value={template.id}
                      disabled={
                        template.authentication?.mode === 'none' && !supportsAuthenticationPolicy
                      }
                    >
                      {template.id === 'local-openai'
                        ? label('localOpenaiTemplate')
                        : template.displayName}
                    </option>
                  ))}
                </IconSelect>
                <span className="text-sm text-muted-foreground">{label('templateHelp')}</span>
              </label>
            )}
            {templateError && (
              <p role="status" className="text-sm text-muted-foreground md:col-span-2">
                {label('templateLoadFailed')}
              </p>
            )}
            {(['id', 'endpoint', 'model', 'apiKey'] as const).map(field => (
              <label key={field} className="text-sm">
                {label(field)}
                {field === 'apiKey' ? (
                  <PasswordInput
                    data-testid={`provider-${field}`}
                    icon={<KeyRound className="h-4 w-4" />}
                    toggleTestId="provider-api-key-toggle"
                    toggleLabel={label('apiKeyToggle')}
                    hideLabel={label('apiKeyToggleHide')}
                    autoComplete="off"
                    required={false}
                    disabled={draft.authentication?.mode === 'none'}
                    value={draft[field]}
                    onChange={event =>
                      setDraft(value => ({ ...value, [field]: event.target.value }))
                    }
                  />
                ) : (
                  <InputWithIcon
                    data-testid={`provider-${field}`}
                    icon={
                      field === 'id' ? (
                        <User className="h-4 w-4" />
                      ) : field === 'endpoint' ? (
                        <Link className="h-4 w-4" />
                      ) : (
                        <Box className="h-4 w-4" />
                      )
                    }
                    type={field === 'endpoint' ? 'url' : 'text'}
                    autoComplete="off"
                    required
                    disabled={
                      (field === 'id' && draftMode !== 'new-api') ||
                      (draftMode === 'new-model' && field !== 'model')
                    }
                    placeholder={
                      field === 'id'
                        ? label('placeholderId')
                        : field === 'endpoint'
                          ? label('placeholderEndpoint')
                          : label('placeholderModel')
                    }
                    value={draft[field]}
                    onChange={event =>
                      setDraft(value => ({ ...value, [field]: event.target.value }))
                    }
                  />
                )}
              </label>
            ))}
            <label className="text-sm">
              {label('apiFormat')}
              <IconSelect
                icon={<Code className="h-4 w-4" />}
                data-testid="provider-format"
                aria-label={label('apiFormat')}
                value={draft.apiFormat}
                disabled={draftMode === 'new-model'}
                onChange={event =>
                  setDraft(value => ({
                    ...value,
                    apiFormat: event.target.value,
                    authentication:
                      event.target.value === 'openai_chat_completions'
                        ? value.authentication
                        : { mode: 'api_key' },
                  }))
                }
              >
                {[
                  'openai_chat_completions',
                  'openai_responses',
                  'anthropic_messages',
                  'gemini_generate_content',
                ].map(format => (
                  <option key={format}>{format}</option>
                ))}
              </IconSelect>
            </label>
            {supportsAuthenticationPolicy && (
              <label className="text-sm">
                {label('authentication')}
                <IconSelect
                  icon={<ShieldCheck className="h-4 w-4" />}
                  data-testid="provider-authentication"
                  aria-label={label('authentication')}
                  value={draft.authentication?.mode ?? 'api_key'}
                  disabled={draftMode === 'new-model'}
                  onChange={event => {
                    const mode = event.target.value === 'none' ? 'none' : 'api_key'
                    setDraft(value => ({
                      ...value,
                      authentication: { mode },
                      apiKey: mode === 'none' ? '' : value.apiKey,
                    }))
                  }}
                >
                  <option value="api_key">{label('authenticationApiKey')}</option>
                  <option value="none" disabled={draft.apiFormat !== 'openai_chat_completions'}>
                    {label('authenticationNone')}
                  </option>
                </IconSelect>
                {draft.authentication?.mode === 'none' && (
                  <p className="text-sm text-muted-foreground">{label('authenticationNoneHelp')}</p>
                )}
              </label>
            )}
            {(['contextWindowTokens', 'maxOutputTokens'] as const).map(field => (
              <label key={field} className="text-sm">
                {label(field)}
                <InputWithIcon
                  data-testid={`provider-${field}`}
                  icon={<Database className="h-4 w-4" />}
                  type="number"
                  min={1}
                  required
                  value={draft[field]}
                  onChange={event =>
                    setDraft(value => ({ ...value, [field]: Number(event.target.value) }))
                  }
                />
              </label>
            ))}
            {settings?.supportsModelCapabilities && (
              <fieldset className="space-y-2 md:col-span-2">
                <legend className="text-sm">{label('capabilities')}</legend>
                <p className="text-sm text-muted-foreground">{label('capabilitiesHelp')}</p>
                <div className="flex flex-wrap gap-2">
                  {(['text', 'tools', 'vision', 'reasoning', 'structured_output'] as const).map(
                    capability => (
                      <label key={capability} className="checkbox-option text-sm">
                        <Checkbox
                          data-testid={`provider-capability-${capability}`}
                          checked={(draft.capabilities ?? conservativeCapabilities)[capability]}
                          onChange={event =>
                            setDraft(value => ({
                              ...value,
                              capabilities: {
                                ...(value.capabilities ?? conservativeCapabilities),
                                [capability]: event.target.checked,
                              },
                            }))
                          }
                        />
                        {label(`capability_${capability}`)}
                      </label>
                    )
                  )}
                </div>
              </fieldset>
            )}
            <label className="checkbox-option text-sm">
              <Checkbox
                data-testid="provider-default"
                checked={draft.makeDefault}
                onChange={event =>
                  setDraft(value => ({ ...value, makeDefault: event.target.checked }))
                }
              />
              <Star className="h-4 w-4 text-text-muted" aria-hidden="true" />
              {label(multiple ? 'makeDefaultModel' : 'makeDefault')}
            </label>
          </fieldset>
          {settings?.supportsChatProtocol && draft.apiFormat === 'openai_chat_completions' && (
            <label className="mt-4 block text-sm">
              {label('chatProtocol')}
              <IconSelect
                data-testid="provider-chat-protocol"
                icon={<Code />}
                value={draft.chatProtocol ?? 'auto'}
                disabled={busy || draftMode === 'new-model'}
                onChange={event =>
                  setDraft(value => ({
                    ...value,
                    chatProtocol: event.target.value as 'auto' | 'standard' | 'minimax',
                  }))
                }
              >
                <option value="auto">{label('chatProtocolAuto')}</option>
                <option value="standard">{label('chatProtocolStandard')}</option>
                <option value="minimax">MiniMax</option>
              </IconSelect>
              <span className="mt-2 block text-sm text-muted-foreground">
                {label('chatProtocolHelp')}
              </span>
            </label>
          )}
          {settings?.supportsModelReasoning && (
            <label className="mt-4 block text-sm">
              {label('reasoningEffort')}
              <IconSelect
                data-testid="provider-reasoning-effort"
                icon={<Code />}
                value={draft.reasoningEffort ?? 'default'}
                disabled={busy}
                onChange={event =>
                  setDraft(value => ({ ...value, reasoningEffort: event.target.value }))
                }
              >
                {['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map(effort => (
                  <option key={effort} value={effort}>
                    {label(`reasoning_${effort}`)}
                  </option>
                ))}
                {draft.reasoningEffort &&
                  !['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(
                    draft.reasoningEffort
                  ) && <option value={draft.reasoningEffort}>{draft.reasoningEffort}</option>}
              </IconSelect>
              <span className="mt-2 block text-sm text-muted-foreground">
                {label('reasoningHelp')}
              </span>
            </label>
          )}
          {settings?.supportsModelReasoningPolicy && (
            <fieldset className="mt-4 space-y-2 text-sm" data-testid="provider-reasoning-policy">
              <legend>{label('reasoningPolicy')}</legend>
              <IconSelect
                data-testid="provider-reasoning-policy-mode"
                icon={<Code />}
                value={draft.reasoningPolicy?.mode ?? 'hidden'}
                disabled={busy}
                onChange={event =>
                  setDraft(value => ({
                    ...value,
                    reasoningPolicy: {
                      mode: event.target.value as
                        'hidden' | 'optional' | 'always_on' | 'always_off',
                      efforts: event.target.value === 'optional' ? ['none'] : [],
                    },
                  }))
                }
              >
                {['hidden', 'optional', 'always_on', 'always_off'].map(mode => (
                  <option key={mode} value={mode}>
                    {label(`reasoningPolicy_${mode}`)}
                  </option>
                ))}
              </IconSelect>
              {draft.reasoningPolicy?.mode === 'optional' && (
                <div className="flex flex-wrap gap-2">
                  {['minimal', 'low', 'medium', 'high', 'xhigh'].map(effort => (
                    <label key={effort} className="checkbox-option text-sm">
                      <Checkbox
                        data-testid={`provider-policy-effort-${effort}`}
                        checked={draft.reasoningPolicy?.efforts.includes(effort) ?? false}
                        disabled={busy}
                        onChange={event => {
                          const checked = event.target.checked
                          setDraft(value => ({
                            ...value,
                            reasoningPolicy: {
                              mode: 'optional',
                              efforts: checked
                                ? [...(value.reasoningPolicy?.efforts ?? ['none']), effort]
                                : (value.reasoningPolicy?.efforts ?? []).filter(
                                    item => item !== effort
                                  ),
                            },
                          }))
                        }}
                      />
                      {label(`reasoning_${effort}`)}
                    </label>
                  ))}
                </div>
              )}
              <p className="text-muted-foreground">{label('reasoningPolicyHelp')}</p>
            </fieldset>
          )}
          {settings?.supportsModelExtraBody && (
            <label className="mt-4 block text-sm">
              {label('extraBody')}
              <textarea
                data-testid="provider-extra-body"
                className="mt-2 min-h-32 w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-sm leading-6 outline-none focus:border-primary"
                value={extraBodyText}
                onChange={event => setExtraBodyText(event.target.value)}
                disabled={busy}
                spellCheck={false}
                placeholder={'{\n  "thinking": { "type": "adaptive" }\n}'}
              />
              <span className="mt-2 block text-sm text-muted-foreground">
                {label('extraBodyHelp')}
              </span>
            </label>
          )}
          <InfoBox icon={<Lock />} title={label('keySecurityTitle')} className="mt-4">
            {label('keyHelp')}
          </InfoBox>
          <InfoBox variant="hint">{label('validationHelp')}</InfoBox>
          {saving && (
            <p role="status" className="text-sm text-muted-foreground">
              {label('validating')}
            </p>
          )}
          <Button
            data-testid="provider-save"
            type="submit"
            disabled={busy || !settings || Boolean(saveRecovery)}
          >
            {label(saving ? 'validating' : 'validateSave')}
          </Button>
        </fieldset>
      </form>
    </SettingsPage>
  )
}
