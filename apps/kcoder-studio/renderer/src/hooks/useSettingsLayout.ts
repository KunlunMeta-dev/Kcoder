import { useState } from 'react'

/** Keep the settings component tree mounted while a form is open.
 * Its CSS remains responsive; after leaving settings the workbench adopts the
 * latest breakpoint. Drafts stay in component memory, never persistent storage. */
export function useSettingsLayout(preferMobile: boolean, settingsOpen: boolean): boolean {
  const [mobile, setMobile] = useState(preferMobile)
  if (!settingsOpen && mobile !== preferMobile) setMobile(preferMobile)
  return mobile
}
