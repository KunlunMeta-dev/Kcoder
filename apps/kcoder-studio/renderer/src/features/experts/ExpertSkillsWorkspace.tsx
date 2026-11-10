// Adapted from Octop SkillsTabs and InstalledSkillsTab; MIT, third_party/octop/LICENSE.
import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Drawer,
  Form,
  Input,
  Segmented,
  Select,
  Spin,
  Switch,
  Table,
  Tooltip,
} from 'antd'
import {
  Blocks,
  Download,
  FileDown,
  Inbox,
  Info,
  LayoutGrid,
  List,
  Package,
  Plus,
  RefreshCw,
  Sparkles,
  Store,
  Trash2,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  OfficeAssistantDraft,
  OfficeAssistantSkill,
  OfficeExpertPackage,
} from '../../../../shared/generated/contracts'
import type { OfficeAssistantItem } from '@/features/office-integration/controller'
import { ExpertClient } from './client'
import { packageSkills, skillSnapshot } from './skillPresentation'
import { ExpertSkillCatalog } from './ExpertSkillCatalog'
import { isContract } from '../../../../shared/generated/validator.mjs'
import styles from '@/features/octop/skills.module.css'

export function ExpertSkillsWorkspace({
  client,
  item,
  onSaved,
}: {
  client: ExpertClient
  item: OfficeAssistantItem
  onSaved: (draft: OfficeAssistantDraft) => void
}) {
  const { t } = useTranslation('experts')
  const [tab, setTab] = useState('custom')
  const [view, setView] = useState('card')
  const [bundle, setBundle] = useState<OfficeExpertPackage | null>(null)
  const [bundleState, setBundleState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<OfficeAssistantSkill | null>(null)
  const [originalSlug, setOriginalSlug] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importSlug, setImportSlug] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const lifetime = useRef<AbortController | null>(null)
  const lock = useRef(false)
  const skills = item.definition.skills ?? []
  const available = packageSkills(bundle).filter(
    file => !skills.some(skill => skill.slug === file.slug)
  )
  useEffect(() => {
    const owner = new AbortController()
    lifetime.current = owner
    void client
      .package(item.definition.id, owner.signal)
      .then(value => {
        if (!owner.signal.aborted) {
          setBundle(value)
          setBundleState('ready')
        }
      })
      .catch(() => {
        if (!owner.signal.aborted) {
          setError(t('personalization.readFailed'))
          setBundleState('failed')
        }
      })
    return () => {
      owner.abort()
      lifetime.current = null
    }
  }, [client, item.definition.id, t])
  const act = async (work: (signal: AbortSignal) => Promise<void>) => {
    const owner = lifetime.current
    if (!owner || lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      await work(owner.signal)
    } catch {
      if (!owner.signal.aborted)
        setError(t(client.pending() ? 'pending' : 'personalization.writeFailed'))
    } finally {
      lock.current = false
      if (!owner.signal.aborted) setBusy(false)
    }
  }
  const save = async (next: OfficeAssistantSkill[], signal: AbortSignal) => {
    const draft = await client.save(
      { ...item.definition, skills: next },
      item.draftRevision,
      signal
    )
    signal.throwIfAborted()
    onSaved(draft)
  }
  const edit = (skill?: OfficeAssistantSkill) => {
    setOriginalSlug(skill && skills.some(value => value.slug === skill.slug) ? skill.slug : null)
    setEditing(
      skill ? { ...skill } : { slug: '', title: '', description: '', content: '', enabled: false }
    )
  }
  const tabs = [
    { key: 'custom', icon: Sparkles, label: 'customSkills' },
    { key: 'builtin', icon: Blocks, label: 'builtinSkills' },
    { key: 'skillhub', icon: Store, label: 'skillMarket' },
    { key: 'packages', icon: Package, label: 'skillPackages' },
  ]
  const toggle = (skill: OfficeAssistantSkill, enabled: boolean) =>
    void act(signal =>
      save(
        skills.map(value => (value.slug === skill.slug ? { ...value, enabled } : value)),
        signal
      )
    )
  const exportSelected = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          { schemaVersion: 1, skills: skills.filter(skill => selected.includes(skill.slug)) },
          null,
          2
        ),
      ],
      { type: 'application/json' }
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'expert-skills.json'
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className={styles.skillsTabs} data-testid="expert-skills-workspace" aria-busy={busy}>
      <div className="octop-personalization-skill-tabs" role="tablist">
        {tabs.map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'active' : ''}
            onClick={() => setTab(key)}
          >
            <Icon size={14} />
            {t(`personalization.${label}`)}
          </button>
        ))}
      </div>
      {error && (
        <Alert
          type="warning"
          showIcon
          message={error}
          action={
            client.pending() ? (
              <Button
                disabled={busy}
                onClick={() =>
                  void act(async signal => {
                    await client.reconcile(signal)
                    const result = await client.controller.call<{ draft: OfficeAssistantDraft }>(
                      'assistant/read',
                      { id: item.definition.id, language: item.definition.language },
                      undefined,
                      signal
                    )
                    signal.throwIfAborted()
                    onSaved(result.draft)
                  })
                }
              >
                {t('reconcile')}
              </Button>
            ) : undefined
          }
        />
      )}
      <div className={styles.skillsTabsContent}>
        {tab === 'custom' ? (
          <>
            <div className={styles.gridToolbar}>
              <span className={styles.gridCount}>
                {t('personalization.totalSkills', { count: skills.length })}
              </span>
              <div className={styles.gridToolbarRight}>
                <Segmented
                  size="small"
                  value={view}
                  onChange={setView}
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
                <Tooltip title={t('refresh')}>
                  <button
                    className={styles.toolbarIconBtn}
                    aria-label={t('refresh')}
                    disabled={busy}
                    onClick={() =>
                      void act(async signal => {
                        const result = await client.controller.call<{
                          draft: OfficeAssistantDraft
                        }>(
                          'assistant/read',
                          { id: item.definition.id, language: item.definition.language },
                          undefined,
                          signal
                        )
                        signal.throwIfAborted()
                        onSaved(result.draft)
                      })
                    }
                  >
                    <RefreshCw size={14} />
                  </button>
                </Tooltip>
                <button
                  className={styles.toolbarBtn}
                  disabled={!selected.length}
                  onClick={exportSelected}
                >
                  <FileDown size={14} />
                  {t('personalization.exportSelected', { count: selected.length })}
                </button>
                <button
                  className={styles.toolbarBtn}
                  disabled={busy}
                  onClick={() => setImportOpen(true)}
                >
                  <Download size={14} />
                  {t('personalization.importSkills')}
                </button>
                <button
                  className={styles.toolbarBtnPrimary}
                  disabled={busy || !!client.pending()}
                  onClick={() => edit()}
                >
                  <Plus size={14} />
                  {t('personalization.createSkill')}
                </button>
              </div>
            </div>
            <div className={styles.skillsListArea}>
              {!skills.length ? (
                <div className="octop-skill-empty">
                  <Inbox size={40} strokeWidth={1.2} />
                  <strong>{t('personalization.noSkills')}</strong>
                  <p>{t('personalization.noSkillsDescription')}</p>
                  <Button type="primary" onClick={() => edit()}>
                    {t('personalization.createSkill')}
                  </Button>
                </div>
              ) : view === 'table' ? (
                <Table
                  rowKey="slug"
                  pagination={false}
                  dataSource={skills}
                  rowSelection={{
                    selectedRowKeys: selected,
                    onChange: keys => setSelected(keys.map(String)),
                  }}
                  columns={[
                    { title: t('name'), dataIndex: 'title' },
                    { title: t('summary'), dataIndex: 'description' },
                    {
                      title: t('personalization.enabled'),
                      render: (_, skill) => (
                        <Switch
                          checked={skill.enabled}
                          disabled={busy || !!client.pending()}
                          onChange={enabled => toggle(skill, enabled)}
                        />
                      ),
                    },
                    {
                      title: t('personalization.details'),
                      render: (_, skill) => (
                        <Button onClick={() => edit(skill)}>{t('personalization.details')}</Button>
                      ),
                    },
                  ]}
                />
              ) : (
                <div className={styles.skillsGrid}>
                  {skills.map(skill => (
                    <article key={skill.slug} className={styles.skillCard}>
                      <div className={styles.cardBody}>
                        <div className={styles.cardHeader}>
                          <input
                            type="checkbox"
                            aria-label={t('personalization.selectSkill', { name: skill.title })}
                            checked={selected.includes(skill.slug)}
                            onChange={e =>
                              setSelected(
                                e.target.checked
                                  ? [...selected, skill.slug]
                                  : selected.filter(id => id !== skill.slug)
                              )
                            }
                          />
                          <div className={styles.iconWrapper}>
                            <Sparkles size={32} />
                          </div>
                          <div className={styles.cardMeta}>
                            <div className={styles.cardTitle}>{skill.title}</div>
                            <div className={styles.cardBadges}>
                              {skill.enabled && (
                                <span className={styles.enabledBadge}>
                                  ✓ {t('personalization.enabled')}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className={styles.cardDesc}>
                          {skill.description || t('personalization.noDescription')}
                        </div>
                        <div className={styles.cardFooter}>
                          <button className={styles.detailBtn} onClick={() => edit(skill)}>
                            <Info size={14} />
                            {t('personalization.details')}
                          </button>
                          <div className={styles.footerActions}>
                            <button
                              className={styles.deleteIconBtn}
                              aria-label={t('personalization.deleteSkill', { name: skill.title })}
                              disabled={busy || skill.enabled || !!client.pending()}
                              onClick={() =>
                                void act(signal =>
                                  save(
                                    skills.filter(value => value.slug !== skill.slug),
                                    signal
                                  )
                                )
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                            <Switch
                              size="small"
                              checked={skill.enabled}
                              disabled={busy || !!client.pending()}
                              onChange={enabled => toggle(skill, enabled)}
                            />
                          </div>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : tab === 'builtin' || tab === 'skillhub' ? (
          <ExpertSkillCatalog
            key={tab}
            client={client}
            kind={tab}
            installed={skills.map(skill => skill.slug)}
            busy={busy}
            onInstall={slug =>
              void act(async signal => {
                const result = await client.mutate(
                  'assistant/skills/install',
                  { id: item.definition.id, slug, language: item.definition.language },
                  signal,
                  item.draftRevision
                )
                if (!isContract('OfficeAssistantDraft', result.draft))
                  throw new Error('INVALID_REPLY')
                signal.throwIfAborted()
                onSaved(result.draft as OfficeAssistantDraft)
                setBundle(await client.package(item.definition.id, signal))
                signal.throwIfAborted()
                setTab('custom')
              })
            }
            onReview={(id, path, slug) =>
              void act(async signal => {
                const result = await client.controller.call<{ content: string }>(
                  'assistant/package/read',
                  { id, path },
                  undefined,
                  signal
                )
                signal.throwIfAborted()
                edit(skillSnapshot(slug, result.content))
              })
            }
          />
        ) : (
          <>
            <div className={styles.gridToolbar}>
              <span className={styles.gridCount}>
                {t(bundleState === 'loading' ? 'loading' : 'personalization.packageSkills', {
                  count: available.length,
                })}
              </span>
              <Button onClick={() => setImportOpen(true)} disabled={!available.length}>
                {t('personalization.importFromPackage')}
              </Button>
            </div>
            <p className={styles.packageMountHint}>{t('personalization.packageHint')}</p>
            {available.map(file => (
              <div className="octop-file-row" key={file.path}>
                <Package size={16} />
                <span>{file.slug}</span>
                <Button
                  disabled={busy || !!client.pending()}
                  onClick={() =>
                    void act(async signal => {
                      const value = await client.controller.call<{ content: string }>(
                        'assistant/package/read',
                        { id: item.definition.id, path: file.path },
                        undefined,
                        signal
                      )
                      signal.throwIfAborted()
                      edit(skillSnapshot(file.slug, value.content))
                    })
                  }
                >
                  {t('personalization.reviewAdd')}
                </Button>
              </div>
            ))}
            {bundleState === 'loading' && <Spin />}
            {bundleState === 'ready' && !available.length && (
              <div className="octop-skill-empty">
                <Package size={40} />
                <p>{t('personalization.noPackageSkills')}</p>
              </div>
            )}
          </>
        )}
      </div>
      <Drawer
        getContainer={false}
        rootClassName="octop-surface octop-drawer-root"
        open={!!editing}
        width={720}
        destroyOnHidden
        title={t(originalSlug ? 'personalization.editSkill' : 'personalization.createSkill')}
        onClose={() => !busy && setEditing(null)}
        footer={
          <div className="octop-footer-actions">
            <Button disabled={busy} onClick={() => setEditing(null)}>
              {t('cancel')}
            </Button>
            <Button
              type="primary"
              disabled={
                busy ||
                !!client.pending() ||
                !editing?.title.trim() ||
                !editing?.content.trim() ||
                !/^[a-zA-Z0-9_.-]{1,128}$/.test(editing?.slug ?? '')
              }
              onClick={() =>
                void act(async signal => {
                  if (!editing) return
                  const next = originalSlug
                    ? skills.map(skill => (skill.slug === originalSlug ? editing : skill))
                    : [...skills, editing]
                  await save(next, signal)
                  signal.throwIfAborted()
                  setEditing(null)
                })
              }
            >
              {busy ? <Spin size="small" /> : t('save')}
            </Button>
          </div>
        }
      >
        {editing && (
          <Form layout="vertical">
            <Form.Item label={t('personalization.skillId')} required>
              <Input
                aria-label={t('personalization.skillId')}
                value={editing.slug}
                disabled={!!originalSlug}
                onChange={e => setEditing({ ...editing, slug: e.target.value })}
              />
            </Form.Item>
            <Form.Item label={t('name')} required>
              <Input
                aria-label={t('name')}
                maxLength={200}
                value={editing.title}
                onChange={e => setEditing({ ...editing, title: e.target.value })}
              />
            </Form.Item>
            <Form.Item label={t('summary')}>
              <Input.TextArea
                aria-label={t('summary')}
                maxLength={4000}
                value={editing.description}
                onChange={e => setEditing({ ...editing, description: e.target.value })}
              />
            </Form.Item>
            <Form.Item label="SKILL.md" required>
              <Input.TextArea
                aria-label="SKILL.md"
                rows={18}
                maxLength={24000}
                value={editing.content}
                onChange={e => setEditing({ ...editing, content: e.target.value })}
              />
            </Form.Item>
            <Form.Item
              label={t('personalization.enableSkill')}
              extra={t('personalization.enableHint')}
            >
              <Switch
                checked={editing.enabled}
                onChange={enabled => setEditing({ ...editing, enabled })}
              />
            </Form.Item>
          </Form>
        )}
      </Drawer>
      <Drawer
        getContainer={false}
        rootClassName="octop-surface octop-drawer-root"
        open={importOpen}
        width={460}
        title={t('personalization.importSkills')}
        onClose={() => setImportOpen(false)}
      >
        <Form layout="vertical">
          <Form.Item label={t('personalization.importFromPackage')}>
            <Select
              aria-label={t('personalization.importFromPackage')}
              value={importSlug || undefined}
              onChange={setImportSlug}
              options={available.map(file => ({ label: file.slug, value: file.slug }))}
            />
          </Form.Item>
          <Button
            disabled={!importSlug || busy}
            onClick={() =>
              void act(async signal => {
                const file = available.find(value => value.slug === importSlug)
                if (!file) return
                const value = await client.controller.call<{ content: string }>(
                  'assistant/package/read',
                  { id: item.definition.id, path: file.path },
                  undefined,
                  signal
                )
                signal.throwIfAborted()
                setImportOpen(false)
                edit(skillSnapshot(file.slug, value.content))
              })
            }
          >
            {t('personalization.reviewAdd')}
          </Button>
          <Form.Item
            label={t('personalization.importFile')}
            extra={t('personalization.importFileHint')}
          >
            <Input
              type="file"
              accept=".md,.json"
              disabled={busy}
              onChange={event => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (!file) return
                void act(async signal => {
                  if (file.size > 128 * 1024) throw new Error('FILE_LIMIT')
                  const text = await file.text()
                  signal.throwIfAborted()
                  if (file.name.endsWith('.json')) {
                    const value = JSON.parse(text) as {
                      schemaVersion?: number
                      skills?: OfficeAssistantSkill[]
                    }
                    if (value.schemaVersion !== 1 || !Array.isArray(value.skills))
                      throw new Error('INVALID_FILE')
                    await save(
                      [...skills, ...value.skills.map(skill => ({ ...skill, enabled: false }))],
                      signal
                    )
                    setImportOpen(false)
                  } else {
                    setImportOpen(false)
                    edit(
                      skillSnapshot(
                        file.name.replace(/\.md$/i, '').replace(/[^a-zA-Z0-9_.-]/g, '-') ||
                          'imported-skill',
                        text
                      )
                    )
                  }
                })
              }}
            />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  )
}
