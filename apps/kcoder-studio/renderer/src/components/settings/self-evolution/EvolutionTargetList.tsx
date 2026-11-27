import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { SettingsSwitch, StatusChip } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { listEvolutionTargets } from '@/kcoder/evolution/evolutionApi'
import type {
  EvolutionSettings,
  EvolutionTargetSummary,
  EvolutionTargetType,
} from '@/kcoder/evolution/evolutionContract'
import {
  formatScore,
  itemEnabled,
  targetSetting,
  withItem,
  withTarget,
} from '@/kcoder/evolution/evolutionSettingsModel'

/** Paginated objects of one learning type with the scope choice and per-item switches. */
export function EvolutionTargetList({
  serverId,
  type,
  settings,
  disabled,
  isCurrent,
  onSave,
}: {
  serverId: string
  type: EvolutionTargetType
  settings: EvolutionSettings
  disabled: boolean
  isCurrent: () => boolean
  onSave: (next: EvolutionSettings) => void
}) {
  const { t, i18n } = useTranslation('evolution')
  const id = useId()
  const [items, setItems] = useState<EvolutionTargetSummary[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [source, setSource] = useState('all')
  const generation = useRef(0)
  const scope = targetSetting(settings, type).scope ?? 'all'

  const load = useCallback(
    async (after?: string) => {
      const ticket = ++generation.current
      setLoading(true)
      setFailed(false)
      try {
        const page = await listEvolutionTargets(serverId, type, after ? { cursor: after } : {})
        if (!isCurrent() || ticket !== generation.current) return
        setItems(current => (after ? [...current, ...page.items] : page.items))
        setCursor(page.nextCursor ?? undefined)
      } catch {
        if (isCurrent() && ticket === generation.current) setFailed(true)
      } finally {
        if (isCurrent() && ticket === generation.current) setLoading(false)
      }
    },
    [isCurrent, serverId, type]
  )
  useEffect(() => {
    queueMicrotask(() => void load())
    return () => {
      generation.current += 1
    }
  }, [load])

  const sources = useMemo(() => Array.from(new Set(items.map(item => item.source))).sort(), [items])
  const visible = source === 'all' ? items : items.filter(item => item.source === source)

  return (
    <div data-testid={`evolution-target-list-${type}`} className="studio-card-inset flex flex-col gap-3 pt-0">
      <fieldset className="flex flex-wrap items-center gap-4" disabled={disabled}>
        <legend className="sr-only">{t('targets.scopeLabel')}</legend>
        {(['all', 'selected'] as const).map(value => (
          <label key={value} className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
            <input
              type="radio"
              name={`${id}-scope`}
              value={value}
              data-testid={`evolution-scope-${type}-${value}`}
              checked={scope === value}
              onChange={() => onSave(withTarget(settings, type, { scope: value }))}
            />
            {t(`targets.scope.${value}`)}
          </label>
        ))}
        {sources.length > 1 && (
          <label className="ml-auto flex items-center gap-2 text-sm text-text-secondary">
            {t('targets.sourceFilter')}
            <SettingsSelect
              density="compact"
              data-testid={`evolution-source-filter-${type}`}
              value={source}
              onChange={event => setSource(event.target.value)}
            >
              <option value="all">{t('targets.allSources')}</option>
              {sources.map(value => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </SettingsSelect>
          </label>
        )}
      </fieldset>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t('targets.loadFailed')}{' '}
          <Button type="button" variant="link" size="sm" onClick={() => void load()}>
            {t('actions.retry')}
          </Button>
        </p>
      )}
      {!loading && !failed && items.length === 0 && (
        <p className="text-sm text-text-muted">{t('targets.empty')}</p>
      )}
      <ul className="flex flex-col divide-y divide-border/60">
        {visible.map(item => {
          const checked = itemEnabled(settings, type, item.targetKey)
          return (
            <li
              key={item.targetKey}
              data-testid="evolution-target-row"
              data-target-key={item.targetKey}
              className="flex flex-wrap items-center gap-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all text-sm font-medium text-text-primary">{item.name}</span>
                  <StatusChip>{item.source}</StatusChip>
                  <StatusChip>{t(`targets.evolutionMode.${item.evolutionMode}`)}</StatusChip>
                  <StatusChip>
                    {item.candidate
                      ? t('targets.channelCandidate', {
                          traffic: Math.round((item.channelTraffic ?? 0) * 100),
                        })
                      : t('targets.channelStable')}
                  </StatusChip>
                </div>
                <p className="mt-1 text-xs tabular-nums text-text-secondary">
                  {t('targets.scoreLine', {
                    score: formatScore(item.stable, i18n.resolvedLanguage),
                    count: item.stable.observations,
                  })}
                  {item.pendingProposals > 0 &&
                    ` · ${t('targets.pendingProposals', { count: item.pendingProposals })}`}
                </p>
              </div>
              <SettingsSwitch
                data-testid="evolution-target-item-toggle"
                aria-label={t('targets.itemToggle', { name: item.name })}
                checked={checked}
                disabled={disabled}
                onCheckedChange={next => onSave(withItem(settings, type, item.targetKey, next))}
              />
            </li>
          )
        })}
      </ul>
      {loading && items.length === 0 && (
        <p role="status" className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {t('targets.loading')}
        </p>
      )}
      {cursor && (
        // The button stays mounted while the next page loads, so the list does not jump.
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          data-testid={`evolution-target-more-${type}`}
          pending={loading}
          onClick={() => void load(cursor)}
        >
          {t('targets.loadMore')}
        </Button>
      )}
    </div>
  )
}
