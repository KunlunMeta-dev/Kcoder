import { useState } from 'react'
import { DesktopEmptyTaskLauncher } from '../../src/components/layout/DesktopEmptyTaskLauncher'
import { StudioWorkModeSwitcher } from '../../src/components/layout/StudioWorkModeSwitcher'
import { GeneralSettingsPage } from '../../src/components/settings/GeneralSettingsPage'

export function WorkModeFixture() {
  const [draft, setDraft] = useState('保留草稿')
  const [settings, setSettings] = useState(false)
  return (
    <div className="flex h-dvh min-w-0 flex-col bg-background text-text-primary">
      <header className="flex shrink-0 items-center border-b border-border/50 p-2">
        <div className="w-52">
          <StudioWorkModeSwitcher onNewChat={() => {}} />
        </div>
        <button
          className="ml-auto rounded-md px-3 py-2 text-sm hover:bg-muted"
          data-testid="fixture-mode-settings"
          onClick={() => setSettings(value => !value)}
        >
          Settings
        </button>
      </header>
      {settings ? (
        <div className="min-h-0 flex-1 overflow-auto p-6">
          <GeneralSettingsPage />
        </div>
      ) : (
        <DesktopEmptyTaskLauncher
          projectName="示例工作区"
          onOpenProjectSelector={() => {}}
          onSelectSuggestion={setDraft}
          composer={
            <textarea
              data-testid="chat-message-input"
              value={draft}
              onChange={event => setDraft(event.target.value)}
              className="min-h-24 w-full resize-none rounded-2xl border border-border bg-background p-4 text-base focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          }
        />
      )}
    </div>
  )
}
