import { ModalDialog } from '@/components/ui/modal-dialog'
import { Button } from '@/components/ui/button'
import { ActionMenu } from '@/components/common/ActionMenu'
import { RuntimeTargetConfirmDialog } from './RuntimeTargetConfirmDialog'
import { localizeQuickPhrase } from '@/lib/quick-phrase-display'
import { ArrowDown, ArrowUp, GripVertical, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { createRandomUuid } from '@/lib/random-id'
import {
  getAppPreferences,
  updateAppPreferences,
  type QuickPhrase,
  type QuickPhraseMode,
} from '@/tauri/appPreferences'
import { SettingsPage, SettingsPageHeader } from './settings-ui'

const emptyPhrase = (): QuickPhrase => ({
  id: createRandomUuid(),
  title: '',
  content: '',
  mode: 'normal',
})

export function QuickPhrasesSettingsPage() {
  const { t } = useTranslation('common')
  const [phrases, setPhrases] = useState<QuickPhrase[]>([])
  const [editing, setEditing] = useState<QuickPhrase | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [deleting, setDeleting] = useState<QuickPhrase | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const loadRevision = useRef(0)
  const load = useCallback(async () => {
    const current = ++loadRevision.current
    setLoadState('loading')
    try {
      const preferences = await getAppPreferences()
      if (current === loadRevision.current) {
        setPhrases(preferences.quickPhrases)
        setLoadState('ready')
      }
    } catch {
      if (current === loadRevision.current) setLoadState('error')
    }
  }, [])

  useEffect(() => {
    let active = true
    const revision = loadRevision
    queueMicrotask(() => {
      if (active) void load()
    })
    return () => {
      active = false
      ++revision.current
    }
  }, [load])

  const save = async (next: QuickPhrase[]) => {
    if (savingRef.current || loadState !== 'ready') return false
    savingRef.current = true
    setSaving(true)
    try {
      await updateAppPreferences({ quickPhrases: next })
      setPhrases(next)
      setError('')
      return true
    } catch {
      setError(t('workbench.quick_phrases_save_error', '无法保存快捷短语，请重试'))
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  const move = async (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= phrases.length) return
    const next = [...phrases]
    ;[next[index], next[target]] = [next[target], next[index]]
    await save(next)
  }
  const commitEditing = async () => {
    if (!editing?.title.trim() || !editing.content.trim()) {
      setError(t('workbench.quick_phrase_required', '标题和内容不能为空'))
      return
    }
    const normalized = { ...editing, title: editing.title.trim(), content: editing.content.trim() }
    const exists = phrases.some(item => item.id === editing.id)
    const saved = await save(
      exists
        ? phrases.map(item => (item.id === editing.id ? normalized : item))
        : [...phrases, normalized]
    )
    if (saved) setEditing(null)
  }

  return (
    <SettingsPage data-testid="quick-phrases-settings-page">
      <SettingsPageHeader
        title={t('workbench.quick_phrases', '快捷短语')}
        description={t('workbench.quick_phrases_description', '创建和排序输入框中常用的短语。')}
        actions={
          <Button
            type="button"
            size="sm"
            data-testid="add-quick-phrase-button"
            disabled={saving || loadState !== 'ready'}
            className="max-md:min-h-11"
            onClick={event => {
              event.currentTarget.focus()
              setError('')
              setEditing(emptyPhrase())
            }}
          >
            <Plus className="h-4 w-4" />
            {t('workbench.quick_phrase_add', '新增快捷短语')}
          </Button>
        }
      />
      {loadState === 'loading' && (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-text-secondary"
          data-testid="quick-phrases-loading"
        >
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          {t('workbench.quick_phrases_loading')}
        </p>
      )}
      {loadState === 'error' && (
        <div
          role="alert"
          data-testid="quick-phrases-load-error"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-destructive/5 p-3 text-sm text-destructive"
        >
          <span>{t('workbench.quick_phrases_load_error')}</span>
          <Button
            variant="outline"
            size="sm"
            data-testid="quick-phrases-retry"
            className="max-md:min-h-11"
            onClick={() => void load()}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}
      {loadState === 'ready' && !phrases.length && (
        <p className="py-8 text-center text-sm text-text-muted">
          {t('workbench.quick_phrases_none')}
        </p>
      )}
      {error && !editing && !deleting && (
        <div
          role="alert"
          className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      {saving && !editing && !deleting && (
        <p role="status" className="mb-2 flex items-center gap-2 text-sm text-text-secondary">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          {t('common.saving')}
        </p>
      )}
      <div className="divide-y divide-border/40" aria-busy={saving || loadState === 'loading'}>
        {phrases.map((phrase, index) => (
          <div
            key={phrase.id}
            data-testid={`quick-phrase-row-${phrase.id}`}
            draggable={!saving && loadState === 'ready'}
            onDragStart={() => setDraggedId(phrase.id)}
            onDragEnd={() => setDraggedId(null)}
            onDragOver={event => event.preventDefault()}
            onDrop={() => {
              const from = phrases.findIndex(item => item.id === draggedId)
              if (from < 0 || from === index) return
              const next = [...phrases]
              const [item] = next.splice(from, 1)
              next.splice(index, 0, item)
              setDraggedId(null)
              void save(next)
            }}
            className="group flex min-h-14 items-center gap-2 rounded-lg px-2 py-2 hover:bg-muted/50"
          >
            <GripVertical
              aria-hidden="true"
              className="hidden h-4 w-4 shrink-0 cursor-grab text-text-muted md:block"
            />
            <button
              type="button"
              data-testid={`quick-phrase-edit-${phrase.id}`}
              disabled={saving || loadState !== 'ready'}
              className="min-h-11 min-w-0 flex-1 rounded-lg px-1 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50 disabled:opacity-50"
              onClick={event => {
                event.currentTarget.focus()
                setError('')
                setEditing(localizeQuickPhrase(phrase, t))
              }}
            >
              <span className="block truncate text-sm font-medium text-text-primary">
                {localizeQuickPhrase(phrase, t).title}
              </span>
              <span className="mt-1 block line-clamp-2 text-xs leading-relaxed text-text-secondary">
                {localizeQuickPhrase(phrase, t).content}
              </span>
              <span className="mt-1 block text-xs text-text-muted">
                {t(`workbench.quick_phrase_mode_${phrase.mode}`)}
              </span>
            </button>
            <ActionMenu
              testId={`quick-phrase-actions-${phrase.id}`}
              placement="bottom-end"
              disabled={saving || loadState !== 'ready'}
              ariaLabel={t('workbench.quick_phrase_actions', {
                title: localizeQuickPhrase(phrase, t).title,
              })}
              items={[
                {
                  label: t('workbench.move_up', '上移'),
                  icon: ArrowUp,
                  testId: `quick-phrase-move-up-${phrase.id}`,
                  disabled: index === 0,
                  onSelect: () => move(index, -1),
                },
                {
                  label: t('workbench.move_down', '下移'),
                  icon: ArrowDown,
                  testId: `quick-phrase-move-down-${phrase.id}`,
                  disabled: index === phrases.length - 1,
                  onSelect: () => move(index, 1),
                },
                {
                  label: t('workbench.delete', '删除'),
                  icon: Trash2,
                  testId: `quick-phrase-delete-${phrase.id}`,
                  danger: true,
                  onSelect: () => {
                    setError('')
                    setDeleting(phrase)
                  },
                },
              ]}
            />
          </div>
        ))}
      </div>
      {editing && (
        <ModalDialog
          testId="quick-phrase-editor"
          title={t(
            phrases.some(phrase => phrase.id === editing.id)
              ? 'workbench.quick_phrase_edit'
              : 'workbench.quick_phrase_add'
          )}
          pending={saving}
          onClose={() => setEditing(null)}
        >
          {error && (
            <div
              role="alert"
              className="mt-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          )}
          <label className="mt-4 block text-sm">
            {t('workbench.quick_phrase_title', '标题')}
            <input
              disabled={saving}
              data-testid="quick-phrase-title-input"
              value={editing.title}
              onChange={event => setEditing({ ...editing, title: event.target.value })}
              className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 outline-none focus:border-focus"
            />
          </label>
          <label className="mt-3 block text-sm">
            {t('workbench.quick_phrase_content', '内容')}
            <textarea
              data-testid="quick-phrase-content-input"
              value={editing.content}
              onChange={event => setEditing({ ...editing, content: event.target.value })}
              disabled={saving}
              rows={5}
              className="mt-1 w-full resize-y rounded-lg border border-border bg-background p-3 outline-none focus:border-focus"
            />
          </label>
          <fieldset className="mt-3">
            <legend className="text-sm">{t('workbench.quick_phrase_mode', '使用模式')}</legend>
            <div className="mt-2 flex flex-wrap gap-2 md:gap-4">
              {(['normal', 'plan', 'goal'] as QuickPhraseMode[]).map(mode => (
                <label
                  key={mode}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm hover:bg-muted"
                >
                  <input
                    type="radio"
                    disabled={saving}
                    className="accent-foreground"
                    data-testid={`quick-phrase-mode-${mode}`}
                    checked={editing.mode === mode}
                    onChange={() => setEditing({ ...editing, mode })}
                  />
                  {mode === 'normal'
                    ? t('workbench.quick_phrase_mode_normal', '普通')
                    : mode === 'plan'
                      ? t('workbench.quick_phrase_mode_plan', '计划模式')
                      : t('workbench.quick_phrase_mode_goal', '目标模式')}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="ghost"
              type="button"
              data-testid="quick-phrase-cancel-button"
              disabled={saving}
              onClick={() => setEditing(null)}
              className="h-8 rounded-lg px-3 text-sm hover:bg-muted max-md:min-h-11"
            >
              {t('common.cancel', '取消')}
            </Button>
            <Button
              type="button"
              data-testid="quick-phrase-save-button"
              disabled={saving}
              onClick={commitEditing}
              className="h-8 rounded-lg bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90 max-md:min-h-11"
            >
              {saving ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  {t('common.saving')}
                </>
              ) : (
                t('common.save', '保存')
              )}
            </Button>
          </div>
        </ModalDialog>
      )}
      {deleting && (
        <RuntimeTargetConfirmDialog
          testId="quick-phrase-delete-dialog"
          title={t('common.delete')}
          description={`${t('workbench.quick_phrase_delete_confirm')} ${localizeQuickPhrase(deleting, t).title}`}
          cancelLabel={t('common.cancel')}
          closeLabel={t('common.close')}
          confirmLabel={t('common.delete')}
          destructive
          pending={saving}
          error={error || undefined}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            void save(phrases.filter(item => item.id !== deleting.id)).then(saved => {
              if (saved) setDeleting(null)
            })
          }}
        />
      )}
    </SettingsPage>
  )
}
