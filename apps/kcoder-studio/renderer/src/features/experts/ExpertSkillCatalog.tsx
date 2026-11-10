// Adapted from Octop SkillHubTab; MIT, third_party/octop/LICENSE.
import { useEffect, useState } from 'react'
import { Alert, Button, Input, Segmented, Spin } from 'antd'
import { Download, Package, RefreshCw, Search, Zap } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { OfficeMarketSkill } from '../../../../shared/generated/contracts'
import type { OfficeAssistantItem } from '@/features/office-integration/controller'
import type { ExpertClient } from './client'
import { packageSkills } from './skillPresentation'
import styles from '@/features/octop/skills.module.css'

interface CatalogSkill extends OfficeMarketSkill {
  sourceId?: string
  path?: string
}
export function ExpertSkillCatalog({
  client,
  kind,
  installed,
  busy,
  onInstall,
  onReview,
}: {
  client: ExpertClient
  kind: 'builtin' | 'skillhub'
  installed: string[]
  busy: boolean
  onInstall: (slug: string) => void
  onReview: (id: string, path: string, slug: string) => void
}) {
  const { t, i18n } = useTranslation('experts')
  const language = i18n.language.startsWith('zh') ? 'zh-CN' : 'en'
  const [items, setItems] = useState<CatalogSkill[]>([])
  const [ranking, setRanking] = useState('recommended')
  const [draftQuery, setDraftQuery] = useState('')
  const [query, setQuery] = useState('')
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    const owner = new AbortController()
    queueMicrotask(() => {
      if (!owner.signal.aborted) {
        setLoading(true)
        setError(false)
      }
    })
    void (async () => {
      if (kind === 'skillhub') {
        const result = await client.controller.call<{ items: OfficeMarketSkill[] }>(
          'assistant/skills/catalog',
          { query, ranking, language, limit: 50 },
          undefined,
          owner.signal
        )
        if (!owner.signal.aborted) setItems(result.items)
      } else {
        const experts: OfficeAssistantItem[] = []
        let cursor: string | undefined
        do {
          const page = await client.controller.call<{
            items: OfficeAssistantItem[]
            nextCursor: string | null
          }>(
            'assistant/list',
            { limit: 10, language, ...(cursor ? { cursor } : {}) },
            undefined,
            owner.signal
          )
          experts.push(...page.items)
          cursor = page.nextCursor ?? undefined
          if (experts.length > 1000) throw new Error('CAPACITY')
        } while (cursor)
        const values = new Map<string, CatalogSkill>()
        for (const expert of experts.filter(item =>
          item.definition.id.startsWith('builtin.octop.')
        )) {
          const bundle = await client.package(expert.definition.id, owner.signal)
          for (const file of packageSkills(bundle))
            if (!values.has(file.slug))
              values.set(file.slug, {
                slug: file.slug,
                title: file.slug,
                description: expert.definition.description,
                sourceId: expert.definition.id,
                path: file.path,
              })
        }
        if (!owner.signal.aborted)
          setItems([...values.values()].sort((a, b) => a.slug.localeCompare(b.slug)))
      }
    })()
      .catch(() => {
        if (!owner.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!owner.signal.aborted) setLoading(false)
      })
    return () => owner.abort()
  }, [client, kind, language, query, ranking, reload])
  return (
    <div className={styles.skillHubContainer}>
      {kind === 'skillhub' && (
        <>
          <div className={styles.skillHubToolbar}>
            <Input.Search
              className={styles.skillHubSearch}
              aria-label={t('personalization.searchSkills')}
              prefix={<Search size={14} />}
              value={draftQuery}
              maxLength={200}
              onChange={event => setDraftQuery(event.target.value)}
              onSearch={() => setQuery(draftQuery.trim())}
              placeholder={t('personalization.searchSkills')}
            />
            <Button
              aria-label={t('refresh')}
              icon={<RefreshCw size={14} />}
              onClick={() => setReload(value => value + 1)}
            />
          </div>
          <Segmented
            className={styles.rankingTabs}
            value={ranking}
            onChange={setRanking}
            options={['recommended', 'trending', 'hot', 'newest'].map(value => ({
              value,
              label: t(`personalization.rankings.${value}`),
            }))}
          />
        </>
      )}
      {loading ? (
        <Spin />
      ) : error ? (
        <Alert
          type="warning"
          message={t('personalization.readFailed')}
          action={<Button onClick={() => setReload(value => value + 1)}>{t('refresh')}</Button>}
        />
      ) : (
        <div className={styles.hubGrid}>
          {items.map(skill => (
            <article key={skill.slug} className={styles.hubCard}>
              <div className={styles.hubCardHeader}>
                <span className={styles.hubCardIconFallback}>
                  {kind === 'builtin' ? <Package size={20} /> : <Zap size={20} />}
                </span>
                <span className={styles.hubCardName}>{skill.title}</span>
              </div>
              <div className={styles.hubCardDesc}>{skill.description}</div>
              <div className={styles.hubCardFooter}>
                <span className={styles.hubCardStat}>{skill.slug}</span>
                <Button
                  size="small"
                  type="primary"
                  icon={<Download size={12} />}
                  disabled={busy || installed.includes(skill.slug) || !!client.pending()}
                  onClick={() =>
                    skill.sourceId && skill.path
                      ? onReview(skill.sourceId, skill.path, skill.slug)
                      : onInstall(skill.slug)
                  }
                >
                  {t(
                    installed.includes(skill.slug)
                      ? 'personalization.installed'
                      : 'personalization.reviewAdd'
                  )}
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
