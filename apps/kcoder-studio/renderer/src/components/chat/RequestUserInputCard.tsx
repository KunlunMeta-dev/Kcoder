import type { RuntimeSourceAgent } from '@/types/subagents'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import {
  Check,
  ChevronDown,
  CornerDownLeft,
  MessageCircleQuestion,
  Pencil,
  ShieldCheck,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { isImeComposingEvent } from '@/lib/ime'
import { cn } from '@/lib/utils'
import type { RequestUserInputResponse } from '@/types/api'
import { PermissionApprovalContent } from './PermissionApprovalContent'
import {
  permissionChoiceKey,
  type PermissionApprovalPresentation,
} from './permissionApprovalPresentation'
import {
  hasImplementationPlanText,
  requestUserInputPayloadKeys,
  requestUserInputRelatedKeysForPayloads,
} from './requestUserInputMessages'

interface RequestUserInputOption {
  id?: string
  label?: string
  description?: string
}

interface RequestUserInputQuestion {
  id?: string
  header?: string
  question?: string
  is_other?: boolean
  isOther?: boolean
  multi_select?: boolean
  multiSelect?: boolean
  options?: RequestUserInputOption[]
}

export interface RequestUserInputPayload extends Pick<RequestUserInputResponse, 'threadId' | 'turnId' | 'appServerEpoch'> {
  sourceAgent?: RuntimeSourceAgent
  kind?: string
  allowImplementationPlanShortcut?: boolean
  approvalPresentation?: PermissionApprovalPresentation
  request_id?: number | string
  requestId?: number | string
  item_id?: string
  itemId?: string
  questions?: RequestUserInputQuestion[]
  // Native terminal receipts can arrive without this viewer submitting an answer.
  resolved?: boolean
  response?: RequestUserInputResponse
  requestUserInputResponse?: RequestUserInputResponse
  request_user_input_response?: RequestUserInputResponse
}

export type RequestUserInputAnswerValues = Record<string, { selectedOptionIds: string[]; text?: string }>

interface RequestUserInputCardProps {
  payload: RequestUserInputPayload
  aliasesByKey?: ReadonlyMap<string, ReadonlySet<string>>
  disabled?: boolean
  // Retire transport guards after owner recovery while preserving form drafts.
  submissionEpoch?: number
  onSubmit?: (response: RequestUserInputResponse, values?: RequestUserInputAnswerValues) => unknown
  onIgnore?: () => void
  selectionValue?: 'label' | 'id'
  autoSubmitOnOptionSelect?: boolean
  preselectFirstOption?: boolean
  focusOnMount?: boolean
  embedded?: boolean
  stickyActions?: boolean
  requireAnswer?: boolean
  allowImplementationPlanShortcut?: boolean
  showIgnoreButton?: boolean
  submitLabel?: string
  ignoreLabel?: string
}

export function RequestUserInputCard(props: RequestUserInputCardProps) {
  const { threadId, turnId, appServerEpoch, sourceAgent } = props.payload
  // A reused parent/block key must not carry drafts or pending transport guards
  // into another request, task, turn, server lifetime or source-agent run.
  const ownerKey = JSON.stringify([threadId, turnId, appServerEpoch,
    props.payload.requestId ?? props.payload.request_id, props.payload.itemId ?? props.payload.item_id,
    sourceAgent?.parentSessionId, sourceAgent?.agentId, sourceAgent?.backgroundRun?.runId])
  const [owner, setOwner] = useState({ key: ownerKey, payload: props.payload })
  const currentKeys = requestUserInputPayloadKeys(props.payload)
  const relatedKeys = owner.key !== ownerKey && props.aliasesByKey
    ? requestUserInputRelatedKeysForPayloads([owner.payload, props.payload], {
        ...owner.payload, answers: {},
      }, props.aliasesByKey)
    : []
  const sameOwner = owner.key === ownerKey || (
    currentKeys.some(key => props.aliasesByKey?.has(key)) &&
    currentKeys.every(key => relatedKeys.includes(key))
  )
  // Keep the original complete binding as the fence through legacy projections.
  // Only registered aliases can retain a form across different transport IDs.
  if (!sameOwner) setOwner({ key: ownerKey, payload: props.payload })
  return <OwnedRequestUserInputCard key={sameOwner ? owner.key : ownerKey} {...props} />
}

function OwnedRequestUserInputCard({
  payload,
  disabled = false,
  submissionEpoch = 0,
  onSubmit,
  onIgnore,
  selectionValue = 'label',
  autoSubmitOnOptionSelect = true,
  preselectFirstOption = true,
  focusOnMount = true,
  embedded = false,
  stickyActions = false,
  requireAnswer = false,
  allowImplementationPlanShortcut = payload.allowImplementationPlanShortcut ?? true,
  showIgnoreButton = true,
  submitLabel,
  ignoreLabel,
}: RequestUserInputCardProps) {
  const { t } = useTranslation('chat')
  const { t: commonT } = useTranslation('common')
  const formRef = useRef<HTMLFormElement | null>(null)
  const isPermission = Boolean(payload.approvalPresentation || (payload.itemId ?? payload.item_id ?? '').startsWith('approval-'))
  const questions = useMemo(() => normalizeQuestions(payload.questions, !isPermission), [payload.questions, isPermission])
  const isImplementationPlanRequest =
    allowImplementationPlanShortcut && isImplementationPlanQuestions(questions)
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>(() =>
    initialAnswers(questions, selectionValue, preselectFirstOption)
  )
  const [multipleAnswers, setMultipleAnswers] = useState<Record<string, string[]>>({})
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({})
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(() =>
    initialActiveQuestionId(questions)
  )
  const [submission, setSubmission] = useState<{ epoch: number } | null>(null)
  const submittedOnce = useRef<{ epoch: number } | null>(null)
  const isDisabled = disabled || submission?.epoch === submissionEpoch
  const incompleteMultiple = questions.some(question => question.multiSelect &&
    !(ownAnswer(multipleAnswers, question.id)?.length || question.allowCustom && ownAnswer(customAnswers, question.id)?.trim()))
  const incompleteRequired =
    requireAnswer &&
    questions.some(question => {
      if (ownAnswer(customAnswers, question.id)?.trim()) return false
      return question.multiSelect
        ? !ownAnswer(multipleAnswers, question.id)?.length
        : !ownAnswer(selectedAnswers, question.id)?.trim()
    })

  useEffect(() => {
    if (focusOnMount) formRef.current?.focus({ preventScroll: true })
  }, [focusOnMount])

  const handleSubmit = (
    answersOverride?: Record<string, string>,
    activeQuestionIdOverride?: string | null,
    customAnswersOverride?: Record<string, string>
  ) => {
    if (
      isDisabled ||
      submittedOnce.current?.epoch === submissionEpoch ||
      questions.length === 0 ||
      incompleteMultiple ||
      incompleteRequired
    )
      return

    const effectiveAnswers = answersOverride ?? selectedAnswers
    const answers = responseAnswers(
      questions,
      effectiveAnswers,
      activeQuestionIdOverride ?? activeQuestionId,
      multipleAnswers,
      customAnswersOverride ?? customAnswers,
      allowImplementationPlanShortcut
    )
    const attempt = { epoch: submissionEpoch }
    submittedOnce.current = attempt
    setSubmission(attempt)
    const response = {
      ...(payload.threadId === undefined ? {} : { threadId: payload.threadId }),
      ...(payload.turnId === undefined ? {} : { turnId: payload.turnId }),
      ...(payload.appServerEpoch === undefined ? {} : { appServerEpoch: payload.appServerEpoch }),
      ...(payload.sourceAgent ? { sourceAgent: payload.sourceAgent } : {}),
      requestId: payload.requestId ?? payload.request_id,
      itemId: payload.itemId ?? payload.item_id,
      answers,
    }
    const releaseSubmission = () => {
      // A retired connection cannot release a newer submission guard.
      if (submittedOnce.current !== attempt) return
      submittedOnce.current = null
      setSubmission(null)
    }
    try {
      // ID-based consumers need the original field provenance. Free text may
      // equal an option ID, and multiple choice may contain both independently.
      const result = selectionValue === 'id'
        ? onSubmit?.(response, Object.fromEntries(questions.map(question => {
            const draft = question.allowCustom
              ? ownAnswer(customAnswersOverride ?? customAnswers, question.id) : undefined
            // Test emptiness without changing indentation or trailing newlines.
            const text = draft?.trim() ? draft : undefined
            const selected = question.multiSelect
              ? ownAnswer(multipleAnswers, question.id) ?? []
              : text ? [] : [ownAnswer(effectiveAnswers, question.id) ?? '']
            const optionIds = new Set(question.options.map(option => option.id))
            return [question.id, {
              selectedOptionIds: [...new Set(selected.filter(value => value && optionIds.has(value)))],
              ...(text ? { text } : {}),
            }]
          })))
        : onSubmit?.(response)
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        void Promise.resolve(result).then(value => {
          if (value === false) releaseSubmission()
        }, releaseSubmission)
      } else if (result === false) releaseSubmission()
    } catch {
      releaseSubmission()
    }
  }

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    handleSubmit()
  }

  const selectOption = (
    question: ReturnType<typeof normalizeQuestions>[number],
    option: RequestUserInputOption
  ) => {
    if (isDisabled || submittedOnce.current?.epoch === submissionEpoch) return
    if (question.multiSelect) {
      const value = optionSelectionValue(option, selectionValue)
      setMultipleAnswers(previous => {
        const selected = ownAnswer(previous, question.id) ?? []
        return {
          ...previous,
          [question.id]: selected.includes(value)
            ? selected.filter(item => item !== value)
            : [...selected, value],
        }
      })
      setActiveQuestionId(question.id)
      return
    }
    const clearedPlanAnswers = isImplementationPlanRequest
      ? emptyCustomAnswersForImplementationPlan(questions)
      : {}
    const nextAnswers = {
      ...selectedAnswers,
      [question.id]: optionSelectionValue(option, selectionValue),
      ...clearedPlanAnswers,
    }
    const nextCustomAnswers = {
      ...customAnswers,
      [question.id]: '',
      ...clearedPlanAnswers,
    }
    setActiveQuestionId(question.id)
    setSelectedAnswers(nextAnswers)
    setCustomAnswers(nextCustomAnswers)
    if (autoSubmitOnOptionSelect && shouldSubmitOnOptionSelect(question, option, questions, allowImplementationPlanShortcut)) {
      handleSubmit(nextAnswers, question.id, nextCustomAnswers)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (isDisabled) return

    if (isImeComposingEvent(event)) {
      // Let IME cancel its candidate without closing this card or its parent panel.
      if (event.key === 'Escape') event.stopPropagation()
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onIgnore?.()
      return
    }

    if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
      return
    }

    const target = event.target as HTMLElement | null
    if (target?.tagName === 'BUTTON') return

    event.preventDefault()
    event.stopPropagation()
    handleSubmit()
  }

  const actionControls = (
    <>
      {showIgnoreButton ? (
        <button
          type="button"
          data-testid="request-user-input-ignore-button"
          disabled={embedded ? disabled : isDisabled}
          onClick={onIgnore}
          className="inline-flex h-9 min-w-[44px] shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-text-muted hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {ignoreLabel ?? t('request_user_input.ignore')}
          <kbd className="rounded border border-border bg-surface px-1.5 py-0.5 text-xs font-semibold text-text-secondary">
            ESC
          </kbd>
        </button>
      ) : null}
      <button
        type="button"
        data-testid="request-user-input-submit-button"
        disabled={isDisabled || questions.length === 0 || incompleteMultiple || incompleteRequired}
        onClick={() => handleSubmit()}
        className="inline-flex h-9 min-w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-full bg-[#2f9bff] px-4 text-sm font-semibold text-white shadow-sm hover:bg-[#1d8af0] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitLabel ?? t('request_user_input.submit')}
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/15">
          <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </button>
    </>
  )

  return (
    <form
      ref={formRef}
      data-testid="request-user-input-card"
      onSubmit={handleFormSubmit}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      className={cn(
        'flex w-full flex-col',
        embedded
          ? 'min-w-0'
          : 'max-h-[min(60dvh,36rem)] rounded-[1.5rem] border border-border bg-background px-4 py-2.5 shadow-[0_18px_42px_rgba(15,23,42,0.10)]'
      )}
    >
      <div
        data-testid="request-user-input-questions"
        className={cn(
          embedded ? 'min-w-0' : 'scrollbar-soft min-h-0 flex-1 overflow-y-auto pr-1',
          stickyActions && 'pb-14'
        )}
      >
        <div className="flex flex-col gap-1.5">
          {questions.map(question => (
            <div key={question.id} className="min-w-0">
              {question.header ? (
                <div className="mb-1 text-sm font-semibold leading-5 text-text-primary">
                  {payload.approvalPresentation ? commonT('approvalUi.title') : question.header}
                </div>
              ) : null}
              {question.multiSelect && <p className="mb-2 text-sm text-text-secondary">{t('request_user_input.multiple_choice_hint')}</p>}
              {payload.approvalPresentation ? (
                <PermissionApprovalContent value={payload.approvalPresentation} />
              ) : (
                <div className="mb-1.5 text-sm font-semibold leading-5 text-text-primary">
                  {question.question}
                </div>
              )}
              {question.options.length > 0 ? (
                <div className="flex flex-col gap-1">
                  {question.options.map((option, index) => {
                    const isSelected = question.multiSelect
                      ? Boolean(
                          ownAnswer(multipleAnswers, question.id)?.includes(
                            optionSelectionValue(option, selectionValue)
                          )
                        )
                      : !ownAnswer(customAnswers, question.id)?.trim() &&
                        ownAnswer(selectedAnswers, question.id) ===
                          optionSelectionValue(option, selectionValue) &&
                        (!isImplementationPlanRequest || activeQuestionId === question.id)
                    return (
                      <button
                        key={`${question.id}-${option.label}-${index}`}
                        type="button"
                        data-testid={`request-user-input-option-${question.id}-${index}`}
                        disabled={isDisabled}
                        aria-pressed={question.multiSelect ? isSelected : undefined}
                        onClick={() => selectOption(question, option)}
                        className={cn(
                          'flex min-h-9 w-full min-w-0 items-start gap-2.5 rounded-2xl px-3 py-2 text-left transition-colors',
                          isSelected ? 'bg-surface' : 'hover:bg-surface',
                          isDisabled && 'cursor-not-allowed opacity-60'
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold leading-none',
                            isSelected
                              ? 'bg-text-primary text-background'
                              : 'bg-surface text-text-muted'
                          )}
                        >
                          {question.multiSelect && isSelected ? <Check className="h-4 w-4" aria-hidden="true"/> : index + 1}
                        </span>
                        <span className="min-w-0 flex-1 whitespace-normal break-words">
                          <span className="text-sm font-semibold leading-5 text-text-primary">
                            {payload.approvalPresentation && permissionChoiceKey(option.label)
                              ? commonT(permissionChoiceKey(option.label)!)
                              : option.label}
                          </span>
                          {option.description ? (
                            <span className="ml-2 text-sm leading-5 text-text-muted">
                              {payload.approvalPresentation &&
                              permissionChoiceKey(option.label, true)
                                ? commonT(permissionChoiceKey(option.label, true)!)
                                : option.description}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ) : null}
              {question.allowCustom ? (
                <div className="mt-1 flex min-w-0 items-center gap-2.5 px-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-text-muted">
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  <textarea
                    rows={2}
                    data-testid={`request-user-input-custom-${question.id}`}
                    aria-label={t('request_user_input.custom_placeholder')}
                    value={ownAnswer(customAnswers, question.id) ?? ''}
                    disabled={isDisabled}
                    onFocus={() => setActiveQuestionId(question.id)}
                    onChange={event => {
                      setActiveQuestionId(question.id)
                      setCustomAnswers(current => ({
                        ...current,
                        [question.id]: event.target.value,
                      }))
                    }}
                    className="min-h-11 max-h-40 min-w-0 flex-1 resize-y rounded-lg border-0 bg-transparent px-0 py-1 text-sm font-semibold leading-5 text-text-primary outline-none placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-60"
                    placeholder={t('request_user_input.custom_placeholder')}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <div
        data-testid="request-user-input-actions"
        className={cn(
          'mt-2 flex shrink-0 items-center justify-end gap-2',
          stickyActions &&
            'sticky bottom-0 z-10 -mx-2.5 border-t border-border bg-background px-2.5 py-2'
        )}
      >
        {actionControls}
      </div>
    </form>
  )
}

export function RequestUserInputSummary({ payload }: { payload: RequestUserInputPayload }) {
  const { t } = useTranslation('chat')
  const { t: commonT } = useTranslation('common')
  const questions = useMemo(() => normalizeQuestions(payload.questions), [payload.questions])
  const response =
    payload.response ?? payload.requestUserInputResponse ?? payload.request_user_input_response
  const rows = questions.map(question => ({
    id: question.id,
    question: payload.approvalPresentation
      ? [commonT('approvalUi.title'), payload.approvalPresentation.subject]
          .filter(Boolean)
          .join(': ')
      : question.question,
    answer:
      payload.approvalPresentation && permissionChoiceKey(responseAnswerText(response, question.id))
        ? commonT(permissionChoiceKey(responseAnswerText(response, question.id))!)
        : responseAnswerText(response, question.id),
  }))
  const itemId = payload.itemId ?? payload.item_id ?? ''
  const isPermission = itemId.startsWith('approval-')

  if (rows.length === 0) return null

  return (
    <div
      data-testid="request-user-input-summary"
      className="min-w-0 overflow-x-hidden text-sm leading-6 text-text-secondary"
    >
      <div className="mb-1.5 inline-flex max-w-full items-center gap-1.5 text-text-muted">
        {isPermission ? (
          <ShieldCheck className="h-4 w-4 shrink-0" strokeWidth={1.7} aria-hidden="true" />
        ) : (
          <MessageCircleQuestion
            className="h-4 w-4 shrink-0"
            strokeWidth={1.7}
            aria-hidden="true"
          />
        )}
        <span>
          {isPermission
            ? t('request_user_input.permission_confirmation')
            : t('request_user_input.asked_count', { count: rows.length })}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
      </div>
      <div className="ml-5 flex min-w-0 flex-col gap-1.5">
        {rows.map(row => (
          <div key={row.id} className="min-w-0">
            <div className="font-medium text-text-secondary">{row.question}</div>
            {row.answer ? (
              <div className="mt-0.5 whitespace-pre-wrap text-text-muted">{row.answer}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function normalizeQuestions(questions: RequestUserInputQuestion[] | undefined, allowFreeform = true) {
  return (questions ?? []).map((question, index) => {
    // IDs are opaque protocol keys; normalize only missing legacy identities.
    const id = question.id?.trim() ? question.id : `question_${index + 1}`
    const options = (question.options ?? [])
      .map(option => ({
        id: option.id,
        // Labels are wire answer values; trimming can merge distinct choices.
        label: option.label ?? '',
        description: option.description?.trim() ?? '',
      }))
      .filter(option => option.label.trim())
    return {
      id,
      header: question.header?.trim() ?? '',
      question: question.question?.trim() || id,
      options,
      multiSelect: question.multiSelect === true || question.multi_select === true,
      allowCustom: allowFreeform && Boolean(question.is_other ?? question.isOther ?? true),
    }
  })
}

// Question IDs are protocol data and may name Object.prototype properties.
// Only explicitly stored drafts belong to a question, including after updates.
function ownAnswer<T>(answers: Record<string, T>, questionId: string): T | undefined {
  return Object.hasOwn(answers, questionId) ? answers[questionId] : undefined
}

function initialAnswers(
  questions: ReturnType<typeof normalizeQuestions>,
  selectionValue: 'label' | 'id',
  preselectFirstOption: boolean
): Record<string, string> {
  return Object.fromEntries(
    questions.map(question => [
      question.id,
      question.multiSelect || !preselectFirstOption
        ? ''
        : optionSelectionValue(question.options[0], selectionValue),
    ])
  )
}

function optionSelectionValue(
  option: RequestUserInputOption | undefined,
  selectionValue: 'label' | 'id'
): string {
  const value = selectionValue === 'id' ? option?.id : option?.label
  return value ?? ''
}

function initialActiveQuestionId(questions: ReturnType<typeof normalizeQuestions>): string | null {
  return implementationPlanOptionQuestion(questions)?.id ?? questions[0]?.id ?? null
}

function responseAnswers(
  questions: ReturnType<typeof normalizeQuestions>,
  selectedAnswers: Record<string, string>,
  activeQuestionId: string | null,
  multipleAnswers: Record<string, string[]>,
  customAnswers: Record<string, string>,
  allowImplementationPlanShortcut: boolean
): RequestUserInputResponse['answers'] {
  if (!allowImplementationPlanShortcut || !isImplementationPlanQuestions(questions)) {
    return Object.fromEntries(
      questions.map(question => {
        const customAnswer = ownAnswer(customAnswers, question.id) ?? ''
        return [question.id, {
          answers: question.multiSelect
            ? [
                ...new Set([
                  ...(ownAnswer(multipleAnswers, question.id) ?? []),
                  ...(question.allowCustom && customAnswer.trim()
                    ? [customAnswer]
                    : []),
                ]),
              ]
            : [
                question.allowCustom && customAnswer.trim()
                  ? customAnswer
                  : (ownAnswer(selectedAnswers, question.id) ?? ''),
              ],
        }]
      })
    )
  }

  const activeQuestion = questions.find(question => question.id === activeQuestionId)
  const activeCustomAnswer = ownAnswer(customAnswers, activeQuestionId ?? '')
  if (activeQuestion?.allowCustom && activeCustomAnswer?.trim()) {
    return {
      [activeQuestion.id]: {
        answers: [activeCustomAnswer],
      },
    }
  }

  const implementQuestion = implementationPlanOptionQuestion(questions)
  if (!implementQuestion) return {}

  return {
    [implementQuestion.id]: {
      answers: [ownAnswer(selectedAnswers, implementQuestion.id) ?? implementQuestion.options[0]?.label ?? ''],
    },
  }
}

function emptyCustomAnswersForImplementationPlan(
  questions: ReturnType<typeof normalizeQuestions>
): Record<string, string> {
  if (!isImplementationPlanQuestions(questions)) return {}

  return Object.fromEntries(
    questions
      .filter(question => question.allowCustom && question.options.length === 0)
      .map(question => [question.id, ''])
  )
}

function shouldSubmitOnOptionSelect(
  question: ReturnType<typeof normalizeQuestions>[number],
  option: RequestUserInputOption,
  questions: ReturnType<typeof normalizeQuestions>,
  allowImplementationPlanShortcut: boolean
): boolean {
  if (question.multiSelect) return false
  if (questions.length === 1) return true
  return allowImplementationPlanShortcut &&
    (question.id === 'implement' || hasImplementationPlanText(option.label))
}

function isImplementationPlanQuestions(questions: ReturnType<typeof normalizeQuestions>): boolean {
  if (questions.some(question => question.multiSelect)) return false
  return Boolean(implementationPlanOptionQuestion(questions))
}

function implementationPlanOptionQuestion(
  questions: ReturnType<typeof normalizeQuestions>
): ReturnType<typeof normalizeQuestions>[number] | undefined {
  return questions.find(question => {
    if (question.id.trim().toLowerCase() === 'implement') return true
    if (hasImplementationPlanText(question.question)) return true
    return question.options.some(option => hasImplementationPlanText(option.label))
  })
}

function responseAnswerText(
  response: RequestUserInputResponse | undefined,
  questionId: string
): string {
  return (
    response?.answers?.[questionId]?.answers
      ?.map(answer => answer.trim())
      .filter(Boolean)
      .join('\n') ?? ''
  )
}
