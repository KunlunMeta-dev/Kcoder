import { useEffect } from 'react'
import { KCoderServersSettingsPage } from '@/components/settings/KCoderServersSettingsPage'

// Account settings use authenticated Gateway HTTP and do not require an app-server.
export function KCoderAccountStartup({ onChanged }: { onChanged: () => Promise<void> }) {
  useEffect(() => {
    const changed = () => void onChanged()
    window.addEventListener('kcoder:servers-changed', changed)
    return () => window.removeEventListener('kcoder:servers-changed', changed)
  }, [onChanged])
  return (
    <main
      data-testid="kcoder-account-startup"
      className="h-dvh overflow-auto bg-background p-6 text-text-primary"
    >
      <KCoderServersSettingsPage />
    </main>
  )
}
