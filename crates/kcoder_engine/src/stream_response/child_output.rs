//! Bound collection of adjacent child model output before its real native authorization.
use futures::{FutureExt, Stream, StreamExt, stream::Peekable};
use kcoder_api::ApiErrorKind;
use kcoder_types::{ContentBlock, ContentDelta, MessageDeltaFields, StreamEvent, Usage};
use std::{pin::Pin, time::Duration};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

const MAX_FRAGMENTS: usize = 64;
const MAX_INPUT_EVENTS: usize = MAX_FRAGMENTS * 2;
const MAX_READY_FRAGMENTS: usize = 128;
const MAX_READY_INPUT_EVENTS: usize = MAX_READY_FRAGMENTS * 2;
const MAX_BATCH_BYTES: usize = 32 * 1024;
const BATCH_WINDOW: Duration = Duration::from_millis(4);
const MAX_BATCH_WINDOW: Duration = Duration::from_millis(16);
const RECENT_OUTPUT: Duration = Duration::from_millis(100);

pub(super) struct ChildOutputBatcher {
    previous: Option<(usize, bool)>,
    window: Duration,
    prefetched_block: Option<StreamEvent>,
    assistant_start_pending: bool,
}

impl Default for ChildOutputBatcher {
    fn default() -> Self {
        Self {
            previous: None,
            window: BATCH_WINDOW,
            prefetched_block: None,
            assistant_start_pending: false,
        }
    }
}

pub(super) fn usage_only(event: &StreamEvent) -> Option<&Usage> {
    match event {
        StreamEvent::MessageDelta {
            delta:
                MessageDeltaFields {
                    stop_reason: None,
                    stop_sequence: None,
                    usage: Some(usage),
                },
        } => Some(usage),
        _ => None,
    }
}

impl ChildOutputBatcher {
    pub(super) async fn next<S>(
        &mut self,
        stream: &mut S,
    ) -> Option<Result<StreamEvent, ApiErrorKind>>
    where
        S: Stream<Item = Result<StreamEvent, ApiErrorKind>> + Unpin,
    {
        if let Some(block) = self.prefetched_block.take() {
            return Some(Ok(block));
        }
        let started = Instant::now();
        let item = stream.next().await;
        if started.elapsed() >= RECENT_OUTPUT {
            self.previous = None;
        }
        item
    }

    pub(super) fn defer_assistant_start_after_message<S>(
        &mut self,
        stream: &mut Peekable<S>,
        consume_usage: impl FnOnce(&StreamEvent, &Usage) -> bool,
    ) -> bool
    where
        S: Stream<Item = Result<StreamEvent, ApiErrorKind>> + Unpin,
    {
        // Chat Completions adapters can emit the first chunk's cumulative usage
        // before its block start. Only advance past it if accounting is settled.
        let _ = Pin::new(&mut *stream)
            .next_if(|event| {
                event.as_ref().is_ok_and(|event| {
                    usage_only(event).is_some_and(|usage| consume_usage(event, usage))
                })
            })
            .now_or_never();
        let prefetched = Pin::new(&mut *stream)
            .next_if(|event| {
                matches!(
                    event,
                    Ok(StreamEvent::ContentBlockStart {
                        content_block: ContentBlock::Text { .. } | ContentBlock::Thinking { .. },
                        ..
                    })
                )
            })
            .now_or_never()
            .flatten();
        let Some(Ok(block)) = prefetched else {
            return false;
        };
        if let StreamEvent::ContentBlockStart {
            index,
            content_block,
        } = &block
        {
            self.defer_assistant_start_at_block(*index, content_block, stream);
        }
        self.prefetched_block = Some(block);
        self.assistant_start_pending
    }

    pub(super) fn defer_assistant_start_at_block<S>(
        &mut self,
        index: usize,
        block: &ContentBlock,
        stream: &mut Peekable<S>,
    ) -> bool
    where
        S: Stream<Item = Result<StreamEvent, ApiErrorKind>> + Unpin,
    {
        let (has_body, thinking) = match block {
            ContentBlock::Text { text } => (!text.is_empty(), false),
            ContentBlock::Thinking { thinking, .. } => (!thinking.is_empty(), true),
            _ => return false,
        };
        let ready = has_body
            || matches!(
                Pin::new(stream).peek().now_or_never().flatten(),
                Some(Ok(StreamEvent::ContentBlockDelta { index: next_index, delta }))
                    if *next_index == index && match delta {
                        ContentDelta::TextDelta { text } => !thinking && !text.is_empty(),
                        ContentDelta::ThinkingDelta { thinking: text } => thinking && !text.is_empty(),
                        _ => false,
                    }
            );
        self.assistant_start_pending = ready;
        ready
    }

    pub(super) fn flush_assistant_start_before(
        &mut self,
        event: &Result<StreamEvent, ApiErrorKind>,
    ) -> bool {
        !matches!(
            event,
            Ok(StreamEvent::ContentBlockStart {
                content_block: ContentBlock::Text { .. } | ContentBlock::Thinking { .. },
                ..
            } | StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { .. } | ContentDelta::ThinkingDelta { .. },
                ..
            })
        ) && self.take_assistant_start()
    }

    pub(super) fn take_assistant_start(&mut self) -> bool {
        std::mem::take(&mut self.assistant_start_pending)
    }

    pub(super) fn observe_publication(&mut self, cost: Duration) {
        // A slow original authorization should amortize its next publication.
        // Its duration says nothing about the upstream producer being idle.
        self.window = if cost <= BATCH_WINDOW {
            // If a publication is already cheaper than waiting for a batch,
            // drain available fragments and immediately release the stream.
            Duration::ZERO
        } else {
            (cost / 4).clamp(BATCH_WINDOW, MAX_BATCH_WINDOW)
        };
    }

    pub(super) async fn collect<S>(
        &mut self,
        stream: &mut Peekable<S>,
        first: &mut StreamEvent,
        cancel: &CancellationToken,
        mut observe: impl FnMut(&StreamEvent) -> Result<bool, ApiErrorKind>,
    ) -> Vec<usize>
    where
        S: Stream<Item = Result<StreamEvent, ApiErrorKind>> + Unpin,
    {
        // Running usage is accounted by the normal outer loop when it is the
        // first event. It does not close the current content block.
        if usage_only(first).is_some() {
            return Vec::new();
        }
        let (index, text, is_thinking) = match first {
            StreamEvent::ContentBlockDelta {
                index,
                delta: ContentDelta::TextDelta { text },
            } => (*index, text, false),
            StreamEvent::ContentBlockDelta {
                index,
                delta: ContentDelta::ThinkingDelta { thinking },
            } => (*index, thinking, true),
            _ => {
                self.previous = None;
                return Vec::new();
            }
        };
        // A new or previously quiet block can absorb ready fragments without
        // paying another authorization. It never waits for the next fragment.
        let only_ready = self.previous.replace((index, is_thinking)) != Some((index, is_thinking))
            || self.window.is_zero();
        let window = if only_ready {
            BATCH_WINDOW
        } else {
            self.window
        };
        let ends_at = Instant::now() + window;
        let deadline = tokio::time::sleep_until(ends_at);
        tokio::pin!(deadline);
        let mut boundaries = Vec::new();
        for inspected in 1..MAX_READY_INPUT_EVENTS {
            let fragments = boundaries.len() + 1;
            if fragments >= MAX_READY_FRAGMENTS || text.len() >= MAX_BATCH_BYTES {
                break;
            }
            let next = Pin::new(&mut *stream).next_if(|item| {
                let Ok(raw) = item else { return false };
                if usage_only(raw).is_some() {
                    return observe(raw).unwrap_or(false);
                }
                let StreamEvent::ContentBlockDelta {
                    index: next_index,
                    delta,
                } = raw
                else {
                    return false;
                };
                let len = match delta {
                    ContentDelta::TextDelta { text } if !is_thinking => text.len(),
                    ContentDelta::ThinkingDelta { thinking } if is_thinking => thinking.len(),
                    _ => return false,
                };
                // A rejected charge leaves the fragment for the normal decoder
                // after the accepted prefix. Controls and other blocks keep their order.
                *next_index == index
                    && len <= MAX_BATCH_BYTES - text.len()
                    && observe(raw).unwrap_or(false)
            });
            let result =
                if only_ready || fragments >= MAX_FRAGMENTS || inspected >= MAX_INPUT_EVENTS {
                    // The larger cap drains backlog only. Never hold a normal
                    // batch open for a model event after reaching its usual limit.
                    if cancel.is_cancelled() || Instant::now() >= ends_at {
                        break;
                    }
                    next.now_or_never().flatten()
                } else {
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => break,
                        _ = &mut deadline => break,
                        result = next => result,
                    }
                };
            let Some(Ok(raw)) = result else { break };
            if usage_only(&raw).is_some() {
                continue;
            }
            let StreamEvent::ContentBlockDelta {
                delta:
                    ContentDelta::TextDelta { text: extra }
                    | ContentDelta::ThinkingDelta { thinking: extra },
                ..
            } = raw
            else {
                unreachable!("next_if selected a model output fragment")
            };
            boundaries.push(text.len());
            text.push_str(&extra);
        }
        boundaries
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use futures::{StreamExt, stream};

    fn text(index: usize, value: &str) -> StreamEvent {
        StreamEvent::ContentBlockDelta {
            index,
            delta: ContentDelta::TextDelta { text: value.into() },
        }
    }

    fn thinking(index: usize, value: &str) -> StreamEvent {
        StreamEvent::ContentBlockDelta {
            index,
            delta: ContentDelta::ThinkingDelta {
                thinking: value.into(),
            },
        }
    }

    async fn start(batch: &mut ChildOutputBatcher, first: &mut StreamEvent) {
        let now = Instant::now();
        let mut idle = stream::pending().peekable();
        assert!(
            batch
                .collect(&mut idle, first, &CancellationToken::new(), |_| Ok(true))
                .await
                .is_empty()
        );
        assert_eq!(
            Instant::now(),
            now,
            "first fragment must not wait for another"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn original_utf8_fragments_controls_and_new_blocks_keep_their_order() {
        let mut batch = ChildOutputBatcher::default();
        start(&mut batch, &mut text(0, "first")).await;
        let cancel = CancellationToken::new();
        let mut first = text(0, "甲");
        let input = [
            text(0, "🙂"),
            text(0, "Z"),
            thinking(0, "start"),
            thinking(0, "想"),
            thinking(0, "想"),
            thinking(1, "next"),
        ];
        let mut stream = stream::iter(input.into_iter().map(Ok)).peekable();
        let mut observed = Vec::new();
        let ends = batch
            .collect(&mut stream, &mut first, &cancel, |raw| {
                observed.push(raw.clone());
                Ok(true)
            })
            .await;
        assert_eq!(ends, [3, 7]);
        assert!(
            matches!(first, StreamEvent::ContentBlockDelta {delta:ContentDelta::TextDelta { text }, ..} if text == "甲🙂Z")
        );
        assert_eq!(observed.len(), 2);
        let mut new_kind = stream.next().await.unwrap().unwrap();
        let now = Instant::now();
        let ends = batch
            .collect(&mut stream, &mut new_kind, &cancel, |_| Ok(true))
            .await;
        assert_eq!(ends, [5, 8]);
        assert_eq!(Instant::now(), now);
        assert!(
            matches!(new_kind, StreamEvent::ContentBlockDelta {delta:ContentDelta::ThinkingDelta { thinking }, ..} if thinking == "start想想")
        );
        let mut new_block = stream.next().await.unwrap().unwrap();
        start(&mut batch, &mut new_block).await;
        assert!(stream.next().await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn a_budget_failure_keeps_the_accepted_prefix_and_the_failing_fragment() {
        let mut batch = ChildOutputBatcher::default();
        start(&mut batch, &mut text(0, "first")).await;
        let mut first = text(0, "x");
        let mut input = stream::iter([
            Ok(text(0, "ok")),
            Ok(text(0, "over")),
            Ok(text(0, "unread")),
        ])
        .peekable();
        let mut budget = kcoder_api::response_budget::ResponseBudget::new(
            kcoder_types::ProviderResponseLimits {
                total_decoded_bytes: 3,
                tool_arguments_bytes: 3,
                ..Default::default()
            },
        );
        budget.observe(&first).unwrap();
        assert_eq!(
            batch
                .collect(&mut input, &mut first, &CancellationToken::new(), |raw| {
                    budget.observe(raw).map(|()| true)
                })
                .await,
            [1]
        );
        assert!(
            matches!(first, StreamEvent::ContentBlockDelta { delta: ContentDelta::TextDelta { text }, .. } if text == "xok")
        );
        let rejected = input.next().await.unwrap().unwrap();
        assert!(
            matches!(&rejected, StreamEvent::ContentBlockDelta { delta: ContentDelta::TextDelta { text }, .. } if text == "over")
        );
        assert!(budget.observe(&rejected).is_err());
        assert!(
            matches!(input.next().await, Some(Ok(StreamEvent::ContentBlockDelta {delta:ContentDelta::TextDelta { text }, ..})) if text == "unread")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn short_async_gaps_fit_one_fixed_window_and_a_quiet_source_restarts_immediately() {
        let mut batch = ChildOutputBatcher::default();
        start(&mut batch, &mut text(0, "first")).await;
        let now = Instant::now();
        let mut input = Box::pin(async_stream::stream! {
            for delay in [1, 3, 5] {
                tokio::time::sleep_until(now + Duration::from_millis(delay)).await;
                yield Ok(text(0, "x"));
            }
        })
        .peekable();
        let ends = batch
            .collect(
                &mut input,
                &mut text(0, "X"),
                &CancellationToken::new(),
                |_| Ok(true),
            )
            .await;
        assert_eq!(ends, [1, 2]);
        assert_eq!(
            Instant::now() - now,
            BATCH_WINDOW,
            "later fragments cannot extend the window"
        );
        assert!(
            input.next().await.is_some(),
            "the next fragment remains available"
        );
        let mut quiet = Box::pin(async_stream::stream! {
            tokio::time::sleep(RECENT_OUTPUT + Duration::from_millis(1)).await;
            yield Ok(text(0, "after pause"));
        });
        let mut resumed = batch.next(&mut quiet).await.unwrap().unwrap();
        start(&mut batch, &mut resumed).await;
    }

    #[tokio::test(start_paused = true)]
    async fn message_start_only_joins_body_that_is_already_ready() {
        let block = || StreamEvent::ContentBlockStart {
            index: 0,
            content_block: ContentBlock::Text {
                text: String::new(),
            },
        };
        let now = Instant::now();
        let mut batch = ChildOutputBatcher::default();
        let mut ready = stream::iter([Ok(block()), Ok(text(0, "first"))]).peekable();
        assert!(batch.defer_assistant_start_after_message(&mut ready, |_, _| false));
        assert!(matches!(
            batch.next(&mut ready).await,
            Some(Ok(StreamEvent::ContentBlockStart { index: 0, .. }))
        ));
        assert!(matches!(
            batch.next(&mut ready).await,
            Some(Ok(StreamEvent::ContentBlockDelta { index: 0, .. }))
        ));
        assert!(batch.take_assistant_start());

        let mut waiting = stream::once(async { Ok(block()) })
            .chain(stream::pending())
            .boxed()
            .peekable();
        assert!(!batch.defer_assistant_start_after_message(&mut waiting, |_, _| false));
        assert!(!batch.take_assistant_start());
        assert!(matches!(
            batch.next(&mut waiting).await,
            Some(Ok(StreamEvent::ContentBlockStart { index: 0, .. }))
        ));
        assert_eq!(Instant::now(), now);
    }

    #[tokio::test(start_paused = true)]
    async fn an_unsettled_opening_usage_frame_stays_in_the_normal_stream() {
        let usage = StreamEvent::MessageDelta {
            delta: MessageDeltaFields {
                stop_reason: None,
                stop_sequence: None,
                usage: Some(Usage {
                    input_tokens: 1,
                    output_tokens: 1,
                    total_tokens: None,
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: None,
                    iterations: None,
                }),
            },
        };
        let mut batch = ChildOutputBatcher::default();
        let mut input = stream::iter([Ok(usage), Ok(text(0, "tail"))]).peekable();
        assert!(!batch.defer_assistant_start_after_message(&mut input, |_, _| false));
        let first = batch.next(&mut input).await.unwrap().unwrap();
        assert_eq!(usage_only(&first).unwrap().output_tokens, 1);
        assert!(!batch.take_assistant_start());
        assert!(matches!(
            batch.next(&mut input).await,
            Some(Ok(StreamEvent::ContentBlockDelta { .. }))
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn slow_authorization_does_not_turn_a_buffered_token_back_into_a_new_block() {
        let mut batch = ChildOutputBatcher::default();
        start(&mut batch, &mut text(0, "first")).await;
        tokio::time::advance(RECENT_OUTPUT * 2).await;
        batch.observe_publication(RECENT_OUTPUT * 2);
        let mut input =
            stream::iter((0..=MAX_READY_FRAGMENTS).map(|_| Ok(text(0, "x")))).peekable();
        let mut first = batch.next(&mut input).await.unwrap().unwrap();
        assert_eq!(
            batch
                .collect(&mut input, &mut first, &CancellationToken::new(), |_| Ok(
                    true
                ))
                .await
                .len(),
            MAX_READY_FRAGMENTS - 1
        );
        assert!(
            input.next().await.is_some(),
            "the drain stops at the larger cap"
        );
        let mut sparse = stream::pending().peekable();
        let started = Instant::now();
        assert!(
            batch
                .collect(
                    &mut sparse,
                    &mut text(0, "last"),
                    &CancellationToken::new(),
                    |_| Ok(true)
                )
                .await
                .is_empty()
        );
        assert_eq!(started.elapsed(), MAX_BATCH_WINDOW);
    }

    #[tokio::test(start_paused = true)]
    async fn first_output_collects_ready_fragments_but_never_waits_for_input() {
        let mut batch = ChildOutputBatcher::default();
        let mut first = text(0, "甲");
        let mut input = stream::iter([Ok(text(0, "乙")), Ok(text(0, "🙂"))])
            .chain(stream::pending())
            .peekable();
        let now = Instant::now();
        let positions = batch
            .collect(&mut input, &mut first, &CancellationToken::new(), |_| {
                Ok(true)
            })
            .await;
        assert_eq!(positions, [3, 6]);
        assert!(matches!(
            first,
            StreamEvent::ContentBlockDelta { delta: ContentDelta::TextDelta { text }, .. }
                if text == "甲乙🙂"
        ));
        assert_eq!(Instant::now(), now);
    }

    #[tokio::test(start_paused = true)]
    async fn fast_publications_collect_only_immediately_ready_input() {
        let mut batch = ChildOutputBatcher::default();
        start(&mut batch, &mut text(0, "start")).await;
        batch.observe_publication(Duration::from_millis(2));
        let mut input = stream::iter([Ok(text(0, "ready"))])
            .chain(stream::pending())
            .peekable();
        let now = Instant::now();
        let mut first = text(0, "first");
        assert_eq!(
            batch
                .collect(&mut input, &mut first, &CancellationToken::new(), |_| Ok(
                    true
                ))
                .await,
            [5]
        );
        assert_eq!(Instant::now(), now);
    }

    #[tokio::test(start_paused = true)]
    async fn a_ready_burst_uses_one_batch_and_stops_at_the_next_control() {
        let mut batch = ChildOutputBatcher::default();
        start(&mut batch, &mut text(0, "first")).await;
        let mut input = stream::iter((1..96).map(|_| Ok(text(0, "x"))).chain(std::iter::once(Ok(
            StreamEvent::ContentBlockStop { index: 0 },
        ))))
        .peekable();
        let now = Instant::now();
        let positions = batch
            .collect(
                &mut input,
                &mut text(0, "x"),
                &CancellationToken::new(),
                |_| Ok(true),
            )
            .await;
        assert_eq!(positions, (1..96).collect::<Vec<_>>());
        assert_eq!(Instant::now(), now);
        assert!(matches!(
            input.next().await,
            Some(Ok(StreamEvent::ContentBlockStop { index: 0 }))
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn a_normal_batch_never_waits_for_the_extra_ready_fragments() {
        let mut batch = ChildOutputBatcher::default();
        start(&mut batch, &mut text(0, "first")).await;
        batch.observe_publication(MAX_BATCH_WINDOW * 4);
        let mut input = stream::iter((1..MAX_FRAGMENTS).map(|_| Ok(text(0, "x"))))
            .chain(stream::pending())
            .peekable();
        let now = Instant::now();
        assert_eq!(
            batch
                .collect(
                    &mut input,
                    &mut text(0, "start"),
                    &CancellationToken::new(),
                    |_| Ok(true)
                )
                .await
                .len(),
            MAX_FRAGMENTS - 1
        );
        assert_eq!(Instant::now(), now);
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_releases_a_pending_collection_before_its_deadline() {
        let mut batch = ChildOutputBatcher::default();
        start(&mut batch, &mut text(0, "first")).await;
        let now = Instant::now();
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1)).await;
            trigger.cancel();
        });
        let mut idle = stream::pending().peekable();
        assert!(
            batch
                .collect(&mut idle, &mut text(0, "pending"), &cancel, |_| Ok(true))
                .await
                .is_empty()
        );
        handle.await.unwrap();
        assert_eq!(Instant::now() - now, Duration::from_millis(1));
    }

    #[tokio::test(start_paused = true)]
    async fn a_byte_limit_or_control_leaves_the_next_provider_event_for_the_decoder() {
        let mut batch = ChildOutputBatcher::default();
        let cancel = CancellationToken::new();
        start(&mut batch, &mut text(0, "first")).await;
        let now = Instant::now();
        let mut current = text(0, &"a".repeat(MAX_BATCH_BYTES - 2));
        let mut input = stream::iter([
            Ok(text(0, "b")),
            Ok(text(0, "甲")),
            Ok(StreamEvent::ContentBlockStop { index: 0 }),
        ])
        .peekable();
        assert_eq!(
            batch
                .collect(&mut input, &mut current, &cancel, |_| Ok(true))
                .await,
            [MAX_BATCH_BYTES - 2]
        );
        let mut next = input.next().await.unwrap().unwrap();
        assert!(
            matches!(&next, StreamEvent::ContentBlockDelta { delta: ContentDelta::TextDelta { text }, .. } if text == "甲")
        );
        assert!(
            batch
                .collect(&mut input, &mut next, &cancel, |_| Ok(true))
                .await
                .is_empty()
        );
        let mut stop = input.next().await.unwrap().unwrap();
        assert!(matches!(&stop, StreamEvent::ContentBlockStop { index: 0 }));
        batch
            .collect(&mut input, &mut stop, &cancel, |_| Ok(true))
            .await;
        start(&mut batch, &mut text(0, "reopened index")).await;
        assert_eq!(Instant::now(), now);
    }

    #[tokio::test(start_paused = true)]
    async fn running_usage_is_observed_in_order_and_stop_or_refused_usage_stays_unconsumed() {
        let mut batch = ChildOutputBatcher::default();
        let cancel = CancellationToken::new();
        let metadata = |tokens, stop: Option<&str>| StreamEvent::MessageDelta {
            delta: MessageDeltaFields {
                stop_reason: stop.map(String::from),
                stop_sequence: None,
                usage: Some(Usage {
                    input_tokens: 1,
                    output_tokens: tokens,
                    total_tokens: None,
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: None,
                    iterations: None,
                }),
            },
        };
        start(&mut batch, &mut text(0, "first")).await;
        let mut normal_update = metadata(1, None);
        let mut idle = stream::pending().peekable();
        assert!(
            batch
                .collect(&mut idle, &mut normal_update, &cancel, |_| panic!(
                    "outer event is accounted by its decoder"
                ))
                .await
                .is_empty()
        );
        let mut input = stream::iter([
            Ok(metadata(2, None)),
            Ok(text(0, "B")),
            Ok(metadata(3, None)),
            Ok(text(0, "C")),
            Ok(metadata(4, Some("max_tokens"))),
            Ok(text(0, "later")),
        ])
        .peekable();
        let mut accepted = Vec::new();
        let ends = batch
            .collect(&mut input, &mut text(0, "A"), &cancel, |raw| {
                if let Some(usage) = usage_only(raw) {
                    if usage.output_tokens == 3 {
                        return Ok(false);
                    }
                    accepted.push("usage");
                } else {
                    accepted.push("text");
                }
                Ok(true)
            })
            .await;
        assert_eq!(accepted, ["usage", "text"]);
        assert_eq!(ends, [1]);
        let boundary = input.next().await.unwrap().unwrap();
        assert_eq!(usage_only(&boundary).unwrap().output_tokens, 3);
        let mut next = input.next().await.unwrap().unwrap();
        assert!(
            batch
                .collect(&mut input, &mut next, &cancel, |_| panic!(
                    "stop is never absorbed"
                ))
                .await
                .is_empty()
        );
        assert!(
            matches!(input.next().await, Some(Ok(StreamEvent::MessageDelta {delta: MessageDeltaFields {stop_reason: Some(reason), ..}})) if reason == "max_tokens")
        );
    }
}
