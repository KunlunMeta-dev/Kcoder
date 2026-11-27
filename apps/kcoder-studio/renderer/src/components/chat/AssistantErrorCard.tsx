import { useState, type ReactNode } from 'react'
import { AlertTriangle, ChevronDown } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { parseChatError } from '@/lib/chat-error'
import { contextPreflightRecovery, decodeProviderFailure } from '@wegent/chat-core'
import type { WorkbenchMessage } from '@/types/workbench'
import { failureRecoveryFacts } from '../../../../shared/failureRecoveryFacts'
import { peerTurnFailure } from '../../../../shared/peerTurnFailure'

/** Historical evidence stays readable; recovery controls belong to the current attempt. */
export function AssistantErrorCard({
  error,
  errorType,
  rawError,
  message,
  historical,
  recoveryBlocked,
  onRetry,
  onSwitchModel,
  detailsActions,
}: {
  error?: string
  errorType?: string
  rawError?: string
  message: WorkbenchMessage
  historical: boolean
  recoveryBlocked: boolean
  onRetry?: (message: WorkbenchMessage) => void
  onSwitchModel?: (message: WorkbenchMessage) => void
  detailsActions?: ReactNode
}) {
  const { t } = useTranslation('chat')
  const [isDetailExpanded, setIsDetailExpanded] = useState(false)
  const displayError = rawError || error
  const providerFailure = decodeProviderFailure(message.providerFailure)
  const peerFailure = peerTurnFailure({
    error: displayError,
    providerFailure,
    turnId: message.turnId,
    attemptId: message.attemptId ?? message.subtaskId,
  })
  const hasErrorDetails = Boolean(displayError || providerFailure || detailsActions)
  const hasFollowUp = Boolean(message.continuationAccepted || message.retriedByMessageId)
  const compact = hasFollowUp || historical
  const contextPreflight = providerFailure?.context_preflight
  const contextRecovery = contextPreflightRecovery({ providerFailure, error: displayError })
  const isContextPreflight = contextRecovery !== undefined
  const canContinue = contextRecovery !== 'select_model'
  const fixedOverhead = contextPreflight?.compaction === 'fixed_overhead_exceeds_limit'
  const parsedError = parseChatError(displayError ?? '', errorType, providerFailure)
  const recoveryFacts = failureRecoveryFacts({
    providerFailure: peerFailure ? undefined : providerFailure,
    errorType:
      peerFailure?.kind === 'authorization'
        ? 'local_runtime_error'
        : peerFailure
          ? undefined
          : parsedError.type,
    turnId: message.turnId,
    attemptId: message.attemptId ?? message.subtaskId,
  })
  const modelName =
    displayError?.match(/model_id:\s*([^"'}\s]+)/)?.[1] ??
    displayError?.match(/model(?:\s+|_id["':\s]+)([a-z0-9._:-]+)/i)?.[1]
  const title = t(
    peerFailure
      ? peerFailure.kind === 'authorization'
        ? 'assistant_error.peer_turn_failed_title'
        : 'assistant_error.peer_legacy_unknown_title'
      : fixedOverhead
        ? 'assistant_error.context_model_too_small_title'
        : parsedError.titleKey,
    {
      defaultValue: t('assistant_error.types.generic_error.title', '消息生成失败'),
    }
  )
  const description = peerFailure
    ? t(
        peerFailure.kind === 'authorization'
          ? 'assistant_error.peer_turn_failed_description'
          : 'assistant_error.peer_legacy_unknown_description'
      )
    : fixedOverhead
      ? t('assistant_error.context_model_too_small_description')
      : parsedError.type === 'model_protocol_error' && modelName
        ? t('assistant_error.types.model_protocol_error.description_with_model', {
            model: modelName,
            defaultValue: `${modelName} 不支持当前运行协议。请切换兼容模型后重试。`,
          })
        : !hasErrorDetails && parsedError.type === 'generic_error'
          ? t('assistant_error.types.generic_error.description_without_details')
          : t(parsedError.descriptionKey, {
              defaultValue: t(
                'assistant_error.types.generic_error.description',
                '请求未能完成。你可以稍后重试，或查看错误详情。'
              ),
            })

  return (
    <div
      data-testid="assistant-error-card"
      data-presentation={compact ? 'history' : 'current'}
      className={compact
        ? 'mt-1 flex min-w-0 max-w-full items-start gap-2 text-text-secondary'
        : 'mt-2 flex w-[min(546px,100%)] max-w-full items-start gap-2.5 rounded-[14px] border border-border bg-surface px-3.5 py-3 text-text-primary'}
    >
      <span className={compact
        ? 'mt-1 flex h-4 w-4 shrink-0 items-center justify-center text-text-muted'
        : 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-base text-red-500 shadow-[inset_0_0_0_1px_rgb(var(--color-border))]'}>
        <AlertTriangle className="h-3 w-3" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        {(!compact || isDetailExpanded) && (
          <p className="text-sm font-semibold leading-5 text-text-primary">{title}</p>
        )}
        {(!compact || isDetailExpanded) && (
          <p className="mt-0.5 text-xs leading-[18px] text-text-secondary">{description}</p>
        )}
        {!compact && isContextPreflight && (
          <p className="mt-2 text-xs text-text-secondary">
            {t('assistant_error.context_request_not_sent')}
          </p>
        )}
        {!compact && isContextPreflight && !canContinue && (
          <p className="mt-2 text-xs text-text-secondary">
            {t('assistant_error.context_continuation_unavailable')}
          </p>
        )}
        <div
          data-testid="assistant-error-recovery-facts"
          hidden={!isDetailExpanded}
          className="mt-2 space-y-1 text-xs leading-[18px] text-text-secondary"
        >
          {peerFailure?.kind === 'authorization' && (
            <p data-testid="peer-turn-safe-reason">
              {t('assistant_error.peer_turn_reason', { code: peerFailure.reason })}
            </p>
          )}
          {contextPreflight && (
            <div className="space-y-1" data-testid="context-preflight-failure">
              <p>
                {t(
                  contextPreflight.count_is_exact
                    ? 'assistant_error.context_measured'
                    : 'assistant_error.context_estimated',
                  {
                    tokens: contextPreflight.request_tokens.toLocaleString(),
                    limit: contextPreflight.input_limit_tokens.toLocaleString(),
                  }
                )}
              </p>
              <p>{t(`assistant_error.context_compaction_${contextPreflight.compaction}`)}</p>
            </div>
          )}
          <p>
            {t('assistant_error.failure_phase', {
              phase: t(
                `assistant_error.phase_${isContextPreflight ? 'context_preflight' : recoveryFacts.phase}`
              ),
            })}
          </p>
          {recoveryFacts.committedStepsPreserved && (
            <p>{t('assistant_error.committed_boundary_preserved')}</p>
          )}
          <p>{t('assistant_error.recovery_boundary_checked')}</p>
        </div>
        {!compact &&
          !peerFailure &&
          !isContextPreflight &&
          providerFailure?.recovery_action === 'needs_human' && (
            <p className="mt-1 text-xs leading-[18px] text-text-secondary">
              {t(
                'assistant_error.needs_human',
                '需要人工处理：请检查模型服务配置、凭据或请求参数，修正后再重试。'
              )}
            </p>
          )}
        <div className={`${compact ? '' : 'mt-3 '}flex flex-wrap items-center gap-2`}>
          {!compact && !peerFailure && parsedError.type !== 'local_runtime_error' && (
            <button
              type="button"
              data-testid={
                canContinue ? 'assistant-error-switch-model-retry' : 'assistant-error-switch-model'
              }
              disabled={recoveryBlocked || !onSwitchModel}
              onClick={() =>
                onSwitchModel?.(canContinue ? message : { ...message, error: displayError })
              }
              className="h-8 rounded-lg border border-text-primary bg-text-primary px-3 text-xs font-semibold text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {canContinue
                ? t('assistant_error.actions.switch_model_retry', '切换模型并重试')
                : t('assistant_error.actions.switch_model', '切换模型')}
            </button>
          )}
          {!peerFailure && !isContextPreflight && !compact && (
            <button
              type="button"
              data-testid="assistant-error-retry"
              disabled={recoveryBlocked || !onRetry}
              onClick={() => onRetry?.(message)}
              className="h-8 rounded-lg border border-border bg-base px-3 text-xs font-semibold text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {(message.turnId ?? message.subtaskId)?.startsWith('turn-')
                ? t('assistant_error.actions.retry_original')
                : t('assistant_error.actions.retry', '重试')}
            </button>
          )}
          {historical && !hasFollowUp && (
            <span data-testid="assistant-error-historical" className="text-xs text-text-secondary">
              {t('assistant_error.historical')}
            </span>
          )}
          {message.continuationAccepted && (
            <span data-testid="assistant-error-continued" className="text-xs text-text-secondary">
              {t('assistant_error.continued')}
            </span>
          )}
          {!message.continuationAccepted && message.retriedByMessageId && (
            <span data-testid="assistant-error-retried" className="text-xs text-text-secondary">
              {t('assistant_error.retried')}
            </span>
          )}
          {hasErrorDetails && (
            <button
              type="button"
              data-testid="assistant-error-details-toggle"
              aria-expanded={isDetailExpanded}
              onClick={() => setIsDetailExpanded(value => !value)}
              className={compact
                ? 'inline-flex min-h-6 items-center gap-1 rounded px-1 text-xs text-text-secondary hover:bg-muted hover:text-text-primary max-md:min-h-11'
                : 'inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-base px-3 text-xs font-semibold text-text-secondary hover:bg-muted hover:text-text-primary'}
            >
              <ChevronDown
                className={[
                  'h-3.5 w-3.5 transition-transform',
                  isDetailExpanded ? 'rotate-180' : '',
                ].join(' ')}
              />
              {t('assistant_error.details', '错误详情')}
            </button>
          )}
        </div>
        {displayError && isDetailExpanded && (
          <pre
            data-testid="assistant-error-details"
            className="mt-2 max-h-32 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-base px-2.5 py-1.5 font-mono text-xs leading-4 text-text-muted"
          >
            {displayError}
          </pre>
        )}
        {isDetailExpanded && detailsActions}
      </div>
    </div>
  )
}
