import { ChevronRight, Search, X } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { settingsGroups, type SettingsItem, type SettingsKey } from './settingsNavigation'

interface SettingsDirectoryProps {
  entries: SettingsItem[]
  current?: SettingsKey
  onChoose: (item: SettingsItem) => void
  mobile?: boolean
}

export function SettingsDirectory({
  entries,
  current,
  onChoose,
  mobile = false,
}: SettingsDirectoryProps) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const words = query.normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const sections = settingsGroups
    .map(group => {
      const heading = t(`workbench.settings_groups.${group}`)
      const matches = entries.filter(item => {
        if (item.group !== group) return false
        const text = [
          heading,
          t(item.label),
          t(`workbench.settings_purpose.${item.key}`),
          ...(item.searchKeys ?? []).map(key => t(key)),
        ]
          .join(' ')
          .normalize('NFKC')
          .toLowerCase()
        return words.every(word => text.includes(word))
      })
      return { group, heading, matches }
    })
    .filter(section => section.matches.length > 0)
  function clearSearch() {
    setQuery('')
    input.current?.focus()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn('relative mb-2 shrink-0', !mobile && 'mx-2')}>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-3 my-auto h-4 w-4 text-text-muted"
        />
        <input
          ref={input}
          type="search"
          value={query}
          data-testid={mobile ? 'mobile-settings-search' : 'settings-search'}
          aria-label={t('workbench.settings_search')}
          placeholder={t('workbench.settings_search')}
          aria-controls={id}
          className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-10 text-sm text-text-primary placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:h-11 [&::-webkit-search-cancel-button]:hidden"
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (
              event.key === 'Enter' &&
              !event.nativeEvent.isComposing &&
              words.length &&
              sections.length === 1 &&
              sections[0].matches.length === 1
            ) {
              event.preventDefault()
              onChoose(sections[0].matches[0])
            }
          }}
        />
        {query && (
          <button
            type="button"
            onClick={clearSearch}
            aria-label={t('workbench.settings_clear_search')}
            className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-muted focus-visible:ring-2 focus-visible:ring-focus max-md:w-11"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
      <nav
        id={id}
        data-testid={mobile ? 'mobile-settings-directory' : 'settings-sidebar-nav'}
        aria-label={t('workbench.settings')}
        className={cn(
          'scrollbar-soft min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3 [scrollbar-gutter:stable]',
          !mobile && 'px-1.5'
        )}
      >
        {sections.map(({ group, heading, matches }) => (
          <section key={group} aria-labelledby={`${id}-${group}`} className="mb-3 last:mb-0">
            <h2
              id={`${id}-${group}`}
              data-testid={`settings-category-${group}`}
              className="px-2.5 pb-1 pt-2 text-xs font-semibold text-text-secondary"
            >
              {heading}
            </h2>
            <div
              className={
                mobile
                  ? 'divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-background'
                  : 'space-y-0.5'
              }
            >
              {matches.map(item => {
                const title = t(item.label)
                const purpose = t(`workbench.settings_purpose.${item.key}`)
                return (
                  <button
                    type="button"
                    key={item.key}
                    data-testid={mobile ? mobileEntryId(item.key) : `settings-nav-${item.key}`}
                    aria-current={current === item.key ? 'page' : undefined}
                    title={purpose}
                    onClick={() => onChoose(item)}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-2.5 text-left text-sm transition-colors hover:bg-[rgb(var(--color-sidebar-hover))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus',
                      mobile ? 'min-h-[56px] py-2' : 'min-h-8 rounded-lg py-1',
                      current === item.key
                        ? 'bg-[rgb(var(--color-sidebar-active))] font-medium text-text-primary'
                        : 'text-text-secondary'
                    )}
                  >
                    <item.icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-text-primary">{title}</span>
                      {(mobile || words.length > 0) && (
                        <span className="mt-0.5 block break-words text-xs font-normal leading-relaxed text-text-secondary">
                          {purpose}
                        </span>
                      )}
                    </span>
                    {mobile && (
                      <ChevronRight
                        className="h-4 w-4 shrink-0 text-text-muted"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                )
              })}
            </div>
          </section>
        ))}
        {!sections.length && (
          <p role="status" className="px-3 py-6 text-sm text-text-secondary">
            {t('workbench.settings_search_empty')}
          </p>
        )}
      </nav>
    </div>
  )
}

function mobileEntryId(key: SettingsKey) {
  if (key === 'plugin-library') return 'mobile-settings-plugins-button'
  if (key === 'plugins') return 'mobile-settings-plugins-config-button'
  if (key === 'access-links') return 'mobile-settings-mobile-connection-button'
  return `mobile-settings-${key}-button`
}
