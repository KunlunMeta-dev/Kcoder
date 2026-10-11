import { CornerDownLeft, Loader2, RotateCcw, Search, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { createLocalAppServices } from '@/api/local/localServices'
import { useTranslation } from '@/hooks/useTranslation'
import { SettingsPage, SettingsPageHeader } from './settings-ui'
import { keybindingPartDisplay } from '@/lib/keyboard-platform'
import {
  getDefaultKeybindings,
  GO_BACK_COMMAND,
  GO_FORWARD_COMMAND,
  INCREASE_FONT_SIZE_COMMAND,
  DECREASE_FONT_SIZE_COMMAND,
  RESET_FONT_SIZE_COMMAND,
  KEYBINDINGS_CHANGED_EVENT,
  OPEN_SETTINGS_COMMAND,
  OPEN_TERMINAL_COMMAND,
  TOGGLE_SIDEBAR_COMMAND,
  TOGGLE_SIDE_PANEL_COMMAND,
  TOGGLE_MODEL_SELECTOR_COMMAND,
  keybindingFromKeyboardEvent,
  mergeKeybindings,
  normalizeKeybinding,
  shortcutsAvailable,
  type KeybindingOverride,
} from '@/lib/keybindings'

const COMMAND_LABELS: Record<string, { label: string; description: string }> = {
  [OPEN_TERMINAL_COMMAND]: {
    label: 'keyboard_shortcuts_open_terminal',
    description: 'keyboard_shortcuts_open_terminal_description',
  },
  [OPEN_SETTINGS_COMMAND]: {
    label: 'keyboard_shortcuts_open_settings',
    description: 'keyboard_shortcuts_open_settings_description',
  },
  [GO_BACK_COMMAND]: {
    label: 'keyboard_shortcuts_go_back',
    description: 'keyboard_shortcuts_go_back_description',
  },
  [GO_FORWARD_COMMAND]: {
    label: 'keyboard_shortcuts_go_forward',
    description: 'keyboard_shortcuts_go_forward_description',
  },
  [TOGGLE_SIDEBAR_COMMAND]: {
    label: 'keyboard_shortcuts_toggle_sidebar',
    description: 'keyboard_shortcuts_toggle_sidebar_description',
  },
  [TOGGLE_SIDE_PANEL_COMMAND]: {
    label: 'keyboard_shortcuts_toggle_side_panel',
    description: 'keyboard_shortcuts_toggle_side_panel_description',
  },
  [TOGGLE_MODEL_SELECTOR_COMMAND]: {
    label: 'keyboard_shortcuts_toggle_model_selector',
    description: 'keyboard_shortcuts_toggle_model_selector_description',
  },
  [INCREASE_FONT_SIZE_COMMAND]: {
    label: 'keyboard_shortcuts_increase_font_size',
    description: 'keyboard_shortcuts_increase_font_size_description',
  },
  [DECREASE_FONT_SIZE_COMMAND]: {
    label: 'keyboard_shortcuts_decrease_font_size',
    description: 'keyboard_shortcuts_decrease_font_size_description',
  },
  [RESET_FONT_SIZE_COMMAND]: {
    label: 'keyboard_shortcuts_reset_font_size',
    description: 'keyboard_shortcuts_reset_font_size_description',
  },
}

function commandFallback(command: string): string {
  if (command === OPEN_SETTINGS_COMMAND) return '打开设置'
  if (command === GO_BACK_COMMAND) return '返回'
  if (command === GO_FORWARD_COMMAND) return '前进'
  if (command === TOGGLE_SIDEBAR_COMMAND) return '切换边栏'
  if (command === TOGGLE_SIDE_PANEL_COMMAND) return '切换侧边面板'
  if (command === TOGGLE_MODEL_SELECTOR_COMMAND) return '选择模型'
  if (command === INCREASE_FONT_SIZE_COMMAND) return '增大字号'
  if (command === DECREASE_FONT_SIZE_COMMAND) return '减小字号'
  if (command === RESET_FONT_SIZE_COMMAND) return '重置字号'
  return command === OPEN_TERMINAL_COMMAND ? '切换底部面板' : command
}

function commandDescriptionFallback(command: string): string {
  if (command === OPEN_SETTINGS_COMMAND) return '打开设置页面'
  if (command === GO_BACK_COMMAND) return '返回导航历史'
  if (command === GO_FORWARD_COMMAND) return '前进导航历史'
  if (command === TOGGLE_SIDEBAR_COMMAND) return '显示或隐藏边栏'
  if (command === TOGGLE_SIDE_PANEL_COMMAND) return '显示或隐藏侧边面板'
  if (command === TOGGLE_MODEL_SELECTOR_COMMAND) return '打开或关闭当前输入区的模型选择器'
  if (command === INCREASE_FONT_SIZE_COMMAND) return '同时增大 UI 和代码字号'
  if (command === DECREASE_FONT_SIZE_COMMAND) return '同时减小 UI 和代码字号'
  if (command === RESET_FONT_SIZE_COMMAND) return '将 UI 和代码字号恢复为默认值'
  return command === OPEN_TERMINAL_COMMAND ? '显示或隐藏底部面板' : ''
}

function KeybindingPill({ value }: { value: string }) {
  const { t } = useTranslation('common')
  const displayValue = value === 'Mouse Back' ? t('workbench.keyboard_mouse_back') : value === 'Mouse Forward' ? t('workbench.keyboard_mouse_forward') : value
  return (
    <span className="inline-flex min-h-7 items-center rounded-full bg-muted px-2.5 text-sm font-medium leading-[18px] text-text-secondary">
      {displayValue.split('+').map((part, index) => (
        <span key={`${part}-${index}`} className="inline-flex items-center">
          {index > 0 ? <span className="mx-0.5"> </span> : null}
          <KeybindingPart value={part} />
        </span>
      ))}
    </span>
  )
}

function KeybindingPart({ value }: { value: string }) {
  if (value === 'Enter') return <CornerDownLeft className="h-3.5 w-3.5" aria-label="Enter" />
  const { text, label } = keybindingPartDisplay(value)
  return <span aria-label={label}>{text}</span>
}

export function KeyboardShortcutsSettingsPage() {
  const { t } = useTranslation('common')
  const [overrides, setOverrides] = useState<KeybindingOverride[]>([])
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [savingCommand, setSavingCommand] = useState<string | null>(null)
  const [recordingCommand, setRecordingCommand] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const mutation = useRef(false)
  const recorder = useRef<HTMLButtonElement | null>(null)

  const defaults = useMemo(() => getDefaultKeybindings(), [])
  const bindings = useMemo(() => mergeKeybindings(overrides), [overrides])
  const filteredCommands = useMemo(() => {
    const trimmedQuery = query.trim().toLowerCase()
    if (!trimmedQuery) return defaults
    return defaults.filter(item => {
      const labels = COMMAND_LABELS[item.command]
      const label = t(`workbench.${labels.label}`, commandFallback(item.command)).toLowerCase()
      const description = t(
        `workbench.${labels.description}`,
        commandDescriptionFallback(item.command)
      ).toLowerCase()
      return (
        item.command.toLowerCase().includes(trimmedQuery) ||
        label.includes(trimmedQuery) ||
        description.includes(trimmedQuery)
      )
    })
  }, [defaults, query, t])

  const saveOverride = useCallback(
    async (command: string, key: string | null) => {
      if (mutation.current || loading || !loaded) return
      const normalized = key ? normalizeKeybinding(key) : null
      const conflict =
        normalized &&
        Object.entries(bindings).find(
          ([other, value]) => other !== command && normalizeKeybinding(value ?? '') === normalized
        )
      if (conflict) {
        const labels = COMMAND_LABELS[conflict[0]]
        setError(
          `${t('workbench.keyboard_shortcuts_conflict')}: ${labels ? t(`workbench.${labels.label}`, commandFallback(conflict[0])) : conflict[0]}`
        )
        setSaved(false)
        return
      }
      mutation.current = true
      setSaved(false)
      const nextOverrides = [
        ...overrides.filter(item => item.command !== command),
        { command, key },
      ].filter(
        item =>
          normalizeKeybinding(item.key ?? '') !==
          normalizeKeybinding(
            defaults.find(base => base.command === item.command)?.defaultKey ?? ''
          )
      )

      setSavingCommand(command)
      setError(null)
      try {
        const response = await createLocalAppServices().runtimeWorkApi?.updateKeybindings({
          keybindings: nextOverrides,
        })
        setOverrides(response?.keybindings ?? nextOverrides)
        setRecordingCommand(null)
        setSaved(true)
        window.dispatchEvent(new CustomEvent(KEYBINDINGS_CHANGED_EVENT))
      } catch (saveError) {
        console.error('[KCoder Studio] Failed to save keybindings:', saveError)
        setError(t('workbench.keyboard_shortcuts_save_failed', '快捷键保存失败'))
      } finally {
        mutation.current = false
        setSavingCommand(null)
        requestAnimationFrame(() => recorder.current?.focus())
      }
    },
    [bindings, defaults, loaded, loading, overrides, t]
  )

  useEffect(() => {
    let active = true
    const load = async () => {
      if (!shortcutsAvailable()) {
        setLoading(false)
        return
      }
      try {
        setError(null)
        const response = await createLocalAppServices().runtimeWorkApi?.getKeybindings()
        if (active) {
          setOverrides(response?.keybindings ?? [])
          setLoaded(true)
        }
      } catch (loadError) {
        console.error('[KCoder Studio] Failed to load keybindings:', loadError)
        if (active) setError(t('workbench.keyboard_shortcuts_load_failed', '快捷键加载失败'))
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [loadAttempt, t])

  useEffect(() => {
    if (!recordingCommand) return undefined

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (mutation.current || event.repeat) return
      if (event.key === 'Escape') {
        setRecordingCommand(null)
        recorder.current?.focus()
        return
      }

      const key = normalizeKeybinding(keybindingFromKeyboardEvent(event))
      if (!key || !key.includes('+')) return
      void saveOverride(recordingCommand, key)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [recordingCommand, saveOverride])

  return (
    <SettingsPage data-testid="keyboard-shortcuts-settings-page">
      <SettingsPageHeader
        title={t('workbench.keyboard_shortcuts_title', '键盘快捷键')}
        description={t('workbench.keyboard_shortcuts_description', '管理当前设备上的本地快捷键')}
      />
      <div className="relative mb-6 max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <input
          data-testid="keyboard-shortcuts-search-input"
          aria-label={t('workbench.keyboard_shortcuts_search')}
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={t('workbench.keyboard_shortcuts_search', '搜索快捷键')}
          className="h-8 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm leading-[18px] outline-none focus:border-primary"
        />
      </div>
      <div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', '加载中...')}
          </div>
        ) : null}
        {error ? (
          <div
            role="alert"
            data-testid="keyboard-shortcuts-error"
            className="mb-4 text-sm text-red-500"
          >
            {error}
            {!loaded && (
              <Button
                variant="outline"
                className="mt-2"
                data-testid="keyboard-shortcuts-retry"
                onClick={() => {
                  setLoading(true)
                  setError(null)
                  setLoadAttempt(value => value + 1)
                }}
              >
                {t('common.retry')}
              </Button>
            )}
          </div>
        ) : null}
        {saved && (
          <p role="status" className="mb-4 text-sm text-text-secondary">
            {t('workbench.keyboard_shortcuts_saved')}
          </p>
        )}
        <div className="overflow-hidden rounded-lg border border-border">
          {filteredCommands.map(item => {
            const labels = COMMAND_LABELS[item.command]
            const currentKey = bindings[item.command]
            const saving = savingCommand === item.command
            const recording = recordingCommand === item.command
            return (
              <div
                key={item.command}
                data-testid={`keyboard-shortcut-row-${item.command}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_minmax(0,220px)_72px] items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="col-span-2 min-w-0 md:col-span-1">
                  <div className="text-sm font-medium text-text-primary">
                    {t(`workbench.${labels.label}`, commandFallback(item.command))}
                  </div>
                  <div className="mt-0.5 text-xs leading-4 text-text-secondary">
                    {t(`workbench.${labels.description}`, commandDescriptionFallback(item.command))}
                  </div>
                </div>
                <div className="flex flex-col items-start gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    data-testid={`keyboard-shortcut-record-${item.command}`}
                    aria-label={t(`workbench.${labels.label}`, commandFallback(item.command))}
                    aria-pressed={recording}
                    onClick={event => {
                      recorder.current = event.currentTarget
                      event.currentTarget.focus()
                      setError(null)
                      setSaved(false)
                      setRecordingCommand(item.command)
                    }}
                    disabled={loading || !loaded || savingCommand !== null}
                    className="inline-flex min-h-8 items-center justify-start text-left disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {recording ? (
                      <span className="inline-flex min-h-7 items-center rounded-full bg-primary/10 px-2.5 text-sm font-medium leading-[18px] text-primary">
                        {t('workbench.keyboard_shortcuts_recording', '按下快捷键')}
                      </span>
                    ) : currentKey ? (
                      <KeybindingPill value={currentKey} />
                    ) : (
                      <span className="text-sm leading-[18px] text-text-muted">
                        {t('workbench.keyboard_shortcuts_unassigned', '未设置')}
                      </span>
                    )}
                  </Button>
                  {item.secondaryKeys?.map(key => (
                    <KeybindingPill key={key} value={key} />
                  ))}
                </div>
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    data-testid={`keyboard-shortcut-reset-${item.command}`}
                    onClick={() => void saveOverride(item.command, item.defaultKey)}
                    disabled={loading || !loaded || savingCommand !== null}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
                    title={t('workbench.keyboard_shortcuts_reset', '恢复默认')}
                    aria-label={t('workbench.keyboard_shortcuts_reset', '恢复默认')}
                  >
                    {saving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    data-testid={`keyboard-shortcut-clear-${item.command}`}
                    onClick={() => void saveOverride(item.command, null)}
                    disabled={loading || !loaded || savingCommand !== null}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
                    title={t('workbench.keyboard_shortcuts_clear', '清除')}
                    aria-label={t('workbench.keyboard_shortcuts_clear', '清除')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </SettingsPage>
  )
}
