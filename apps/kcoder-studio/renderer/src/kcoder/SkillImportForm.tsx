import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

export function SkillImportForm({
  disabled,
  install,
}: {
  disabled: boolean
  install: (path: string) => Promise<void>
}) {
  const { t } = useTranslation('common')
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  return (
    <form
      data-testid="kcoder-skill-import"
      className="flex flex-col gap-3 border-b border-border pb-4"
      onSubmit={event => {
        event.preventDefault()
        setError('')
        void install(path.trim())
          .then(() => setPath(''))
          .catch(value => setError(value instanceof Error ? value.message : String(value)))
      }}
    >
      <label className="text-sm">
        {t('workbench.skill_import_path')}
        <input
          className="mt-2 min-h-11 w-full rounded-lg border border-border bg-background px-3 md:min-h-8"
          required
          value={path}
          disabled={disabled}
          onChange={event => setPath(event.target.value)}
        />
      </label>
      <button
        type="submit"
        disabled={disabled}
        className="min-h-11 self-start rounded-lg bg-text-primary px-3 text-sm text-background disabled:opacity-50 md:min-h-8"
      >
        {t('workbench.skill_import')}
      </button>
      {error && (
        <p role="alert" className="text-sm text-text-secondary">
          {error}
        </p>
      )}
    </form>
  )
}
