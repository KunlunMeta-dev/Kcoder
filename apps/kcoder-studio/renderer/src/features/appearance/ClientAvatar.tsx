import { useState, type ReactNode } from 'react'
import { UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { selectClientImage } from '@/lib/client-image'
import { saveClientAvatar, useClientAvatar } from './clientAvatarStore'

export function ClientAvatar({ fallback }: { fallback?: ReactNode }) {
  const avatar = useClientAvatar()
  const [failed, setFailed] = useState<string | null>(null)
  return avatar && failed !== avatar ? (
    <img
      data-testid="client-avatar-image"
      src={avatar}
      alt=""
      className="h-full w-full rounded-full object-cover"
      onError={() => setFailed(avatar)}
    />
  ) : (
    (fallback ?? <UserRound className="h-5 w-5" aria-hidden="true" />)
  )
}

export function ClientAvatarSettings() {
  const { t } = useTranslation('common')
  const avatar = useClientAvatar()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const update = async (remove: boolean) => {
    setBusy(true)
    setError(false)
    try {
      if (remove) saveClientAvatar(null)
      else {
        const value = await selectClientImage('avatar')
        if (value) saveClientAvatar(value)
      }
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mb-6 border-b border-border py-4" data-testid="client-avatar-settings">
      <div className="flex flex-wrap items-center gap-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface text-text-secondary">
          <ClientAvatar />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-medium">{t('profile.avatar')}</h2>
          <p className="text-sm text-text-secondary">{t('profile.avatarHelp')}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="max-md:min-h-11"
          data-testid="client-avatar-select"
          disabled={busy}
          onClick={() => void update(false)}
        >
          {t('profile.changeAvatar')}
        </Button>
        {avatar && (
          <Button
            variant="ghost"
            size="sm"
            className="max-md:min-h-11"
            data-testid="client-avatar-remove"
            disabled={busy}
            onClick={() => void update(true)}
          >
            {t('profile.resetAvatar')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-500">
          {t('profile.avatarError')}
        </p>
      )}
    </section>
  )
}
