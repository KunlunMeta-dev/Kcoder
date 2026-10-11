import { useTranslation } from '@/hooks/useTranslation'
import { runtimeNameForCurrentHost } from '@/kcoder/legacyRuntimeAbi'
import {
  Bot,
  FilePenLine,
  Flame,
  RotateCcw,
  ShieldOff,
  ShieldQuestion,
  ShieldX,
  SlidersHorizontal,
} from 'lucide-react'
import { ActionMenu } from '@/components/common/ActionMenu'

const modes = [
  ['ask', ShieldQuestion],
  ['auto', Bot],
  ['accept_edits', FilePenLine],
  ['dont_ask', ShieldX],
  ['bypass', ShieldOff],
  ['yolo', Flame],
  ['default', RotateCcw],
] as const

export function GatewayPermissionSelector({
  value,
  disabled,
  onChange,
}: {
  value?: string
  disabled?: boolean
  onChange?: (value: string) => void
}) {
  const { t } = useTranslation('common')
  if (runtimeNameForCurrentHost() !== 'kcoder' || !onChange) return null
  const current = value ?? 'default'
  return (
    <ActionMenu
      testId="composer-permission-selector"
      icon={SlidersHorizontal}
      placement="top-start"
      disabled={disabled}
      ariaLabel={`${t('workbench.permission_mode')}：${t(`workbench.permission_mode_${current}`)}`}
      triggerClassName="flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-40"
      items={modes.map(([mode, icon]) => ({
        label: t(`workbench.permission_mode_${mode}`),
        icon,
        testId: `permission-mode-${mode}`,
        checked: current === mode,
        onSelect: () => onChange(mode),
      }))}
    />
  )
}
