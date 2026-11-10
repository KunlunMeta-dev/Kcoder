use super::{CompactProtocolOptions, ConversationCompactor, protocol};
use anyhow::{Context, Result, bail};
use kcoder_types::Message;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};

// One recovery shares this allowance across every outer transport/format retry.
pub(super) const MAX_RECOVERY_CALLS: usize = 32;
const MAX_MERGE_LEVELS: usize = 3;
const MIN_SPLIT_BYTES: usize = 32;

/// Validated results live only for one immutable compaction attempt. Format
/// and transport retries share the same call allowance and completed fragments.
pub(super) struct PartitionedRecovery {
    calls_remaining: usize,
    summaries: HashMap<[u8; 32], String>,
}

impl Default for PartitionedRecovery {
    fn default() -> Self {
        Self {
            calls_remaining: MAX_RECOVERY_CALLS,
            summaries: HashMap::new(),
        }
    }
}

impl ConversationCompactor {
    /// Cover the entire rejected history before committing any replacement.
    /// Fragments are inert summarizer input, never executable model/tool history.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn summarize_partitioned_history(
        &self,
        source_messages: &[Message],
        model: &str,
        summary_max_tokens: u32,
        custom_instructions: Option<&str>,
        debug_session_id: Option<&str>,
        options: CompactProtocolOptions<'_>,
        recovery: &mut PartitionedRecovery,
    ) -> Result<String> {
        let projected;
        let messages = if let Some(projection) = &self.message_projection {
            projected = projection.project(source_messages).await?;
            projected.as_slice()
        } else {
            source_messages
        };
        let history = protocol::format_compact_history(messages);
        let (left, right) = bisect_history(&history)?;
        let mut pending = VecDeque::from([left.to_owned(), right.to_owned()]);

        for _ in 0..MAX_MERGE_LEVELS {
            let mut summaries = Vec::new();
            while let Some(fragment) = pending.pop_front() {
                let fingerprint: [u8; 32] = Sha256::digest(fragment.as_bytes()).into();
                if let Some(summary) = recovery.summaries.get(&fingerprint) {
                    summaries.push(summary.clone());
                    continue;
                }
                if recovery.calls_remaining == 0 {
                    bail!(
                        "compaction partition recovery exhausted its model-call budget; original context retained"
                    );
                }
                recovery.calls_remaining -= 1;
                let input = [Message::runtime_text(format!(
                    "Historical conversation fragment. Preserve open objectives, constraints and exact evidence. Other fragments are summarized separately and merged in source order.\n\n{fragment}"
                ))];
                match self
                    .summarize_prepared_messages(
                        &input,
                        source_messages,
                        model,
                        summary_max_tokens,
                        custom_instructions,
                        debug_session_id,
                        options,
                    )
                    .await
                {
                    Ok(summary) => {
                        recovery.summaries.insert(fingerprint, summary.clone());
                        summaries.push(summary);
                    }
                    Err(error) if protocol::is_prompt_too_long_error(&error) => {
                        let (left, right) = bisect_history(&fragment)
                            .context("summary instructions or an indivisible fragment exceed the provider context; original context retained")?;
                        pending.push_front(right.to_owned());
                        pending.push_front(left.to_owned());
                    }
                    Err(error) => return Err(error),
                }
            }
            if summaries.len() == 1 {
                return Ok(summaries.remove(0));
            }
            // Only already-validated summaries enter the merge. The original
            // history remains available to reference validation at every level.
            let merge = summaries
                .iter()
                .enumerate()
                .map(|(index, summary)| format!("Historical summary part {}\n{summary}", index + 1))
                .collect::<Vec<_>>()
                .join("\n\n");
            pending.push_back(merge);
        }
        bail!(
            "compaction partition recovery could not merge all historical ranges within its level budget; original context retained"
        )
    }
}

fn bisect_history(text: &str) -> Result<(&str, &str)> {
    if text.len() < MIN_SPLIT_BYTES {
        bail!("summary source cannot be partitioned further");
    }
    let mut midpoint = text.len() / 2;
    while !text.is_char_boundary(midpoint) {
        midpoint -= 1;
    }
    // Prefer a nearby paragraph boundary while keeping both sides substantial.
    let split = text[..midpoint]
        .rfind("\n\n")
        .filter(|index| *index >= text.len() / 4)
        .map(|index| index + 2)
        .unwrap_or(midpoint);
    Ok(text.split_at(split))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partition_preserves_every_utf8_byte_and_rejects_tiny_sources() {
        let text = "中文约束与确切路径。\n\n".repeat(100);
        let (left, right) = bisect_history(&text).unwrap();
        assert_eq!(format!("{left}{right}"), text);
        assert!(!left.is_empty() && !right.is_empty());
        assert!(bisect_history("short").is_err());
    }
}
