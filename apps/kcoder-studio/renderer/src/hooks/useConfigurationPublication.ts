import { useCallback, useEffect, useRef, useState } from 'react'

type Phase = 'none' | 'read_required' | 'observed'
export interface PublicationObservation {
  lifetime: number
  publication: number
  scope: number
}

/** Ephemeral UI receipt state, never configuration or a durable success verdict. */
export function useConfigurationPublication() {
  const [phase, setPhase] = useState<Phase>('none')
  const current = useRef<Phase>('none'),
    publication = useRef(0),
    lifetime = useRef(0)
  const advanceLifetime = useCallback(() => {
    lifetime.current++
  }, [])
  useEffect(() => {
    advanceLifetime()
    return advanceLifetime
  }, [advanceLifetime])
  const capture = useCallback(
    (scope: number): PublicationObservation => ({
      lifetime: lifetime.current,
      publication: publication.current,
      scope,
    }),
    []
  )
  const live = useCallback(
    (token: PublicationObservation) => token.lifetime === lifetime.current,
    []
  )
  const blocked = useCallback(() => current.current === 'read_required', [])
  const unknown = useCallback((token: PublicationObservation) => {
    if (token.lifetime !== lifetime.current || token.publication !== publication.current)
      return false
    publication.current++
    current.current = 'read_required'
    setPhase('read_required')
    return true
  }, [])
  const observed = useCallback((token: PublicationObservation, scope: number) => {
    if (
      token.lifetime === lifetime.current &&
      token.publication === publication.current &&
      token.scope === scope &&
      current.current === 'read_required'
    ) {
      current.current = 'observed'
      setPhase('observed')
    }
  }, [])
  const confirmed = useCallback((token: PublicationObservation) => {
    if (token.lifetime === lifetime.current && token.publication === publication.current) {
      current.current = 'none'
      setPhase('none')
    }
  }, [])
  return { phase, capture, live, blocked, unknown, observed, confirmed }
}
