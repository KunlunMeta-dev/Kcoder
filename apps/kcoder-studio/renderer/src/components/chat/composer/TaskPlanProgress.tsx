import { Check, Circle, ListChecks } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getPlanDisposition } from '@/features/composer-status/projection'
import { useTranslation } from '@/hooks/useTranslation'
import {
  calculateFloatingMenuHorizontalLayout,
  getFloatingMenuVisibleBounds,
  observeFloatingMenuLayout,
} from '@/lib/floating-menu'
import type { RuntimePlanEventPayload, RuntimePlanStep } from '@/types/api'
import { ComposerStatusItem } from './ComposerStatusRegion'

type TaskPlanProgressProps = {
  plan?: RuntimePlanEventPayload | null
  stale?: boolean
  presentation?: 'detail' | 'embedded'
}

export function TaskPlanProgress({ plan, stale = false, presentation }: TaskPlanProgressProps) {
  const { t } = useTranslation('common')
  const triggerRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [tooltipLayout, setTooltipLayout] = useState({ left: 8, top: 8, width: 496, maxHeight: 480 })

  useEffect(() => {
    if (import.meta.env.DEV) {
      console.warn('[KCoder Studio] Runtime task plan progress rendered', {
        stepCount: plan?.plan.length ?? 0,
      })
    }
  }, [plan])

  useLayoutEffect(() => {
    if (!plan?.plan.length || presentation !== undefined) return

    const updateLayout = () => {
      const trigger = triggerRef.current
      const tooltip = tooltipRef.current
      if (!trigger || !tooltip) return
      const triggerRect = trigger.getBoundingClientRect()
      const visibleBounds = getFloatingMenuVisibleBounds(trigger, 8)
      const horizontalLayout = calculateFloatingMenuHorizontalLayout({
        anchorRect: triggerRect,
        containerLeft: 0,
        visibleBounds,
        preferredWidth: 496,
        alignment: 'center',
      })
      const tooltipHeight = tooltip.getBoundingClientRect().height || 80
      const top = Math.max(visibleBounds.top, triggerRect.top - tooltipHeight - 6)
      setTooltipLayout({
        left: horizontalLayout.left,
        top,
        width: horizontalLayout.width,
        maxHeight: Math.max(0, triggerRect.top - visibleBounds.top - 6),
      })
    }

    updateLayout()
    return observeFloatingMenuLayout(triggerRef.current, updateLayout, [tooltipRef.current])
  }, [plan, presentation])

  if (!plan?.plan.length) return null

  const disposition = getPlanDisposition(plan, stale)
  const currentIndex = currentPlanStepIndex(plan.plan)
  const activeStep = plan.plan[currentIndex]
  const progressLabel = t('workbench.task_plan_progress', {
    current: currentIndex + 1,
    total: plan.plan.length,
  })
  const planTitle = t('workbench.workspace_tab_plan', '计划')
  const staleLabel = stale
    ? t('workbench.task_plan_last_known', 'Last known plan · awaiting sync')
    : undefined
  const detail = (
    <ol className="space-y-1" data-testid="runtime-plan-detail">
      {plan.plan.map((step, index) => (
        <li
          key={`${index}-${step.step}`}
          className="flex items-start gap-2 text-sm leading-5 text-text-secondary"
        >
          <PlanStepIcon step={step} compact />
          <span className={step.status === 'inProgress' ? 'text-text-primary' : ''}>
            {step.step}
          </span>
        </li>
      ))}
    </ol>
  )

  if (presentation === 'detail') {
    return staleLabel ? (
      <div>
        <p className="mb-2 text-xs text-warning" data-testid="runtime-plan-stale-label">
          {staleLabel}
        </p>
        {detail}
      </div>
    ) : (
      detail
    )
  }
  if (disposition === 'hidden') return null
  if (presentation === 'embedded') {
    return (
      <ComposerStatusItem
        id="plan"
        title={`${planTitle} ${currentIndex + 1}/${plan.plan.length}`}
        statusText={staleLabel}
        summary={activeStep.step}
        attention={stale}
        icon={ListChecks}
      >
        {detail}
      </ComposerStatusItem>
    )
  }

  return (
    <div className="relative z-20 mb-2 flex justify-center">
      <div ref={triggerRef} className="group relative" tabIndex={0}>
        <div
          ref={tooltipRef}
          style={{
            left: tooltipLayout.left,
            top: tooltipLayout.top,
            width: tooltipLayout.width,
            maxHeight: tooltipLayout.maxHeight,
          }}
          className="pointer-events-none fixed z-popover overflow-y-auto rounded-2xl border border-border/70 bg-background px-3.5 py-2.5 opacity-0 shadow-[0_8px_22px_rgba(15,23,42,0.08)] transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100"
          data-testid="runtime-plan-popover"
        >
          <ol className="space-y-1">
            {plan.plan.map((step, index) => (
              <li
                key={`${index}-${step.step}`}
                className="flex min-w-0 items-start gap-1.5 text-xs leading-[18px] text-text-secondary"
              >
                <PlanStepIcon step={step} compact />
                <span className={`min-w-0 break-words ${step.status === 'inProgress' ? 'text-text-primary' : ''}`}>
                  {step.step}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div
          aria-label={staleLabel ?? progressLabel}
          data-testid="runtime-plan-progress-button"
          className="flex h-8 items-center gap-1.5 rounded-xl border border-border/70 bg-background px-3 text-xs font-normal text-text-secondary shadow-sm transition-colors group-hover:bg-surface group-focus:bg-surface"
        >
          <PlanStepIcon step={activeStep} />
          <span>{staleLabel ?? progressLabel}</span>
        </div>
      </div>
    </div>
  )
}

function currentPlanStepIndex(plan: RuntimePlanStep[]): number {
  const inProgressIndex = plan.findIndex(step => step.status === 'inProgress')
  if (inProgressIndex >= 0) return inProgressIndex
  const pendingIndex = plan.findIndex(step => step.status === 'pending')
  return pendingIndex >= 0 ? pendingIndex : Math.max(plan.length - 1, 0)
}

function PlanStepIcon({ step, compact = false }: { step: RuntimePlanStep; compact?: boolean }) {
  const sizeClass = compact ? 'h-3.5 w-3.5' : 'h-4 w-4'
  if (step.status === 'completed') {
    return <Check className={`mt-0.5 ${sizeClass} shrink-0 text-primary`} strokeWidth={2.5} />
  }
  return (
    <Circle
      className={`mt-0.5 ${sizeClass} shrink-0 ${step.status === 'inProgress' ? 'animate-pulse text-primary' : 'text-text-muted'}`}
      strokeWidth={2}
    />
  )
}
