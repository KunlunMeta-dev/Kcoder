import { ModalDialog } from '@/components/ui/modal-dialog'
import { Button } from '@/components/ui/button'
import { RuntimeTargetConfirmDialog } from './RuntimeTargetConfirmDialog'
import { localizeQuickPhrase } from '@/lib/quick-phrase-display'
import { ArrowDown, ArrowUp, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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

  useEffect(() => {
    void getAppPreferences().then(value => setPhrases(value.quickPhrases))
  }, [])

  const save = async (next: QuickPhrase[]) => {
    if (savingRef.current) return false
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
  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= phrases.length) return
    const next = [...phrases]
    ;[next[index], next[target]] = [next[target], next[index]]
    void save(next)
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
      />
      {error && !editing && !deleting && (
        <div
          role="alert"
          className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      <Button
        variant="ghost"
        type="button"
        data-testid="add-quick-phrase-button"
        onClick={event => {
          event.currentTarget.focus()
          setError('')
          setEditing(emptyPhrase())
        }}
        disabled={saving}
        className="mb-4 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 py-3 text-sm font-medium text-text-primary hover:border-blue-500 hover:bg-blue-500/5"
      >
        <Plus className="h-4 w-4" />
        {t('workbench.quick_phrase_add', '新增快捷短语')}
      </Button>
      <div className="space-y-1">
        {phrases.map((phrase, index) => (
          <div
            key={phrase.id}
            draggable
            onDragStart={() => setDraggedId(phrase.id)}
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
            className="flex min-h-14 items-center gap-2 rounded-xl px-2 py-2 hover:bg-muted"
          >
            <GripVertical className="h-4 w-4 cursor-grab text-text-muted" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {localizeQuickPhrase(phrase, t).title}
              </div>
              <div className="truncate text-xs text-text-muted">
                {localizeQuickPhrase(phrase, t).content}
              </div>
            </div>
            <span className="text-xs text-text-muted">
              {phrase.mode === 'normal'
                ? t('workbench.quick_phrase_mode_normal', '普通')
                : phrase.mode === 'plan'
                  ? t('workbench.quick_phrase_mode_plan', '计划')
                  : t('workbench.quick_phrase_mode_goal', '目标模式')}
            </span>
            <Button
              variant="ghost"
              type="button"
              data-testid={`quick-phrase-move-up-${phrase.id}`}
              onClick={() => move(index, -1)}
              disabled={saving || index === 0}
              className="h-8 w-8 rounded-lg p-2 hover:bg-background disabled:opacity-30"
              aria-label={t('workbench.move_up', '上移')}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              type="button"
              data-testid={`quick-phrase-move-down-${phrase.id}`}
              onClick={() => move(index, 1)}
              disabled={saving || index === phrases.length - 1}
              className="h-8 w-8 rounded-lg p-2 hover:bg-background disabled:opacity-30"
              aria-label={t('workbench.move_down', '下移')}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              type="button"
              data-testid={`quick-phrase-edit-${phrase.id}`}
              onClick={event => {
                event.currentTarget.focus()
                setError('')
                setEditing(localizeQuickPhrase(phrase, t))
              }}
              disabled={saving}
              className="h-8 w-8 rounded-lg p-2 hover:bg-background"
              aria-label={t('workbench.edit', '编辑')}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              type="button"
              data-testid={`quick-phrase-delete-${phrase.id}`}
              onClick={event => {
                event.currentTarget.focus()
                setError('')
                setDeleting(phrase)
              }}
              disabled={saving}
              className="h-8 w-8 rounded-lg p-2 text-destructive hover:bg-destructive/10"
              aria-label={t('workbench.delete', '删除')}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      {editing && (
        <ModalDialog
          testId="quick-phrase-editor"
          title={t('workbench.quick_phrase_edit', '编辑快捷短语')}
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
            <div className="mt-2 flex gap-4">
              {(['normal', 'plan', 'goal'] as QuickPhraseMode[]).map(mode => (
                <label key={mode} className="flex items-center gap-1.5 text-sm">
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
              className="h-8 rounded-lg px-3 text-sm hover:bg-muted"
            >
              {t('common.cancel', '取消')}
            </Button>
            <Button
              type="button"
              data-testid="quick-phrase-save-button"
              disabled={saving}
              onClick={commitEditing}
              className="h-8 rounded-lg bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90"
            >
              {t('common.save', '保存')}
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
