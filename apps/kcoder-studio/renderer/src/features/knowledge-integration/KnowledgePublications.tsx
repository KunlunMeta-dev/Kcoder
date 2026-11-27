import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { sameKnowledgeOwner } from './identity'
import { createRandomUuid } from '@/lib/random-id'
import { useDomainAction } from './useDomainAction'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import type {
  KnowledgePublication,
  KnowledgeRetrieval,
  PublicationSource,
  KnowledgeVisibility,
  KnowledgeAdoption,
} from '../../../../shared/generated/contracts'
import { KnowledgeOperationError, type KnowledgeIntegrationClient } from './client'
import { fieldClass, OperationError, PageActions } from './shared'
import { useDomainPage } from './useDomainPage'
import { PublicationMetadata } from './PublicationMetadata'
import { PublicationHistory } from './PublicationHistory'
import { PublicationSources } from './PublicationSources'
import { NativeWikiPublicationSources } from './NativeWikiPublicationSources'
import {
  publicationSourceKey as sourceKey,
  type NativeWikiPublicationInputs,
} from './wikiPublicationInputs'
export interface PublishableAudience {
  visibility: KnowledgeVisibility
  audienceId: string | null
  label: string
}
export interface PublishableWikiPage {
  title: string
  source: PublicationSource
}
const localDateTime = (epochMs?: number | null) => {
  if (epochMs == null) return ''
  const date = new Date(epochMs)
  const pad = (value: number, width = 2) => value.toString().padStart(width, '0')
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}
function PublicationRow({
  publication,
  client,
  refresh,
  adoption,
  onUpdate,
}: {
  adoption?: KnowledgeAdoption
  publication: KnowledgePublication
  client: KnowledgeIntegrationClient
  refresh: () => void
  onUpdate: (publication: KnowledgePublication) => void
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const action = useDomainAction(refresh, client)
  const [sourceError, setSourceError] = useState<KnowledgeOperationError>()
  const [selected, setSelected] = useState(publication)
  const [version, setVersion] = useState(publication.version)
  const [query, setQuery] = useState(''),
    [retrieval, setRetrieval] = useState<KnowledgeRetrieval>()
  const currentAdoption =
    adoption && sameKnowledgeOwner(adoption.owner, client.scope) ? adoption : undefined
  const accessError = [action.error, sourceError].find(
    error =>
      error &&
      (error.code.includes('DENIED') ||
        [
          'KNOWLEDGE_OWNER_CHANGED',
          'KNOWLEDGE_CALLER_SCOPE_MISMATCH',
          'KNOWLEDGE_POLICY_UNAVAILABLE',
          'KNOWLEDGE_OPERATION_UNAVAILABLE',
          'KNOWLEDGE_SHARED_READER_UNAVAILABLE',
          'KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE',
          'KNOWLEDGE_RPC_CONFIGURATION_CHANGED',
          'KNOWLEDGE_RPC_CONFIGURATION_UNAVAILABLE',
          'KNOWLEDGE_NATIVE_FEATURE_UNAVAILABLE',
          'KNOWLEDGE_NATIVE_STORE_UNAVAILABLE',
          'KNOWLEDGE_PUBLICATION_NOT_INITIALIZED',
          'KNOWLEDGE_PUBLICATION_NOT_FOUND',
          'KNOWLEDGE_PUBLICATION_CORRUPT',
          'KNOWLEDGE_PUBLICATION_IDENTITY_MISMATCH',
          'KNOWLEDGE_PUBLICATION_REVOKED',
          'KNOWLEDGE_PUBLICATION_NOT_EFFECTIVE',
          'KNOWLEDGE_PUBLICATION_EXPIRED',
        ].includes(error.code))
  )
  useEffect(() => {
    if (accessError) refresh()
  }, [accessError, refresh])
  if (accessError) {
    return (
      <article className="studio-card-spacing workbench-card">
        <OperationError error={accessError} />
        <Button
          variant="outline"
          className="min-h-11 md:min-h-0"
          disabled={action.blocked}
          data-testid="publication-refresh-access"
          onClick={() => {
            setSourceError(accessError)
            void action.run(async () => {
              const current = await client.resolvePublication(selected, selected.version)
              setSelected(current)
              setSourceError(undefined)
            })
          }}
        >
          {t('refresh')}
        </Button>
      </article>
    )
  }
  return (
    <article
      className="studio-card-spacing workbench-card workbench-card-interactive space-y-3"
      data-testid="knowledge-publication-row"
    >
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="font-medium">{publication.draft.title}</h3>
        <span className="text-sm text-text-muted">
          {t('version', { version: publication.version })}
        </span>
      </div>
      <p className="text-xs text-text-muted">
        {t(`visibility.${publication.draft.visibility}`)}
        {publication.draft.audienceId ? ` · ${publication.draft.audienceId}` : ''}
      </p>
      <PublicationMetadata publication={selected} />
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-sm">
          <span>{t('versionLabel')}</span>
          <input
            type="number"
            min={1}
            max={publication.version}
            value={version}
            onChange={event => setVersion(Number(event.target.value))}
            className={fieldClass}
            data-testid="publication-version"
          />
        </label>
        <Button
          variant="outline"
          disabled={action.blocked || version < 1 || !Number.isInteger(version)}
          onClick={() =>
            void action.run(async () => {
              setRetrieval(undefined)
              setSelected(await client.resolvePublication(publication, version))
            })
          }
          data-testid="publication-load-version"
        >
          {t('loadVersion')}
        </Button>
        <Button
          disabled={
            action.blocked ||
            (!!currentAdoption &&
              currentAdoption.enabled &&
              currentAdoption.publicationVersion === selected.version)
          }
          onClick={() =>
            void action.run(() => client.adoptPublication(selected, currentAdoption?.revision ?? 0))
          }
          data-testid="publication-adopt"
        >
          {t('adoptVersion', { version: selected.version })}
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        {t('viewingVersion', { version: selected.version })}
      </p>
      {selected.version !== publication.version && (
        <details className="studio-card-spacing rounded-xl border border-border">
          <summary className="cursor-pointer text-sm" data-testid="publication-compare-toggle">
            {t('compareVersions', { from: selected.version, to: publication.version })}
          </summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <h4 className="text-sm font-medium">{t('version', { version: selected.version })}</h4>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-sm">
                {selected.pages.map(page => page.markdown).join('\n\n')}
              </pre>
            </div>
            <div>
              <h4 className="text-sm font-medium">
                {t('version', { version: publication.version })}
              </h4>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-sm">
                {publication.pages.map(page => page.markdown).join('\n\n')}
              </pre>
            </div>
          </div>
        </details>
      )}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={e => {
          e.preventDefault()
          setRetrieval(undefined)
          void action.run(async () => {
            const result = await client.retrieve(selected, query)
            setRetrieval(result)
          })
        }}
      >
        <input
          className={`${fieldClass} flex-1`}
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label={t('query')}
          data-testid="knowledge-query"
        />
        <Button
          variant="outline"
          type="submit"
          disabled={action.blocked || !query.trim()}
          data-testid="knowledge-search"
        >
          {t('search')}
        </Button>
      </form>
      <OperationError error={action.error} onInspect={() => void action.inspect()} />
      {retrieval?.outcome === 'no_match' && (
        <p className="text-sm text-text-muted" data-testid="knowledge-no-match">
          {t('noMatch')}
        </p>
      )}
      {retrieval?.hits.map(hit => (
        <blockquote
          key={`${hit.source.pageId}-${hit.source.pageRevision}`}
          className="border-l-2 border-border pl-3 text-sm"
        >
          <p className="whitespace-pre-wrap">{hit.excerpt}</p>
          <p className="mt-1 text-xs text-text-muted">
            {t('citation')}: {hit.source.pageRevision}
          </p>
        </blockquote>
      ))}
      <details className="text-sm text-text-secondary">
        <summary className="cursor-pointer" data-testid="publication-sources-toggle">
          {t('source')}
        </summary>
        {selected.pages.map(page => (
          <div key={`${page.source.pageId}-${page.source.pageRevision}`} className="mt-3">
            <h4 className="font-medium">{page.title}</h4>
            <p className="break-all text-xs text-text-muted">{page.source.pageRevision}</p>
            <p className="mt-2 whitespace-pre-wrap">{page.markdown}</p>
          </div>
        ))}
      </details>
      <PublicationSources
        key={JSON.stringify([
          client.ownerKey,
          selected.owner,
          selected.draft.publicationId,
          selected.version,
        ])}
        client={client}
        publication={selected}
        onError={setSourceError}
      />
      {sameKnowledgeOwner(publication.owner, client.scope) && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={action.blocked}
            onClick={() => onUpdate(publication)}
            data-testid="publication-new-version"
          >
            {t('createUpdatedVersion')}
          </Button>
          <Button
            variant="destructive"
            disabled={action.blocked}
            onClick={() => void action.run(() => client.revokePublication(publication))}
            data-testid="knowledge-revoke"
          >
            {t('revoke')}
          </Button>
        </div>
      )}
    </article>
  )
}
export function KnowledgePublications({
  client,
  sourcePages = [],
  audiences = [],
  wikiInputs,
}: {
  client: KnowledgeIntegrationClient
  sourcePages?: PublishableWikiPage[]
  audiences?: PublishableAudience[]
  wikiInputs?: NativeWikiPublicationInputs
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const page = useDomainPage(client.ownerKey, (after, signal) =>
    client.listPublications(after, signal)
  )
  const adoptions = useDomainPage(client.ownerKey, (after, signal) =>
    client.listAdoptions(after, signal)
  )
  const refreshPage = page.refresh
  const refreshAdoptions = adoptions.refresh
  const refresh = useCallback(() => {
    refreshPage()
    refreshAdoptions()
  }, [refreshPage, refreshAdoptions])
  const action = useDomainAction(refresh, client)
  const [title, setTitle] = useState(''),
    [selection, setSelection] = useState<{
      ownerKey: string
      pages: Map<string, PublishableWikiPage>
    }>({ ownerKey: client.ownerKey, pages: new Map() })
  const selected =
    selection.ownerKey === client.ownerKey
      ? selection.pages
      : new Map<string, PublishableWikiPage>()
  const setSelected = (pages: Map<string, PublishableWikiPage>) =>
    setSelection({ ownerKey: client.ownerKey, pages })
  const [showEditor, setShowEditor] = useState(false)
  const [sourceReadError, setSourceReadError] = useState<KnowledgeOperationError>()
  const sourceInputUnavailable =
    !!wikiInputs && (!!sourceReadError || wikiInputs.ownerKey !== client.ownerKey)
  const toggleSource = (page: PublishableWikiPage, checked: boolean) => {
    setSelection(current => {
      const next = new Map(current.ownerKey === client.ownerKey ? current.pages : [])
      if (checked && next.size < 64) next.set(sourceKey(page.source), structuredClone(page))
      else if (!checked) next.delete(sourceKey(page.source))
      return { ownerKey: client.ownerKey, pages: next }
    })
  }
  const [draftId, setDraftId] = useState(() => createRandomUuid())
  const [expectedVersion, setExpectedVersion] = useState(0)
  const [purpose, setPurpose] = useState(''),
    [reviewNote, setReviewNote] = useState('')
  const [validFrom, setValidFrom] = useState(''),
    [validUntil, setValidUntil] = useState('')
  const [baseValidity, setBaseValidity] = useState<{ from: number | null; until: number | null }>({
    from: null,
    until: null,
  })
  const [unresolved, setUnresolved] = useState('')
  const [updateCandidate, setUpdateCandidate] = useState<KnowledgePublication>()
  const [showHistory, setShowHistory] = useState(false)
  const editor = useRef<HTMLDetailsElement>(null)
  const [audienceKey, setAudienceKey] = useState('personal:')
  const audienceChoices: PublishableAudience[] = [
    { visibility: 'personal', audienceId: null, label: t('personal') },
    ...audiences.filter(a => a.visibility !== 'personal'),
  ]
  const audience = audienceChoices.find(
    a => `${a.visibility}:${a.audienceId ?? ''}` === audienceKey
  )
  const selectedSources = [...selected.values()]
  return (
    <section className="space-y-5" data-testid="knowledge-publications">
      <p className="text-sm text-text-secondary">{t('knowledgeHint')}</p>
      <details
        className="studio-card-spacing workbench-card workbench-card-interactive"
        onToggle={event => setShowHistory(event.currentTarget.open)}
      >
        <summary className="cursor-pointer font-medium" data-testid="publication-history-toggle">
          {t('publicationHistory')}
        </summary>
        {showHistory && <PublicationHistory client={client} refreshPublications={refresh} />}
      </details>
      {updateCandidate && (
        <div
          className="studio-card-spacing space-y-3 rounded-xl border border-border"
          data-testid="publication-update-confirmation"
        >
          <p className="text-sm">{t('publicationUpdateConfirmation')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="publication-confirm-update"
              onClick={() => {
                setDraftId(updateCandidate.draft.publicationId)
                setExpectedVersion(updateCandidate.version)
                setTitle(updateCandidate.draft.title)
                setPurpose(updateCandidate.draft.purpose ?? '')
                setReviewNote(updateCandidate.draft.reviewConclusion ?? '')
                setValidFrom(localDateTime(updateCandidate.draft.validFromMs))
                setValidUntil(localDateTime(updateCandidate.draft.validUntilMs))
                setBaseValidity({
                  from: updateCandidate.draft.validFromMs ?? null,
                  until: updateCandidate.draft.validUntilMs ?? null,
                })
                setUnresolved(updateCandidate.draft.unresolved.join('\n'))
                setSelected(
                  new Map(
                    updateCandidate.pages.map(page => [
                      sourceKey(page.source),
                      { title: page.title, source: structuredClone(page.source) },
                    ])
                  )
                )
                setAudienceKey(
                  `${updateCandidate.draft.visibility}:${updateCandidate.draft.audienceId ?? ''}`
                )
                setUpdateCandidate(undefined)
                if (editor.current) editor.current.open = true
              }}
            >
              {t('confirmUpdatedVersion')}
            </Button>
            <Button
              variant="ghost"
              data-testid="publication-cancel-update"
              onClick={() => setUpdateCandidate(undefined)}
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}
      <details className="studio-card-spacing workbench-card workbench-card-interactive">
        <summary className="cursor-pointer font-medium" data-testid="knowledge-adoptions-toggle">
          {t('adoptedVersions')}
        </summary>
        <OperationError error={adoptions.error} />
        <ul className="mt-3 space-y-3">
          {adoptions.items.map(item => (
            <li
              key={JSON.stringify([item.owner, item.id])}
              className="flex flex-wrap items-center gap-2"
              data-testid="knowledge-adoption-row"
            >
              <span className="mr-auto text-sm">
                {page.items.find(
                  publication =>
                    publication.draft.publicationId === item.publicationId &&
                    sameKnowledgeOwner(publication.owner, item.publicationOwner)
                )?.draft.title ?? item.publicationId}{' '}
                · {t('version', { version: item.publicationVersion })} ·{' '}
                {t(item.enabled ? 'enabled' : 'disabled')}
                {!sameKnowledgeOwner(item.owner, client.scope) && (
                  <span className="ml-2 text-text-muted">{t('previousScopeAdoption')}</span>
                )}
              </span>
              <Button
                variant="outline"
                disabled={action.blocked}
                onClick={() =>
                  void action.run(() =>
                    sameKnowledgeOwner(item.owner, client.scope)
                      ? client.setAdoptionEnabled(item, !item.enabled)
                      : client.adoptPublicationReference({
                          owner: item.publicationOwner,
                          publicationId: item.publicationId,
                          version: item.publicationVersion,
                        })
                  )
                }
                data-testid="knowledge-adoption-toggle"
              >
                {t(
                  !sameKnowledgeOwner(item.owner, client.scope)
                    ? 'adoptInCurrentScope'
                    : item.enabled
                      ? 'disable'
                      : 'enable'
                )}
              </Button>
            </li>
          ))}
        </ul>
        <PageActions {...adoptions} />
      </details>

      <details
        ref={editor}
        className="studio-card-spacing workbench-card workbench-card-interactive"
        onToggle={event => {
          if (event.target === event.currentTarget) setShowEditor(event.currentTarget.open)
        }}
      >
        <summary className="cursor-pointer font-medium" data-testid="publication-create-toggle">
          {t('createPublication')}
        </summary>
        <form
          className="mt-4 space-y-3"
          onSubmit={e => {
            e.preventDefault()
            const toTimestamp = (value: string, original: number | null) => {
              if (original != null && value === localDateTime(original)) return original
              if (!value) return null
              const result = new Date(value).getTime()
              if (!Number.isFinite(result))
                throw new KnowledgeOperationError('KNOWLEDGE_INVALID_VALIDITY')
              return result
            }
            void action
              .run(async () => {
                if (!audience) throw new KnowledgeOperationError('KNOWLEDGE_AUDIENCE_DENIED')
                if (sourceInputUnavailable || !selectedSources.length)
                  throw new KnowledgeOperationError('KNOWLEDGE_SOURCE_UNAVAILABLE')
                return client.publishKnowledge(
                  {
                    publicationId: draftId,
                    title,
                    purpose: purpose.trim() || null,
                    reviewConclusion: reviewNote.trim() || null,
                    visibility: audience.visibility,
                    audienceId: audience.audienceId,
                    sources: selectedSources.map(page => page.source),
                    validFromMs: toTimestamp(validFrom, baseValidity.from),
                    validUntilMs: toTimestamp(validUntil, baseValidity.until),
                    unresolved: unresolved
                      .split('\n')
                      .map(item => item.trim())
                      .filter(Boolean),
                  },
                  expectedVersion
                )
              })
              .then(ok => {
                if (ok) {
                  setTitle('')
                  setSelected(new Map())
                  setDraftId(createRandomUuid())
                  setExpectedVersion(0)
                  setPurpose('')
                  setReviewNote('')
                  setValidFrom('')
                  setValidUntil('')
                  setBaseValidity({ from: null, until: null })
                  setUnresolved('')
                }
              })
          }}
        >
          <label className="block space-y-1 text-sm">
            <span>{t('publicationTitle')}</span>
            <input
              className={fieldClass}
              value={title}
              onChange={e => setTitle(e.target.value)}
              required
              disabled={action.blocked}
              data-testid="publication-title"
            />
          </label>
          {!audience && (
            <p role="alert" className="text-sm text-text-muted">
              {t('audienceUnavailable')}
            </p>
          )}
          {expectedVersion > 0 && (
            <p className="text-sm text-text-muted">
              {t('newPublicationVersion', { from: expectedVersion, to: expectedVersion + 1 })}
            </p>
          )}
          <label className="block space-y-1 text-sm">
            <span>{t('publicationPurpose')}</span>
            <textarea
              className={fieldClass}
              value={purpose}
              onChange={event => setPurpose(event.target.value)}
              required
              maxLength={4096}
              disabled={action.blocked}
              data-testid="publication-purpose"
              rows={2}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span>{t('validFrom')}</span>
              <input
                type="datetime-local"
                step="0.001"
                className={fieldClass}
                value={validFrom}
                onChange={event => setValidFrom(event.target.value)}
                disabled={action.blocked}
                data-testid="publication-valid-from"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span>{t('validUntil')}</span>
              <input
                type="datetime-local"
                step="0.001"
                className={fieldClass}
                value={validUntil}
                onChange={event => setValidUntil(event.target.value)}
                disabled={action.blocked}
                data-testid="publication-valid-until"
              />
            </label>
          </div>
          <p className="text-xs text-text-muted">
            {t('validityTimezone', { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}
          </p>
          <details>
            <summary
              className="cursor-pointer text-sm text-text-secondary"
              data-testid="publication-review-toggle"
            >
              {t('publisherReviewNote')}
            </summary>
            <p className="mt-2 text-xs text-text-muted">{t('publisherReviewHint')}</p>
            <textarea
              className={`${fieldClass} mt-2`}
              value={reviewNote}
              onChange={event => setReviewNote(event.target.value)}
              maxLength={4096}
              disabled={action.blocked}
              data-testid="publication-review-note"
              aria-label={t('publisherReviewNote')}
              rows={2}
            />
            <label className="mt-2 block space-y-1 text-sm">
              <span>{t('unresolvedItems')}</span>
              <textarea
                className={fieldClass}
                value={unresolved}
                onChange={event => setUnresolved(event.target.value)}
                disabled={action.blocked}
                data-testid="publication-unresolved"
                rows={2}
              />
            </label>
          </details>
          <label className="block space-y-1 text-sm">
            <span>{t('publicationAudience')}</span>
            <SettingsSelect
              className={fieldClass}
              value={audienceKey}
              onChange={e => setAudienceKey(e.target.value)}
              disabled={action.blocked}
              data-testid="publication-audience"
            >
              {audienceChoices.map(a => (
                <option
                  key={`${a.visibility}:${a.audienceId ?? ''}`}
                  value={`${a.visibility}:${a.audienceId ?? ''}`}
                >
                  {a.label}
                </option>
              ))}
            </SettingsSelect>
          </label>
          {wikiInputs && showEditor ? (
            <NativeWikiPublicationSources
              provider={wikiInputs}
              ownerKey={client.ownerKey}
              selected={selected}
              disabled={action.blocked}
              onToggle={toggleSource}
              onError={setSourceReadError}
            />
          ) : null}
          {!wikiInputs && !sourcePages.length && (
            <p className="text-sm text-text-muted">{t('noPages')}</p>
          )}
          {!wikiInputs && (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm">{t('sourcePages')}</legend>
              {sourcePages.map(source => {
                const key = sourceKey(source.source)
                return (
                  <label key={key} className="flex min-h-11 items-center gap-2 text-sm">
                    <Checkbox
                      checked={selected.has(key)}
                      onChange={e => toggleSource(source, e.target.checked)}
                      disabled={action.blocked || (!selected.has(key) && selected.size >= 64)}
                      data-testid="publication-source-checkbox"
                    />
                    <span>
                      {source.title}
                      <span className="ml-2 text-xs text-text-muted">
                        {source.source.pageRevision}
                      </span>
                    </span>
                  </label>
                )
              })}
            </fieldset>
          )}
          {!!selectedSources.length && !sourceInputUnavailable && (
            <div className="space-y-2" data-testid="publication-selected-sources">
              <p className="text-sm text-text-muted">{t('fixedSourceSelectionHint')}</p>
              {selectedSources.map(page => (
                <div
                  key={sourceKey(page.source)}
                  className="flex flex-wrap items-center gap-2 text-sm"
                  data-testid="publication-selected-source"
                >
                  <span className="mr-auto min-w-0 break-words">
                    {page.title} ·{' '}
                    <span className="break-all text-xs text-text-muted">
                      {page.source.pageRevision}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={action.blocked}
                    className="min-h-11 md:min-h-0"
                    data-testid="publication-source-remove"
                    onClick={() => toggleSource(page, false)}
                  >
                    {t('removeSelectedSource')}
                  </Button>
                </div>
              ))}
            </div>
          )}
          {sourceInputUnavailable && (
            <p className="text-sm text-text-muted">{t('sourceSelectionAwaitingRead')}</p>
          )}
          <OperationError error={action.error} onInspect={() => void action.inspect()} />
          <Button
            type="submit"
            disabled={
              action.blocked ||
              !selectedSources.length ||
              sourceInputUnavailable ||
              !title.trim() ||
              !purpose.trim() ||
              !audience
            }
            data-testid="knowledge-publish"
          >
            {t('publish')}
          </Button>
        </form>
      </details>
      <OperationError
        error={
          page.error?.code === 'KNOWLEDGE_PUBLICATION_NOT_INITIALIZED' ? undefined : page.error
        }
      />
      <div aria-busy={page.pending} className="space-y-3">
        {page.pending && (
          <p role="status" className="text-sm text-text-muted">
            {t('loading')}
          </p>
        )}
        {!page.pending &&
          (!page.error || page.error.code === 'KNOWLEDGE_PUBLICATION_NOT_INITIALIZED') &&
          !page.items.length && <p className="text-text-muted">{t('empty')}</p>}
        {page.items.map(publication => (
          <PublicationRow
            key={`${JSON.stringify(publication.owner)}-${publication.draft.publicationId}-${publication.version}`}
            publication={publication}
            client={client}
            refresh={refresh}
            onUpdate={setUpdateCandidate}
            adoption={adoptions.items.find(
              item =>
                item.publicationId === publication.draft.publicationId &&
                sameKnowledgeOwner(item.publicationOwner, publication.owner) &&
                sameKnowledgeOwner(item.owner, client.scope)
            )}
          />
        ))}
      </div>
      <PageActions {...page} />
    </section>
  )
}
