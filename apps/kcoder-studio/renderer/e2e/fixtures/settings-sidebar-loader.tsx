import { lazy, Suspense } from 'react'

const SettingsSidebarFixture = lazy(() => import('./settings-sidebar'))

export default function SettingsSidebarLoader() {
  return (
    <Suspense fallback={null}>
      <SettingsSidebarFixture />
    </Suspense>
  )
}
