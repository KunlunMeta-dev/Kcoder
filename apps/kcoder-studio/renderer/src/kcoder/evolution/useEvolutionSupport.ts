import { useEffect, useState } from 'react'
import { supportsSelfEvolution } from './evolutionApi'

/** Capability read for one target; `false` until the target confirms `selfEvolutionV1`. */
export function useEvolutionSupport(deviceId: string | undefined, workspacePath?: string): boolean {
  const key = JSON.stringify([deviceId ?? null, workspacePath ?? null])
  const [result, setResult] = useState<{ key: string; supported: boolean } | null>(null)
  useEffect(() => {
    if (!deviceId) return
    let active = true
    supportsSelfEvolution(deviceId, workspacePath).then(
      supported => {
        if (active) setResult({ key, supported })
      },
      () => {
        if (active) setResult({ key, supported: false })
      }
    )
    return () => {
      active = false
    }
  }, [deviceId, key, workspacePath])
  return Boolean(deviceId) && result?.key === key && result.supported
}
