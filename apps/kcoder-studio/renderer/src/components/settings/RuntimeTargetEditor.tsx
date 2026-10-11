import { Checkbox } from '@/components/ui/checkbox'
import {
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  Folder,
  Globe,
  Hash,
  Loader2,
  Server,
  ShieldAlert,
  Tag,
  Terminal,
  User,
  X,
  Zap,
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { TFunction } from 'i18next'
import { Button } from '@/components/ui/button'
import { IconSelect, InputWithIcon } from './settings-ui'
import type {
  RuntimeTargetDraft,
  RuntimeTargetEditorSession,
  RuntimeTargetErrors,
  RuntimeTargetField,
  RuntimeTargetValidationCode,
} from './runtime-target-model'

interface RuntimeTargetEditorProps {
  session: RuntimeTargetEditorSession
  errors: RuntimeTargetErrors
  busy: 'test' | 'save' | null
  result: { kind: 'success' | 'error'; message: string; detail?: string } | null
  t: TFunction<'localRuntime'>
  onUpdate: <K extends RuntimeTargetField>(field: K, value: RuntimeTargetDraft[K]) => void
  onBlur: (field: RuntimeTargetField) => void
  onToggleAdvanced: () => void
  onClose: (trigger: HTMLElement) => void
  onTest: () => void
  onSubmit: () => void
  onRequestNoSandbox: (trigger: HTMLElement) => void
}

function FieldError({
  field,
  code,
  t,
}: {
  field: RuntimeTargetField
  code?: RuntimeTargetValidationCode
  t: TFunction<'localRuntime'>
}) {
  if (!code) return null
  return (
    <p id={`runtime-target-${field}-error`} className="mt-1 text-xs text-red-500">
      {t(`targets.validation.${code}`)}
    </p>
  )
}

export function RuntimeTargetEditor({
  session,
  errors,
  busy,
  result,
  t,
  onUpdate,
  onBlur,
  onToggleAdvanced,
  onClose,
  onTest,
  onSubmit,
  onRequestNoSandbox,
}: RuntimeTargetEditorProps) {
  const labelRef = useRef<HTMLInputElement>(null)
  const draft = session.draft

  useEffect(() => {
    labelRef.current?.focus()
  }, [session.mode, session.originalId])

  const errorProps = (field: RuntimeTargetField) => ({
    'aria-invalid': errors[field] ? true : undefined,
    'aria-describedby': errors[field] ? `runtime-target-${field}-error` : undefined,
  })

  return (
    <section
      data-testid="runtime-target-editor"
      className="mb-6 rounded-2xl border border-border/60 bg-surface/30 p-5 max-md:p-4"
    >
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-medium text-text-primary">
            {session.mode === 'edit' ? t('targets.editTitle') : t('targets.addTitle')}
          </h2>
          <p className="mt-1 text-xs text-text-secondary">
            {session.mode === 'edit'
              ? t('targets.editDescription', { id: session.originalId })
              : t('targets.addDescription')}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="runtime-target-close"
          aria-label={t('targets.closeEditor')}
          title={t('targets.closeEditor')}
          disabled={busy === 'save'}
          onClick={event => onClose(event.currentTarget)}
          className="h-8 w-8 focus-visible:ring-focus max-md:h-11 max-md:w-11"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <form
        data-testid="runtime-target-form"
        noValidate
        onSubmit={event => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 max-md:grid-cols-1">
          <label className="block text-xs font-medium text-text-secondary">
            {t('targets.fields.name')}
            <InputWithIcon
              ref={labelRef}
              icon={<Tag className="h-4 w-4" />}
              textSize="sm"
              data-testid="runtime-target-label"
              value={draft.label}
              onChange={event => onUpdate('label', event.target.value)}
              onBlur={() => onBlur('label')}
              autoComplete="off"
              {...errorProps('label')}
            />
            <FieldError field="label" code={errors.label} t={t} />
          </label>
          <label className="block text-xs font-medium text-text-secondary">
            {t('targets.fields.id')}
            <InputWithIcon
              icon={<Hash className="h-4 w-4" />}
              textSize="sm"
              data-testid="runtime-target-id"
              value={draft.id}
              disabled={session.mode === 'edit'}
              maxLength={64}
              onChange={event => onUpdate('id', event.target.value)}
              onBlur={() => onBlur('id')}
              placeholder={t('targets.placeholders.id')}
              autoComplete="off"
              className="disabled:cursor-not-allowed disabled:opacity-60"
              {...errorProps('id')}
            />
            <FieldError field="id" code={errors.id} t={t} />
          </label>
          <label className="block text-xs font-medium text-text-secondary">
            {t('targets.fields.transport')}
            <IconSelect
              icon={<Zap className="h-4 w-4" />}
              textSize="sm"
              data-testid="runtime-target-transport"
              aria-label={t('targets.fields.transport')}
              value={draft.transport}
              onChange={event =>
                onUpdate('transport', event.target.value as RuntimeTargetDraft['transport'])
              }
            >
              <option value="local">{t('targets.transport.local')}</option>
              <option value="ssh">{t('targets.transport.ssh')}</option>
            </IconSelect>
          </label>
          {draft.transport === 'ssh' && (
            <label className="block text-xs font-medium text-text-secondary">
              {t('targets.fields.host')}
              <InputWithIcon
                icon={<Server className="h-4 w-4" />}
                textSize="sm"
                data-testid="runtime-target-host"
                value={draft.host}
                onChange={event => onUpdate('host', event.target.value)}
                onBlur={() => onBlur('host')}
                placeholder={t('targets.placeholders.host')}
                autoComplete="off"
                {...errorProps('host')}
              />
              <FieldError field="host" code={errors.host} t={t} />
            </label>
          )}
          <label className="block text-xs font-medium text-text-secondary">
            {draft.transport === 'local'
              ? t('targets.fields.localWorkspace')
              : t('targets.fields.remoteWorkspace')}
            <InputWithIcon
              icon={<Folder className="h-4 w-4" />}
              textSize="sm"
              data-testid="runtime-target-workspace"
              value={draft.workspacePath}
              onChange={event => onUpdate('workspacePath', event.target.value)}
              onBlur={() => onBlur('workspacePath')}
              placeholder={t('targets.placeholders.workspace')}
              autoComplete="off"
              {...errorProps('workspacePath')}
            />
            <FieldError field="workspacePath" code={errors.workspacePath} t={t} />
          </label>
          {draft.transport === 'ssh' && (
            <div className="block text-xs font-medium text-text-secondary">
              <label className="flex items-center gap-2">
                <Checkbox
                  data-testid="runtime-target-account-mode"
                  checked={draft.accountMode}
                  onChange={event => onUpdate('accountMode', event.target.checked)}
                  onBlur={() => onBlur('accountMode')}
                  className="h-4 w-4"
                />
                {t('accounts.connectionMode')}
              </label>
              <span className="mt-1 block text-xs text-text-muted">
                {t('accounts.connectionHelp')}
              </span>
            </div>
          )}
        </div>

        <div className="mt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="runtime-target-advanced-toggle"
            aria-expanded={session.advancedOpen}
            onClick={onToggleAdvanced}
            className="px-2 text-text-secondary focus-visible:ring-focus max-md:h-11"
          >
            {session.advancedOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            {t('targets.advanced')}
          </Button>
          <p className="mt-1 px-2 text-xs text-text-muted">{t('targets.advancedSubtitle')}</p>
        </div>

        {session.advancedOpen && (
          <div data-testid="runtime-target-advanced" className="mt-3 border-t border-border pt-4">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 max-md:grid-cols-1">
              {draft.transport === 'ssh' && (
                <>
                  <label className="block text-xs font-medium text-text-secondary">
                    {t('targets.fields.sshUser')}
                    <InputWithIcon
                      icon={<User className="h-4 w-4" />}
                      textSize="sm"
                      data-testid="runtime-target-user"
                      value={draft.user}
                      onChange={event => onUpdate('user', event.target.value)}
                      autoComplete="username"
                    />
                  </label>
                  <label className="block text-xs font-medium text-text-secondary">
                    {t('targets.fields.sshPort')}
                    <InputWithIcon
                      icon={<Hash className="h-4 w-4" />}
                      textSize="sm"
                      data-testid="runtime-target-port"
                      inputMode="numeric"
                      value={draft.port}
                      onChange={event => onUpdate('port', event.target.value)}
                      onBlur={() => onBlur('port')}
                      placeholder="22"
                      autoComplete="off"
                      {...errorProps('port')}
                    />
                    <FieldError field="port" code={errors.port} t={t} />
                  </label>
                </>
              )}
              <label className="block text-xs font-medium text-text-secondary">
                {t('targets.fields.command')}
                <InputWithIcon
                  icon={<Terminal className="h-4 w-4" />}
                  textSize="sm"
                  data-testid="runtime-target-command"
                  disabled={draft.accountMode}
                  value={draft.command}
                  onChange={event => onUpdate('command', event.target.value)}
                  onBlur={() => onBlur('command')}
                  placeholder="kcoder"
                  autoComplete="off"
                  className="disabled:cursor-not-allowed disabled:opacity-60"
                  {...errorProps('command')}
                />
                <FieldError field="command" code={errors.command} t={t} />
              </label>
              <label className="block text-xs font-medium text-text-secondary">
                {t('targets.fields.profile')}
                <InputWithIcon
                  icon={<FileText className="h-4 w-4" />}
                  textSize="sm"
                  data-testid="runtime-target-profile"
                  disabled={draft.accountMode}
                  value={draft.profile}
                  onChange={event => onUpdate('profile', event.target.value)}
                  autoComplete="off"
                  className="disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>
              <label className="block text-xs font-medium text-text-secondary">
                {t('targets.fields.settingsFile')}
                <InputWithIcon
                  icon={<File className="h-4 w-4" />}
                  textSize="sm"
                  data-testid="runtime-target-settings-file"
                  disabled={draft.accountMode}
                  value={draft.settingsFile}
                  onChange={event => onUpdate('settingsFile', event.target.value)}
                  onBlur={() => onBlur('settingsFile')}
                  placeholder={t('targets.placeholders.settingsFile')}
                  autoComplete="off"
                  className="disabled:cursor-not-allowed disabled:opacity-60"
                  {...errorProps('settingsFile')}
                />
                <FieldError field="settingsFile" code={errors.settingsFile} t={t} />
              </label>
              <label className="block text-xs font-medium text-text-secondary">
                {t('targets.fields.chromium')}
                <InputWithIcon
                  icon={<Globe className="h-4 w-4" />}
                  textSize="sm"
                  data-testid="runtime-target-chromium"
                  disabled={draft.accountMode}
                  value={draft.chromiumBin}
                  onChange={event => onUpdate('chromiumBin', event.target.value)}
                  placeholder={t('targets.placeholders.chromium')}
                  autoComplete="off"
                  className="disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>
            </div>
            {draft.transport === 'ssh' && (
              <label className="mt-4 flex min-h-9 items-start gap-2 text-sm text-text-secondary max-md:min-h-11">
                <Checkbox
                  data-testid="runtime-target-accept-host-key"
                  checked={draft.acceptNewHostKey}
                  onChange={event => onUpdate('acceptNewHostKey', event.target.checked)}
                  className="mt-1 h-4 w-4 focus-visible:ring-2 focus-visible:ring-focus"
                />
                <span>
                  {t('targets.acceptHostKey')}
                  <span className="mt-0.5 block text-xs text-text-muted">
                    {t('targets.acceptHostKeyHelp')}
                  </span>
                </span>
              </label>
            )}
            <label className="mt-4 flex min-h-9 items-start gap-2 text-sm text-text-secondary max-md:min-h-11">
              <Checkbox
                data-testid="runtime-target-no-sandbox"
                disabled={draft.accountMode}
                checked={draft.chromiumNoSandbox}
                onChange={event => {
                  if (event.target.checked) onRequestNoSandbox(event.currentTarget)
                  else onUpdate('chromiumNoSandbox', false)
                }}
                className="mt-1 h-4 w-4 focus-visible:ring-2 focus-visible:ring-focus"
              />
              <span>{t('targets.noSandbox')}</span>
            </label>
          </div>
        )}

        {draft.chromiumNoSandbox && (
          <div
            role="alert"
            data-testid="runtime-target-no-sandbox-warning"
            className="mt-4 flex gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400"
          >
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t('targets.noSandboxEnabledWarning')}</span>
          </div>
        )}

        {result && (
          <div
            role={result.kind === 'error' ? 'alert' : 'status'}
            className={`mt-4 rounded-lg px-3 py-2 text-sm ${
              result.kind === 'error'
                ? 'bg-red-500/10 text-red-500'
                : 'bg-green-500/10 text-green-600 dark:text-green-400'
            }`}
          >
            <p>{result.message}</p>
            {result.detail && (
              <p className="mt-1 break-words text-xs opacity-80">{result.detail}</p>
            )}
          </div>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="runtime-target-test"
            disabled={busy !== null}
            onClick={onTest}
            className="focus-visible:ring-focus max-md:h-11"
          >
            {busy === 'test' && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
            {t('targets.testConnection')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            data-testid="runtime-target-save"
            disabled={busy !== null}
            className="min-w-28 focus-visible:ring-focus max-md:h-11"
          >
            {busy === 'save' && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
            {t('targets.save')}
          </Button>
        </div>
      </form>
    </section>
  )
}
