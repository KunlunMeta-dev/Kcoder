// Adapted from Octop Personalization/PageShell; MIT, third_party/octop/LICENSE.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Empty, Segmented, Spin } from 'antd'
import { Sparkles, Waypoints, Wrench } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { OctopSurface } from '@/features/octop/OctopSurface'
import { WorkspacePageHeader } from '@/components/layout/WorkspacePageHeader'
import { Button } from '@/components/ui/button'
import { useRuntimeSettingsTargets } from '@/features/runtime-target/useRuntimeSettingsTargets'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { navigateTo } from '@/lib/navigation'
import { stripAppBasePath } from '@/config/runtime'
import type { OfficeAssistantDraft } from '../../../../shared/generated/contracts'
import type { OfficeAssistantItem } from '@/features/office-integration/controller'
import { ExpertTarget } from './ExpertTarget'
import type { ExpertClient } from './client'
import { ExpertSkillsWorkspace } from './ExpertSkillsWorkspace'
import { ExpertToolsWorkspace } from './ExpertToolsWorkspace'
import { expertPresentation } from './presentation'
import {
  channelConnectionsRoute,
  expertPersonalizationRoute,
  readExpertSettingsScope,
} from './personalizationRoutes'
import './personalization.css'

const tabs = [
  { value: 'skills', icon: Sparkles },
  { value: 'tools', icon: Wrench },
  { value: 'channels', icon: Waypoints },
]

export function PersonalizationPage() {
  return stripAppBasePath(window.location.pathname).endsWith('/channels') ? (
    <LegacyChannelsRedirect />
  ) : (
    <ExpertPersonalizationPage />
  )
}

function LegacyChannelsRedirect() {
  useEffect(() => {
    const query = new URLSearchParams(window.location.search),
      deviceId = query.get('deviceId')
    navigateTo(
      channelConnectionsRoute(
        deviceId ? { deviceId, workspacePath: query.get('workspacePath') || undefined } : undefined
      )
    )
  }, [])
  return null
}

function ExpertPersonalizationPage() {
  const { t } = useTranslation('experts')
  const targets = useRuntimeSettingsTargets()
  const selected = readExpertSettingsScope(window.location.search)
  const serverId = selected?.deviceId ?? ''
  const workspacePath = selected?.workspacePath
  const scope = usePluginTargetScope(serverId, workspacePath)
  const [revision, setRevision] = useState(0)
  const tab = stripAppBasePath(window.location.pathname).endsWith('/tools') ? 'tools' : 'skills'
  // A deep link retains its explicit owner; it never falls back to another host.
  const targetExists = targets.targets.some(target => target.id === serverId)
  return (
    <OctopSurface variant="workbench">
      <div className="octop-personalization" data-testid="personalization-page">
        <WorkspacePageHeader
          title={`${t('personalization.title')} / ${t(`personalization.tabs.${tab}`)}`}
          onBack={() => navigateTo('/experts')}
          actions={
            selected && (
              <Segmented
                className="octop-personalization-path-tabs"
                value={tab}
                onChange={value => navigateTo(expertPersonalizationRoute(selected, String(value)))}
                options={tabs.map(({ value, icon: Icon }) => ({
                  value,
                  label: (
                    <span>
                      <Icon size={14} />
                      {t(`personalization.tabs.${value}`)}
                    </span>
                  ),
                }))}
              />
            )
          }
        />
        <div className="expert-page-content">
          <p className="mb-4 text-sm text-text-secondary">{t('personalization.expertScoped')}</p>
          {!selected || (!targets.loading && !targetExists) ? (
            <Empty description={t('personalization.enterFromExpert')}>
              <Button type="button" variant="outline" onClick={() => navigateTo('/experts')}>
                {t('title')}
              </Button>
            </Empty>
          ) : targets.loading ? (
            <Spin />
          ) : (
            <ExpertTarget
              key={`${scope.key}:${selected.expertId}:${revision}`}
              serverId={serverId}
              workspacePath={workspacePath}
              isCurrent={scope.isCurrent}
              onReconnect={() => setRevision(value => value + 1)}
            >
              {client => (
                <PersonalizedExpert
                  key={client.pendingKey + selected.expertId}
                  client={client}
                  expertId={selected.expertId}
                  tab={tab}
                />
              )}
            </ExpertTarget>
          )}
        </div>
      </div>
    </OctopSurface>
  )
}

function PersonalizedExpert({
  client,
  expertId,
  tab,
}: {
  client: ExpertClient
  expertId: string
  tab: 'skills' | 'tools'
}) {
  const { t, i18n } = useTranslation('experts')
  const language = i18n.language.startsWith('zh') ? 'zh-CN' : 'en'
  const [item, setItem] = useState<OfficeAssistantItem>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const generation = useRef(0)
  useEffect(() => {
    const owner = new AbortController()
    const lifetime = generation
    const epoch = ++lifetime.current
    void (async () => {
      let cursor: string | undefined
      let count = 0
      do {
        const page = await client.list(cursor, language, owner.signal)
        owner.signal.throwIfAborted()
        const found = page.items.find(
          item =>
            item.definition.id === expertId && expertPresentation(item.definition).kind !== 'team'
        )
        if (found) {
          if (epoch === lifetime.current) setItem(found)
          return
        }
        count += page.items.length
        if (count > 1000) throw new Error('CAPACITY')
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      throw new Error('EXPERT_UNAVAILABLE')
    })()
      .catch(() => {
        if (!owner.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!owner.signal.aborted) setLoading(false)
      })
    return () => {
      owner.abort()
      lifetime.current++
    }
  }, [client, expertId, language])
  const onSaved = useCallback(
    (draft: OfficeAssistantDraft) =>
      setItem(
        item => item && { ...item, definition: draft.definition, draftRevision: draft.revision }
      ),
    []
  )
  return (
    <>
      {item && (
        <p className="mb-3 text-sm font-medium" data-testid="personalization-current-expert">
          {item.definition.title}
        </p>
      )}
      <div className="octop-personalization-body">
        {loading ? (
          <Spin />
        ) : error || !item ? (
          <Empty description={t('personalization.readFailed')} />
        ) : tab === 'tools' ? (
          <ExpertToolsWorkspace client={client} item={item} onSaved={onSaved} />
        ) : (
          <ExpertSkillsWorkspace client={client} item={item} onSaved={onSaved} />
        )}
      </div>
    </>
  )
}
