import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import {
  evolutionFailureKind,
  listEvolutionPreferences,
  updateEvolutionPreference,
} from '@/kcoder/evolution/evolutionApi'
import type { EvolutionPreferenceListResult } from '@/kcoder/evolution/evolutionContract'

type Notice = 'load_failed' | 'conflict' | 'unconfirmed' | 'save_failed' | null

/** View, edit or delete personal preferences against the listed revision. */
export function EvolutionPreferencesPanel({
  serverId,
  disabled,
  isCurrent,
}: {
  serverId: string
  disabled: boolean
  isCurrent: () => boolean
}) {
  const { t, i18n } = useTranslation('evolution')
  const [snapshot, setSnapshot] = useState<EvolutionPreferenceListResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const generation = useRef(0)

  const load = useCallback(async () => {
    const ticket = ++generation.current
    setLoading(true)
    setNotice(null)
    try {
      const next = await listEvolutionPreferences(serverId)
      if (!isCurrent() || ticket !== generation.current) return
      setSnapshot(next)
    } catch {
      if (isCurrent() && ticket === generation.current) setNotice('load_failed')
    } finally {
      if (isCurrent() && ticket === generation.current) setLoading(false)
    }
  }, [isCurrent, serverId])
  useEffect(() => {
    queueMicrotask(() => void load())
    return () => {
      generation.current += 1
    }
  }, [load])

  const write = async (key: string, value: string | null) => {
    if (!snapshot || busyKey) return
    setBusyKey(key)
    setNotice(null)
    try {
      await updateEvolutionPreference(serverId, key, value, snapshot.revision)
      if (!isCurrent()) return
      setEditing(null)
      await load()
    } catch (error) {
      if (!isCurrent()) return
      const kind = evolutionFailureKind(error, true)
      setNotice(kind === 'conflict' ? 'conflict' : kind === 'unconfirmed' ? 'unconfirmed' : 'save_failed')
    } finally {
      if (isCurrent()) setBusyKey(null)
    }
  }

  const blocked = notice === 'conflict' || notice === 'unconfirmed'
  return (
    <div data-testid="evolution-preferences-panel" className="studio-card-inset flex flex-col gap-3 pt-0">
      <p className="text-sm text-text-secondary">{t('preferences.onlyYou')}</p>
      {notice && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span>{t(`preferences.notice.${notice}`)}</span>
          {(notice === 'load_failed' || blocked) && (
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              {t('actions.refresh')}
            </Button>
          )}
        </div>
      )}
      {loading && !snapshot && (
        <p role="status" className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {t('preferences.loading')}
        </p>
      )}
      {snapshot && snapshot.items.length === 0 && (
        <p className="text-sm text-text-muted">{t('preferences.empty')}</p>
      )}
      <ul className="flex flex-col divide-y divide-border/60">
        {snapshot?.items.map(item => {
          const isEditing = editing?.key === item.key
          const inputId = `evolution-preference-${item.key}`
          return (
            <li key={item.key} data-testid="evolution-preference-row" className="flex flex-col gap-2 py-2">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <label htmlFor={inputId} className="break-all text-sm font-medium text-text-primary">
                    {item.key}
                  </label>
                  {!isEditing && (
                    <p className="mt-1 break-words text-sm text-text-secondary">{item.value}</p>
                  )}
                  <p className="mt-1 text-xs text-text-muted">
                    {t('preferences.meta', {
                      count: item.evidenceCount,
                      date: new Date(item.updatedAt).toLocaleDateString(i18n.resolvedLanguage),
                    })}
                  </p>
                </div>
                {!isEditing && (
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={disabled || blocked || busyKey !== null}
                      onClick={() => setEditing({ key: item.key, value: item.value })}
                    >
                      {t('actions.edit')}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      data-testid="evolution-preference-delete"
                      disabled={disabled || blocked || (busyKey !== null && busyKey !== item.key)}
                      pending={busyKey === item.key && editing?.key !== item.key}
                      onClick={() => void write(item.key, null)}
                    >
                      {t('preferences.delete')}
                    </Button>
                  </div>
                )}
              </div>
              {isEditing && (
                <div className="flex flex-col gap-2">
                  <textarea
                    id={inputId}
                    data-testid="evolution-preference-input"
                    value={editing.value}
                    onChange={event => setEditing({ key: item.key, value: event.target.value })}
                    className="min-h-20 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm text-text-primary outline-none focus:border-primary"
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      data-testid="evolution-preference-save"
                      disabled={(busyKey !== null && busyKey !== item.key) || !editing.value.trim()}
                      pending={busyKey === item.key}
                      onClick={() => void write(item.key, editing.value.trim())}
                    >
                      {t('actions.save')}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                      {t('actions.cancel')}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
