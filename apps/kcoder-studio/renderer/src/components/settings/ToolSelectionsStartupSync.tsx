import { useEffect } from 'react'
import { listenAccountContextChanges } from '@/kcoder/accountContextEvents'
import {
  clearToolSelectionProjections,
  syncLocalToolSelectionProjection,
} from '@/kcoder/toolSelections'

export function ToolSelectionsStartupSync() {
  useEffect(() => {
    let active = true
    let generation = 0
    const sync = () => {
      const request = ++generation
      void syncLocalToolSelectionProjection(() => active && request === generation)
    }
    queueMicrotask(() => {
      if (active) sync()
    })
    const stop = listenAccountContextChanges(() => {
      clearToolSelectionProjections()
      sync()
    })
    return () => {
      active = false
      generation += 1
      clearToolSelectionProjections()
      stop()
    }
  }, [])
  return null
}
