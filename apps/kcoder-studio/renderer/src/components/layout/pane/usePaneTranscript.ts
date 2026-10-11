import type { RuntimeTurnNavigationItem } from '@/types/api'
import { useCallback } from 'react'
import { mergeRuntimeTranscriptMessages } from '../runtimeTranscriptMessages'
import { RUNTIME_TRANSCRIPT_PAGE_SIZE } from './paneMessageReducer'
import { type LoadedTranscriptRange } from './sessionTypes'
import {
  mergeTranscriptRanges,
  runtimeTurnNavigationLoadOptions,
  transcriptRangeFromPage,
} from './transcriptRanges'
import type { usePaneSubscription } from './usePaneSubscription'

export function usePaneTranscript(context: ReturnType<typeof usePaneSubscription>) {
  const {
    transcriptPageGateRef,
    transcriptHasMoreBefore,
    setTranscriptHasMoreBefore,
    transcriptBeforeCursor,
    setTranscriptBeforeCursor,
    transcriptLoadingMoreBefore,
    setTranscriptLoadingMoreBefore,
    transcriptLoadingFullContent,
    setTranscriptLoadingFullContent,
    transcriptFullContent,
    setTranscriptFullContent,
    setLoadedTranscriptRanges,
    setTurnNavigation,
    loadRuntimeTranscriptForPaneRef,
    runtimeTaskLoadTargetRef,
    loadedTranscriptRangesRef,
    runtimeTaskLoadTarget,
    messagesRef,
    dispatchMessages,
  } = context
  const loadMoreTranscriptBefore = useCallback(async () => {
    if (
      !runtimeTaskLoadTarget ||
      !transcriptBeforeCursor ||
      transcriptLoadingMoreBefore ||
      transcriptFullContent
    )
      return

    const { key: loadKey, address } = runtimeTaskLoadTarget
    const beforeCursor = transcriptBeforeCursor
    const ticket = transcriptPageGateRef.current.begin(runtimeTaskLoadTarget.identityKey)
    setTranscriptLoadingMoreBefore(true)
    try {
      const transcript = await loadRuntimeTranscriptForPaneRef.current(address, {
        limit: RUNTIME_TRANSCRIPT_PAGE_SIZE,
        beforeCursor,
      })
      if (
        !transcriptPageGateRef.current.accept(
          ticket,
          runtimeTaskLoadTargetRef.current?.identityKey,
          transcript.historyReset === true
        )
      )
        return
      if (transcript.historyReset) {
        setTranscriptLoadingMoreBefore(false)
        setTranscriptLoadingFullContent(false)
      }
      const nextMessages = mergeRuntimeTranscriptMessages(
        transcript.messages,
        messagesRef.current,
        transcript.historyReset
      )
      const nextRanges = transcript.historyReset
        ? transcriptRangeFromPage(transcript)
        : mergeTranscriptRanges(
            loadedTranscriptRangesRef.current,
            transcriptRangeFromPage(transcript)
          )
      setTranscriptHasMoreBefore(Boolean(transcript.hasMoreBefore))
      setTranscriptBeforeCursor(transcript.beforeCursor ?? null)
      setLoadedTranscriptRanges(nextRanges)
      if (transcript.historyReset) setTranscriptFullContent(transcript.fullContent === true)
      setTurnNavigation(current =>
        transcript.turnNavigation && transcript.turnNavigation.length > 0
          ? transcript.turnNavigation
          : transcript.historyReset
            ? []
            : current
      )
      dispatchMessages({ type: 'reset', messages: nextMessages })
    } catch (error) {
      console.error('[KCoder Studio] Runtime pane older transcript load failed', {
        key: loadKey,
        address,
        beforeCursor,
        error,
      })
    } finally {
      if (
        transcriptPageGateRef.current.current(ticket, runtimeTaskLoadTargetRef.current?.identityKey)
      )
        setTranscriptLoadingMoreBefore(false)
    }
  }, [
    dispatchMessages,
    loadRuntimeTranscriptForPaneRef,
    loadedTranscriptRangesRef,
    messagesRef,
    runtimeTaskLoadTarget,
    runtimeTaskLoadTargetRef,
    setLoadedTranscriptRanges,
    setTranscriptBeforeCursor,
    setTranscriptFullContent,
    setTranscriptHasMoreBefore,
    setTranscriptLoadingFullContent,
    setTranscriptLoadingMoreBefore,
    setTurnNavigation,
    transcriptBeforeCursor,
    transcriptFullContent,
    transcriptLoadingMoreBefore,
    transcriptPageGateRef,
  ])

  const loadTranscriptTurnNavigationItem = useCallback(
    async (item: RuntimeTurnNavigationItem) => {
      if (!runtimeTaskLoadTarget || !item.cursor) {
        return
      }
      if (transcriptFullContent) {
        return
      }
      if (messagesRef.current.some(message => message.id === item.id)) {
        return
      }

      const { address } = runtimeTaskLoadTarget
      const loadOptions = runtimeTurnNavigationLoadOptions(item, loadedTranscriptRangesRef.current)
      const ticket = transcriptPageGateRef.current.begin(runtimeTaskLoadTarget.identityKey)
      const transcript = await loadRuntimeTranscriptForPaneRef.current(address, loadOptions)
      if (
        !transcriptPageGateRef.current.accept(
          ticket,
          runtimeTaskLoadTargetRef.current?.identityKey,
          transcript.historyReset === true
        )
      )
        return
      if (transcript.historyReset) {
        setTranscriptLoadingMoreBefore(false)
        setTranscriptLoadingFullContent(false)
      }
      const nextHasMoreBefore =
        loadOptions.beforeCursor === undefined && !transcript.historyReset
          ? transcriptHasMoreBefore
          : Boolean(transcript.hasMoreBefore)
      const nextBeforeCursor =
        loadOptions.beforeCursor === undefined && !transcript.historyReset
          ? transcriptBeforeCursor
          : (transcript.beforeCursor ?? null)
      const nextMessages = mergeRuntimeTranscriptMessages(
        transcript.messages,
        messagesRef.current,
        transcript.historyReset
      )
      const nextRanges = transcript.historyReset
        ? transcriptRangeFromPage(transcript)
        : mergeTranscriptRanges(
            loadedTranscriptRangesRef.current,
            transcriptRangeFromPage(transcript)
          )
      setTranscriptHasMoreBefore(nextHasMoreBefore)
      setTranscriptBeforeCursor(nextBeforeCursor)
      setLoadedTranscriptRanges(nextRanges)
      if (transcript.historyReset) setTranscriptFullContent(transcript.fullContent === true)
      setTurnNavigation(current =>
        transcript.turnNavigation && transcript.turnNavigation.length > 0
          ? transcript.turnNavigation
          : transcript.historyReset
            ? []
            : current
      )
      dispatchMessages({ type: 'reset', messages: nextMessages })
    },
    [
      dispatchMessages,
      loadRuntimeTranscriptForPaneRef,
      loadedTranscriptRangesRef,
      messagesRef,
      runtimeTaskLoadTarget,
      runtimeTaskLoadTargetRef,
      setLoadedTranscriptRanges,
      setTranscriptBeforeCursor,
      setTranscriptFullContent,
      setTranscriptHasMoreBefore,
      setTranscriptLoadingFullContent,
      setTranscriptLoadingMoreBefore,
      setTurnNavigation,
      transcriptBeforeCursor,
      transcriptFullContent,
      transcriptHasMoreBefore,
      transcriptPageGateRef,
    ]
  )

  const loadTranscriptGap = useCallback(
    async (gap: LoadedTranscriptRange) => {
      if (!runtimeTaskLoadTarget || transcriptFullContent || gap.end <= gap.start) return

      const { address } = runtimeTaskLoadTarget
      const limit = Math.min(RUNTIME_TRANSCRIPT_PAGE_SIZE, gap.end - gap.start)
      const ticket = transcriptPageGateRef.current.begin(runtimeTaskLoadTarget.identityKey)
      const loadOptions = {
        limit,
        afterCursor: `offset:${gap.start}`,
      }
      const transcript = await loadRuntimeTranscriptForPaneRef.current(address, loadOptions)
      if (
        !transcriptPageGateRef.current.accept(
          ticket,
          runtimeTaskLoadTargetRef.current?.identityKey,
          transcript.historyReset === true
        )
      )
        return
      if (transcript.historyReset) {
        setTranscriptLoadingMoreBefore(false)
        setTranscriptLoadingFullContent(false)
        setTranscriptHasMoreBefore(Boolean(transcript.hasMoreBefore))
        setTranscriptBeforeCursor(transcript.beforeCursor ?? null)
        setTranscriptFullContent(transcript.fullContent === true)
      }
      const nextMessages = mergeRuntimeTranscriptMessages(
        transcript.messages,
        messagesRef.current,
        transcript.historyReset
      )
      const nextRanges = transcript.historyReset
        ? transcriptRangeFromPage(transcript)
        : mergeTranscriptRanges(
            loadedTranscriptRangesRef.current,
            transcriptRangeFromPage(transcript)
          )
      setLoadedTranscriptRanges(nextRanges)
      setTurnNavigation(current =>
        transcript.turnNavigation && transcript.turnNavigation.length > 0
          ? transcript.turnNavigation
          : transcript.historyReset
            ? []
            : current
      )
      dispatchMessages({ type: 'reset', messages: nextMessages })
    },
    [
      dispatchMessages,
      loadRuntimeTranscriptForPaneRef,
      loadedTranscriptRangesRef,
      messagesRef,
      runtimeTaskLoadTarget,
      runtimeTaskLoadTargetRef,
      setLoadedTranscriptRanges,
      setTranscriptBeforeCursor,
      setTranscriptFullContent,
      setTranscriptHasMoreBefore,
      setTranscriptLoadingFullContent,
      setTranscriptLoadingMoreBefore,
      setTurnNavigation,
      transcriptFullContent,
      transcriptPageGateRef,
    ]
  )

  const loadFullTranscript = useCallback(async () => {
    if (!runtimeTaskLoadTarget || transcriptLoadingFullContent || transcriptFullContent) return

    const { address } = runtimeTaskLoadTarget
    const ticket = transcriptPageGateRef.current.begin(runtimeTaskLoadTarget.identityKey)
    setTranscriptLoadingFullContent(true)
    try {
      const transcript = await loadRuntimeTranscriptForPaneRef.current(address, {
        includeFullContent: true,
        refresh: true,
      })
      if (
        !transcriptPageGateRef.current.accept(
          ticket,
          runtimeTaskLoadTargetRef.current?.identityKey,
          true
        )
      )
        return
      setTranscriptLoadingMoreBefore(false)
      setTranscriptLoadingFullContent(false)
      const nextMessages = mergeRuntimeTranscriptMessages(
        transcript.messages,
        messagesRef.current,
        true
      )
      setTranscriptFullContent(transcript.fullContent === true)
      setTranscriptHasMoreBefore(Boolean(transcript.hasMoreBefore))
      setTranscriptBeforeCursor(transcript.beforeCursor ?? null)
      setLoadedTranscriptRanges(transcriptRangeFromPage(transcript))
      setTurnNavigation(() =>
        transcript.turnNavigation && transcript.turnNavigation.length > 0
          ? transcript.turnNavigation
          : []
      )
      dispatchMessages({ type: 'reset', messages: nextMessages })
    } catch (error) {
      console.error('[KCoder Studio] Runtime pane full transcript load failed', {
        address,
        error,
      })
      throw error
    } finally {
      if (
        transcriptPageGateRef.current.current(ticket, runtimeTaskLoadTargetRef.current?.identityKey)
      )
        setTranscriptLoadingFullContent(false)
    }
  }, [
    dispatchMessages,
    loadRuntimeTranscriptForPaneRef,
    messagesRef,
    runtimeTaskLoadTarget,
    runtimeTaskLoadTargetRef,
    setLoadedTranscriptRanges,
    setTranscriptBeforeCursor,
    setTranscriptFullContent,
    setTranscriptHasMoreBefore,
    setTranscriptLoadingFullContent,
    setTranscriptLoadingMoreBefore,
    setTurnNavigation,
    transcriptFullContent,
    transcriptLoadingFullContent,
    transcriptPageGateRef,
  ])
  return {
    ...context,
    loadMoreTranscriptBefore,
    loadTranscriptTurnNavigationItem,
    loadTranscriptGap,
    loadFullTranscript,
  }
}
