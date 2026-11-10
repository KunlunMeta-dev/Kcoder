import { ExpertConversationActions } from './ExpertConversationActions'
// Octop conversation layout adapted under third_party/octop/LICENSE.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ArrowLeft, Bot, MessageSquare, Network, Plus, RefreshCw, Search } from 'lucide-react'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import type { ChannelTaskSource, AgentTaskBinding } from '../../../../shared/generated/contracts'
import type { OfficeAssistantItem } from '@/features/office-integration/controller'
import type { ExpertClient } from './client'
import { ExpertTarget } from './ExpertTarget'
import { ExpertTaskDialog } from './ExpertTaskDialog'
import { expertAvatar, expertPresentation } from './presentation'
import { expertConversationTasks, expertTaskChannelId, expertTaskConversationScope } from './expertTaskProjection'
import { useExpertConversationRefresh } from './useExpertConversationRefresh'
import {
  expertConversationRoute,
  readExpertConversationScope,
  type ExpertConversationScope,
} from './conversationRoutes'
import './expert-conversations.css'

const subscribe = (changed: () => void) => {
  window.addEventListener('popstate', changed)
  return () => window.removeEventListener('popstate', changed)
}
const locationSnapshot = () => window.location.href

/** The resident KCoder pane remains the single owner of transcript and execution. */
export function ExpertConversationShell({
  active,
  children,
}: {
  active: boolean
  children: ReactNode
}) {
  const { t } = useTranslation('experts')
  const { state } = useWorkbench()
  const [revision, setRevision] = useState(0)
  const location = useSyncExternalStore(subscribe, locationSnapshot)
  const scope = readExpertConversationScope(new URL(location).search)
  const target = usePluginTargetScope(
    active ? scope?.deviceId : undefined,
    active ? scope?.workspacePath : undefined
  )
  const binding = state.currentRuntimeTask?.runtimeHandle?.agentDefinition as
    AgentTaskBinding | undefined
  const channelSource = state.currentRuntimeTask?.runtimeHandle?.channelTaskSource as
    ChannelTaskSource | undefined
  const pendingDefinition = state.currentRuntimeTask?.runtimeHandle?.pendingAgentDefinition as
    { id?: string } | undefined
  const draft = state.expertDraft
  const matchedTask =
    !!scope &&
    state.currentRuntimeTask?.deviceId === scope.deviceId &&
    sameWorkspacePath(state.currentRuntimeTask.workspacePath ?? '', scope.workspacePath) &&
    (!new URL(location).searchParams.get('taskId') ||
      new URL(location).searchParams.get('taskId') === state.currentRuntimeTask.taskId) &&
    (!!binding ||
      !!pendingDefinition ||
      !!state.currentRuntimeTask.runtimeHandle?.channelTaskSource) &&
    (!scope.channelId ||
      binding?.sourceId === scope.channelId ||
      channelSource?.channelId === scope.channelId) &&
    (!scope.expertId ||
      binding?.definition?.id === scope.expertId ||
      pendingDefinition?.id === scope.expertId)
  const matchedDraft =
    !!scope &&
    !state.currentRuntimeTask &&
    !!draft &&
    draft.draftKey === state.standaloneChatKey &&
    draft.deviceId === scope.deviceId &&
    sameWorkspacePath(draft.workspacePath, scope.workspacePath) &&
    draft.reference.id === scope.expertId
  return (
    <div
      className={active ? 'expert-conversations' : 'contents'}
      data-testid={active ? 'expert-conversations' : undefined}
    >
      {active &&
        (scope ? (
          <ExpertTarget
            key={`${target.key}:${revision}`}
            serverId={scope.deviceId}
            workspacePath={scope.workspacePath}
            isCurrent={target.isCurrent}
            onReconnect={() => setRevision(value => value + 1)}
          >
            {client => (
              <ExpertConversationRail
                client={client}
                scope={scope}
                search={new URL(location).search}
              />
            )}
          </ExpertTarget>
        ) : (
          <p role="alert">{t('unavailable')}</p>
        ))}
      <div className={active ? 'expert-conversation-main' : 'contents'}>
        {active && !matchedTask && !matchedDraft && (
          <div className="expert-conversation-welcome">
            <Bot size={40} />
            <p>{t('conversation.welcome')}</p>
            <p className="text-sm">{t('conversation.noGhost')}</p>
          </div>
        )}
        <div className={active && !matchedTask && !matchedDraft ? 'hidden' : 'contents'}>
          {children}
        </div>
      </div>
    </div>
  )
}

function ExpertConversationRail({
  client,
  scope,
  search,
}: {
  client: ExpertClient
  scope: ExpertConversationScope
  search: string
}) {
  const { t, i18n } = useTranslation('experts')
  const { state, refreshWorkLists } = useWorkbench()
  const [items, setItems] = useState<OfficeAssistantItem[]>([])
  const [query, setQuery] = useState('')
  const [catalogError, setCatalogError] = useState(false)
  const { busy, error: refreshError, refresh } = useExpertConversationRefresh(refreshWorkLists)
  const [launching, setLaunching] = useState<OfficeAssistantItem | null>(null)
  // The rail lists all experts; a channel deep link must not filter its siblings.
  const tasks = expertConversationTasks(state.runtimeWork, {
    ...scope, expertId: undefined, channelId: undefined,
  })
  useEffect(() => {
    const abort = new AbortController()
    void (async () => {
      const all: OfficeAssistantItem[] = []
      let cursor: string | undefined
      do {
        const result = await client.list(
          cursor,
          i18n.language.startsWith('zh') ? 'zh-CN' : 'en',
          abort.signal
        )
        all.push(...result.items)
        cursor = result.nextCursor ?? undefined
      } while (cursor && all.length < 500 && !abort.signal.aborted)
      if (cursor && !abort.signal.aborted) setCatalogError(true)
      if (!abort.signal.aborted)
        setItems(all.filter(item => expertPresentation(item.definition).kind !== 'team'))
    })().catch(() => {
      if (!abort.signal.aborted) setCatalogError(true)
    })
    return () => abort.abort()
  }, [client, i18n.language])
  useEffect(() => {
    const selected = expertConversationTasks(state.runtimeWork, scope)
    const hasDraft =
      !!state.expertDraft &&
      state.expertDraft.draftKey === state.standaloneChatKey &&
      state.expertDraft.reference.id === scope.expertId
    const creating = state.currentRuntimeTask?.runtimeHandle?.pendingAgentDefinition as
      { id?: string } | undefined
    if (creating?.id === scope.expertId && state.currentRuntimeTask?.deviceId === scope.deviceId)
      return
    if (!new URLSearchParams(search).has('taskId') && !hasDraft && selected.length) {
      const { task, space } = selected[0]
      navigateTo(expertConversationRoute(expertTaskConversationScope(scope, task), {
        deviceId: space.deviceId, taskId: task.taskId,
      }))
    }
  }, [tasks, scope, search, state.runtimeWork, state.currentRuntimeTask, state.expertDraft, state.standaloneChatKey])
  const allSpaces = [
    ...(state.runtimeWork?.chats ?? []),
    ...(state.runtimeWork?.projects.flatMap(item => item.deviceWorkspaces) ?? []),
  ].filter(
    space =>
      space.deviceId === scope.deviceId &&
      sameWorkspacePath(space.workspacePath, scope.workspacePath)
  )
  const partial =
    !state.runtimeWork ||
    !allSpaces.length ||
    allSpaces.some(space => space.threadsComplete === false || space.threadListSyncFailed)
  const groups: { id: string; title: string; item?: OfficeAssistantItem; channelId?: string }[] = [
    ...items.map(item => ({
      id: item.definition.id,
      title: item.definition.title,
      item,
      channelId: undefined,
    })),
    ...tasks
      .filter(
        ({ binding }) =>
          binding && !items.some(item => item.definition.id === binding.definition.id)
      )
      .map(({ binding }) => ({
        id: binding!.definition.id,
        title: binding!.title,
        item: undefined,
        channelId: undefined,
      })),
    ...tasks
      .filter(({ binding, task }) => !binding && task.runtimeHandle?.channelTaskSource)
      .map(({ task }) => {
        const channel = task.runtimeHandle!.channelTaskSource as ChannelTaskSource
        return {
          id: `channel:${channel.channelId}`,
          title: t('channelTitle'),
          channelId: channel.channelId,
          item: undefined,
        }
      }),
  ]
    .filter((group, index, all) => all.findIndex(other => other.id === group.id) === index)
    .filter(group =>
      `${group.title} ${tasks
        .filter(item =>
          group.channelId
            ? (item.task.runtimeHandle?.channelTaskSource as ChannelTaskSource)?.channelId ===
              group.channelId
            : item.binding?.definition.id === group.id
        )
        .map(item => item.task.title)
        .join(' ')}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase())
    )
  return (
    <aside className="expert-conversation-rail" aria-label={t('conversation.history')}>
      <div className="expert-conversation-search">
        <Search size={14} />
        <input
          aria-label={t('conversation.search')}
          placeholder={t('conversation.search')}
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
      </div>
      <div className="expert-conversation-tabs">
        <span className="expert-conversation-active-tab">{t('title')}</span>
        <button disabled title={t('conversation.teamUnavailable')}>
          {t('conversation.team')}
        </button>
        <button disabled title={t('conversation.cloudUnavailable')}>
          {t('conversation.cloud')}
        </button>
        <button
          aria-label={t('refresh')}
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {(catalogError || refreshError || partial) && (
        <p role="alert" className="p-3 text-sm">
          {t('task.historyPartial')}
        </p>
      )}
      <div className="expert-conversation-groups">
        {groups.map(group => {
          const selected = group.channelId
            ? scope.channelId === group.channelId
            : scope.expertId === group.id
          const avatar = group.item && expertAvatar(group.item.definition)
          const sessions = tasks
            .filter(item =>
              group.channelId
                ? (item.task.runtimeHandle?.channelTaskSource as ChannelTaskSource)?.channelId ===
                  group.channelId
                : item.binding?.definition.id === group.id
            )
            .filter(
              item =>
                !query ||
                `${group.title} ${item.task.title}`
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase())
            )
          return (
            <section className="expert-conversation-group" data-selected={selected} key={group.id}>
              <div className="expert-conversation-expert">
                <button
                  className="expert-conversation-identity"
                  onClick={() =>
                    navigateTo(
                      expertConversationRoute({
                        ...scope,
                        expertId: group.channelId ? undefined : group.id,
                        channelId: group.channelId,
                      })
                    )
                  }
                >
                  {avatar ? (
                    <img src={avatar} width={28} height={28} alt="" />
                  ) : (
                    <span className="expert-conversation-avatar">
                      <Bot size={20} />
                    </span>
                  )}
                  <span>
                    <strong>{group.title}</strong>
                    <small>{group.item?.definition.description}</small>
                  </span>
                </button>
                <button
                  aria-label={t('conversation.new')}
                  disabled={!group.item || !expertPresentation(group.item.definition).enabled}
                  onClick={() => setLaunching(group.item!)}
                >
                  <Plus size={14} />
                </button>
              </div>
              {selected && (
                <div className="expert-conversation-sessions">
                  {sessions.map(({ task }) => (
                    <div
                      key={task.taskId}
                      className="expert-conversation-session"
                      data-testid="expert-conversation-session"
                      data-task-id={task.taskId}
                      data-channel-id={expertTaskChannelId(task)}
                      data-selected={new URLSearchParams(search).get('taskId') === task.taskId}
                    >
                      <button
                        className="expert-conversation-session-link"
                        onClick={() =>
                          navigateTo(
                            expertConversationRoute(
                              expertTaskConversationScope(scope, task),
                              { deviceId: scope.deviceId, taskId: task.taskId }
                            )
                          )
                        }
                      >
                        {expertTaskChannelId(task) ? <Network size={13} /> : <MessageSquare size={13} />}
                        <span>{task.title}</span>
                        {expertTaskChannelId(task) && <small>{t('channelTitle')}</small>}
                      </button>
                      <ExpertConversationActions
                        address={{
                          deviceId: scope.deviceId,
                          taskId: task.taskId,
                          threadId: task.threadId ?? undefined,
                          workspacePath: scope.workspacePath,
                          runtimeHandle: task.runtimeHandle,
                        }}
                        title={task.title}
                        pinned={!!task.pinned}
                        route={expertConversationRoute(
                          expertTaskConversationScope(scope, task),
                          { deviceId: scope.deviceId, taskId: task.taskId }
                        )}
                      />
                    </div>
                  ))}
                  {!partial && !sessions.length && (
                    <p className="p-2 text-sm">{t('task.historyEmpty')}</p>
                  )}
                </div>
              )}
            </section>
          )
        })}
      </div>
      <div className="expert-conversation-footnote">
        <button onClick={() => navigateTo('/experts')}>
          <ArrowLeft size={12} />
          {t('conversation.manage')}
        </button>
        <p>{t('conversation.originalHistory')}</p>
      </div>
      {launching && (
        <ExpertTaskDialog client={client} initial={launching} onClose={() => setLaunching(null)} />
      )}
    </aside>
  )
}
