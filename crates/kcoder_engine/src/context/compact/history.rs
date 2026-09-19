use super::TokenCounter;
use anyhow::Result;
use kcoder_types::{ContentBlock, Message};

pub(super) const PTL_RETRY_MARKER: &str = "[earlier conversation truncated for compaction retry]";
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
    serde_json::to_writer(&mut writer, messages).ok()?;
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
    let Message::User { content } = message else {
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
        messages.push(Message::user_text(format_compact_summary_message(
            &combined_summary,
        )));
    }
    messages.extend(recent);
    messages
}

fn combine_compact_summaries(prior_summary: Option<&str>, new_summary: Option<&str>) -> String {
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
        && matches!(&messages[preserve_start], Message::User { content } if is_tool_result_only_content(content))
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

pub(super) fn truncate_head_for_ptl_retry(
    messages: Vec<Message>,
    old_len: usize,
) -> Result<Vec<Message>> {
    let effective_old_len = old_len.min(messages.len());
    if let Some(boundary) = latest_compact_boundary(&messages)
        .filter(|boundary| boundary.summary_index < effective_old_len)
    {
        let boundary_message = messages[boundary.summary_index].clone();
        let suffix_start = boundary.suffix_start;
        let suffix_old_len = effective_old_len.saturating_sub(suffix_start);
        let suffix = messages.into_iter().skip(suffix_start).collect();
        let mut truncated = truncate_unprotected_head_for_ptl_retry(suffix, suffix_old_len)?;
        truncated.insert(0, boundary_message);
        return Ok(truncated);
    }

    truncate_unprotected_head_for_ptl_retry(messages, effective_old_len)
}

fn truncate_unprotected_head_for_ptl_retry(
    messages: Vec<Message>,
    old_len: usize,
) -> Result<Vec<Message>> {
    if old_len == 0 {
        anyhow::bail!("compaction failed: prompt too long and no old messages can be dropped");
    }

    let effective_old_len = old_len.min(messages.len());
    let marker_offset = messages.first().is_some_and(is_ptl_retry_marker_message) as usize;
    let effective_old_len = effective_old_len.saturating_sub(marker_offset);
    let messages = messages.into_iter().skip(marker_offset).collect::<Vec<_>>();
    let groups = group_message_indices_by_user_turn(&messages[..effective_old_len]);
    if groups.len() < 2 {
        anyhow::bail!(
            "compaction failed: prompt too long and not enough message groups can be dropped"
        );
    }

    // Preserve the fallback when the provider does
    // not expose a parseable token gap: drop roughly 20% of old API-round
    // groups while keeping at least one group available for summarization.
    let drop_groups = std::cmp::min(
        std::cmp::max(1, groups.len() / 5),
        groups.len().saturating_sub(1),
    );
    let drop_until = groups[drop_groups].0;

    let mut truncated: Vec<Message> = messages.into_iter().skip(drop_until).collect();
    truncated.insert(0, Message::user_text(PTL_RETRY_MARKER));

    Ok(truncated)
}

fn is_ptl_retry_marker_message(message: &Message) -> bool {
    matches!(
        message,
        Message::User { content }
            if content.iter().any(
                |block| matches!(block, ContentBlock::Text { text } if text == PTL_RETRY_MARKER)
            )
    )
}

fn group_message_indices_by_user_turn(messages: &[Message]) -> Vec<(usize, usize)> {
    if messages.is_empty() {
        return Vec::new();
    }

    let mut groups = Vec::new();
    let mut start = 0;

    for (i, message) in messages.iter().enumerate().skip(1) {
        if is_user_request_message(message) {
            groups.push((start, i));
            start = i;
        }
    }

    groups.push((start, messages.len()));
    groups
}

pub(crate) fn is_user_request_message(message: &Message) -> bool {
    let Message::User { content } = message else {
        return false;
    };
    !is_tool_result_only_content(content)
}

pub(super) fn is_tool_result_only_content(content: &[ContentBlock]) -> bool {
    !content.is_empty()
        && content
            .iter()
            .all(|block| matches!(block, ContentBlock::ToolResult { .. }))
}
