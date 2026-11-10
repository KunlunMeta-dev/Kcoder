import { asyncQuestionRevisionFingerprint, asyncQuestionSourceFingerprint, asyncQuestionCommittedStateChanged } from '../../../../shared/asyncQuestionRevision'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, MessageCircleQuestion, RefreshCw } from 'lucide-react'
import type {
  AsyncQuestionAnswerResult,
  AsyncQuestionListResult,
  AsyncQuestionRecord,
} from '../../../../shared/generated/contracts'
import { isAsyncQuestionAnswerResult, isAsyncQuestionListResult } from '../../../../shared/generated/contractGuards.mjs'
import { useTranslation } from '@/hooks/useTranslation'
import { createRandomUuid } from '@/lib/random-id'
import { workspacePathKey } from '@/lib/workspace-path-identity'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { requestLocalExecutor, subscribeLocalExecutorEvents } from '@/host/localExecutor'
import type { RuntimeTaskAddress } from '@/types/api'
import { ComposerStatusItem, useComposerStatusItem } from './composer/ComposerStatusRegion'
import { RequestUserInputCard, type RequestUserInputPayload, type RequestUserInputAnswerValues } from './RequestUserInputCard'

type Availability = 'checking' | 'recovering' | 'unsupported' | 'supported' | 'unavailable'

interface Props {
  address: RuntimeTaskAddress
  pendingCreation?: boolean
}

interface SubmissionIdentity {
  fingerprint: string
  submissionId: string
}

type QuestionReadFailureStage = 'support' | 'owner' | 'initialList' | 'refreshList' | 'subscription'

interface QuestionReadFailure {
  ownerKey: string
  stage: QuestionReadFailureStage
}

class QuestionOwnerMismatchError extends Error {}

const readFailureKeys: Record<QuestionReadFailureStage, { short: string; detail: string }> = {
  subscription: {
    short: 'async_questions.subscriptionErrorShort',
    detail: 'async_questions.subscriptionError',
  },
  support: {
    short: 'async_questions.supportReadErrorShort',
    detail: 'async_questions.supportReadError',
  },
  owner: {
    short: 'async_questions.ownerResolutionErrorShort',
    detail: 'async_questions.ownerResolutionError',
  },
  initialList: {
    short: 'async_questions.initialListReadErrorShort',
    detail: 'async_questions.initialListReadError',
  },
  refreshList: {
    short: 'async_questions.refreshListErrorShort',
    detail: 'async_questions.refreshListError',
  },
}

// Structural wire guards cannot bind saved answers to the original items and
// options. Check that binding before a list or competing receipt consumes drafts.
function hasValidQuestionAnswers(question: AsyncQuestionRecord): boolean {
  // Wire guards allow zero revisions and arbitrary Vec lengths; State requires
  // positive revisions, one to eight items and at most sixteen options per item.
  if (question.revision < 1 || question.questions.length < 1 || question.questions.length > 8) return false
  if (new Set(question.questions.map(item => item.id)).size !== question.questions.length ||
      question.questions.some(item => item.options.length > 16 ||
        new Set(item.options.map(option => option.id)).size !== item.options.length))
    return false
  const answers = question.answer?.answers
  // Delivery states require the saved answer; a status alone must not consume
  // an unanswered card or its draft. Withdrawal may precede any answer.
  if (!answers) return ['pending', 'cancelled', 'stale'].includes(question.status)
  // State cannot keep a saved answer on an answerable pending question.
  if (question.status === 'pending') return false
  if (Object.keys(answers).length !== question.questions.length) return false
  return question.questions.every(item => {
    if (!Object.hasOwn(answers, item.id)) return false
    const answer = answers[item.id]
    const selected = answer.selectedOptionIds ?? []
    const optionIds = new Set(item.options.map(option => option.id))
    return (item.multiSelect || selected.length <= 1) &&
      new Set(selected).size === selected.length &&
      selected.every(id => optionIds.has(id)) &&
      (selected.length > 0 || Boolean(answer.text?.trim()))
  })
}

const genericReadFailureShortKey = 'async_questions.statusReadErrorShort'

export function AsyncQuestionPanel(props: Props) {
  const scope = usePluginTargetScope(props.address.deviceId, workspacePathKey(props.address.workspacePath))
  // An address can survive an account or target rebind. Retire its old drafts,
  // submission identities and receipt handlers with the existing UI lifetime.
  return <OwnedAsyncQuestionPanel key={scope.key} {...props} isOwnerCurrent={scope.isCurrent} />
}

function OwnedAsyncQuestionPanel({ address, pendingCreation = false, isOwnerCurrent }: Props & {
  isOwnerCurrent: () => boolean
}) {
  // Keep every rendered identity fixed across callbacks and awaited reads.
  const { taskId, deviceId, threadId, workspacePath: rawWorkspacePath } = address
  const targetKey = JSON.stringify([
    taskId,
    deviceId,
    threadId ?? null,
    workspacePathKey(rawWorkspacePath),
  ])
  // Preserve the original RPC path spelling while this task address is equivalent.
  // Recreating read callbacks for path aliases unmounts cards and loses answer drafts.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- targetKey includes the path comparison identity; never send that normalized key as an RPC path.
  const workspacePath = useMemo(() => rawWorkspacePath, [targetKey])
  const { t } = useTranslation('chat')
  const statusItem = useComposerStatusItem('questions')
  const {
    available: hasComposerStatusRegion,
    expanded: regionExpanded,
    close: closeStatusItem,
  } = statusItem
  const [availability, setAvailability] = useState<Availability>('checking')
  const [questions, setQuestions] = useState<AsyncQuestionRecord[]>([])
  const [questionOwnerKey, setQuestionOwnerKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const contentId = useId()
  const [readFailure, setReadFailure] = useState<QuestionReadFailure | null>(null)
  const [subscriptionFailureOwner, setSubscriptionFailureOwner] = useState<string | null>(null)
  const [showDismissed, setShowDismissed] = useState(false)
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set())
  const [submissionErrors, setSubmissionErrors] = useState<Partial<Record<string, number>>>({})
  const submissions = useRef(new Map<string, SubmissionIdentity>())
  const resolvedThreadId = useRef<string | null>(null)
  const questionsOwner = useRef<string | null>(null)
  const questionListHasRecords = useRef(false)
  const pendingCreationRef = useRef(pendingCreation)
  useLayoutEffect(() => {
    pendingCreationRef.current = pendingCreation
  }, [pendingCreation])
  const retryRef = useRef<(recheckSupport?: boolean) => void>(() => undefined)
  const retrySubscriptionRef = useRef<() => void>(() => undefined)
  const loadSequence = useRef(0)
  const listRefresh = useRef<{
    ownerSequence: number
    again: boolean
    notificationFingerprints: Set<string>
    promise: Promise<void>
  } | null>(null)
  const ownerSequence = useRef(0)
  const [submissionEpoch, setSubmissionEpoch] = useState(0)
  const targetRef = useRef(targetKey)
  // Track accepted content synchronously: multiple RPC completions may share a
  // React batch, before a layout effect could observe the first state update.
  const displayedQuestions = useRef({ ownerKey: questionOwnerKey, questions })
  const currentReadFailure = readFailure?.ownerKey === targetKey ? readFailure.stage
    : subscriptionFailureOwner === targetKey ? 'subscription' : null
  const loadError = currentReadFailure !== null

  const acceptList = useCallback((result: AsyncQuestionListResult, expectedThreadId: string) => {
    // A typed transport response is still untrusted JSON. Reject malformed
    // nested records before React state can turn a read failure into a crash.
    if (!isAsyncQuestionListResult(result)) throw new Error('Invalid asynchronous question list')
    if (result.threadId !== expectedThreadId)
      throw new QuestionOwnerMismatchError('task changed')
    if (result.questions.some(question => question.threadId !== expectedThreadId))
      throw new QuestionOwnerMismatchError('question owner changed')
    // Native and older Gateways may bypass the broker's duplicate-ID fence.
    // Ambiguous cards cannot share drafts, submission identities or React keys.
    const receivedIds = new Set(result.questions.map(question => question.questionId))
    if (receivedIds.size !== result.questions.length ||
        !result.questions.every(hasValidQuestionAnswers))
      throw new Error('Invalid asynchronous question identity or saved answer')
    // Revisions order one original question, not a reused ID from another
    // request. Validate before state updates so failure keeps the card/draft.
    if (displayedQuestions.current.ownerKey === targetRef.current) {
      const known = new Map(displayedQuestions.current.questions.map(question => [question.questionId, question]))
      // Full lists include terminal records; absence cannot withdraw a known
      // question or discard its draft, even after a reconnect.
      if ([...known.keys()].some(id => !receivedIds.has(id)))
        throw new Error('Incomplete asynchronous question list')
      if (result.questions.some(question => {
        const previous = known.get(question.questionId)
        if (previous && asyncQuestionCommittedStateChanged(previous, question))
          throw new Error('Conflicting asynchronous question state')
        return previous && (asyncQuestionSourceFingerprint(previous) !== asyncQuestionSourceFingerprint(question) ||
          (previous.revision === question.revision &&
            asyncQuestionRevisionFingerprint(previous) !== asyncQuestionRevisionFingerprint(question)))
      })) throw new QuestionOwnerMismatchError('question source changed')
    }
    // List replies must not undo a newer answer receipt received in flight.
    const sameOwner = questionsOwner.current === targetRef.current
    questionsOwner.current = targetRef.current
    setQuestionOwnerKey(targetRef.current)
    questionListHasRecords.current = result.questions.length > 0
    const currentById = new Map((sameOwner ? displayedQuestions.current.questions : [])
      .map(question => [question.questionId, question]))
    const reconciled = result.questions.map(question => {
      const previous = currentById.get(question.questionId)
      return previous?.threadId === expectedThreadId && previous.revision > question.revision
        ? previous
        : question
    })
    displayedQuestions.current = { ownerKey: targetRef.current, questions: reconciled }
    setQuestions(reconciled)
    setReadFailure(null)
  }, [])

  const refresh = useCallback(
    async (expectedTargetKey: string) => {
      const selectedThreadId = resolvedThreadId.current
      if (
        !isOwnerCurrent() ||
        pendingCreationRef.current ||
        !selectedThreadId ||
        targetRef.current !== expectedTargetKey
      ) return
      const requestOwnerSequence = ownerSequence.current
      const isCurrent = () => isOwnerCurrent() && !pendingCreationRef.current &&
        ownerSequence.current === requestOwnerSequence &&
        targetRef.current === expectedTargetKey &&
        resolvedThreadId.current === selectedThreadId
      loadSequence.current += 1
      const pending = listRefresh.current
      if (pending?.ownerSequence === requestOwnerSequence) {
        // Notifications received during a read need a later snapshot, without
        // spending another concurrent RPC slot or applying the superseded list.
        pending.again = true
        return pending.promise
      }
      let resolve!: () => void
      let reject!: (error: unknown) => void
      const promise = new Promise<void>((onResolve, onReject) => {
        resolve = onResolve
        reject = onReject
      })
      const refresh = {
        ownerSequence: requestOwnerSequence,
        again: false,
        notificationFingerprints: new Set<string>(),
        promise,
      }
      listRefresh.current = refresh
      const release = () => {
        if (listRefresh.current === refresh) listRefresh.current = null
      }
      void (async () => {
        try {
          do {
            refresh.again = false
            const requestSequence = loadSequence.current
            try {
              const result = await requestLocalExecutor<AsyncQuestionListResult>(
                'runtime.asyncQuestion.request',
                {
                  taskId: taskId,
                  deviceId,
                  ...(workspacePath == null ? {} : { workspacePath: workspacePath }),
                  method: 'asyncQuestion/list',
                  params: { threadId: selectedThreadId, includeTerminal: true },
                }
              )
              if (!isCurrent() || requestSequence !== loadSequence.current) continue
              acceptList(result, selectedThreadId)
            } catch (error) {
              if (isCurrent() && requestSequence === loadSequence.current) {
                setReadFailure({
                  ownerKey: expectedTargetKey,
                  stage: error instanceof QuestionOwnerMismatchError
                    ? 'owner'
                    : questionListHasRecords.current && questionsOwner.current === expectedTargetKey
                      ? 'refreshList'
                      : 'initialList',
                })
              }
            } finally {
              if (isCurrent() && requestSequence === loadSequence.current) {
                // Recovery must finish original-task readback before answers reopen.
                setAvailability('supported')
                setLoading(false)
              }
            }
          } while (refresh.again && isCurrent())
        } finally {
          // Release in the read's continuation, before another microtask can
          // enqueue a notification onto an already-finished refresh loop.
          release()
        }
      })().then(resolve, reject)
      return promise
    },
    [acceptList, deviceId, taskId, workspacePath, isOwnerCurrent]
  )

  useEffect(() => {
    let active = true
    const currentTarget = targetKey
    let unlisten: (() => void) | undefined
    let subscribing = false
    setSubmissionEpoch(++ownerSequence.current)
    targetRef.current = currentTarget
    resolvedThreadId.current = null
    submissions.current.clear()
    loadSequence.current += 1

    if (questionsOwner.current !== currentTarget) {
      questionsOwner.current = null
      setQuestionOwnerKey(null)
      questionListHasRecords.current = false
      displayedQuestions.current = { ownerKey: null, questions: [] }
      setQuestions([])
      setDismissedIds(new Set())
      setShowDismissed(false)
      setSubmissionErrors({})
    }
    setAvailability('checking')
    setReadFailure(null)
    setSubscriptionFailureOwner(null)
    setLoading(true)

    if (pendingCreation) {
      return () => {
        active = false
        ownerSequence.current += 1
        resolvedThreadId.current = null
        loadSequence.current += 1
      }
    }

    const subscribe = () => {
      if (!active || unlisten || subscribing) return
      subscribing = true
      void subscribeLocalExecutorEvents(event => {
        if (
          !active ||
          !isOwnerCurrent() ||
          pendingCreationRef.current ||
          targetRef.current !== currentTarget ||
          !['async-question:changed', 'async-question:refresh'].includes(event.event) ||
          event.payload.taskId !== taskId ||
          event.payload.serverId !== deviceId ||
          (resolvedThreadId.current && event.payload.threadId !== resolvedThreadId.current)
        )
          return
        if (event.event === 'async-question:refresh') {
          if (typeof event.payload.threadId !== 'string' || !event.payload.threadId ||
              (threadId && event.payload.threadId !== threadId) ||
              (workspacePath != null && (typeof event.payload.workspacePath !== 'string' ||
                workspacePathKey(event.payload.workspacePath) !== workspacePathKey(workspacePath)))) return
          // Retry capability failures too; retain mounted cards and answer drafts.
          retryRef.current(true)
          return
        }
        const previous = displayedQuestions.current.ownerKey === currentTarget
          ? displayedQuestions.current.questions.find(question =>
              question.questionId === event.payload.questionId &&
              question.threadId === event.payload.threadId)
          : undefined
        // Complete Gateway snapshots identify exact replays without another
        // read. Legacy hints and same-revision conflicts must still reconcile.
        if (previous && event.payload.revisionFingerprint === asyncQuestionRevisionFingerprint(previous)) return
        if (previous && typeof event.payload.revision === 'number' &&
            Number.isSafeInteger(event.payload.revision) &&
            event.payload.revision < previous.revision) return
        // Unseen cards cannot use the displayed-record replay fence yet. Keep
        // each distinct hint only for this coalesced read, so interleaved
        // delivery cannot invalidate every trailing snapshot before it applies.
        const pending = listRefresh.current
        const { questionId, revisionFingerprint } = event.payload
        if (pending?.ownerSequence === ownerSequence.current &&
            typeof questionId === 'string' && typeof revisionFingerprint === 'string') {
          const fingerprint = JSON.stringify([questionId, revisionFingerprint])
          if (pending.notificationFingerprints.has(fingerprint)) return
          // Bound retained hints; previously unseen excess hints still refresh.
          if (pending.notificationFingerprints.size < 512)
            pending.notificationFingerprints.add(fingerprint)
        }
        void refresh(currentTarget)
      })
        .then(stop => {
          subscribing = false
          if (active) {
            unlisten = stop
            setSubscriptionFailureOwner(null)
            // Native registration may finish after the first snapshot. Reconcile
            // changes missed in that gap through the existing coalesced read.
            if (resolvedThreadId.current) void refresh(currentTarget)
          } else stop()
        })
        .catch(() => {
          subscribing = false
          // A successful snapshot does not restore live updates. Retain this
          // failure separately until registration succeeds for this task visit.
          if (active) setSubscriptionFailureOwner(currentTarget)
        })
    }
    retrySubscriptionRef.current = subscribe
    subscribe()

    const supportSequence = loadSequence.current
    void requestLocalExecutor<{ supported?: boolean; threadId?: string }>(
      'runtime.asyncQuestion.supports',
      {
        taskId: taskId,
        deviceId,
        ...(workspacePath == null ? {} : { workspacePath: workspacePath }),
      }
    )
      .then(async result => {
        if (!active || !isOwnerCurrent() || pendingCreationRef.current || targetRef.current !== currentTarget ||
            supportSequence !== loadSequence.current) return
        if (result.supported === false) {
          setAvailability('unsupported')
          setLoading(false)
          return
        }
        if (result.supported !== true) throw new Error('Invalid asynchronous question capability')
        const canonicalThreadId = typeof result.threadId === 'string' ? result.threadId.trim() : ''
        if (!canonicalThreadId || (threadId && threadId !== canonicalThreadId)) {
          setAvailability('unavailable')
          setReadFailure({ ownerKey: currentTarget, stage: 'owner' })
          setLoading(false)
          return
        }
        resolvedThreadId.current = canonicalThreadId
        await refresh(currentTarget)
      })
      .catch(() => {
        if (!active || !isOwnerCurrent() || pendingCreationRef.current || targetRef.current !== currentTarget ||
            supportSequence !== loadSequence.current) return
        setAvailability('unavailable')
        setReadFailure({ ownerKey: currentTarget, stage: 'support' })
        setLoading(false)
      })

    return () => {
      active = false
      ownerSequence.current += 1
      resolvedThreadId.current = null
      loadSequence.current += 1
      unlisten?.()
    }
  }, [deviceId, taskId, threadId, workspacePath, pendingCreation, refresh, targetKey, isOwnerCurrent])

  const retry = useCallback((recheckSupport = false) => {
    if (!isOwnerCurrent() || pendingCreationRef.current) return
    retrySubscriptionRef.current()
    if (availability === 'supported' && !recheckSupport) {
      setLoading(true)
      void refresh(targetKey)
      return
    }
    // Retire in-flight reads and answers even if recovery returns the same
    // thread. Its new snapshot cannot be overwritten by the old connection.
    setSubmissionEpoch(++ownerSequence.current)
    // Suspend the old connection's question binding until capability discovery
    // settles. A changed event must not start a list and supersede that result.
    resolvedThreadId.current = null
    const requestSequence = ++loadSequence.current
    // Recovery must negotiate the new connection without unmounting a supported
    // card and losing its unsent draft while the capability read is in flight.
    setAvailability(questionsOwner.current === targetKey && questionListHasRecords.current
      ? 'recovering' : 'checking')
    setLoading(true)
    void requestLocalExecutor<{ supported?: boolean; threadId?: string }>(
      'runtime.asyncQuestion.supports',
      {
        taskId: taskId,
        deviceId,
        ...(workspacePath == null ? {} : { workspacePath: workspacePath }),
      }
    )
      .then(result => {
        // The same task may have been left and revisited while this read waited.
        if (
          !isOwnerCurrent() ||
          pendingCreationRef.current ||
          targetRef.current !== targetKey ||
          requestSequence !== loadSequence.current
        ) return
        if (result.supported === false) {
          resolvedThreadId.current = null
          setAvailability('unsupported')
          setLoading(false)
          return
        }
        if (result.supported !== true) throw new Error('Invalid asynchronous question capability')
        const canonicalThreadId = typeof result.threadId === 'string' ? result.threadId.trim() : ''
        if (
          !canonicalThreadId ||
          (threadId && threadId !== canonicalThreadId)
        ) {
          setAvailability('unavailable')
          setReadFailure({ ownerKey: targetKey, stage: 'owner' })
          setLoading(false)
          return
        }
        resolvedThreadId.current = canonicalThreadId
        void refresh(targetKey)
      })
      .catch(() => {
        if (
          !isOwnerCurrent() ||
          pendingCreationRef.current ||
          targetRef.current !== targetKey ||
          requestSequence !== loadSequence.current
        ) return
        setAvailability('unavailable')
        setReadFailure({ ownerKey: targetKey, stage: 'support' })
        setLoading(false)
      })
  }, [deviceId, taskId, threadId, workspacePath, availability, refresh, targetKey, isOwnerCurrent])

  useLayoutEffect(() => {
    retryRef.current = retry
  }, [retry])

  const dismiss = useCallback((questionId: string) => {
    setDismissedIds(previous => new Set(previous).add(questionId))
  }, [])

  const collapse = useCallback(() => {
    if (hasComposerStatusRegion) {
      closeStatusItem()
      return
    }
    setExpanded(false)
    toggleRef.current?.focus({ preventScroll: true })
  }, [closeStatusItem, hasComposerStatusRegion])

  const sendAnswer = useCallback(
    async (
      record: AsyncQuestionRecord,
      submissionId: string,
      answers: NonNullable<AsyncQuestionRecord['answer']>['answers']
    ) => {
      if (!isOwnerCurrent() || targetRef.current !== targetKey || !resolvedThreadId.current) {
        throw new Error('task changed')
      }
      const requestOwnerSequence = ownerSequence.current
      const selectedThreadId = resolvedThreadId.current
      // A task visit owns its receipt handling and follow-up reads.
      const isCurrent = () => isOwnerCurrent() && ownerSequence.current === requestOwnerSequence &&
        !pendingCreationRef.current && targetRef.current === targetKey &&
        resolvedThreadId.current === selectedThreadId
      setSubmissionErrors(current => ({ ...current, [record.questionId]: undefined }))
      try {
        const response = await requestLocalExecutor<AsyncQuestionAnswerResult>(
          'runtime.asyncQuestion.request',
          {
            taskId: taskId,
            deviceId,
            ...(workspacePath == null ? {} : { workspacePath: workspacePath }),
            method: 'asyncQuestion/answer',
            params: {
              threadId: selectedThreadId,
              questionId: record.questionId,
              submissionId,
              expectedRevision: record.revision,
              answers,
            },
          }
        )
        // A discarded receipt must release the card's local submission guard.
        // Recovery rereads the outcome; normal completion would leave a retained
        // pending card permanently submitted even though no receipt was applied.
        if (!isCurrent()) throw new QuestionOwnerMismatchError('task changed')
        // Legacy targets omit the nested task ID. Bind only that omission to
        // the captured task, then retain the full generated receipt validation.
        const startedTurn = response?.startedTurn
        const result = startedTurn && startedTurn.threadId === undefined
          ? { ...response, startedTurn: { ...startedTurn, threadId: selectedThreadId } }
          : response
        // A losing answer still returns the saved winner. Without that answer,
        // completion cannot consume the draft or mark its card submitted.
        if (!isAsyncQuestionAnswerResult(result) || !result.question.answer || !hasValidQuestionAnswers(result.question))
          throw new Error('Invalid asynchronous question receipt')
        if (
          result.threadId !== selectedThreadId ||
          result.question.threadId !== selectedThreadId ||
          result.question.questionId !== record.questionId ||
          asyncQuestionSourceFingerprint(result.question) !== asyncQuestionSourceFingerprint(record) ||
          (result.startedTurn != null && (!result.startedTurn.id.trim() ||
            result.startedTurn.threadId !== selectedThreadId ||
            (Reflect.get(result.startedTurn, 'turnId') !== undefined &&
              Reflect.get(result.startedTurn, 'turnId') !== result.startedTurn.id)))
        )
          throw new Error('question owner changed')
        // Native compatibility results also reach this panel directly. Confirm
        // the exact accepted input before replacing its draft with a receipt.
        // A losing device may still display the authoritative winner.
        const saved = result.question.answer
        if (result.accepted === true && (saved.submissionId !== submissionId ||
            Object.keys(saved.answers).length !== Object.keys(answers).length ||
            Object.entries(answers).some(([id, answer]) => {
              if (!Object.hasOwn(saved.answers, id)) return true
              const received = saved.answers[id]
              const selected = answer.selectedOptionIds ?? []
              const receivedSelected = received.selectedOptionIds ?? []
              return selected.length !== receivedSelected.length ||
                selected.some((option, index) => option !== receivedSelected[index]) ||
                (answer.text ?? null) !== (received.text ?? null)
            })))
          throw new Error('Asynchronous question receipt does not match the submitted answer')
        // A receipt may follow a list refresh while the answer is pending.
        // Keep equal-revision content, saved answers and confirmed terminal states.
        const previous = displayedQuestions.current.questions.find(question =>
          question.questionId === record.questionId) ?? record
        if (asyncQuestionCommittedStateChanged(previous, result.question) ||
            (previous.revision === result.question.revision &&
              asyncQuestionRevisionFingerprint(previous) !== asyncQuestionRevisionFingerprint(result.question)))
          throw new Error('Conflicting asynchronous question receipt')
        submissions.current.delete(record.questionId)
        setDismissedIds(current => {
          const next = new Set(current)
          next.delete(record.questionId)
          return next
        })
        const reconciled = displayedQuestions.current.questions.map(question =>
          question.questionId === record.questionId &&
          question.revision <= result.question.revision
            ? result.question
            : question
        )
        displayedQuestions.current = { ownerKey: targetKey, questions: reconciled }
        setQuestions(reconciled)
      } catch (error) {
        if (isCurrent()) {
          setSubmissionErrors(current => ({
            ...current,
            [record.questionId]: Math.max(
              current[record.questionId] ?? record.revision,
              record.revision
            ),
          }))
          // Keep uncertain actions closed until original-task readback settles.
          setLoading(true)
          void refresh(targetKey)
        }
        throw error
      }
    },
    [deviceId, taskId, workspacePath, refresh, targetKey, isOwnerCurrent]
  )

  const submit = useCallback(
    async (record: AsyncQuestionRecord, answers: RequestUserInputAnswerValues | undefined) => {
      if (!answers) throw new Error('Structured asynchronous question answers are required')
      const fingerprint = JSON.stringify(answers)
      const previous = submissions.current.get(record.questionId)
      const submissionId =
        previous?.fingerprint === fingerprint ? previous.submissionId : createRandomUuid()
      submissions.current.set(record.questionId, { fingerprint, submissionId })
      await sendAnswer(record, submissionId, answers)
    },
    [sendAnswer]
  )

  const retrySavedAnswer = useCallback(
    async (record: AsyncQuestionRecord) => {
      const savedAnswer = record.answer
      if ((record.status !== 'queued' && record.status !== 'answer_saved') || !savedAnswer) {
        throw new Error('No queued answer is available to continue.')
      }
      await sendAnswer(record, savedAnswer.submissionId, savedAnswer.answers)
    },
    [sendAnswer]
  )

  const ownedQuestions = questionOwnerKey === targetKey ? questions : []
  const hasOwnedRecords = ownedQuestions.length > 0
  const activeQuestions = ownedQuestions.filter(
    question => showDismissed || !dismissedIds.has(question.questionId)
  )
  const hiddenCount = ownedQuestions.filter(question => dismissedIds.has(question.questionId)).length
  const isExpanded = hasComposerStatusRegion ? regionExpanded : expanded
  const pendingCount = ownedQuestions
    .filter(question => question.status === 'pending')
    .reduce((count, question) => count + question.questions.length, 0)
  const deliveryCount = ownedQuestions.filter(
    question =>
      (question.status === 'queued' || question.status === 'answer_saved') && question.answer
  ).length
  const deliveryFailedCount = ownedQuestions.filter(question => question.status === 'delivery_failed').length
  const deliveryUnknownCount = ownedQuestions.filter(question => question.status === 'delivery_unknown').length
  // A newer authoritative revision supersedes the local transport failure,
  // including when that failure arrives after the refreshed record. Keep an
  // unchanged pending/saved answer uncertain; delivery errors have their own status.
  const unconfirmedQuestionIds = new Set(
    ownedQuestions
      .filter(question => {
        const failedRevision = submissionErrors[question.questionId]
        return (
          failedRevision !== undefined &&
          failedRevision >= question.revision &&
          (question.status === 'pending' ||
            question.status === 'queued' ||
            question.status === 'answer_saved')
        )
      })
      .map(question => question.questionId)
  )
  const submissionErrorCount = unconfirmedQuestionIds.size
  const attention =
    loadError || deliveryFailedCount > 0 || deliveryUnknownCount > 0 || submissionErrorCount > 0
  const failureSummary = currentReadFailure
    ? t(hasOwnedRecords ? readFailureKeys[currentReadFailure].short : genericReadFailureShortKey)
    : ''
  const summary = [
    failureSummary,
    pendingCount > 0 ? t('async_questions.pendingCount', { count: pendingCount }) : '',
    deliveryCount > 0 ? t('async_questions.deliveryCount', { count: deliveryCount }) : '',
    deliveryFailedCount > 0
      ? t('async_questions.deliveryFailedCount', { count: deliveryFailedCount })
      : '',
    deliveryUnknownCount > 0
      ? t('async_questions.deliveryUnknownCount', { count: deliveryUnknownCount })
      : '',
    submissionErrorCount > 0 ? t('async_questions.submitErrorShort') : '',
  ]
    .filter(Boolean)
    .join(' · ')

  if (pendingCreation || availability === 'checking' || availability === 'unsupported') return null
  if (availability === 'unavailable' && !loadError) return null
  if (availability === 'supported' && !loadError && !hasOwnedRecords) return null
  const questionTitle = loadError && !hasOwnedRecords
    ? t('composer_status.questionStatus')
    : t('composer_status.questions')

  const showDismissedButton = isExpanded && hiddenCount > 0 ? (
    <button
      type="button"
      data-testid="async-question-show-dismissed"
      onClick={() => setShowDismissed(value => !value)}
      className="rounded-lg px-2 py-1 text-xs font-medium text-text-secondary hover:bg-surface"
    >
      {showDismissed
        ? t('async_questions.hideDismissed')
        : t('async_questions.showDismissed', { count: hiddenCount })}
    </button>
  ) : null

  const refreshButton = (
    <button
      type="button"
      data-testid="async-question-refresh"
      aria-label={t('async_questions.refresh')}
      disabled={loading}
      onClick={() => retry()}
      className="inline-flex h-8 w-8 items-center justify-center rounded-full text-text-muted hover:bg-surface hover:text-text-primary disabled:opacity-50"
    >
      <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
    </button>
  )

  const details = (
    <div
      id={contentId}
      data-testid="async-question-content"
      hidden={!hasComposerStatusRegion && !expanded}
      className={
        hasComposerStatusRegion
          ? 'flex min-w-0 flex-col gap-2 pb-1'
          : expanded
            ? 'scrollbar-soft mt-1 flex max-h-[min(32dvh,18rem)] min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain pb-1'
            : 'hidden'
      }
    >
      {hasComposerStatusRegion ? (
        <div className="flex items-center justify-end gap-2">
          {showDismissedButton}
          {refreshButton}
        </div>
      ) : null}
      <p className="px-1 text-xs text-text-muted">{t('async_questions.nonBlockingHint')}</p>
      {loadError ? (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-surface px-3 py-2 text-sm text-text-secondary">
          <span>{t(readFailureKeys[currentReadFailure!].detail)}</span>
          <button
            type="button"
            data-testid="async-question-retry"
            disabled={loading}
            onClick={() => retry()}
            className="shrink-0 rounded-lg px-2 py-1 font-semibold text-text-primary hover:bg-background disabled:opacity-50"
          >
            {t('async_questions.retry')}
          </button>
        </div>
      ) : null}
      {activeQuestions.map(question => (
        <AsyncQuestionCard
          key={question.questionId}
          question={question}
          submissionEpoch={submissionEpoch}
          disabled={availability !== 'supported' || loadError || (loading && unconfirmedQuestionIds.has(question.questionId))}
          submissionError={unconfirmedQuestionIds.has(question.questionId)}
          stickyActions={hasComposerStatusRegion}
          onSubmit={(_response, answers) => submit(question, answers)}
          onRetrySavedAnswer={() => retrySavedAnswer(question)}
          onDismiss={() =>
            question.status === 'pending' ? collapse() : dismiss(question.questionId)
          }
        />
      ))}
      {loading && !hasOwnedRecords && !loadError ? (
        <p className="px-1 text-sm text-text-muted">{t('async_questions.loading')}</p>
      ) : null}
      {availability === 'unavailable' && !loading ? (
        <p className="px-1 text-sm text-text-muted">{t('async_questions.unavailable')}</p>
      ) : null}
    </div>
  )

  const standalonePanel = (
    <section
      data-testid="async-question-panel"
      data-task-id={taskId}
      onKeyDown={event => {
        if (expanded && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          collapse()
        }
      }}
      className="mb-2 flex min-w-0 shrink-0 flex-col rounded-xl border border-border bg-background/95 px-3 py-1.5"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <button
          ref={toggleRef}
          type="button"
          data-testid="async-question-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded(value => !value)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left text-sm text-text-primary sm:min-h-8"
        >
          <ChevronDown
            className={`h-4 w-4 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`}
            aria-hidden="true"
          />
          <span className="truncate font-medium">{t('async_questions.title')}</span>
          {summary ? (
            <span
              data-testid="async-question-summary"
              className="min-w-0 truncate text-xs text-text-secondary"
            >
              {summary}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 text-xs text-text-muted">
            {t(expanded ? 'async_questions.collapse' : 'async_questions.expand')}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {showDismissedButton}
          {refreshButton}
        </div>
      </div>
      {details}
    </section>
  )

  const embeddedPanel = (
    <section
      data-testid="async-question-panel"
      data-task-id={taskId}
      className="flex min-w-0 flex-col gap-2"
    >
      {details}
    </section>
  )

  return (
    <ComposerStatusItem
      id="questions"
      title={questionTitle}
      statusText={deliveryCount > 0 ? t('async_questions.deliveryCount', { count: deliveryCount }) : undefined}
      summary={summary || undefined}
      count={pendingCount > 0 ? pendingCount : undefined}
      icon={MessageCircleQuestion}
      attention={attention}
    >
      {hasComposerStatusRegion ? embeddedPanel : standalonePanel}
    </ComposerStatusItem>
  )
}

function AsyncQuestionCard({
  question,
  submissionEpoch,
  disabled,
  submissionError,
  stickyActions,
  onSubmit,
  onRetrySavedAnswer,
  onDismiss,
}: {
  question: AsyncQuestionRecord
  submissionEpoch: number
  disabled: boolean
  submissionError: boolean
  stickyActions: boolean
  onSubmit: (_response: unknown, answers?: RequestUserInputAnswerValues) => Promise<void>
  onRetrySavedAnswer: () => Promise<void>
  onDismiss: () => void
}) {
  const { t } = useTranslation('chat')
  const [answerTooLong, setAnswerTooLong] = useState(false)
  const [deliveryRetry, setDeliveryRetry] = useState<{ epoch: number } | null>(null)
  const deliveryRetryInFlight = useRef<{ epoch: number } | null>(null)
  const retryingDelivery = deliveryRetry?.epoch === submissionEpoch
  const statusKey = question.status.replaceAll('-', '_')
  const isPending = question.status === 'pending'
  const canContinueDelivery =
    (question.status === 'queued' || question.status === 'answer_saved') && Boolean(question.answer)
  const continueDelivery = async () => {
    // React state may not render between activations. Only the request that
    // acquired this card's guard may release its pending delivery state.
    if (disabled || deliveryRetryInFlight.current?.epoch === submissionEpoch) return
    const attempt = { epoch: submissionEpoch }
    deliveryRetryInFlight.current = attempt
    setDeliveryRetry(attempt)
    try {
      await onRetrySavedAnswer()
    } catch {
      // The panel keeps the failure visible and refreshes the authoritative record.
    } finally {
      if (deliveryRetryInFlight.current === attempt) {
        deliveryRetryInFlight.current = null
        setDeliveryRetry(null)
      }
    }
  }
  const authoritativeAnswers = question.answer
    ? question.questions
        .map(item => {
          const saved = question.answer?.answers[item.id]
          const optionLabels = (saved?.selectedOptionIds ?? []).map(
            optionId => item.options.find(option => option.id === optionId)?.label ?? optionId
          )
          const values = [...optionLabels, saved?.text].filter((value): value is string =>
            Boolean(value)
          )
          return { id: item.id, question: item.question, value: values.join(', ') }
        })
        .filter(item => item.value)
    : []
  const payload: RequestUserInputPayload = {
    questions: question.questions.map(item => ({
      id: item.id,
      header: item.header,
      question: item.question,
      multiSelect: item.multiSelect,
      isOther: true,
      options: item.options.map(option => ({
        id: option.id,
        label: option.label,
        description: option.description,
      })),
    })),
  }

  return (
    <article
      data-testid={`async-question-card-${question.questionId}`}
      data-status={question.status}
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/80 bg-background p-2.5"
    >
      <div className="flex min-w-0 items-center justify-between gap-3 px-1">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-text-secondary">
            {t(`async_questions.status.${statusKey}`, {
              defaultValue: t('async_questions.status.unknown'),
            })}
          </div>
          {!isPending && question.deliveryError ? (
            <p className="mt-0.5 text-xs text-text-muted">{question.deliveryError}</p>
          ) : null}
          {isPending && answerTooLong ? (
            <p role="alert" data-testid="async-question-answer-too-long" className="mt-0.5 text-xs text-danger">
              {t('async_questions.answerTooLong')}
            </p>
          ) : null}
          {(isPending || canContinueDelivery) && submissionError ? (
            <p data-testid="async-question-submit-error" className="mt-0.5 text-xs text-danger">
              {t('async_questions.submitError')}
            </p>
          ) : null}
        </div>
        {!isPending ? (
          <button
            type="button"
            data-testid={`async-question-dismiss-${question.questionId}`}
            onClick={onDismiss}
            className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-text-muted hover:bg-surface"
          >
            {t('async_questions.later')}
          </button>
        ) : null}
      </div>
      {authoritativeAnswers.length > 0 ? (
        <div
          data-testid={`async-question-authoritative-answer-${question.questionId}`}
          className="flex min-w-0 flex-col gap-1 rounded-lg bg-surface px-3 py-2"
        >
          <p className="text-xs font-semibold text-text-secondary">
            {t('async_questions.authoritativeAnswer')}
          </p>
          {authoritativeAnswers.map(answer => (
            <p
              key={answer.id}
              className="min-w-0 whitespace-pre-wrap break-words text-sm text-text-primary"
            >
              <span className="font-medium">{answer.question}: </span>
              {answer.value}
            </p>
          ))}
        </div>
      ) : null}
      {isPending ? (
        <RequestUserInputCard
          payload={payload}
          submissionEpoch={submissionEpoch}
          disabled={disabled}
          selectionValue="id"
          autoSubmitOnOptionSelect={false}
          preselectFirstOption={false}
          focusOnMount={false}
          embedded
          stickyActions={stickyActions}
          requireAnswer
          allowImplementationPlanShortcut={false}
          submitLabel={t('async_questions.submit')}
          ignoreLabel={t('async_questions.later')}
          onSubmit={(response, answers) => {
            // These ID-based values already have State's persisted shape. Count
            // UTF-8 JSON bytes before dispatch so a local rejection cannot lock
            // the unchanged question as an uncertain remote submission.
            const tooLong = answers !== undefined &&
              new TextEncoder().encode(JSON.stringify(answers)).byteLength > 16 * 1024
            setAnswerTooLong(tooLong)
            if (tooLong) return false
            return onSubmit(response, answers)
          }}
          onIgnore={onDismiss}
        />
      ) : canContinueDelivery ? (
        <button
          type="button"
          data-testid={`async-question-continue-delivery-${question.questionId}`}
          disabled={disabled || retryingDelivery}
          onClick={() => void continueDelivery()}
          className="self-start rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-contrast hover:opacity-90 disabled:opacity-50"
        >
          {retryingDelivery
            ? t('async_questions.continuingDelivery')
            : t('async_questions.continueDelivery')}
        </button>
      ) : null}
    </article>
  )
}
