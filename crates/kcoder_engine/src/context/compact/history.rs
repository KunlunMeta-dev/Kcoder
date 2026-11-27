use super::TokenCounter;
use kcoder_types::{ContentBlock, Message};

pub(super) const COMPACT_SUMMARY_PREFIX: &str = "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.";
pub(super) const LEGACY_COMPACT_SUMMARY_PREFIX: &str = "Earlier conversation summary:";
pub(super) const COMPACT_CONTINUATION_MARKER: &str = "\n\nRecent messages are preserved verbatim.";
/// Structural boundary tag embedded in engine-written compact summaries.
/// Pasted transcript text can reproduce the human-readable prefix, but users
/// do not accidentally include this marker, which makes forged boundaries
/// (and the silent history truncation they cause) much less likely.
pub(crate) const COMPACT_BOUNDARY_MARKER: &str = "<!--kcoder:compact-boundary-->";
/// Latest compaction boundary found in the conversation.
///
/// The summary message itself is the boundary marker. A later full compaction
/// includes that summary and the suffix in its input, but never reintroduces
/// history from before the boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactBoundary {
    pub summary_index: usize,
    pub suffix_start: usize,
    pub summary: String,
}

pub(super) fn fingerprint_messages(messages: &[Message]) -> Option<[u8; 32]> {
    fingerprint_serializable(messages)
}

pub(crate) fn fingerprint_serializable(
    value: &(impl serde::Serialize + ?Sized),
) -> Option<[u8; 32]> {
    use sha2::{Digest, Sha256};
    struct HashWriter(Sha256);
    impl std::io::Write for HashWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    // Stream every serialized field without allocating another transcript-sized buffer.
    let mut writer = HashWriter(Sha256::new());
    serde_json::to_writer(&mut writer, value).ok()?;
    Some(writer.0.finalize().into())
}

#[derive(Debug, Clone)]
pub(crate) struct CompactionSplit {
    pub(crate) old: Vec<Message>,
    pub(crate) recent: Vec<Message>,
}

pub fn latest_compact_boundary(messages: &[Message]) -> Option<CompactBoundary> {
    // A real compaction replaces the model-visible state, so its summary is
    // always the first message (resume reconstructs the same shape from the
    // structured compact-boundary JSONL records). Never scan later user
    // messages for public text markers: a user can paste those strings, and
    // treating a later match as trusted would silently discard all preceding
    // instructions and conversation state.
    compact_summary_text(messages.first()?).map(|summary| CompactBoundary {
        summary_index: 0,
        suffix_start: 1,
        summary,
    })
}

/// Return the model-visible conversation after the latest compact boundary.
///
/// The boundary summary message is included because it replaces all earlier
/// history. Provider requests are built from messages after the compact
/// boundary, not from the full UI transcript.
pub fn messages_after_latest_compact_boundary(messages: &[Message]) -> Vec<Message> {
    match latest_compact_boundary(messages) {
        Some(boundary) => messages[boundary.summary_index..].to_vec(),
        None => messages.to_vec(),
    }
}

pub(super) fn compact_summary_text(message: &Message) -> Option<String> {
    if message.origin() != kcoder_types::MessageOrigin::Compaction {
        return None;
    }
    let Message::User { content, .. } = message else {
        return None;
    };
    let ContentBlock::Text { text } = content.first()? else {
        return None;
    };
    let text = text.trim_start();

    let summary = if let Some(rest) = text.strip_prefix(COMPACT_BOUNDARY_MARKER) {
        // Engine-written summaries carry the structural marker; these are
        // always trusted.
        rest.trim_start().strip_prefix(COMPACT_SUMMARY_PREFIX)?
    } else if let Some(rest) = text.strip_prefix(COMPACT_SUMMARY_PREFIX) {
        // Without the marker, require the full generated shape so pasted
        // prefix-only text cannot forge a boundary and silently discard
        // everything before it.
        let (summary, _) = rest.split_once(COMPACT_CONTINUATION_MARKER)?;
        return Some(summary.trim().to_string());
    } else {
        text.strip_prefix(LEGACY_COMPACT_SUMMARY_PREFIX)?
    };
    let summary = summary
        .split_once(COMPACT_CONTINUATION_MARKER)
        .map(|(summary, _)| summary)
        .unwrap_or(summary);
    Some(summary.trim().to_string())
}

pub(super) fn build_compacted_messages(
    prior_summary: Option<&str>,
    new_summary: Option<&str>,
    recent: Vec<Message>,
) -> Vec<Message> {
    let combined_summary = combine_compact_summaries(prior_summary, new_summary);
    let mut messages = Vec::new();
    if !combined_summary.trim().is_empty() {
        messages.push(Message::compaction_text(format_compact_summary_message(
            &combined_summary,
        )));
    }
    messages.extend(recent);
    messages
}

pub(super) fn combine_compact_summaries(
    prior_summary: Option<&str>,
    new_summary: Option<&str>,
) -> String {
    match (
        prior_summary.map(str::trim).filter(|s| !s.is_empty()),
        new_summary.map(str::trim).filter(|s| !s.is_empty()),
    ) {
        (Some(prior), Some(new)) => format!(
            "{}\n\nAdditional conversation since last summary:\n{}",
            prior, new
        ),
        (Some(prior), None) => prior.to_string(),
        (None, Some(new)) => new.to_string(),
        (None, None) => String::new(),
    }
}

pub(super) fn format_compact_summary_message(summary: &str) -> String {
    format!(
        "{}\n{}\n\n{}{}\nContinue the conversation from where it left off without asking the user any further questions. Resume directly - do not acknowledge the summary, do not recap what was happening, do not preface with \"I'll continue\" or similar. Pick up the last task as if the break never happened.",
        COMPACT_BOUNDARY_MARKER,
        COMPACT_SUMMARY_PREFIX,
        summary.trim(),
        COMPACT_CONTINUATION_MARKER
    )
}

/// Messages preserved verbatim at the tail when a session has no usable
/// user-request boundary (headless single-prompt runs).
pub(super) const TAIL_SPLIT_PRESERVE_MESSAGES: usize = 4;
/// Below this length there is nothing meaningful to summarize anyway, so the
/// tail-split fallback stays off and compaction is skipped instead.
const MIN_MESSAGES_FOR_TAIL_SPLIT: usize = 6;

/// Split messages into old (to summarize) and recent (to preserve intact).
///
/// We preserve at least the last user request, the assistant response to it,
/// and any pending tool results. Anything before that is candidate for
/// summarization.
pub(crate) fn split_for_compaction(messages: &[Message]) -> CompactionSplit {
    // Walk backwards to find the start of the most recent complete API round.
    // A complete round ends with an assistant message and begins with the user
    // message that triggered it.
    let mut user_count = 0;
    let mut split_index = messages.len();

    for (i, msg) in messages.iter().enumerate().rev() {
        split_index = i;
        // Only genuine user requests count as turn boundaries: tool_result
        // containers are user-role messages too, and counting them pushes the
        // latest real request into the summarized prefix.
        if is_user_request_message(msg) {
            user_count += 1;
            if user_count >= 2 {
                // The second-to-last user message is the boundary. Everything
                // from this message onwards is preserved.
                break;
            }
        }
    }

    // Always preserve at least the last 4 messages as a safety net.
    let mut preserve_start = split_index.min(messages.len().saturating_sub(4));

    // Headless single-prompt sessions put every user request (the prompt plus
    // any injected context) at the very start of the conversation, so the
    // boundary above yields an empty or near-empty `old` segment and
    // compaction can never engage no matter how large the context grows.
    // Fall back to a tail split: keep the newest few messages verbatim and
    // let the older tool rounds be summarized.
    if preserve_start <= 1 && messages.len() > MIN_MESSAGES_FOR_TAIL_SPLIT {
        preserve_start = messages.len().saturating_sub(TAIL_SPLIT_PRESERVE_MESSAGES);
    }

    // Never split a tool_use/tool_result pair across the boundary: if the
    // split landed on a tool_result container, walk backwards to include the
    // assistant message carrying its tool_use.
    while preserve_start > 0
        && matches!(&messages[preserve_start], Message::User { content, .. } if is_tool_result_only_content(content))
    {
        preserve_start -= 1;
    }

    CompactionSplit {
        old: messages[..preserve_start].to_vec(),
        recent: messages[preserve_start..].to_vec(),
    }
}

/// When normal two-turn verbatim retention would leave compacted context over budget,
/// retain only the final real user request and later messages. An oversized single
/// turn remains indivisible and this function never sacrifices the current request.
/// A true hard-limit emergency may override normal recent-message preferences and
/// summarize complete historical turns before the current real user request, which always remains verbatim.
pub(crate) fn split_for_compaction_with_recent_budget_and_emergency(
    messages: &[Message],
    recent_budget: usize,
    emergency: bool,
) -> CompactionSplit {
    let split = split_for_compaction(messages);
    let recent_tokens = split
        .recent
        .iter()
        .map(TokenCounter::estimate_single_message)
        .sum::<usize>();
    if !emergency && (split.old.is_empty() || recent_tokens <= recent_budget) {
        return split;
    }
    if !split.old.is_empty() && recent_tokens <= recent_budget {
        return split;
    }

    let Some(latest_request_start) = messages.iter().rposition(is_user_request_message) else {
        return split;
    };
    if latest_request_start == 0 || latest_request_start >= messages.len() {
        return split;
    }
    // If the old segment contains only an existing compact boundary, no complete turn
    // after it can be summarized again. Emergency splitting must not repeatedly compact the existing summary as an older turn.
    if latest_compact_boundary(&messages[..latest_request_start])
        .is_some_and(|boundary| boundary.suffix_start >= latest_request_start)
    {
        return split;
    }

    CompactionSplit {
        old: messages[..latest_request_start].to_vec(),
        recent: messages[latest_request_start..].to_vec(),
    }
}

pub(crate) fn is_user_request_message(message: &Message) -> bool {
    kcoder_types::is_real_user_message(message)
}

pub(super) fn is_tool_result_only_content(content: &[ContentBlock]) -> bool {
    !content.is_empty()
        && content
            .iter()
            .all(|block| matches!(block, ContentBlock::ToolResult { .. }))
}
