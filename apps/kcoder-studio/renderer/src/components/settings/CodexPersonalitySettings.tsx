import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import {
  DEFAULT_CODEX_PERSONALITY,
  getLocalCodexPersonality,
  saveLocalCodexPersonality,
  type CodexPersonality,
} from '@/features/model-settings/localCodexSettings'
import { useTranslation } from '@/hooks/useTranslation'

const PERSONALITIES: CodexPersonality[] = ['friendly', 'pragmatic']

export function CodexPersonalitySettings({ deviceId }: { deviceId?: string }) {
  const { t } = useTranslation('common')
  const [personality, setPersonality] = useState<CodexPersonality>(DEFAULT_CODEX_PERSONALITY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [reload, setReload] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const deviceIdRef = useRef(deviceId)
  const operationGeneration = useRef(0)

  useEffect(() => {
    deviceIdRef.current = deviceId
  }, [deviceId])

  useEffect(() => {
    let cancelled = false
    operationGeneration.current += 1
    async function loadPersonality() {
      setLoading(true)
      setSaving(false)
      setOpen(false)
      setLoadError(false)
      setSaveError(false)
      try {
        const value = await (deviceId
          ? getLocalCodexPersonality(deviceId)
          : getLocalCodexPersonality())
        if (!cancelled) setPersonality(value)
      } catch (error) {
        if (!cancelled) setLoadError(true)
        console.error('[KCoder Studio] Failed to read interaction style', error)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadPersonality()
    return () => {
      cancelled = true
      operationGeneration.current += 1
    }
  }, [deviceId, reload])

  useEffect(() => {
    if (!open) return
    const closeMenu = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeMenu)
    return () => document.removeEventListener('mousedown', closeMenu)
  }, [open])

  const selectPersonality = async (nextPersonality: CodexPersonality) => {
    if (loading || saving || loadError) return
    const generation = operationGeneration.current
    const targetDeviceId = deviceId
    const previousPersonality = personality
    setPersonality(nextPersonality)
    setOpen(false)
    setSaving(true)
    setSaveError(false)
    try {
      const savedPersonality = await (targetDeviceId
        ? saveLocalCodexPersonality(nextPersonality, targetDeviceId)
        : saveLocalCodexPersonality(nextPersonality))
      if (deviceIdRef.current === targetDeviceId && generation === operationGeneration.current)
        setPersonality(savedPersonality)
    } catch (error) {
      if (deviceIdRef.current === targetDeviceId && generation === operationGeneration.current) {
        setPersonality(previousPersonality)
        setSaveError(true)
      }
      console.error('[KCoder Studio] Failed to write interaction style', error)
    } finally {
      if (deviceIdRef.current === targetDeviceId && generation === operationGeneration.current)
        setSaving(false)
    }
  }

  return (
    <section
      data-testid="interaction-style-settings"
      className="mt-4 rounded-xl border border-border bg-background px-4 py-4"
    >
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('workbench.codex_personality_title')}
          </h2>
          <p className="mt-1 text-xs leading-5 text-text-secondary">
            {t('workbench.codex_personality_description')}
          </p>
        </div>

        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            data-testid="codex-personality-select"
            aria-haspopup="listbox"
            aria-expanded={open}
            disabled={loading || saving || loadError}
            onClick={() => setOpen(current => !current)}
            className="inline-flex h-8 min-w-[104px] items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-text-primary transition-colors hover:bg-muted"
          >
            <span>
              {loadError
                ? t('workbench.interaction_style_not_loaded')
                : t(`workbench.codex_personality_${personality}`)}
            </span>
            {loading || saving ? (
              <Loader2 className="h-4 w-4 animate-spin text-text-secondary" />
            ) : (
              <ChevronDown
                className={`h-4 w-4 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`}
              />
            )}
          </button>

          {open ? (
            <div
              role="listbox"
              aria-label={t('workbench.codex_personality_title')}
              className="absolute right-0 top-10 z-50 w-64 overflow-hidden rounded-xl border border-border bg-background p-1.5 shadow-lg"
            >
              {PERSONALITIES.map(option => (
                <button
                  key={option}
                  type="button"
                  role="option"
                  aria-selected={personality === option}
                  data-testid={`codex-personality-option-${option}`}
                  onClick={() => void selectPersonality(option)}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left hover:bg-surface"
                >
                  <span>
                    <span className="block text-sm font-medium text-text-primary">
                      {t(`workbench.codex_personality_${option}`)}
                    </span>
                    <span className="mt-0.5 block text-xs leading-5 text-text-secondary">
                      {t(`workbench.codex_personality_${option}_description`)}
                    </span>
                  </span>
                  {personality === option ? (
                    <Check className="ml-3 h-4 w-4 shrink-0 text-text-primary" />
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {(loadError || saveError) && (
        <div className="mt-3 flex items-center gap-3 text-sm text-red-500">
          <p role="alert">
            {t(
              loadError
                ? 'workbench.interaction_style_load_failed'
                : 'workbench.interaction_style_save_failed'
            )}
          </p>
          {loadError && (
            <button
              type="button"
              data-testid="interaction-style-retry"
              onClick={() => setReload(value => value + 1)}
              className="min-h-11 rounded-lg px-3 text-text-primary hover:bg-muted"
            >
              {t('common.retry', '重试')}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
