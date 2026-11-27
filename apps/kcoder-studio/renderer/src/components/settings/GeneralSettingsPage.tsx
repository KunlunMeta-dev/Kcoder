import { useEffect, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  SettingsGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSwitch,
} from './settings-ui'
import { applyLanguagePreference, languagePreferenceOptions } from '@/i18n/languagePreference'
import { MigrationDialog } from './MigrationDialog'
import { isKCoderGatewayPage } from '@/kcoder/gatewayRpc'
import { saveConversationPreferences } from '@/features/appearance/useConversationPreferences'
import { ClientAvatarSettings } from '@/features/appearance/ClientAvatar'
import {
  setInlineWidgetsEnabled,
  useInlineWidgetsEnabled,
} from '@/features/workbench/studioWorkMode'
import { useDesktopTrayAvailability } from '@/kcoder/useDesktopTrayAvailability'
import {
  defaultAppPreferences,
  getAppPreferences,
  updateAppPreferences,
  type AppLanguagePreference,
  type AppPreferences,
  type AppPreferencesPatch,
  type ConversationProcessDisplay,
} from '@/host/appPreferences'

type BooleanPreferenceKey = keyof AppPreferencesPatch

interface SwitchRowProps {
  preferenceKey: BooleanPreferenceKey
  testId: string
  label: string
  description?: string
}

const GENERAL_ROW_CLASS_NAME = 'py-4'
const GENERAL_ROW_LABEL_CLASS_NAME = 'font-normal'

function PreferenceSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-5">
      <h2 className="mb-2 text-sm font-semibold text-text-primary">{title}</h2>
      <SettingsGroup>{children}</SettingsGroup>
    </section>
  )
}

export function GeneralSettingsPage() {
  const { t } = useTranslation('common')
  const { t: migrationText } = useTranslation('migration')
  const gatewayRuntime = isKCoderGatewayPage()
  const trayAvailability = useDesktopTrayAvailability()
  const inlineWidgetsEnabled = useInlineWidgetsEnabled()
  const [preferences, setPreferences] = useState<AppPreferences>(defaultAppPreferences)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // `/migration` and `/migrate` open this page with `?migration=open`.
  const [showImportDialog, setShowImportDialog] = useState(
    () => new URLSearchParams(window.location.search).get('migration') === 'open'
  )
  const closeImportDialog = () => {
    setShowImportDialog(false)
    const params = new URLSearchParams(window.location.search)
    if (params.get('migration') !== 'open') return
    params.delete('migration')
    const search = params.toString()
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`
    )
  }

  useEffect(() => {
    let cancelled = false

    getAppPreferences()
      .then(nextPreferences => {
        if (!cancelled) {
          setPreferences(nextPreferences)
          setError(null)
        }
      })
      .catch(fetchError => {
        console.error('[KCoder Studio] Failed to load app preferences', fetchError)
        if (!cancelled) {
          setError(t('workbench.general_settings_load_failed'))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [t])

  const handlePreferenceChange = async (key: BooleanPreferenceKey, value: boolean) => {
    setPreferences(current => ({ ...current, [key]: value }))
    setSaving(true)
    setError(null)
    try {
      const nextPreferences = await updateAppPreferences({ [key]: value })
      setPreferences(nextPreferences)
    } catch (saveError) {
      console.error('[KCoder Studio] Failed to update app preferences', saveError)
      setPreferences(current => ({
        ...current,
        [key]: !value,
      }))
      setError(t('workbench.general_settings_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const renderSwitchRow = ({ preferenceKey, testId, label, description }: SwitchRowProps) => (
    <SettingsRow
      label={label}
      description={description && <span id={`${testId}-help`}>{description}</span>}
      className={GENERAL_ROW_CLASS_NAME}
      labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
      control={
        <SettingsSwitch
          data-testid={testId}
          checked={Boolean(preferences[preferenceKey])}
          disabled={loading || saving}
          onCheckedChange={checked => {
            void handlePreferenceChange(preferenceKey, checked)
          }}
          aria-label={label}
          aria-describedby={description ? `${testId}-help` : undefined}
        />
      }
    />
  )

  const handleLanguageChange = async (language: AppLanguagePreference) => {
    if (language === preferences.language) {
      return
    }

    const previousLanguage = preferences.language
    setPreferences(current => ({ ...current, language }))
    setSaving(true)
    setError(null)
    try {
      const nextPreferences = await updateAppPreferences({ language })
      setPreferences(nextPreferences)
      await applyLanguagePreference(nextPreferences.language)
    } catch (saveError) {
      console.error('[KCoder Studio] Failed to update app language preference', saveError)
      setPreferences(current => ({ ...current, language: previousLanguage }))
      setError(t('workbench.general_settings_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const handleProcessDisplayChange = async (conversationProcessDisplay: ConversationProcessDisplay) => {
    if (conversationProcessDisplay === preferences.conversationProcessDisplay) return
    const previous = preferences.conversationProcessDisplay
    setSaving(true)
    setError(null)
    setPreferences(current => ({ ...current, conversationProcessDisplay }))
    try {
      await saveConversationPreferences({ conversationProcessDisplay })
    } catch (saveError) {
      console.error('[KCoder Studio] Failed to update conversation display', saveError)
      setPreferences(current => ({ ...current, conversationProcessDisplay: previous }))
      setError(t('workbench.general_settings_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsPage data-testid="general-settings-page">
      <SettingsPageHeader
        title={t('workbench.general_settings_title')}
        description={t('workbench.general_settings_subtitle')}
      />

      <PreferenceSection title={t('workbench.general_sections.profile')}>
        <ClientAvatarSettings />
        <SettingsRow
          label={t('workbench.general_settings_language_preference')}
          description={t('workbench.general_settings_language_description')}
          className={GENERAL_ROW_CLASS_NAME}
          labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
          control={
            <div className="grid h-8 w-full shrink-0 grid-cols-3 rounded-md border border-border bg-background p-0.5 md:w-[300px]">
              {languagePreferenceOptions.map(option => {
                const active = preferences.language === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    data-testid={`general-language-${option.value}-button`}
                    disabled={loading || saving}
                    title={t(`workbench.${option.descriptionKey}`)}
                    aria-pressed={active}
                    onClick={() => void handleLanguageChange(option.value)}
                    className={[
                      'flex min-w-0 items-center justify-center rounded-[5px] px-2 text-sm font-medium leading-[18px] transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                      active
                        ? 'bg-text-primary text-background shadow-sm'
                        : 'text-text-secondary hover:bg-muted hover:text-text-primary',
                    ].join(' ')}
                  >
                    <span className="truncate">{t(`workbench.${option.shortLabelKey}`)}</span>
                  </button>
                )
              })}
            </div>
          }
        />
      </PreferenceSection>
      <PreferenceSection title={t('workbench.general_sections.conversation')}>
        <SettingsRow
          label={t('workbench.work_mode.inline_widgets')}
          description={t('workbench.work_mode.inline_widgets_help')}
          className={GENERAL_ROW_CLASS_NAME}
          labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
          control={
            <SettingsSwitch
              data-testid="general-inline-widgets-toggle"
              aria-label={t('workbench.work_mode.inline_widgets')}
              checked={inlineWidgetsEnabled}
              onCheckedChange={setInlineWidgetsEnabled}
            />
          }
        />
        <SettingsRow
          label={t('workbench.conversation_process_display.title')}
          description={t(`workbench.conversation_process_display.${preferences.conversationProcessDisplay}_help`)}
          className={GENERAL_ROW_CLASS_NAME}
          labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
          control={
            <div role="group" aria-label={t('workbench.conversation_process_display.title')}
              className="grid h-8 max-w-full grid-cols-2 rounded-md border border-border bg-background p-0.5">
              {(['two-level-v1', 'three-level-v1'] as const).map(value => (
                <button key={value} type="button" data-testid={`general-process-display-${value}`}
                  aria-pressed={preferences.conversationProcessDisplay === value}
                  disabled={loading || saving} onClick={() => void handleProcessDisplayChange(value)}
                  className={`min-w-0 truncate rounded-md px-3 text-sm disabled:opacity-60 ${
                    preferences.conversationProcessDisplay === value
                      ? 'bg-text-primary text-background' : 'text-text-secondary hover:bg-muted'}`}>
                  {t(`workbench.conversation_process_display.${value}`)}
                </button>
              ))}
            </div>
          }
        />
      </PreferenceSection>
      <PreferenceSection title={t('workbench.general_sections.app')}>
        {renderSwitchRow({
          preferenceKey: 'experimentalFeaturesEnabled',
          testId: 'general-experimental-features-toggle',
          label: t('workbench.general_settings_experimental_features'),
          description: t('workbench.general_settings_experimental_features_description'),
        })}
        {trayAvailability === 'available' &&
          renderSwitchRow({
            preferenceKey: 'closeToTrayEnabled',
            testId: 'general-close-to-tray-toggle',
            label: t('workbench.general_settings_close_to_tray'),
            description: preferences.closeToTrayEnabled
              ? t('workbench.general_settings_background_description')
              : t('workbench.general_settings_background_disabled_description'),
          })}
      </PreferenceSection>
      {gatewayRuntime && (
        <PreferenceSection title={t('workbench.general_sections.data')}>
          <SettingsRow
            label={migrationText('row_title')}
            description={migrationText('row_description')}
            className={GENERAL_ROW_CLASS_NAME}
            labelClassName={GENERAL_ROW_LABEL_CLASS_NAME}
            control={
              <button
                type="button"
                data-testid="general-external-content-import-button"
                onClick={() => setShowImportDialog(true)}
                className="h-8 rounded-md bg-surface px-3 text-sm font-medium text-text-primary hover:bg-muted"
              >
                {migrationText('row_action')}
              </button>
            }
          />
        </PreferenceSection>
      )}

      {(loading || saving || error) && (
        <div
          data-testid="general-settings-status"
          className="mt-4 flex items-center gap-2 text-xs text-text-secondary"
        >
          {(loading || saving) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <span>
            {error ??
              (loading ? t('common.loading', '加载中...') : t('workbench.general_settings_saving'))}
          </span>
        </div>
      )}
      {gatewayRuntime && showImportDialog && (
        <MigrationDialog onClose={closeImportDialog} />
      )}
    </SettingsPage>
  )
}
