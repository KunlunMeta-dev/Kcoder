import { WorkspacePageHeader } from '@/components/layout/WorkspacePageHeader'
import { currentHostDeviceId } from '@/features/runtime-target/currentHostTarget'
import { downloadLink } from '@/kcoder/downloadLink'
import { WikiArchiveTransfer } from './WikiArchiveTransfer'
import { WikiLibraryCreate } from './WikiLibraryCreate'
import { exportMarkdownZip, importMarkdownZip } from './wikiMarkdownBundle'
import { WikiError } from './WikiError'
import { WikiLibraryRename } from './WikiLibraryRename'
import { KnowledgeContents } from './KnowledgeContents'
import { WikiManagedKnowledge } from './WikiManagedKnowledge'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BookOpen,
  Plus,
  RefreshCw,
  LibraryBig,
  Pencil,
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Download,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { PageContent } from '@/components/ui/page-content'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { workbenchModelTarget } from '@/features/workbench/workbenchModelTarget'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { knowledgeApi, type WikiLibrary } from '@/kcoder/knowledgeApi'

export type WikiWorkspaceSection = 'library' | 'memory'

export function KnowledgeWorkspace({
  initialSection = 'library',
}: { initialSection?: WikiWorkspaceSection } = {}) {
  const { t } = useTranslation('knowledge')
  const { state } = useWorkbench()
  const target = workbenchModelTarget(state)
  const [requested, setRequested] = useState<string | null>(null)
  const [section, setSection] = useState<WikiWorkspaceSection>(initialSection)
  const [previousInitial, setPreviousInitial] = useState(initialSection)
  if (previousInitial !== initialSection) {
    setPreviousInitial(initialSection)
    setSection(initialSection)
  }
  const serverId = state.devices.some(device => device.device_id === requested)
    ? requested!
    : currentHostDeviceId(state.devices) || ''
  const scope = usePluginTargetScope(serverId)
  const workspacePath = serverId === target?.deviceId ? target.workspacePath : undefined
  const sections: WikiWorkspaceSection[] = ['library', 'memory']
  const owner = JSON.stringify([scope.key, workspacePath])
  const [visited, setVisited] = useState({
    owner,
    sections: [initialSection] as WikiWorkspaceSection[],
  })
  if (visited.owner !== owner || !visited.sections.includes(section))
    setVisited({
      owner,
      sections: visited.owner === owner ? [...visited.sections, section] : [section],
    })
  const openedSections = visited.owner === owner ? visited.sections : [section]
  const chooseSection = (next: WikiWorkspaceSection) => {
    setSection(next)
    setVisited(current => ({ owner, sections: Array.from(new Set([...current.sections, next])) }))
  }
  return (
    <main
      data-testid="knowledge-workspace"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-text-primary"
    >
      <WorkspacePageHeader
        title={t('title')}
        backLabel={t('back')}
        backTestId="knowledge-back"
        actions={
          <>
            {' '}
            <SettingsSelect
              density="compact"
              icon={<BookOpen />}
              aria-label={t('targetRequired')}
              data-testid="knowledge-target"
              value={serverId}
              onChange={event => setRequested(event.target.value)}
            >
              {state.devices.map(device => (
                <option key={device.device_id} value={device.device_id}>
                  {device.name}
                </option>
              ))}
            </SettingsSelect>{' '}
          </>
        }
      />
      <nav
        role="tablist"
        aria-label={t('workspaceTabs')}
        className="mx-auto my-4 inline-flex shrink-0 gap-1 self-center rounded-2xl border border-border/70 bg-surface/60 p-1"
      >
        {sections.map(value => (
          <Button
            key={value}
            id={`wiki-workspace-tab-${value}`}
            role="tab"
            aria-selected={section === value}
            aria-controls={`wiki-workspace-panel-${value}`}
            tabIndex={section === value ? 0 : -1}
            variant="ghost"
            className={
              section === value
                ? 'min-h-11 min-w-28 rounded-xl bg-background font-medium shadow-sm ring-1 ring-border/40 hover:bg-background'
                : 'min-h-11 min-w-28 rounded-xl text-text-secondary'
            }
            data-testid={`wiki-workspace-tab-${value}`}
            onClick={() => chooseSection(value)}
            onKeyDown={event => {
              const index = sections.indexOf(value)
              const next =
                event.key === 'ArrowRight'
                  ? sections[(index + 1) % sections.length]
                  : event.key === 'ArrowLeft'
                    ? sections[(index + sections.length - 1) % sections.length]
                    : event.key === 'Home'
                      ? sections[0]
                      : event.key === 'End'
                        ? sections.at(-1)
                        : undefined
              if (next) {
                event.preventDefault()
                chooseSection(next)
                document.getElementById(`wiki-workspace-tab-${next}`)?.focus()
              }
            }}
          >
            {t(`workspaceSections.${value}`)}
          </Button>
        ))}
      </nav>
      {serverId ? (
        <>
          {sections
            .filter(value => value === section || openedSections.includes(value))
            .map(value => (
              <div
                key={`${owner}:${value}`}
                id={`wiki-workspace-panel-${value}`}
                role="tabpanel"
                aria-labelledby={`wiki-workspace-tab-${value}`}
                hidden={section !== value}
                className={section === value ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}
              >
                {value === 'library' ? (
                  <KnowledgeLibrary serverId={serverId} isCurrent={scope.isCurrent} />
                ) : (
                  <WikiManagedKnowledge
                    serverId={serverId}
                    workspacePath={workspacePath}
                    section={value}
                  />
                )}
              </div>
            ))}
        </>
      ) : (
        <p>{t('targetRequired')}</p>
      )}
    </main>
  )
}

function KnowledgeLibrary({ serverId, isCurrent }: { serverId: string; isCurrent: () => boolean }) {
  const { t } = useTranslation('knowledge')
  const [retrievalEnabled, setRetrievalEnabled] = useState(false)
  const [organizationEnabled, setOrganizationEnabled] = useState(false)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [libraries, setLibraries] = useState<WikiLibrary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [busy, setBusy] = useState(true)
  const [next, setNext] = useState<string | null>(null)
  const revision = useRef(0)
  const markdownPicker = useRef<HTMLInputElement>(null)
  const [contentRevision, setContentRevision] = useState(0)
  const [archiveMode, setArchiveMode] = useState<'export' | 'import' | null>(null)
  const menu = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (
        menu.current?.open &&
        event.target instanceof Node &&
        !menu.current.contains(event.target)
      )
        menu.current.open = false
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menu.current?.open) {
        menu.current.open = false
        menu.current.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [])
  const [creating, setCreating] = useState(false)
  const reload = useCallback(async () => {
    const attempt = ++revision.current
    setBusy(true)
    try {
      const status = await knowledgeApi.status(serverId)
      if (!isCurrent() || attempt !== revision.current) return
      setError('')
      setEnabled(status.enabled)
      setRetrievalEnabled(status.retrievalEnabled ?? status.enabled)
      setOrganizationEnabled(status.organizationEnabled ?? status.enabled)
      if (status.enabled) {
        const [list, selection] = await Promise.all([
          knowledgeApi.libraries(serverId),
          knowledgeApi.defaultLibrary(serverId),
        ])
        if (selection.libraryId && !list.items.some(item => item.id === selection.libraryId)) {
          list.items.unshift(await knowledgeApi.library(serverId, selection.libraryId))
        }
        if (!isCurrent() || attempt !== revision.current) return
        setLibraries(list.items)
        setNext(list.nextAfterId ?? null)
        setSelected(current =>
          selection.libraryId && list.items.some(item => item.id === selection.libraryId)
            ? selection.libraryId
            : list.items.some(item => item.id === current)
              ? current
              : (list.items[0]?.id ?? null)
        )
      } else {
        setLibraries([])
        setSelected(null)
        setNext(null)
      }
    } catch (cause) {
      if (isCurrent() && attempt === revision.current)
        setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      if (isCurrent() && attempt === revision.current) setBusy(false)
    }
  }, [serverId, isCurrent])
  useEffect(() => {
    const lifetime = revision
    let active = true
    queueMicrotask(() => {
      if (active) void reload()
    })
    return () => {
      active = false
      ++lifetime.current
    }
  }, [reload])
  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    ++revision.current
    try {
      await operation()
      if (isCurrent()) await reload()
    } catch (cause) {
      if (isCurrent()) {
        setError(String(cause instanceof Error ? cause.message : cause))
        setBusy(false)
      }
    }
  }
  const libraryToolbar = (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {libraries.length > 0 ? (
        <SettingsSelect
          density="compact"
          className="max-w-full"
          icon={<BookOpen />}
          data-testid="knowledge-library-picker"
          aria-label={t('selectLibrary')}
          value={selected ?? ''}
          disabled={busy}
          onChange={event => {
            const library = libraries.find(item => item.id === event.target.value)!
            if (library.archived) setSelected(library.id)
            else void mutate(() => knowledgeApi.selectLibrary(serverId, library.id))
          }}
        >
          {libraries.map(library => (
            <option key={library.id} value={library.id}>
              {library.name}
              {library.archived ? ` · ${t('archived')}` : ''}
            </option>
          ))}
        </SettingsSelect>
      ) : (
        <span className="sr-only">{libraries.find(item => item.id === selected)?.name}</span>
      )}
      {libraries.find(library => library.id === selected) && (
        <details ref={menu} className="relative">
          <summary
            aria-label={t('wikiActions')}
            data-testid="knowledge-library-actions"
            className="flex size-10 cursor-pointer list-none items-center justify-center rounded-xl border border-border/60 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11 max-md:min-w-11"
          >
            <MoreHorizontal className="size-4" />
          </summary>
          <div
            onClick={event => {
              if (
                event.target instanceof Element &&
                event.target.closest('button') &&
                menu.current
              ) {
                menu.current.open = false
                menu.current.querySelector('summary')?.focus()
              }
            }}
            className="absolute right-0 top-11 z-20 max-h-[60vh] w-56 overflow-y-auto rounded-xl border border-border/60 bg-background p-1.5 shadow-lg"
          >
            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-start"
              disabled={busy}
              data-testid="wiki-archive-export"
              onClick={() => setArchiveMode('export')}
            >
              <Download />
              {t('exportArchive')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-start"
              disabled={busy || !organizationEnabled}
              onClick={() => {
                if (organizationEnabled) setArchiveMode('import')
              }}
              data-testid="wiki-archive-import"
            >
              <Upload />
              {t('importArchive')}
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-start"
              disabled={busy}
              onClick={() =>
                void mutate(async () => {
                  const bundle = await knowledgeApi.exportArchive(
                    serverId,
                    selected!,
                    isCurrent,
                    true
                  )
                  const blob = await exportMarkdownZip(bundle)
                  if (!isCurrent()) return
                  const url = URL.createObjectURL(blob)
                  const link = document.createElement('a')
                  link.href = url
                  link.download = 'wiki-markdown.zip'
                  downloadLink(link)
                  setTimeout(() => URL.revokeObjectURL(url), 1000)
                })
              }
            >
              <Download />
              {t('exportMarkdown')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-start"
              disabled={
                busy ||
                !organizationEnabled ||
                libraries.find(item => item.id === selected)?.archived
              }
              onClick={() => {
                if (organizationEnabled) markdownPicker.current?.click()
              }}
            >
              <Upload />
              {t('importMarkdown')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-start"
              data-testid="wiki-rename"
              disabled={busy || !organizationEnabled}
              onClick={() => setRenaming(true)}
            >
              <Pencil />
              {t('renameWiki')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-start"
              disabled={busy || !organizationEnabled}
              onClick={() => void mutate(() => knowledgeApi.reindex(serverId, selected!))}
            >
              <RefreshCw />
              {t('rebuildIndex')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-start"
              data-testid="wiki-archive"
              disabled={busy || !organizationEnabled}
              onClick={() => {
                const library = libraries.find(item => item.id === selected)!
                void mutate(() => knowledgeApi.archive(serverId, library, !library.archived))
              }}
            >
              {libraries.find(item => item.id === selected)?.archived ? (
                <ArchiveRestore />
              ) : (
                <Archive />
              )}
              {t(
                libraries.find(item => item.id === selected)?.archived
                  ? 'restoreWiki'
                  : 'archiveWiki'
              )}
            </Button>
          </div>
        </details>
      )}
      <Button
        size="sm"
        className="max-md:min-h-11"
        data-testid="knowledge-create"
        disabled={busy || !organizationEnabled}
        onClick={() => setCreating(true)}
      >
        <Plus />
        {t('create')}
      </Button>
      {!libraries.length && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !organizationEnabled}
          onClick={() => {
            if (organizationEnabled) setArchiveMode('import')
          }}
          data-testid="wiki-archive-import"
        >
          <Upload />
          {t('importArchive')}
        </Button>
      )}
      {next && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void knowledgeApi
              .libraries(serverId, next)
              .then(list => {
                if (isCurrent()) {
                  setLibraries(current =>
                    Array.from(
                      new Map([...current, ...list.items].map(item => [item.id, item])).values()
                    )
                  )
                  setNext(list.nextAfterId ?? null)
                }
              })
              .catch(cause => {
                if (isCurrent()) setError(String(cause instanceof Error ? cause.message : cause))
              })
              .finally(() => {
                if (isCurrent()) setBusy(false)
              })
          }}
        >
          {t('more')}
        </Button>
      )}
    </div>
  )
  return (
    <div
      data-testid="knowledge-scroll"
      className="studio-page-gutter min-h-0 flex-1 overflow-y-auto py-5"
    >
      <PageContent data-testid="knowledge-content" className="flex flex-col">
        <section
          data-testid="knowledge-space-hero"
          className="studio-card-spacing mb-4 grid shrink-0 gap-6 rounded-2xl border border-border/70 bg-background lg:grid-cols-2"
        >
          <div className="studio-card-inset flex min-w-0 items-center gap-6 rounded-xl bg-surface/60">
            <span
              aria-hidden="true"
              className="flex size-32 shrink-0 items-center justify-center rounded-3xl bg-muted/70 text-text-primary max-sm:size-20"
            >
              <BookOpen className="size-24 max-sm:size-14" strokeWidth={1.4} />
            </span>
            <div className="min-w-0">
              <h2 className="heading-lg font-semibold tracking-tight">{t('yourWikis')}</h2>
              <p className="mt-3 text-base leading-relaxed text-text-secondary">{t('spaceHint')}</p>
            </div>
          </div>
          <div className="flex min-w-0 items-center py-3">
            <div className="min-w-0 flex-1 space-y-5">
              <div className="flex items-start justify-between gap-5">
                <div>
                  <p className="text-base font-medium">{t('retrieval')}</p>
                  <p
                    id="wiki-retrieval-help"
                    className="mt-1 text-sm leading-relaxed text-text-secondary"
                  >
                    {t('retrievalDescription')}
                  </p>
                </div>
                <Switch
                  size="sm"
                  className="data-[state=checked]:bg-text-primary [&>span]:bg-background"
                  data-testid="knowledge-retrieval-enabled"
                  aria-label={t('retrievalToggle')}
                  aria-describedby="wiki-retrieval-help"
                  checked={retrievalEnabled}
                  disabled={busy || enabled === null}
                  onCheckedChange={value =>
                    void mutate(() =>
                      knowledgeApi.configureMode(serverId, 'retrievalEnabled', value)
                    )
                  }
                />
              </div>
              <div className="flex items-start justify-between gap-5">
                <div>
                  <p className="text-base font-medium">{t('organization')}</p>
                  <p
                    id="wiki-organization-help"
                    className="mt-1 text-sm leading-relaxed text-text-secondary"
                  >
                    {t('organizationDescription')}
                  </p>
                </div>
                <Switch
                  size="sm"
                  className="data-[state=checked]:bg-text-primary [&>span]:bg-background"
                  data-testid="knowledge-organization-enabled"
                  aria-label={t('organizationToggle')}
                  aria-describedby="wiki-organization-help"
                  checked={organizationEnabled}
                  disabled={busy || enabled === null}
                  onCheckedChange={value =>
                    void mutate(() =>
                      knowledgeApi.configureMode(serverId, 'organizationEnabled', value)
                    )
                  }
                />
              </div>
            </div>
          </div>
        </section>
        {error && <WikiError error={error} onReload={() => void reload()} reloading={busy} />}
        {creating && (
          <WikiLibraryCreate
            serverId={serverId}
            isCurrent={isCurrent}
            onClose={() => setCreating(false)}
            onCreated={() => {
              setCreating(false)
              setBusy(true)
              void reload()
            }}
          />
        )}
        {enabled === false && (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto pb-12 text-center">
            <div className="mb-7 flex size-16 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-surface/50 text-text-secondary shadow-sm">
              <LibraryBig className="size-7" strokeWidth={1.4} />
            </div>
            <h2 className="heading-base">{t('welcomeTitle')}</h2>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-text-secondary">
              {t('enableHint')}
            </p>
            <Button
              className="mt-7 min-h-11 px-6"
              data-testid="knowledge-enable"
              disabled={busy}
              onClick={() => void mutate(() => knowledgeApi.configure(serverId, true))}
            >
              {t('enable')}
            </Button>
            <p className="mt-4 max-w-sm text-xs leading-relaxed text-text-muted">
              {t('disabledHint')}
            </p>
          </div>
        )}
        <input
          ref={markdownPicker}
          type="file"
          accept=".zip"
          className="hidden"
          aria-label={t('importMarkdown')}
          onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (!file || !selected) return
            void mutate(async () => {
              const bundle = await importMarkdownZip(file)
              if (!isCurrent()) return
              await knowledgeApi.importMarkdown(serverId, selected, bundle, isCurrent)
              if (isCurrent()) setContentRevision(value => value + 1)
            })
          }}
        />
        {enabled && (
          <>
            {(!selected || libraries.find(item => item.id === selected)?.archived) &&
              libraryToolbar}
            {libraries.find(item => item.id === selected)?.archived ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center text-text-secondary">
                <Archive className="size-8" />
                <p>{t('archiveHint')}</p>
                <Button
                  variant="outline"
                  disabled={busy || !organizationEnabled}
                  onClick={() =>
                    void mutate(() =>
                      knowledgeApi.archive(
                        serverId,
                        libraries.find(item => item.id === selected)!,
                        false
                      )
                    )
                  }
                >
                  {t('restoreWiki')}
                </Button>
              </div>
            ) : !selected ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 pb-12 text-center">
                <BookOpen className="mb-2 size-8 text-text-muted" strokeWidth={1.25} />
                <h3 className="heading-base">{t('emptyTitle')}</h3>
                <p className="max-w-sm text-sm leading-relaxed text-text-secondary">{t('empty')}</p>
              </div>
            ) : (
              <KnowledgeContents
                key={`${selected}:${contentRevision}`}
                libraryId={selected}
                serverId={serverId}
                isCurrent={isCurrent}
                actions={libraryToolbar}
                canRetrieve={retrievalEnabled}
                canOrganize={organizationEnabled}
              />
            )}
          </>
        )}
        {archiveMode && (archiveMode === 'import' || selected) && (
          <WikiArchiveTransfer
            serverId={serverId}
            libraryId={selected ?? undefined}
            mode={archiveMode}
            isCurrent={isCurrent}
            onClose={() => setArchiveMode(null)}
            onImported={library => {
              setLibraries(current => [library, ...current.filter(item => item.id !== library.id)])
              // Importing a backup does not silently replace the target's existing default Wiki.
              setSelected(current => current ?? library.id)
            }}
          />
        )}
        {renaming && libraries.find(library => library.id === selected) && (
          <WikiLibraryRename
            library={libraries.find(library => library.id === selected)!}
            serverId={serverId}
            isCurrent={isCurrent}
            onClose={() => setRenaming(false)}
            onSaved={value =>
              setLibraries(current =>
                current.map(library => (library.id === value.id ? value : library))
              )
            }
          />
        )}
      </PageContent>
    </div>
  )
}
