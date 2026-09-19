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
import { providerSaveErrorKey } from '@/kcoder/providerValidationErrors'
import { isPlaintextRemoteEndpoint } from '@/lib/endpoint-security'

import { ConfigTemplatesSection } from './ConfigTemplatesSection'
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

const emptyDraft = (): ProviderDraft => ({
  id: '',
  apiFormat: 'openai_chat_completions',
  endpoint: '',
  model: '',
  contextWindowTokens: 128000,
  maxOutputTokens: 8192,
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

export function KCoderProviderSettingsPage() {
  const { t } = useTranslation('common')
  const workbench = useContext(WorkbenchContext)
  const initialTarget = useRef(
    workbench ? workbenchModelTarget(workbench.state).deviceId : undefined
  )
  const [servers, setServers] = useState<GatewayServer[]>([])
  const [serverId, setServerId] = useState('')
  const [settings, setSettings] = useState<ProviderSettings | null>(null)
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
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const generation = useRef(0)
  const [deleting, setDeleting] = useState<ProviderProfile | null>(null)
  const [deleteKind, setDeleteKind] = useState<'provider' | 'model'>('provider')
  const [replacement, setReplacement] = useState('')
  const [removeCredentials, setRemoveCredentials] = useState(false)
  const deleteTrigger = useRef<HTMLButtonElement | null>(null)
  const label = (name: string) => t(`providerSettings.${name}`)
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
    setDraftMode(addModel ? 'new-model' : 'edit')
    setError(null)
    setDraft({
      id: profile.id,
      apiFormat: profile.apiFormat,
      endpoint: profile.endpoint,
      model: addModel ? '' : profile.model,
      contextWindowTokens: addModel ? 128000 : profile.contextWindowTokens,
      maxOutputTokens: addModel ? 8192 : profile.maxOutputTokens,
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

  const refresh = useCallback(async () => {
    if (!serverId) return
    const current = ++generation.current
    setBusy(true)
    setError(null)
    try {
      const next = await readProviderSettings(serverId)
      if (current === generation.current) setSettings(next)
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
  }, [serverId, templateRefresh])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => {
      window.clearTimeout(timer)
      generation.current += 1
    }
  }, [refresh])

  const save = async () => {
    if (busy || !serverId || !settings) return
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
    if (isPlaintextRemoteEndpoint(draft.endpoint)) {
      // Plain HTTP outside loopback sends prompts and completions over the network
      // in the clear; make the trade-off explicit before persisting it.
      const proceed = window.confirm(
        t('providerSettings.plaintextEndpointConfirm', { endpoint: draft.endpoint.trim() })
      )
      if (!proceed) {
        setNotice(t('providerSettings.plaintextEndpointDeclined'))
        return
      }
    }
    if (!draft.model.trim()) {
      setError(t('providerSettings.modelRequired'))
      document.querySelector<HTMLInputElement>('[data-testid="provider-model"]')?.focus()
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
              capabilities: draft.capabilities ?? conservativeCapabilities,
            }
          : draft
      )
      if (current !== generation.current) return
      setSettings(next)
      setDraftMode('edit')
      setDraft(value => ({
        ...value,
        apiKey: '',
        ...(next.supportsMultipleModels ? { originalModel: value.model.trim() } : {}),
      }))
      setNotice(label(next.supportsNewSessionReload ? 'savedForNewSessions' : 'saved'))
      if (next.supportsNewSessionReload)
        window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
    } catch (failure) {
      // Never echo a failed request that may contain an API key.
      if (current === generation.current) setError(t(providerSaveErrorKey(failure)))
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
      setDraft(value => (value.id === deleting.id ? emptyDraft() : value))
      if (draft.id === deleting.id) setDraftMode('new-api')
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
          : `${label(next.supportsNewSessionReload ? 'deletedForNewSessions' : deleteKind === 'model' ? 'modelDeleted' : 'deleted')} ${defaultNotice}`
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
      <ConfigTemplatesSection key={serverId} serverId={serverId} />
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
            setDraft(emptyDraft())
            setDraftMode('new-api')
            setNotice(null)
            setDeleting(null)
            setServerId(event.target.value)
          }}
        >
          {servers.map(server => (
            <option key={server.id} value={server.id}>
              {server.label ?? server.id}
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
          disabled={busy}
          onClick={() => {
            setDraft(emptyDraft())
            setDraftMode('new-api')
            setError(null)
          }}
        >
          {label('add')}
        </Button>
      </div>
      {settings?.supportsNewSessionReload && (
        <p data-testid="provider-session-reload" className="text-sm text-muted-foreground">
          {label('newSessionReloadHelp')}
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
      {deleting && (
        <RuntimeTargetConfirmDialog
          testId="provider-delete-dialog"
          title={`${label(deleteKind === 'model' ? 'deleteModel' : 'delete')} ${deleting.id}${deleteKind === 'model' ? ` · ${deleting.model}` : ''}`}
          description={label(
            settings?.supportsNewSessionReload
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
                    {template.displayName}
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
                  onChange={event => setDraft(value => ({ ...value, [field]: event.target.value }))}
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
                  onChange={event => setDraft(value => ({ ...value, [field]: event.target.value }))}
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
        <InfoBox icon={<Lock />} title={label('keySecurityTitle')} className="mt-4">
          {label('keyHelp')}
        </InfoBox>
        <InfoBox variant="hint">{label('validationHelp')}</InfoBox>
        {saving && (
          <p role="status" className="text-sm text-muted-foreground">
            {label('validating')}
          </p>
        )}
        <Button data-testid="provider-save" type="submit" disabled={busy || !settings}>
          {label(saving ? 'validating' : 'validateSave')}
        </Button>
      </form>
    </SettingsPage>
  )
}
