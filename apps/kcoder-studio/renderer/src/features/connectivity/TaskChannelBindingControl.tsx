import { Network } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'
import { runtimeThreadId } from '@/lib/runtime-thread-id'
import { TaskChannelBindingDialog } from './TaskChannelBindingDialog'

export function TaskChannelBindingControl({
  address,
  compact = false,
  className,
}: {
  address: RuntimeTaskAddress
  compact?: boolean
  className?: string
}) {
  const { t } = useTranslation('connectivity')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size={compact ? 'icon' : 'sm'}
        className={className}
        aria-label={t('chatTasks.bindTask')}
        title={t('chatTasks.bindTask')}
        disabled={!runtimeThreadId(address) || !address.workspacePath}
        onClick={() => setOpen(true)}
      >
        {compact ? <Network className="size-4" aria-hidden="true" /> : t('chatTasks.bindTask')}
      </Button>
      {open && <TaskChannelBindingDialog address={address} onClose={() => setOpen(false)} />}
    </>
  )
}
