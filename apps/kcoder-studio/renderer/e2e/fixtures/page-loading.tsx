import { lazy, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DeferredWorkbenchPage } from '../../src/components/layout/DeferredWorkbenchPage'
import { LocalRuntimeInitializer } from '../../src/features/local-runtime/LocalRuntimeInitializer'
import '../../src/i18n'
import '../../src/styles/globals.css'

let finishLoading: (() => void) | undefined
export const Feature = lazy(
  () =>
    new Promise<{ default: () => React.ReactNode }>(resolve => {
      finishLoading = () => resolve({ default: () => <p>Feature ready</p> })
    })
)

export function Fixture() {
  const [open, setOpen] = useState(false)
  const [count, setCount] = useState(0)
  return (
    <div className="flex h-dvh bg-base text-text-primary">
      <aside className="flex w-60 shrink-0 flex-col gap-4 bg-surface p-5">
        <span>KCoder Studio</span>
        <button type="button" onClick={() => setCount(value => value + 1)}>
          Sidebar state: {count}
        </button>
        <button type="button" onClick={() => setOpen(true)}>
          Open feature
        </button>
        <button type="button" onClick={() => finishLoading?.()}>
          Finish loading
        </button>
      </aside>
      <main className="min-w-0 flex-1" data-testid="feature-content">
        {open ? (
          <DeferredWorkbenchPage>
            <Feature />
          </DeferredWorkbenchPage>
        ) : (
          <p>Home ready</p>
        )}
      </main>
    </div>
  )
}

const initialFeature = new URLSearchParams(window.location.search).has('initial-feature')
if (initialFeature) {
  window.addEventListener('fixture-finish-loading', () => finishLoading?.(), { once: true })
}

createRoot(document.getElementById('root')!).render(initialFeature ? (
  <LocalRuntimeInitializer waitForInitialPage>
    <DeferredWorkbenchPage><Feature /></DeferredWorkbenchPage>
  </LocalRuntimeInitializer>
) : <Fixture />)
