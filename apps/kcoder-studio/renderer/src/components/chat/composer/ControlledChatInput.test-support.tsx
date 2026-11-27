import type { RuntimeGoal } from '@/types/api'
import { useState } from 'react'
import { vi } from 'vitest'
import type { ChatSubmitOptions, ProjectChatControls } from '../ChatInput'
import { ChatInput } from '../ChatInput'
export function ControlledChatInput({
  onSubmit = vi.fn(),
  projectChat,
  variant,
  onSetGoal,
}: {
  onSubmit?: (valueOverride?: string, options?: ChatSubmitOptions) => void
  projectChat?: ProjectChatControls
  variant?: 'compact' | 'desktop'
  onSetGoal?: (mode?: RuntimeGoal['mode']) => void
}) {
  const [value, setValue] = useState('')

  return (
    <ChatInput
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
      disabled={false}
      variant={variant}
      projectChat={projectChat}
      onSetGoal={onSetGoal}
    />
  )
}
