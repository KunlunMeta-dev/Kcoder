import { useCallback, useRef } from 'react'
import type { ComposerSlashSubmit } from './composerAutocomplete'
import type { ComposerSubmitOptions } from './composerTextareaTypes'

export function useComposerSubmit(
  draft: string,
  submitMessage: (value?: string, options?: ComposerSubmitOptions) => void
) {
  const slashSubmitRef = useRef<ComposerSlashSubmit | null>(null)
  const submit = useCallback((value = draft, options?: ComposerSubmitOptions) => {
    if (!slashSubmitRef.current?.(value)) submitMessage(value, options)
  }, [draft, submitMessage])
  return { slashSubmitRef, submit }
}
