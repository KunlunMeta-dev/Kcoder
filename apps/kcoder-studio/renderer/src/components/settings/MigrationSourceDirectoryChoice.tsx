import { useId } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { validSourceDirectory, type SourceDirectoryChoice } from '@/kcoder/migrationSourceDirectoryIntent'

/** This text is a path on the selected source device, never a browser file picker. */
export function MigrationSourceDirectoryChoice({ value, onChange, disabled }: {
  value: SourceDirectoryChoice; onChange: (value: SourceDirectoryChoice) => void; disabled: boolean
}) {
  const { t } = useTranslation('migration'), id = useId()
  return <div className="space-y-2" data-testid="migration-source-directory-choice">
    <label className="flex min-h-11 items-center gap-2 text-sm">
      <input type="checkbox" data-testid="migration-source-directory-explicit" checked={value.explicit} disabled={disabled}
        onChange={event => onChange({ ...value, explicit: event.target.checked })}/>{t('sourceDirectory.explicit')}
    </label>
    {value.explicit ? <div className="space-y-2">
      <label htmlFor={id} className="text-sm">{t('sourceDirectory.path')}</label>
      <input id={id} data-testid="migration-source-directory-path" value={value.path} disabled={disabled}
        onChange={event => onChange({ ...value, path: event.target.value })} spellCheck={false} autoComplete="off" maxLength={4096}
        className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm"/>
      <p className="text-xs leading-5 text-text-secondary">{t('sourceDirectory.boundary')}</p>
      {!!value.path && !validSourceDirectory(value.path) && <p role="alert" className="text-sm text-destructive">{t('sourceDirectory.absolute')}</p>}
    </div> : <p className="text-xs text-text-secondary">{t('sourceDirectory.automatic')}</p>}
  </div>
}
