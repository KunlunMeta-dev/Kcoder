import { DesktopMenuBar } from '../../src/kcoder/DesktopMenuBar'
import { ConnectionsSettingsPage } from '../../src/components/settings/ConnectionsSettingsPage'

/** Synthetic presentation fixture; it never creates tasks or changes a target. */
export default function SettingsSidebarFixture() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <DesktopMenuBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ConnectionsSettingsPage onBack={() => {}} />
      </div>
    </div>
  )
}
