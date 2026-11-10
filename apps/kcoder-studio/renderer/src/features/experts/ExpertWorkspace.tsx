import { expertPersonalizationRoute } from './personalizationRoutes'
import { Button as WorkbenchButton } from '@/components/ui/button'
import { navigateTo } from '@/lib/navigation'
import { expertConversationRoute } from './conversationRoutes'
import { ExpertTaskHistory } from './ExpertTaskHistory'
// Presentation adapted from Octop Experts; MIT, renderer/third_party/octop/LICENSE.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { stripAppBasePath } from '@/config/runtime'
import {
  Alert,
  Button,
  Drawer,
  Input,
  Segmented,
  Select,
  Spin,
  Table,
  Tabs,
  Tag,
  Tooltip,
} from 'antd'
import {
  BookOpen,
  Bot,
  Copy,
  Download,
  FileText,
  GraduationCap,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Store,
  Users,
  Zap,
  Activity,
  TrendingUp,
  Wrench,
  Server,
  Terminal,
  Video,
  Globe,
  ListTodo,
  Presentation,
  Sparkles,
  MessageSquare,
  type LucideIcon,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from '@/hooks/useTranslation'
import { createRandomUuid } from '@/lib/random-id'
import {
  OfficeClientError,
  type OfficeAssistantItem,
} from '@/features/office-integration/controller'
import type {
  OfficeAssistantDefinition,
  OfficeAssistantVersion,
  OfficeExpertPackage,
  OfficeMarketExpert,
} from '../../../../shared/generated/contracts'
import { isContract } from '../../../../shared/generated/validator.mjs'
import { ExpertClient, newExpert, newExpertFromTemplate } from './client'
import { useExpertCatalog, type ExpertTab } from './useExpertCatalog'
import { ExpertLoading } from './ExpertLoading'
import {
  annotations,
  updateAnnotations,
  expertPresentation,
  marketPresentation,
  withPresentation,
  expertAvatar,
} from './presentation'
import styles from '@/features/octop/experts.module.css'
import { PersonalExpertCard } from './PersonalExpertCard'
import { ExpertEditor } from './ExpertEditor'
import { EmptyGuide } from '@/features/octop/EmptyGuide'
import { marketQuickPrompts } from '@/features/octop/marketWorkflow'
import {
  splitMarkdownFrontmatter,
  parseWorkflowFrontmatterMeta,
} from '@/features/octop/workflowMarkdown'

const promptIcons: Record<string, LucideIcon> = {
  activity: Activity,
  'trending-up': TrendingUp,
  wrench: Wrench,
  server: Server,
  terminal: Terminal,
  video: Video,
  globe: Globe,
  'list-todo': ListTodo,
  presentation: Presentation,
  sparkles: Sparkles,
  'message-square': MessageSquare,
  'file-text': FileText,
  'book-open': BookOpen,
  zap: Zap,
}

const portraits = import.meta.glob('../octop/assets/*.avif', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>

function expertTabFromLocation(): ExpertTab {
  const value = new URLSearchParams(window.location.search).get('tab')
  return ['mine', 'teams', 'library', 'market'].includes(value ?? '') ? (value as ExpertTab) : 'mine'
}

export function ExpertWorkspace({ client }: { client: ExpertClient }) {
  const { t, i18n } = useTranslation('experts')
  const language = i18n.language.startsWith('zh') ? 'zh-CN' : 'en'
  const [tab, setTab] = useState<ExpertTab>(expertTabFromLocation)
  useLayoutEffect(() => {
    const syncTab = () => {
      if (stripAppBasePath(window.location.pathname) === '/experts') setTab(expertTabFromLocation())
    }
    // Retained pages run their effects again when shown; a plain entry opens My experts.
    syncTab()
    window.addEventListener('popstate', syncTab)
    return () => window.removeEventListener('popstate', syncTab)
  }, [])
  const [scene, setScene] = useState('')
  const [queries, setQueries] = useState<Record<ExpertTab, string>>({
    mine: '',
    teams: '',
    library: '',
    market: '',
  })
  const query = queries[tab]
  const catalog = useExpertCatalog(client, language, tab, query, scene)
  const { items, library, market, scenes } = catalog
  const [view, setView] = useState<'card' | 'table'>('card')
  const [selected, setSelected] = useState<OfficeAssistantItem | null>(null)
  const [editing, setEditing] = useState<OfficeAssistantDefinition | null>(null)
  const [copyFrom, setCopyFrom] = useState<{ id: string; revision: string }>()
  const [marketDetail, setMarketDetail] = useState<OfficeMarketExpert | null>(null)
  const [marketContent, setMarketContent] = useState('')
  const workflowDocument = splitMarkdownFrontmatter(marketContent)
  const workflowMeta = parseWorkflowFrontmatterMeta(workflowDocument.raw)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(false)
  const [source, setSource] = useState<OfficeMarketExpert | null>(null)
  const [filesOpen, setFilesOpen] = useState(false)
  const [fileEdit, setFileEdit] = useState(false)
  const [readFile, setReadFile] = useState<{ path: string; content: string } | null>(null)
  const [versions, setVersions] = useState<OfficeAssistantVersion[]>([])
  const [versionCursor, setVersionCursor] = useState<string | null>(null)
  const [versionName, setVersionName] = useState('1.0.0')
  const [packageInfo, setPackageInfo] = useState<OfficeExpertPackage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(() => client.pending())
  const lifetime = useRef<AbortController | null>(null)
  const lock = useRef(false)
  useEffect(() => {
    const owner = new AbortController()
    lifetime.current = owner
    return () => {
      owner.abort()
      lifetime.current = null
    }
  }, [client])
  useEffect(() => {
    if (!marketDetail) return
    const request = new AbortController()
    const lifetimeSignal = lifetime.current?.signal
    if (!lifetimeSignal) return
    const signal = AbortSignal.any([request.signal, lifetimeSignal])
    queueMicrotask(() => {
      if (signal.aborted) return
      setDetailLoading(true)
      setDetailError(false)
      setMarketContent('')
      void client.controller
        .call<{ item: OfficeMarketExpert; content: string }>(
          'assistant/market/read',
          { slug: marketDetail.slug, language },
          undefined,
          signal
        )
        .then(result => {
          if (signal.aborted) return
          if (!isContract('OfficeMarketExpertDetail', result))
            throw new Error('OFFICE_INVALID_REPLY')
          setMarketContent(result.content)
        })
        .catch(() => {
          if (!signal.aborted) setDetailError(true)
        })
        .finally(() => {
          if (!signal.aborted) setDetailLoading(false)
        })
    })
    return () => request.abort()
  }, [client, marketDetail, language])
  const act = async (work: (signal: AbortSignal) => Promise<void>) => {
    const owner = lifetime.current
    if (lock.current || !owner || owner.signal.aborted) return
    lock.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work(owner.signal)
    } catch (error) {
      if (!owner.signal.aborted)
        setError(
          error instanceof OfficeClientError ? `${t('failed')} (${error.code})` : t('failed')
        )
    } finally {
      lock.current = false
      if (!owner.signal.aborted) {
        setBusy(false)
        setPending(client.pending())
      }
    }
  }
  const readDetails = async (item: OfficeAssistantItem, signal: AbortSignal) => {
    const [versions, assets] = await Promise.all([
      client.controller.call<{ items: OfficeAssistantVersion[]; nextCursor: string | null }>(
        'assistant/versions',
        { id: item.definition.id, limit: 10 },
        undefined,
        signal
      ),
      client.package(item.definition.id, signal),
    ])
    signal.throwIfAborted()
    setVersions(versions.items)
    setVersionCursor(versions.nextCursor)
    setPackageInfo(assets)
  }
  const edit = (item: OfficeAssistantItem, files = false) =>
    void act(async signal => {
      setCopyFrom(undefined)
      setSource(null)
      setSelected(item)
      setEditing(structuredClone(item.definition))
      setFilesOpen(files)
      setVersions([])
      setPackageInfo(null)
      await readDetails(item, signal)
    })
  const close = () => {
    if (busy) return
    setSelected(null)
    setEditing(null)
    setSource(null)
    setCopyFrom(undefined)
    setFilesOpen(false)
    setFileEdit(false)
  }
  const save = () => {
    if (!editing || !editing.title.trim()) return
    const definition = editing
    if (new TextEncoder().encode(JSON.stringify(definition.inputSchema)).byteLength > 16 * 1024) {
      setError(t('settingsTooLarge'))
      return
    }
    const customId = annotations(definition).customId
    if (
      !selected &&
      typeof customId === 'string' &&
      customId &&
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,62}[a-zA-Z0-9]$/.test(customId)
    ) {
      setError(t('customIdInvalid'))
      return
    }
    if (
      expertPresentation(definition).kind === 'team' &&
      expertPresentation(definition).members.length < 2
    ) {
      setError(t('teams.membersMin'))
      return
    }
    void act(async signal => {
      let saved
      if (source) {
        const result = await client.mutate(
          'assistant/market/install',
          { id: definition.id, slug: source.slug, language },
          signal
        )
        signal.throwIfAborted()
        if (!isContract('OfficeAssistantDraft', result.draft))
          throw new Error('OFFICE_INVALID_REPLY')
        const installed = result.draft as {
          definition: OfficeAssistantDefinition
          revision: number
        }
        setSource(null)
        setSelected({
          definition: installed.definition,
          draftRevision: installed.revision,
          builtin: false,
        })
        saved = await client.save(
          {
            ...installed.definition,
            title: definition.title,
            description: definition.description,
            inputSchema: definition.inputSchema,
            ...(definition.instructions.trim() ? { instructions: definition.instructions } : {}),
          },
          installed.revision,
          signal
        )
      } else
        saved = await client.save(
          definition,
          selected?.definition.id === definition.id ? selected.draftRevision : undefined,
          signal,
          copyFrom
        )
      signal.throwIfAborted()
      setSource(null)
      setCopyFrom(undefined)
      const item = { definition: saved.definition, draftRevision: saved.revision, builtin: false }
      setSelected(item)
      setEditing(structuredClone(item.definition))
      setNotice(t('saved'))
      await Promise.all([readDetails(item, signal), catalog.refreshPersonal(signal)])
    })
  }
  const create = (team = false) => {
    setSelected(null)
    setSource(null)
    setCopyFrom(undefined)
    setFilesOpen(false)
    setEditing(
      updateAnnotations(
        withPresentation(
          {
            ...newExpert(language),
            title: t(team ? 'teams.defaultName' : 'genericName'),
            description: team ? '' : t('genericDescription'),
          },
          { kind: team ? 'team' : 'expert', color: '#6c757d' }
        ),
        { welcome: t('defaultWelcome'), avatarPreset: team ? null : 'generic' }
      )
    )
  }
  const copy = () => {
    if (!editing || !selected) return
    setCopyFrom({ id: selected.definition.id, revision: String(selected.draftRevision) })
    setEditing(
      updateAnnotations(
        {
          ...editing,
          id: `personal.${createRandomUuid()}`,
          title: `${editing.title} ${t('copySuffix')}`,
        },
        { customId: '' }
      )
    )
    setSelected(null)
    setVersions([])
    setPackageInfo(null)
  }
  const remove = (item: OfficeAssistantItem) =>
    void act(async signal => {
      await client.mutate(
        'assistant/deleteDraft',
        { id: item.definition.id },
        signal,
        item.draftRevision
      )
      signal.throwIfAborted()
      setEditing(null)
      setSelected(null)
      await catalog.refreshPersonal(signal)
    })
  const install = (item: OfficeMarketExpert) => {
    setMarketDetail(null)
    setSelected(null)
    setCopyFrom(undefined)
    setSource(item)
    setFilesOpen(false)
    const presentation = marketPresentation(item, language)
    setEditing(
      withPresentation(
        { ...newExpert(language), title: presentation.title, description: item.description },
        { color: presentation.color }
      )
    )
  }
  const template = (item: OfficeAssistantItem) => {
    if (busy || pending) return
    if (item.definition.id.startsWith('builtin.octop.') && !item.version) {
      setError(t('failed'))
      return
    }
    setSelected(null)
    setSource(null)
    setCopyFrom(
      item.definition.id.startsWith('builtin.octop.')
        ? {
            id: item.definition.id,
            revision: String(item.version),
          }
        : undefined
    )
    setVersions([])
    setPackageInfo(null)
    setEditing(newExpertFromTemplate(item.definition))
    if (item.definition.id.startsWith('builtin.octop.'))
      void act(async signal => {
        const assets = await client.package(item.definition.id, signal)
        signal.throwIfAborted()
        setPackageInfo(assets)
      })
  }
  const patch = (value: Partial<OfficeAssistantDefinition>) =>
    setEditing(old => (old ? { ...old, ...value } : old))
  const octopLibrary = library
    .filter(item => annotations(item.definition).catalogue === 'octop')
    .sort((a, b) => Number(annotations(a.definition).rank) - Number(annotations(b.definition).rank))
  const filtered = (
    tab === 'library' ? (octopLibrary.length ? octopLibrary : library) : items
  ).filter(
    item =>
      (tab === 'library' ||
        expertPresentation(item.definition).kind === (tab === 'teams' ? 'team' : 'expert')) &&
      `${item.definition.title} ${item.definition.description}`
        .toLowerCase()
        .includes(query.toLowerCase())
  )
  const changeTab = (key: string) => {
    const url = new URL(window.location.href)
    if (key === 'mine') url.searchParams.delete('tab')
    else url.searchParams.set('tab', key)
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    setTab(key as ExpertTab)
    setError('')
    setNotice('')
  }
  const toolbar = (
    <div className={styles.gridToolbar}>
      <span className={styles.gridCount}>
        {t(
          tab === 'market'
            ? 'totalMarket'
            : tab === 'teams'
              ? 'teams.total'
              : tab === 'library'
                ? 'totalLibrary'
                : 'totalAgents',
          { count: tab === 'market' ? market.length : filtered.length }
        )}
      </span>
      <div
        className={`${styles.gridToolbarRight} ${tab === 'market' ? styles.marketToolbarRight : ''}`}
      >
        <Input
          type="search"
          aria-label={t(tab === 'market' ? 'marketSearch' : 'search')}
          className={tab === 'market' ? styles.marketSearch : styles.toolbarSearch}
          prefix={<Search size={14} />}
          allowClear
          value={query}
          placeholder={t(tab === 'market' ? 'marketSearch' : 'search')}
          onChange={e => setQueries(previous => ({ ...previous, [tab]: e.target.value }))}
        />
        {['mine', 'teams'].includes(tab) && (
          <Segmented
            size="small"
            value={view}
            onChange={v => setView(v as 'card' | 'table')}
            options={[
              {
                value: 'card',
                label: (
                  <span className={styles.viewModeLabel}>
                    <LayoutGrid size={14} />
                    {t('viewCard')}
                  </span>
                ),
              },
              {
                value: 'table',
                label: (
                  <span className={styles.viewModeLabel}>
                    <List size={14} />
                    {t('viewTable')}
                  </span>
                ),
              },
            ]}
          />
        )}
        <Tooltip title={t('refresh')}>
          <WorkbenchButton
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            type="button"
            disabled={busy || catalog.refreshing}
            aria-label={t('refresh')}
            onClick={() => void catalog.refresh(lifetime.current?.signal).catch(() => undefined)}
          >
            <RefreshCw size={14} className={catalog.refreshing ? styles.spinning : undefined} />
          </WorkbenchButton>
        </Tooltip>
        {['mine', 'teams'].includes(tab) && (
          <WorkbenchButton
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => create(tab === 'teams')}
          >
            <Plus size={14} />
            {t(tab === 'teams' ? 'teams.create' : 'create')}
          </WorkbenchButton>
        )}
        {tab === 'mine' && (
          <WorkbenchButton
            type="button"
            variant="outline"
            size="sm"
            onClick={() => changeTab('library')}
          >
            {t('addFromLibrary')}
          </WorkbenchButton>
        )}
      </div>
    </div>
  )
  const empty = (
    <EmptyGuide
      team={tab === 'teams'}
      onCreate={() => create(tab === 'teams')}
      onLibrary={() => changeTab('library')}
      disabled={
        busy ||
        (tab === 'teams' &&
          items.filter(item => expertPresentation(item.definition).kind === 'expert').length < 2)
      }
    />
  )
  const cards =
    tab === 'market' ? (
      <div className={styles.cardGrid}>
        {market.map(item => {
          const meta = marketPresentation(item, language)
          const image = portraits[`../octop/assets/${item.slug}.avif`]
          return (
            <div
              key={item.slug}
              className={styles.expertTemplateCard}
              style={{ '--expert-accent': meta.color } as CSSProperties}
              role="button"
              tabIndex={0}
              onKeyDown={e => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  setMarketDetail(item)
                }
              }}
              onClick={() => setMarketDetail(item)}
            >
              <div className={styles.marketCardHeader}>
                <div
                  className={styles.agentCardIcon}
                  style={{ color: meta.color, background: `${meta.color}18` }}
                >
                  {image ? (
                    <img className={styles.marketIconImg} src={image} alt="" />
                  ) : (
                    <Zap size={20} />
                  )}
                </div>
                <div className={styles.agentCardTitleBlock}>
                  <h2 className={styles.agentCardName}>{meta.title}</h2>
                </div>
              </div>
              <div className={styles.agentCardDesc}>{item.description}</div>
              <div className={styles.marketCardFooter}>
                <span className={styles.marketMeta}>
                  <Zap size={13} />
                  {t('skillsCount', { count: item.skillSlugs.length })}
                </span>
                <Button
                  type="primary"
                  size="small"
                  icon={<Download size={14} />}
                  disabled={busy || !!pending}
                  onClick={e => {
                    e.stopPropagation()
                    install(item)
                  }}
                >
                  {t('createFromMarket')}
                </Button>
              </div>
            </div>
          )
        })}
      </div>
    ) : tab === 'library' ? (
      <>
        <p className="octop-library-hint">{t('libraryHint')}</p>
        <div className={styles.cardGrid}>
          {filtered.map(item => (
            <div
              key={item.definition.id}
              className={styles.expertTemplateCard}
              style={
                {
                  '--expert-accent': expertPresentation(item.definition).color,
                } as React.CSSProperties
              }
              role="button"
              tabIndex={0}
              onClick={() => template(item)}
              onKeyDown={e => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  template(item)
                }
              }}
            >
              <div className={styles.expertTemplateHeader}>
                <div
                  className={`${styles.agentCardIcon} ${expertAvatar(item.definition) ? styles.agentCardPortrait : ''}`}
                >
                  {expertAvatar(item.definition) ? (
                    <img src={expertAvatar(item.definition)} width={44} height={44} alt="" />
                  ) : (
                    <Bot size={22} />
                  )}
                </div>
                <div className={styles.agentCardTitleBlock}>
                  <div className={styles.agentCardName}>{item.definition.title}</div>
                </div>
              </div>
              <div className={styles.agentCardDesc}>{item.definition.description}</div>
              <div className={styles.expertCardFooter}>
                <span className={styles.expertCardHint}>{t('createFromTemplate')}</span>
              </div>
            </div>
          ))}
        </div>
      </>
    ) : view === 'card' ? (
      <div className={styles.cardGrid}>
        {filtered.map(item => (
          <PersonalExpertCard
            key={item.definition.id}
            item={item}
            busy={busy}
            pending={!!pending}
            onUse={item => {
              if (!client.target?.workspacePath) return
              navigateTo(
                expertConversationRoute({
                  deviceId: client.target.serverId,
                  workspacePath: client.target.workspacePath,
                  expertId: item.definition.id,
                })
              )
            }}
            onPersonalize={item => {
              if (!client.target?.workspacePath) return
              navigateTo(
                expertPersonalizationRoute({
                  deviceId: client.target.serverId,
                  workspacePath: client.target.workspacePath,
                  expertId: item.definition.id,
                })
              )
            }}
            onEdit={edit}
            onRefresh={() =>
              void catalog.refreshPersonal(lifetime.current?.signal).catch(() => undefined)
            }
            onRemove={remove}
            onToggle={(item, enabled) =>
              void act(async signal => {
                await client.save(
                  withPresentation(item.definition, { enabled }),
                  item.draftRevision,
                  signal
                )
                await catalog.refreshPersonal(signal)
              })
            }
            onCopy={item =>
              void act(async signal => {
                setSource(null)
                setSelected(null)
                setCopyFrom({ id: item.definition.id, revision: String(item.draftRevision) })
                setEditing(
                  updateAnnotations(
                    {
                      ...structuredClone(item.definition),
                      id: `personal.${createRandomUuid()}`,
                      title: `${item.definition.title} ${t('copySuffix')}`,
                    },
                    { customId: '' }
                  )
                )
                setVersions([])
                setPackageInfo(null)
                signal.throwIfAborted()
              })
            }
          />
        ))}
      </div>
    ) : (
      <Table
        rowKey={item => item.definition.id}
        dataSource={filtered}
        pagination={{ pageSize: 10 }}
        scroll={{ x: 680 }}
        columns={[
          {
            title: t('name'),
            render: (_, item) => (
              <button onClick={() => edit(item)}>{item.definition.title}</button>
            ),
          },
          { title: t('expertId'), render: (_, item) => item.definition.id },
          { title: t('summary'), render: (_, item) => item.definition.description },
          {
            title: t('actions'),
            render: (_, item) => (
              <Button icon={<Pencil size={14} />} onClick={() => edit(item)}>
                {t('edit')}
              </Button>
            ),
          },
        ]}
      />
    )
  const body = (
    <div
      data-testid="expert-catalog-content"
      aria-busy={catalog.initialLoading || catalog.refreshing}
    >
      {toolbar}
      {tab === 'market' && !query && scenes.length > 0 && (
        <div className={styles.marketSceneTabsWrap}>
          <Segmented
            className={styles.marketSceneTabs}
            block
            size="large"
            value={scene}
            onChange={v => setScene(String(v))}
            options={[
              { value: '', label: t('allScenes') },
              ...scenes.map(value => ({
                value,
                label: t(`scenes.${value}`, { defaultValue: value }),
              })),
            ]}
          />
        </div>
      )}
      {catalog.initialLoading ? (
        <ExpertLoading />
      ) : !query && ['mine', 'teams'].includes(tab) && filtered.length === 0 ? (
        empty
      ) : (
        cards
      )}
    </div>
  )
  return (
    <section className="octop-fill-tabs" data-testid="expert-workspace">
      {pending && (
        <Alert
          className="octop-notice"
          type="warning"
          message={t('pending')}
          action={
            <Button
              disabled={busy}
              onClick={() =>
                void act(async signal => {
                  await client.reconcile(signal)
                  await catalog.refreshPersonal(signal)
                  if (tab === 'library' || tab === 'market') await catalog.refresh(signal)
                })
              }
            >
              {t('reconcile')}
            </Button>
          }
        />
      )}
      {catalog.error && (
        <Alert
          className="octop-notice"
          type="error"
          message={t('failed')}
          action={
            <Button
              disabled={catalog.refreshing || busy}
              onClick={() => void catalog.refresh(lifetime.current?.signal).catch(() => undefined)}
            >
              {t('refresh')}
            </Button>
          }
        />
      )}
      {error && (
        <Alert
          className="octop-notice"
          type="error"
          message={error}
          closable
          onClose={() => setError('')}
        />
      )}
      {notice && (
        <Alert
          className="octop-notice"
          type="success"
          message={notice}
          closable
          onClose={() => setNotice('')}
        />
      )}
      <Tabs
        activeKey={tab}
        onChange={changeTab}
        items={[
          {
            key: 'mine',
            label: (
              <span className="octop-tab-label">
                <GraduationCap size={16} />
                {t('mine')}
              </span>
            ),
            children: tab === 'mine' ? body : null,
          },
          {
            key: 'teams',
            label: (
              <span className="octop-tab-label">
                <Users size={16} />
                {t('teams.title')}
              </span>
            ),
            children: tab === 'teams' ? body : null,
          },
          {
            key: 'library',
            label: (
              <span className="octop-tab-label">
                <BookOpen size={16} />
                {t('library')}
              </span>
            ),
            children: tab === 'library' ? body : null,
          },
          {
            key: 'market',
            label: (
              <span className="octop-tab-label">
                <Store size={16} />
                {t('market')}
              </span>
            ),
            children: tab === 'market' ? body : null,
          },
        ]}
      />
      <Drawer
        getContainer={false}
        rootClassName="octop-surface octop-drawer-root"
        open={!!editing}
        width={640}
        destroyOnHidden
        closable={!busy}
        maskClosable={!busy}
        keyboard={!busy}
        onClose={close}
        title={
          source
            ? t('createDrawerTitle', { name: marketPresentation(source, language).title })
            : !selected && editing?.title === t('genericName')
              ? t('createDrawerTitle', { name: t('genericName') })
              : t(
                  editing && expertPresentation(editing).kind === 'team'
                    ? 'teams.editTitle'
                    : selected
                      ? 'editExpert'
                      : 'create'
                )
        }
        footer={
          <div className="octop-footer-actions">
            <WorkbenchButton
              type="button"
              variant="ghost"
              size="sm"
              onClick={close}
              disabled={busy}
            >
              {t('cancel')}
            </WorkbenchButton>
            {selected && (
              <WorkbenchButton
                type="button"
                variant="outline"
                size="sm"
                onClick={copy}
                disabled={busy || !!pending}
              >
                <Copy size={14} />
                {t('copy')}
              </WorkbenchButton>
            )}
            <WorkbenchButton
              type="button"
              size="sm"
              disabled={busy || !!pending || !editing?.title.trim()}
              onClick={save}
            >
              {busy ? t('loading') : t(selected ? 'save' : 'createAction')}
            </WorkbenchButton>
          </div>
        }
      >
        {editing && (
          <>
            {error && <Alert type="error" message={error} />}
            {notice && <Alert type="success" message={notice} />}
            <ExpertEditor
              definition={editing}
              isNew={!selected}
              onChange={setEditing}
              onEditFile={() => setFileEdit(true)}
              showDetails={filesOpen}
              members={
                expertPresentation(editing).kind === 'team' ? (
                  <label>
                    {t('teams.members')}
                    <Select
                      mode="multiple"
                      aria-label={t('teams.members')}
                      value={expertPresentation(editing).members}
                      options={items
                        .filter(
                          item =>
                            item.definition.id !== editing.id &&
                            expertPresentation(item.definition).kind === 'expert'
                        )
                        .map(item => ({ value: item.definition.id, label: item.definition.title }))}
                      onChange={members => setEditing(withPresentation(editing, { members }))}
                    />
                    <p>{t('teams.membersHint')}</p>
                  </label>
                ) : undefined
              }
              files={
                packageInfo ? (
                  <>
                    <p>
                      {packageInfo.files.length} {t('files')} · {packageInfo.skillSlugs.length}{' '}
                      {t('skills')}
                    </p>
                    {packageInfo.files.map(file => (
                      <div key={file.path} className="octop-file-row">
                        <FileText size={14} />
                        <span title={file.path}>{file.path}</span>
                        <Button
                          type="link"
                          disabled={busy || file.bytes > 256 * 1024}
                          onClick={() =>
                            void act(async signal => {
                              const result = await client.controller.call<{ content: string }>(
                                'assistant/package/read',
                                {
                                  id:
                                    !selected && copyFrom?.id.startsWith('builtin.octop.')
                                      ? copyFrom.id
                                      : editing.id,
                                  path: file.path,
                                },
                                undefined,
                                signal
                              )
                              signal.throwIfAborted()
                              setReadFile({ path: file.path, content: result.content })
                            })
                          }
                        >
                          {t('preview')}
                        </Button>
                      </div>
                    ))}
                  </>
                ) : (
                  <p>{t('noFiles')}</p>
                )
              }
              versions={
                <>
                  {client.target?.workspacePath && (
                    <ExpertTaskHistory
                      deviceId={client.target.serverId}
                      workspacePath={client.target.workspacePath}
                      expertId={editing.id}
                    />
                  )}
                  <div className="flex gap-2">
                    <Input
                      aria-label={t('version')}
                      value={versionName}
                      onChange={e => setVersionName(e.target.value)}
                    />
                    <Button
                      disabled={!selected || busy || !!pending}
                      onClick={() =>
                        void act(async signal => {
                          await client.mutate(
                            'assistant/saveVersion',
                            { id: editing.id, version: versionName },
                            signal,
                            selected?.draftRevision
                          )
                          await readDetails(selected!, signal)
                        })
                      }
                    >
                      {t('publish')}
                    </Button>
                  </div>
                  {!versions.length && <p>{t('noVersions')}</p>}
                  {versions.map(version => (
                    <div className="octop-file-row" key={version.version}>
                      <span>{version.version}</span>
                      <Button
                        disabled={busy || !!pending || version.archived}
                        onClick={() =>
                          void act(async signal => {
                            await client.mutate(
                              'assistant/archive',
                              { id: editing.id, version: version.version },
                              signal
                            )
                            await readDetails(selected!, signal)
                          })
                        }
                      >
                        {t('archive')}
                      </Button>
                    </div>
                  ))}
                  {versionCursor && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void act(async signal => {
                          const page = await client.controller.call<{
                            items: OfficeAssistantVersion[]
                            nextCursor: string | null
                          }>(
                            'assistant/versions',
                            { id: editing.id, limit: 10, cursor: versionCursor },
                            undefined,
                            signal
                          )
                          signal.throwIfAborted()
                          setVersions(old => [...old, ...page.items])
                          setVersionCursor(page.nextCursor)
                        })
                      }
                    >
                      {t('next')}
                    </Button>
                  )}
                </>
              }
            />
          </>
        )}
      </Drawer>
      <Drawer
        getContainer={false}
        rootClassName="octop-surface octop-drawer-root"
        open={fileEdit}
        width={720}
        title="SOUL.md"
        onClose={() => setFileEdit(false)}
        footer={
          <div className="octop-footer-actions">
            <Button type="primary" onClick={() => setFileEdit(false)}>
              {t('confirm')}
            </Button>
          </div>
        }
      >
        <label className="octop-drawer-fields">
          {t('instructions')}
          <Input.TextArea
            className="octop-editor"
            aria-label={t('instructions')}
            value={editing?.instructions ?? ''}
            rows={22}
            onChange={e => patch({ instructions: e.target.value })}
          />
        </label>
      </Drawer>
      <Drawer
        getContainer={false}
        rootClassName="octop-surface octop-drawer-root"
        open={!!readFile}
        width={720}
        title={readFile?.path}
        onClose={() => setReadFile(null)}
      >
        <pre className="whitespace-pre-wrap break-words">{readFile?.content}</pre>
      </Drawer>
      <Drawer
        getContainer={false}
        rootClassName="octop-surface octop-drawer-root"
        open={!!marketDetail}
        width={560}
        destroyOnHidden
        title={marketDetail ? marketPresentation(marketDetail, language).title : ''}
        onClose={() => setMarketDetail(null)}
        footer={
          marketDetail ? (
            <Button
              block
              type="primary"
              size="large"
              icon={<Download size={14} />}
              onClick={() => install(marketDetail)}
            >
              {t('createFromMarket')}
            </Button>
          ) : null
        }
      >
        {marketDetail && (
          <div className={styles.marketDrawerBody}>
            <p className={styles.marketDrawerDesc}>{marketDetail.description}</p>
            <div>
              <div className={styles.marketSectionTitle}>{t('quickPrompts')}</div>
              {detailLoading ? (
                <Spin size="small" />
              ) : detailError ? (
                <Alert type="warning" message={t('failed')} />
              ) : marketQuickPrompts(marketContent, language).length ? (
                <div className={styles.marketQuickPromptList}>
                  {marketQuickPrompts(marketContent, language).map((prompt, index) => {
                    const Icon = promptIcons[prompt.icon] ?? Zap
                    return (
                      <div
                        className={styles.marketQuickPromptCard}
                        key={`${prompt.title}-${index}`}
                      >
                        <div
                          className={styles.marketQuickPromptIcon}
                          style={{
                            background: prompt.color,
                          }}
                        >
                          <Icon size={16} />
                        </div>
                        <div>
                          <div className={styles.marketQuickPromptTitle}>{prompt.title}</div>
                          <div className={styles.marketQuickPromptDesc}>{prompt.description}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className={styles.marketWorkflowPreview}>{t('noQuickPrompts')}</p>
              )}
            </div>
            <div>
              <div className={styles.marketSectionTitle}>{t('taskExamples')}</div>
              <div className={styles.marketTaskExampleList}>
                {marketPresentation(marketDetail, language).examples.map(text => (
                  <div key={text} className={styles.marketTaskExampleItem}>
                    {text}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className={styles.marketSectionTitle}>{t('workflow')}</div>
              {detailLoading ? (
                <Spin size="small" />
              ) : marketContent ? (
                <div className={styles.marketWorkflowPanel}>
                  <div className={styles.marketWorkflowMeta}>
                    <div className={styles.marketWorkflowMetaTitle}>{t('packageInfo')}</div>
                    <div className={styles.marketTagRow}>
                      {workflowMeta.displayName && (
                        <Tag bordered={false}>{workflowMeta.displayName}</Tag>
                      )}
                      {workflowMeta.version && <Tag bordered={false}>v{workflowMeta.version}</Tag>}
                      {workflowMeta.packageType && (
                        <Tag bordered={false}>{workflowMeta.packageType}</Tag>
                      )}
                    </div>
                    {workflowMeta.children.length > 0 && (
                      <div className={styles.marketWorkflowChildren}>
                        <div className={styles.marketWorkflowChildrenLabel}>
                          {t('orchestratedSkills')}
                        </div>
                        <div className={styles.marketSkillList}>
                          {workflowMeta.children.map(slug => (
                            <Tag key={slug}>{slug}</Tag>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <div
                    className={`${styles.marketWorkflowPreview} ${styles.marketWorkflowMarkdown}`}
                  >
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        img: ({ alt }) => <span>{alt}</span>,
                        a: ({ href, children }) =>
                          href?.startsWith('https://') ? (
                            <a href={href} target="_blank" rel="noopener noreferrer">
                              {children}
                            </a>
                          ) : (
                            <span>{children}</span>
                          ),
                      }}
                    >
                      {workflowDocument.body}
                    </ReactMarkdown>
                  </div>
                </div>
              ) : (
                <p>{t('noWorkflow')}</p>
              )}
            </div>
          </div>
        )}
      </Drawer>
    </section>
  )
}
