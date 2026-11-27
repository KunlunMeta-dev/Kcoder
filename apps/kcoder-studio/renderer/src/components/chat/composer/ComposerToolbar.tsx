import {
  ArrowUp,
  ChevronDown,
  ClipboardList,
  Clock3,
  CornerDownRight,
  FastForward,
  MoreHorizontal,
  Square,
  Zap,
} from 'lucide-react'
import { useId, useRef, useState, type ReactNode } from 'react'
import { ActionMenu } from '@/components/common/ActionMenu'
import type { ComposerSubmitOptions } from './ComposerTextarea'
import { useTranslation } from '@/hooks/useTranslation'
import type { ModelOptions, RuntimeContextUsage, UnifiedModel, RuntimeGoal } from '@/types/api'
import { AddContextMenu } from './AddContextMenu'
import { GatewayPermissionSelector } from './GatewayPermissionSelector'
import { ComposerModePill, GoalDraftPill } from './GoalDraftPill'
import { ContextUsageIndicator } from './ContextUsageIndicator'
import { ModelSelector } from './ModelSelector'
import { QuickPhraseMenu } from './QuickPhraseMenu'
import type { QuickPhrase } from '@/host/appPreferences'
import { ComposerOverflowGroup } from './ComposerOverflowGroup'
import { useToolbarDensity } from './useToolbarDensity'
import './composer-toolbar.css'

interface ComposerToolbarProps {
  textOnly?: boolean
  sendTestId?: string
  pauseTestId?: string
  canSend: boolean
  disabled?: boolean
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  activeModel?: UnifiedModel | null
  selectedModelOptions: ModelOptions
  modelSelectorOpenSignal?: number
  onModelSelectorOpenChange?: (open: boolean) => void
  isModelSelectionReady: boolean
  contextUsage?: RuntimeContextUsage
  contextUsageScopeKey?: string
  onSelectModel: (model: UnifiedModel | null) => void
  onSelectModelAndOptions?: (model: UnifiedModel, options: ModelOptions) => void
  onSelectModelOption: (optionId: string, value: string) => void
  onBlockedModelSelect?: (model: UnifiedModel, message?: string) => void
  onFileSelect: (files: File | File[]) => void
  planModeActive?: boolean
  onSetPlanMode?: () => void
  onClearPlanMode?: () => void
  onSetGoal?: (mode?: RuntimeGoal['mode']) => void
  onCompactContext?: () => void
  goalDraftActive?: boolean
  goalDraftMode?: RuntimeGoal['mode']
  onCancelGoalDraft?: () => void
  isStreaming?: boolean
  onPause?: () => void
  stopping?: boolean
  onShortenWait?: () => void
  shortenWaitAvailable?: boolean
  onQuickPhraseSelect: (phrase: QuickPhrase) => void
  onSubmit: (options?: ComposerSubmitOptions) => void
  leadingContext?: ReactNode
  modeStatus?: ReactNode
}

const NARROW_MODEL_SELECTOR_MAX_WIDTH = 100

export function ComposerToolbar({
  textOnly = false,
  sendTestId = 'send-message-button',
  pauseTestId = 'pause-response-button',
  canSend,
  disabled = false,
  models,
  selectedModel,
  activeModel,
  selectedModelOptions,
  modelSelectorOpenSignal,
  onModelSelectorOpenChange,
  isModelSelectionReady,
  contextUsage,
  contextUsageScopeKey,
  onSelectModel,
  onSelectModelAndOptions,
  onSelectModelOption,
  onBlockedModelSelect,
  onFileSelect,
  planModeActive = false,
  onSetPlanMode,
  onClearPlanMode,
  onSetGoal,
  onCompactContext,
  goalDraftActive = false,
  goalDraftMode = 'standard',
  onCancelGoalDraft,
  isStreaming = false,
  onPause,
  stopping = false,
  onShortenWait,
  shortenWaitAvailable = false,
  onQuickPhraseSelect,
  onSubmit,
  leadingContext,
  modeStatus,
}: ComposerToolbarProps) {
  const { t } = useTranslation('common')
  const toolbarRef = useRef<HTMLDivElement>(null)
  const density = useToolbarDensity(toolbarRef)
  const compact = density > 0
  const moreRef = useRef<HTMLButtonElement>(null)
  const optionalId = useId()
  const secondaryId = useId()
  const [moreOpen, setMoreOpen] = useState(false)
  const moreLabel = t('workbench.more_composer_actions', '更多操作')
  const modelChangePending = Boolean(
    activeModel &&
    (!selectedModel ||
      activeModel.name !== selectedModel.name ||
      activeModel.type !== selectedModel.type)
  )
  const activeModelLabel = activeModel?.displayName || activeModel?.name
  const selectedModelLabel =
    selectedModel?.displayName || selectedModel?.name || t('workbench.default_model', 'Default')

  return (
    <div
      ref={toolbarRef}
      data-testid="composer-toolbar"
      data-density={density}
      data-compact={compact ? 'true' : 'false'}
      className="composer-toolbar mt-auto flex min-h-8 min-w-0 flex-nowrap items-end justify-between gap-2 pt-1"
    >
      <div data-testid="composer-toolbar-actions" className="flex shrink-0 items-center gap-1">
        {!textOnly && (
          <AddContextMenu
            disabled={disabled}
            onFileSelect={onFileSelect}
            onSetPlanMode={planModeActive ? undefined : onSetPlanMode}
            onSetGoal={onSetGoal}
          />
        )}
        {!textOnly && (
          <GatewayPermissionSelector
            value={selectedModelOptions.kcoderPermissionMode}
            disabled={disabled || isStreaming}
            onChange={value => onSelectModelOption('kcoderPermissionMode', value)}
          />
        )}
        <ComposerOverflowGroup
          id={optionalId}
          folded={!textOnly && density >= 3}
          label={moreLabel}
          triggerRef={moreRef}
          onOpenChange={setMoreOpen}
        >
          {!textOnly && (
            <QuickPhraseMenu disabled={disabled} iconOnly={false} onSelect={onQuickPhraseSelect} />
          )}
          {leadingContext}
          <ComposerOverflowGroup
            id={secondaryId}
            folded={!textOnly && density === 2}
            label={moreLabel}
            triggerRef={moreRef}
            onOpenChange={setMoreOpen}
          >
            {modeStatus}
            {goalDraftActive ? (
              <GoalDraftPill onCancel={onCancelGoalDraft} mode={goalDraftMode} />
            ) : planModeActive ? (
              <ComposerModePill
                label={t('workbench.plan_mode', '计划模式')}
                icon={ClipboardList}
                testId="plan-mode-pill"
                cancelTestId="cancel-plan-mode-button"
                cancelLabel={t('workbench.disable_plan_mode', '关闭计划模式')}
                disabled={disabled}
                onCancel={onClearPlanMode}
                title={t('workbench.collaboration_mode', '运行模式')}
              />
            ) : null}
          </ComposerOverflowGroup>
        </ComposerOverflowGroup>
        {!textOnly && density >= 2 && (
          <button
            ref={moreRef}
            type="button"
            data-testid="composer-more-button"
            popoverTarget={density >= 3 ? optionalId : secondaryId}
            aria-label={moreLabel}
            title={moreLabel}
            aria-expanded={moreOpen}
            aria-controls={density >= 3 ? optionalId : secondaryId}
            aria-haspopup="dialog"
            disabled={disabled}
            className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50 max-md:h-11 max-md:w-11"
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>
      <div
        data-testid="composer-toolbar-model-controls"
        aria-busy={!isModelSelectionReady}
        className="ml-auto flex shrink-0 items-center gap-1.5"
      >
        {!textOnly && (
          <ContextUsageIndicator
            key={contextUsageScopeKey}
            usage={contextUsage}
            disabled={disabled}
            onCompactContext={onCompactContext}
          />
        )}
        {!textOnly && (
          <ModelSelector
            models={models}
            selectedModel={selectedModel}
            selectedModelOptions={selectedModelOptions}
            nextTurn={isStreaming && modelChangePending}
            openSignal={modelSelectorOpenSignal}
            onOpenChange={onModelSelectorOpenChange}
            disabled={disabled || !isModelSelectionReady}
            onSelectModel={onSelectModel}
            onSelectModelAndOptions={onSelectModelAndOptions}
            onSelectModelOption={onSelectModelOption}
            onBlockedModelSelect={onBlockedModelSelect}
            buttonClassName="opacity-90 hover:opacity-100"
            maxClosedWidth={compact ? NARROW_MODEL_SELECTOR_MAX_WIDTH : undefined}
          />
        )}
        {textOnly ? (
          <>
            {isStreaming && onPause && (
              <button
                type="button"
                data-testid={pauseTestId}
                onClick={onPause}
                disabled={stopping}
                aria-busy={stopping}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-text-primary text-background hover:opacity-80 disabled:opacity-40 max-md:h-11 max-md:w-11"
                aria-label={stopping ? t('workbench.stopping_response') : t('workbench.pause_response')}
          >
                <span className="size-3.5 rounded-sm bg-current" aria-hidden="true" />
              </button>
            )}
            <button
              type="submit"
              data-testid={sendTestId}
              disabled={!canSend}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-text-primary text-background hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40 max-md:h-11 max-md:w-11"
              aria-label={t('workbench.send_message')}
            >
              <ArrowUp className="size-4" />
            </button>
          </>
        ) : isStreaming && !canSend && shortenWaitAvailable ? (
          <button
            type="button"
            data-testid="shorten-wait-button"
            onClick={onShortenWait}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[#1f1f1f] px-3 text-white hover:bg-[#333]"
            aria-label={t('workbench.shorten_wait', '跳过等待')}
          >
            <FastForward className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="text-xs font-medium">{t('workbench.shorten_wait', '跳过等待')}</span>
          </button>
        ) : isStreaming && !canSend ? (
          <button
            type="button"
            data-testid="pause-response-button"
            onClick={onPause}
            disabled={stopping}
            aria-busy={stopping}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1f1f1f] p-0 text-white hover:bg-[#333]"
            aria-label={stopping ? t('workbench.stopping_response') : t('workbench.pause_response')}
          >
            <span className="h-3.5 w-3.5 rounded-sm bg-current" aria-hidden="true" />
          </button>
        ) : isStreaming && canSend ? (
          <div className="flex items-center rounded-full bg-[#1f1f1f] text-white">
            <button
              type="submit"
              data-testid="send-message-button"
              className="flex h-8 w-8 items-center justify-center rounded-l-full hover:bg-[#333]"
              aria-label={t('workbench.send_after_turn', '当前回复结束后发送')}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
            <ActionMenu
              ariaLabel={t('workbench.choose_send_mode', '选择发送方式')}
              testId="send-mode-menu-button"
              icon={ChevronDown}
              triggerClassName="flex h-8 w-7 items-center justify-center rounded-r-full border-l border-white/20 hover:bg-[#333]"
              items={[
                ...(onPause ? [{
                  label: t(stopping ? 'workbench.stopping_response' : 'workbench.pause_response'),
                  icon: Square,
                  testId: 'stop-response-option',
                  disabled: stopping,
                  onSelect: onPause,
                }] : []),
                {
                  label: t('workbench.send_after_turn', '当前回复结束后发送'),
                  icon: Clock3,
                  testId: 'send-after-turn-option',
                  onSelect: () => onSubmit(),
                },
                {
                  label:
                    modelChangePending && activeModelLabel
                      ? t(
                          'workbench.guide_current_turn_with_model',
                          'Guide current response · {{model}}',
                          {
                            model: activeModelLabel,
                          }
                        )
                      : t('workbench.guide_current_turn', '引导当前回复'),
                  icon: CornerDownRight,
                  testId: 'guide-current-turn-option',
                  onSelect: () => onSubmit({ guideWhenBusy: true }),
                },
                {
                  label:
                    modelChangePending && selectedModelLabel
                      ? t(
                          'workbench.interrupt_and_send_with_model',
                          'Interrupt and use {{model}}',
                          {
                            model: selectedModelLabel,
                          }
                        )
                      : t('workbench.interrupt_and_send', '打断并立即发送'),
                  icon: Zap,
                  testId: 'interrupt-and-send-option',
                  onSelect: () => onSubmit({ interruptWhenBusy: true }),
                },
              ]}
            />
          </div>
        ) : (
          <button
            type="submit"
            data-testid="send-message-button"
            disabled={!canSend}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1f1f1f] p-0 text-white disabled:cursor-not-allowed disabled:bg-text-muted/45 disabled:text-background"
            aria-label={t('workbench.send_message', '发送消息')}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}
