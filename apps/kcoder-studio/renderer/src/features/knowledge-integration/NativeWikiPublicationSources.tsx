import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { createRandomUuid } from '@/lib/random-id'
import { KnowledgeOperationError } from './client'
import type { PublishableWikiPage } from './KnowledgePublications'
import { OperationError, PageActions } from './shared'
import { useDomainPage } from './useDomainPage'
import {
  publicationSourceKey,
  type NativeWikiMetadataPage,
  type NativeWikiPublicationInputs,
  type NativeWikiPublicationLibrary,
} from './wikiPublicationInputs'

function validatePage<T>(
  page: NativeWikiMetadataPage<T>,
  valid: (item: T) => boolean,
  project: (item: T) => T
) {
  if (
    !page ||
    !Array.isArray(page.items) ||
    Object.keys(page).some(key => !['items', 'nextCursor'].includes(key)) ||
    page.items.length > 10 ||
    (page.nextCursor != null && (typeof page.nextCursor !== 'string' || !page.nextCursor)) ||
    page.items.some(item => !valid(item))
  )
    throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
  return { items: page.items.map(project), nextCursor: page.nextCursor ?? null }
}
const text = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= 4096

export function NativeWikiPublicationSources({
  provider,
  ownerKey,
  selected,
  disabled,
  onToggle,
  onError,
}: {
  provider: NativeWikiPublicationInputs
  ownerKey: string
  selected: ReadonlyMap<string, PublishableWikiPage>
  disabled: boolean
  onToggle: (page: PublishableWikiPage, checked: boolean) => void
  onError: (error?: KnowledgeOperationError) => void
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const providerInstance = useMemo(() => ({ provider, key: createRandomUuid() }), [provider]).key
  const namespace = JSON.stringify([ownerKey, provider.ownerKey, providerInstance])
  const [choice, setChoice] = useState<{ namespace: string; id: string; selectionKey: string }>()
  const libraryId = choice?.namespace === namespace ? choice.id : undefined
  const checkOwner = () => {
    if (provider.ownerKey !== ownerKey) throw new KnowledgeOperationError('KNOWLEDGE_OWNER_CHANGED')
  }
  const libraries = useDomainPage(namespace, async (after, signal) => {
    checkOwner()
    const result = await provider.listLibraries({ after, limit: 10, signal: signal! })
    checkOwner()
    return validatePage(
      result,
      (item: NativeWikiPublicationLibrary) =>
        !!item &&
        text(item.id) &&
        text(item.title) &&
        (item.archived == null || typeof item.archived === 'boolean'),
      item => ({
        id: item.id,
        title: item.title,
        ...(item.archived == null ? {} : { archived: item.archived }),
      })
    )
  })
  const pages = useDomainPage(
    JSON.stringify([namespace, libraryId, choice?.selectionKey]),
    async (after, signal) => {
      if (!libraryId) return { items: [], nextCursor: null }
      checkOwner()
      const result = await provider.listPages({ libraryId, after, limit: 10, signal: signal! })
      checkOwner()
      return validatePage(
        result,
        (item: PublishableWikiPage) =>
          !!item &&
          text(item.title) &&
          !!item.source &&
          item.source.libraryId === libraryId &&
          text(item.source.pageId) &&
          text(item.source.pageRevision),
        item => ({
          title: item.title,
          source: {
            libraryId: item.source.libraryId,
            pageId: item.source.pageId,
            pageRevision: item.source.pageRevision,
          },
        })
      )
    }
  )
  const error = libraries.error ?? pages.error
  useEffect(() => {
    if (error) onError(error)
    else if (!libraries.pending && (!libraryId || !pages.pending)) onError(undefined)
  }, [error, libraries.pending, pages.pending, libraryId, onError])
  return (
    <div className="studio-card-spacing workbench-card space-y-3" data-testid="native-wiki-publication-inputs">
      <p className="text-sm text-text-muted">{t('nativeWikiInputsHint')}</p>
      <OperationError error={error} />
      <fieldset className="space-y-2" disabled={disabled} aria-busy={libraries.pending}>
        <legend className="mb-2 text-sm">{t('wikiLibraries')}</legend>
        {libraries.pending && (
          <p role="status" className="text-sm text-text-muted">
            {t('loading')}
          </p>
        )}
        {!libraries.pending && !libraries.error && !libraries.items.length && (
          <p className="text-sm text-text-muted">{t('noWikiLibraries')}</p>
        )}
        <div className="flex flex-wrap gap-2">
          {!libraries.error &&
            libraries.items.map(library => (
              <Button
                key={library.id}
                type="button"
                variant={libraryId === library.id ? 'secondary' : 'outline'}
                className="min-h-11 max-w-full text-left md:min-h-0"
                aria-pressed={libraryId === library.id}
                data-testid="publication-library-choice"
                onClick={() =>
                  setChoice({ namespace, id: library.id, selectionKey: createRandomUuid() })
                }
              >
                <span className="min-w-0 truncate" title={library.title}>
                  {library.title}
                </span>
                {library.archived === true ? ` · ${t('wikiLibraryArchived')}` : ''}
              </Button>
            ))}
        </div>
        <PageActions {...libraries} />
      </fieldset>
      {!libraryId && <p className="text-sm text-text-muted">{t('chooseWikiLibrary')}</p>}
      {libraryId && (
        <fieldset
          className="space-y-2"
          disabled={disabled}
          aria-busy={pages.pending}
          data-testid="publication-library-pages"
        >
          <legend className="mb-2 text-sm">{t('sourcePages')}</legend>
          {pages.pending && (
            <p role="status" className="text-sm text-text-muted">
              {t('loading')}
            </p>
          )}
          {!pages.pending && !pages.error && !pages.items.length && (
            <p className="text-sm text-text-muted">{t('noPages')}</p>
          )}
          {!pages.pending &&
            !pages.error &&
            pages.items.map(page => {
              const key = publicationSourceKey(page.source)
              return (
                <label key={key} className="flex min-h-11 items-center gap-2 text-sm">
                  <Checkbox
                    checked={selected.has(key)}
                    disabled={disabled || (!selected.has(key) && selected.size >= 64)}
                    onChange={event => onToggle(page, event.target.checked)}
                    data-testid="publication-source-checkbox"
                  />
                  <span className="min-w-0 break-words">
                    {page.title}
                    <span className="ml-2 break-all text-xs text-text-muted">
                      {page.source.pageRevision}
                    </span>
                  </span>
                </label>
              )
            })}
          <PageActions {...pages} />
        </fieldset>
      )}
    </div>
  )
}
