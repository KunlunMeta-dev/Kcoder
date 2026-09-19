import {
  Hash,
  Info,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  Server,
  ShieldCheck,
  Tag,
  Terminal,
  User,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import {
  deleteSshConnection,
  listSshConnections,
  saveSshConnection,
  type SshConnectionProfile,
  type SshConnectionUpdate,
} from '@/kcoder/sshTerminal'
import { RuntimeTargetConfirmDialog } from './RuntimeTargetConfirmDialog'
import {
  IconSelect,
  InfoBox,
  InputWithIcon,
  PasswordInput,
  SectionHeader,
  SettingsPage,
  SettingsPageHeader,
} from './settings-ui'

type Draft = Omit<SshConnectionProfile, 'id' | 'port' | 'passwordSaved'> & {
  port: string
  password: string
  passwordAction: string
}
type Field = 'label' | 'host' | 'port' | 'username' | 'privateKeyPath' | 'password'
type Errors = Partial<Record<Field, string>>
const fields: Field[] = ['label', 'host', 'port', 'username', 'privateKeyPath', 'password']
const blankDraft: Draft = {
  label: '',
  host: '',
  port: '22',
  username: '',
  authMethod: 'password',
  privateKeyPath: '',
  password: '',
  passwordAction: 'keep',
}
const buttonClass = 'focus-visible:ring-blue-500 max-md:min-h-11'

const fieldIcons: Record<Field, ReactNode> = {
  label: <Tag className="h-4 w-4" />,
  host: <Server className="h-4 w-4" />,
  port: <Hash className="h-4 w-4" />,
  username: <User className="h-4 w-4" />,
  privateKeyPath: <KeyRound className="h-4 w-4" />,
  password: <Lock className="h-4 w-4" />,
}

function validText(value: string, maxBytes: number): boolean {
  return (
    value.length > 0 &&
    new TextEncoder().encode(value).length <= maxBytes &&
    Array.from(value).every(
      character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  )
}

function validHost(host: string): boolean {
  if (!validText(host, 253)) return false
  if (host.includes(':')) {
    const [address, scope, ...extra] = host.split('%')
    if (!/^[a-fA-F0-9:.]+$/.test(address)) return false
    if (extra.length || (scope !== undefined && !/^[a-zA-Z0-9_.-]+$/.test(scope))) return false
    try {
      return new URL(`http://[${address}]`).hostname.startsWith('[')
    } catch {
      return false
    }
  }
  return host.split('.').every(part => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(part))
}

function validate(draft: Draft): Errors {
  const errors: Errors = {}
  if (
    draft.authMethod === 'password' &&
    (new TextEncoder().encode(draft.password).length > 4096 || draft.password.includes('\0'))
  )
    errors.password = 'passwordInvalid'
  if (!draft.label.trim()) errors.label = 'labelRequired'
  else if (!validText(draft.label.trim(), 120)) errors.label = 'labelInvalid'
  if (!validHost(draft.host.trim())) {
    errors.host = 'hostInvalid'
  }
  if (!/^\d+$/.test(draft.port) || Number(draft.port) < 1 || Number(draft.port) > 65535) {
    errors.port = 'portInvalid'
  }
  if (
    !validText(draft.username.trim(), 128) ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9_.@\\-]*\$?$/.test(draft.username.trim())
  ) {
    errors.username = 'usernameInvalid'
  }
  if (draft.authMethod === 'key' && !draft.privateKeyPath?.trim())
    errors.privateKeyPath = 'keyRequired'
  else if (
    draft.authMethod === 'key' &&
    (!validText(draft.privateKeyPath!.trim(), 4096) ||
      !/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(draft.privateKeyPath!.trim()))
  )
    errors.privateKeyPath = 'keyInvalid'
  return errors
}

function connectionId(draft: Draft, profiles: SshConnectionProfile[]): string {
  const slugify = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48)
  const slug = slugify(draft.label.trim()) || slugify(draft.host) || 'ssh'
  let id = slug
  let suffix = 2
  while (profiles.some(profile => profile.id === id)) id = `${slug}-${suffix++}`
  return id
}

export function SshConnectionsSettingsPage() {
  const { t } = useTranslation('localRuntime')
  const [profiles, setProfiles] = useState<SshConnectionProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [editor, setEditor] = useState<{ id?: string; initial: Draft; draft: Draft } | null>(null)
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<SshConnectionProfile | null>(null)
  const [discardPending, setDiscardPending] = useState(false)
  const busyRef = useRef(false)
  const loadRevision = useRef(0)
  const opener = useRef<HTMLElement | null>(null)
  const deleteOpener = useRef<HTMLElement | null>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  const load = useCallback(async () => {
    const revision = ++loadRevision.current
    setLoading(true)
    setLoadFailed(false)
    try {
      const loaded = await listSshConnections()
      if (revision === loadRevision.current) setProfiles(loaded)
    } catch {
      if (revision === loadRevision.current) setLoadFailed(true)
    } finally {
      if (revision === loadRevision.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const invalidate = () => {
      loadRevision.current++
    }
    const timer = window.setTimeout(() => void load(), 0)
    return () => {
      window.clearTimeout(timer)
      invalidate()
    }
  }, [load])

  const restoreFocus = (target: HTMLElement | null) => {
    window.setTimeout(() => (target?.isConnected ? target : addRef.current)?.focus(), 0)
  }

  const openEditor = (trigger: HTMLElement, profile?: SshConnectionProfile) => {
    const draft: Draft = profile
      ? {
          label: profile.label,
          host: profile.host,
          port: String(profile.port),
          username: profile.username,
          authMethod: profile.authMethod,
          privateKeyPath: profile.privateKeyPath ?? '',
          password: '',
          passwordAction: 'keep',
        }
      : { ...blankDraft }
    opener.current = trigger
    setEditor({ id: profile?.id, initial: draft, draft })
    setErrors({})
    setActionError(null)
    setSuccess(null)
    window.setTimeout(() => formRef.current?.querySelector('input')?.focus(), 0)
  }

  const closeEditor = () => {
    setEditor(null)
    setDiscardPending(false)
    setActionError(null)
    restoreFocus(opener.current)
  }

  const update = (field: keyof Draft, value: string) => {
    setEditor(current =>
      current ? { ...current, draft: { ...current.draft, [field]: value } } : current
    )
    setErrors(current => ({ ...current, [field]: undefined }))
    setActionError(null)
  }

  const save = async () => {
    if (!editor || busyRef.current) return
    const validation = validate(editor.draft)
    setErrors(validation)
    const invalid = fields.find(field => validation[field])
    if (invalid) {
      formRef.current?.querySelector<HTMLElement>(`[name="${invalid}"]`)?.focus()
      return
    }
    busyRef.current = true
    setBusy(true)
    setActionError(null)
    const { draft } = editor
    const profile: SshConnectionUpdate = {
      id: editor.id ?? connectionId(draft, profiles),
      label: draft.label.trim(),
      host: draft.host.trim(),
      port: Number(draft.port),
      username: draft.username.trim(),
      authMethod: draft.authMethod,
      ...(draft.authMethod === 'key' ? { privateKeyPath: draft.privateKeyPath!.trim() } : {}),
      ...(draft.authMethod === 'password' && draft.password
        ? { password: draft.password }
        : draft.passwordAction === 'clear'
          ? { password: null }
          : {}),
    }
    try {
      const saved = await saveSshConnection(profile)
      setProfiles(current =>
        current.some(item => item.id === saved.id)
          ? current.map(item => (item.id === saved.id ? saved : item))
          : [...current, saved]
      )
      window.dispatchEvent(new Event('kcoder:ssh-connections-changed'))
      closeEditor()
      setSuccess(t('sshConnections.saved'))
    } catch {
      setActionError(t('sshConnections.saveFailed'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!deleteCandidate || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setActionError(null)
    try {
      await deleteSshConnection(deleteCandidate.id)
      setProfiles(current => current.filter(item => item.id !== deleteCandidate.id))
      window.dispatchEvent(new Event('kcoder:ssh-connections-changed'))
      setSuccess(t('sshConnections.deleted'))
    } catch {
      setActionError(t('sshConnections.deleteFailed'))
    } finally {
      setDeleteCandidate(null)
      busyRef.current = false
      setBusy(false)
      restoreFocus(deleteOpener.current)
    }
  }

  return (
    <SettingsPage data-testid="ssh-connections-settings-page">
      <SettingsPageHeader
        title={t('sshConnections.title')}
        description={t('sshConnections.description')}
        actions={
          <Button
            ref={addRef}
            variant="primary"
            size="sm"
            className={buttonClass}
            data-testid="ssh-connection-add"
            disabled={loading || loadFailed || !!editor || busy}
            onClick={event => openEditor(event.currentTarget)}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('sshConnections.add')}
          </Button>
        }
      />
      {loading && (
        <p role="status" className="mb-4 text-sm text-text-secondary">
          {t('sshConnections.loading')}
        </p>
      )}
      {loadFailed && (
        <div role="alert" className="mb-4 space-y-2">
          <p className="text-sm text-red-500">{t('sshConnections.loadFailed')}</p>
          <Button
            variant="secondary"
            size="sm"
            className={buttonClass}
            data-testid="ssh-connections-retry"
            onClick={() => void load()}
          >
            {t('retry')}
          </Button>
        </div>
      )}
      {success && (
        <p role="status" className="mb-4 text-sm text-text-secondary">
          {success}
        </p>
      )}
      {actionError && (
        <p role="alert" className="mb-4 text-sm text-red-500">
          {actionError}
        </p>
      )}
      {editor && (
        <form
          ref={formRef}
          noValidate
          data-testid="ssh-connection-form"
          className="mb-6 space-y-5 rounded-2xl border border-border/60 bg-surface/30 p-5"
          onSubmit={event => {
            event.preventDefault()
            void save()
          }}
        >
          <SectionHeader
            icon={<Terminal />}
            title={t(editor.id ? 'sshConnections.editTitle' : 'sshConnections.add')}
            description={t('sshConnections.formSubtitle')}
          />
          <fieldset disabled={busy} className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
            {fields
              .filter(
                field =>
                  (field !== 'privateKeyPath' || editor.draft.authMethod === 'key') &&
                  (field !== 'password' || editor.draft.authMethod === 'password')
              )
              .map(field => (
                <div key={field} className={field === 'privateKeyPath' ? 'md:col-span-2' : ''}>
                  <label
                    htmlFor={`ssh-connection-${field}`}
                    className="text-base text-text-primary"
                  >
                    {t(`sshConnections.fields.${field}`)}
                  </label>
                  {field === 'password' ? (
                    <PasswordInput
                      id={`ssh-connection-${field}`}
                      name={field}
                      icon={fieldIcons.password}
                      data-testid={`ssh-connection-${field}`}
                      toggleTestId="ssh-connection-password-toggle"
                      toggleLabel={t('sshConnections.passwordToggle')}
                      hideLabel={t('sshConnections.passwordToggleHide')}
                      value={editor.draft[field] ?? ''}
                      autoComplete="new-password"
                      spellCheck={false}
                      aria-invalid={errors[field] ? true : undefined}
                      aria-describedby={errors[field] ? `ssh-connection-${field}-error` : undefined}
                      onChange={event => update(field, event.target.value)}
                      onBlur={() =>
                        setErrors(current => ({
                          ...current,
                          [field]: validate(editor.draft)[field],
                        }))
                      }
                    />
                  ) : (
                    <InputWithIcon
                      id={`ssh-connection-${field}`}
                      name={field}
                      icon={fieldIcons[field]}
                      data-testid={`ssh-connection-${field}`}
                      value={editor.draft[field] ?? ''}
                      inputMode={field === 'port' ? 'numeric' : undefined}
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={errors[field] ? true : undefined}
                      aria-describedby={
                        [
                          errors[field] ? `ssh-connection-${field}-error` : '',
                          field === 'privateKeyPath' ? 'ssh-connection-key-help' : '',
                        ]
                          .filter(Boolean)
                          .join(' ') || undefined
                      }
                      onChange={event => update(field, event.target.value)}
                      onBlur={() =>
                        setErrors(current => ({
                          ...current,
                          [field]: validate(editor.draft)[field],
                        }))
                      }
                    />
                  )}
                  {field === 'privateKeyPath' && (
                    <p id="ssh-connection-key-help" className="mt-1 text-sm text-text-secondary">
                      {t('sshConnections.keyHelp')}
                    </p>
                  )}
                  {errors[field] && (
                    <p id={`ssh-connection-${field}-error`} className="mt-1 text-sm text-red-500">
                      {t(`sshConnections.validation.${errors[field]}`)}
                    </p>
                  )}
                </div>
              ))}
            <div className="md:col-span-2">
              {editor.draft.authMethod === 'password' &&
                profiles.find(profile => profile.id === editor.id)?.passwordSaved && (
                  <div className="mb-3 flex items-center gap-2 text-sm text-text-secondary">
                    <span data-testid="ssh-connection-password-status">
                      {t(
                        editor.draft.passwordAction === 'clear'
                          ? 'sshConnections.passwordWillClear'
                          : 'sshConnections.passwordSaved'
                      )}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="ssh-connection-clear-password"
                      onClick={() => {
                        update('password', '')
                        update('passwordAction', 'clear')
                      }}
                    >
                      {t('sshConnections.clearPassword')}
                    </Button>
                  </div>
                )}
              <label htmlFor="ssh-connection-auth" className="text-base text-text-primary">
                {t('sshConnections.fields.authMethod')}
              </label>
              <IconSelect
                id="ssh-connection-auth"
                icon={<ShieldCheck />}
                data-testid="ssh-connection-auth"
                value={editor.draft.authMethod}
                onChange={event => update('authMethod', event.target.value)}
                aria-describedby="ssh-connection-auth-help"
              >
                {(['password', 'key', 'agent'] as const).map(method => (
                  <option key={method} value={method}>
                    {t(`sshConnections.auth.${method}`)}
                  </option>
                ))}
              </IconSelect>
              <InfoBox icon={<Info />} id="ssh-connection-auth-help" className="mt-2">
                {t(
                  editor.draft.authMethod === 'agent'
                    ? 'sshConnections.agentHelp'
                    : 'sshConnections.credentialsHelp'
                )}
              </InfoBox>
            </div>
          </fieldset>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={buttonClass}
              data-testid="ssh-connection-cancel"
              disabled={busy}
              onClick={() =>
                JSON.stringify(editor.draft) === JSON.stringify(editor.initial)
                  ? closeEditor()
                  : setDiscardPending(true)
              }
            >
              {t('sshConnections.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              className={buttonClass}
              data-testid="ssh-connection-save"
              disabled={busy}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {t('sshConnections.save')}
            </Button>
          </div>
        </form>
      )}
      {!loading && !loadFailed && profiles.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <Terminal className="h-6 w-6 text-text-muted" aria-hidden="true" />
          <p className="text-sm text-text-secondary">{t('sshConnections.empty')}</p>
        </div>
      )}
      <div className="divide-y divide-border">
        {profiles.map(profile => (
          <div
            key={profile.id}
            data-testid={`ssh-connection-row-${profile.id}`}
            className="flex flex-wrap items-center gap-3 py-4"
          >
            <Terminal className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="break-words text-base font-medium">{profile.label}</div>
              <p className="break-all text-sm text-text-secondary">
                {profile.username}@{profile.host.includes(':') ? `[${profile.host}]` : profile.host}
                :{profile.port} · {t(`sshConnections.auth.${profile.authMethod}`)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                size="sm"
                className={buttonClass}
                data-testid={`ssh-connection-edit-${profile.id}`}
                disabled={!!editor || busy}
                aria-label={t('sshConnections.editLabel', { name: profile.label })}
                onClick={event => openEditor(event.currentTarget, profile)}
              >
                {t('sshConnections.edit')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={`${buttonClass} text-red-500`}
                data-testid={`ssh-connection-delete-${profile.id}`}
                disabled={!!editor || busy}
                aria-label={t('sshConnections.deleteLabel', { name: profile.label })}
                onClick={event => {
                  deleteOpener.current = event.currentTarget
                  setDeleteCandidate(profile)
                  setActionError(null)
                  setSuccess(null)
                }}
              >
                {t('sshConnections.delete')}
              </Button>
            </div>
          </div>
        ))}
      </div>
      {deleteCandidate && (
        <RuntimeTargetConfirmDialog
          testId="ssh-connection-delete-dialog"
          destructive
          pending={busy}
          title={t('sshConnections.deleteTitle')}
          description={t('sshConnections.deleteDescription', { name: deleteCandidate.label })}
          cancelLabel={t('sshConnections.cancel')}
          closeLabel={t('sshConnections.closeDialog')}
          confirmLabel={t('sshConnections.delete')}
          onCancel={() => {
            setDeleteCandidate(null)
            restoreFocus(deleteOpener.current)
          }}
          onConfirm={() => void remove()}
        />
      )}
      {discardPending && (
        <RuntimeTargetConfirmDialog
          testId="ssh-connection-discard-dialog"
          title={t('sshConnections.discardTitle')}
          description={t('sshConnections.discardDescription')}
          cancelLabel={t('sshConnections.keepEditing')}
          closeLabel={t('sshConnections.closeDialog')}
          confirmLabel={t('sshConnections.discard')}
          onCancel={() => {
            setDiscardPending(false)
            restoreFocus(
              formRef.current?.querySelector('[data-testid="ssh-connection-cancel"]') ?? null
            )
          }}
          onConfirm={closeEditor}
        />
      )}
    </SettingsPage>
  )
}
