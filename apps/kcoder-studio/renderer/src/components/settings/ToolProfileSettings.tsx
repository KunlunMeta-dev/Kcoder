import { useEffect, useRef, useState } from 'react'
import { Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import {
  readToolProfile,
  saveToolProfile,
  TOOL_PROFILES,
  type ToolProfile,
  type ToolProfileSettings as ProfileSettings,
} from '@/kcoder/toolProfiles'
import { SettingsSelect } from './SettingsSelect'
import { SettingsGroup, SettingsRow } from './settings-ui'

export function ToolProfileSettings({ serverId }: { serverId: string }) {
  return <ToolProfileEditor key={serverId} serverId={serverId} />
}

function ToolProfileEditor({ serverId }: { serverId: string }) {
  const { t } = useTranslation('common')
  const [loaded, setLoaded] = useState<ProfileSettings | null>(null)
  const [profile, setProfile] = useState<ToolProfile>('full')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const generation = useRef(0)

  useEffect(() => {
    const current = ++generation.current
    if (serverId) {
      void readToolProfile(serverId).then(
        value => {
          if (generation.current !== current) return
          setLoaded(value)
          setProfile(value.profile)
        },
        failure => {
          if (generation.current === current)
            setError(failure instanceof Error ? failure.message : t('toolProfile.loadFailed'))
        }
      )
    }
    return () => {
      generation.current = current + 1
    }
  }, [serverId, reload, t])

  const save = async () => {
    const current = generation.current
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const value = await saveToolProfile(serverId, profile)
      if (generation.current !== current) return
      setLoaded(value)
      setProfile(value.profile)
      setSaved(true)
    } catch (failure) {
      if (generation.current === current)
        setError(failure instanceof Error ? failure.message : t('toolProfile.saveFailed'))
    } finally {
      if (generation.current === current) setSaving(false)
    }
  }

  return (
    <SettingsGroup className="mb-4" data-testid="tool-profile-settings">
      <SettingsRow
        label={<label htmlFor="runtime-tool-profile">{t('toolProfile.title')}</label>}
        description={t('toolProfile.description')}
        control={
          <div className="flex flex-wrap items-center gap-2">
            <SettingsSelect
              id="runtime-tool-profile"
              data-testid="tool-profile-select"
              icon={<Wrench className="h-4 w-4" />}
              value={profile}
              disabled={!loaded || saving}
              onChange={event => {
                setProfile(event.target.value as ToolProfile)
                setSaved(false)
              }}
            >
              {TOOL_PROFILES.map(value => (
                <option key={value} value={value}>
                  {t(`toolProfile.${value}`)}
                </option>
              ))}
            </SettingsSelect>
            <Button
              size="sm"
              data-testid="tool-profile-save"
              disabled={!loaded || saving || profile === loaded.profile}
              onClick={() => void save()}
            >
              {t(saving ? 'toolProfile.saving' : 'toolProfile.save')}
            </Button>
          </div>
        }
      />
      <div className="space-y-2 px-4 py-3 text-sm text-text-secondary">
        <p data-testid="tool-profile-help">{t(`toolProfile.${profile}Help`)}</p>
        <p>{t('toolProfile.appliesToNewSessions')}</p>
        {loaded?.cliOverride && (
          <p data-testid="tool-profile-cli-override">
            {t('toolProfile.cliOverride', { profile: loaded.effectiveProfile })}
          </p>
        )}
        {!serverId && <p>{t('toolProfile.chooseTarget')}</p>}
        {saved && <p role="status">{t('toolProfile.saved')}</p>}
        {error && (
          <div role="alert" className="break-words text-destructive">
            {error}
            <Button
              variant="ghost"
              size="sm"
              data-testid="tool-profile-reload"
              disabled={saving}
              onClick={() => {
                setLoaded(null)
                setProfile('full')
                setError(null)
                setSaved(false)
                setReload(value => value + 1)
              }}
            >
              {t('toolProfile.reload')}
            </Button>
          </div>
        )}
      </div>
    </SettingsGroup>
  )
}
