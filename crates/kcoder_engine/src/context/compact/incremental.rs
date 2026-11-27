use super::{ContextBudget, Message, TokenCounter, latest_compact_boundary};

const MAX_RETAINED_SUMMARY_TOKENS: usize = 16_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SummaryStrategy {
    Full,
    Incremental,
    Distill,
}

pub(crate) struct SummaryPlan {
    pub retained_summary: Option<String>,
    pub source_start: usize,
    pub strategy: SummaryStrategy,
    pub no_work: bool,
}

/// Select by source kind and token mass. Old sessions need no extra markers or
/// settings: a native compact boundary already identifies the prior summary.
pub(crate) fn summary_plan(
    old: &[Message],
    budget: &ContextBudget,
    allow_retention: bool,
) -> SummaryPlan {
    let boundary = latest_compact_boundary(old);
    if allow_retention && let Some(boundary) = boundary {
        let retained_tokens = TokenCounter::estimate_single_message(&Message::compaction_text(
            boundary.summary.clone(),
        ));
        let retained_limit = MAX_RETAINED_SUMMARY_TOKENS.min(budget.auto_compact_threshold() / 4);
        if retained_tokens <= retained_limit {
            return SummaryPlan {
                retained_summary: Some(boundary.summary),
                source_start: boundary.suffix_start,
                strategy: SummaryStrategy::Incremental,
                no_work: old.len() <= boundary.suffix_start,
            };
        }
        return SummaryPlan {
            retained_summary: None,
            source_start: 0,
            strategy: SummaryStrategy::Distill,
            no_work: false,
        };
    }
    SummaryPlan {
        retained_summary: None,
        source_start: 0,
        strategy: SummaryStrategy::Full,
        no_work: false,
    }
}

/// A growth gate counts raw consumed content, never historical provider usage
/// anchors or already compressed summaries. Pressure/hard limits are separate.
pub(crate) fn consumed_growth_tokens(messages: &[Message]) -> usize {
    let split = super::history::split_for_compaction(messages);
    let start = latest_compact_boundary(&split.old).map_or(0, |boundary| boundary.suffix_start);
    split.old[start..]
        .iter()
        .map(TokenCounter::estimate_single_message)
        .sum()
}

pub(crate) fn growth_threshold(budget: &ContextBudget) -> usize {
    // Scale with the active model's effective budget, including explicit
    // threshold overrides. Large windows must not inherit a fixed small cap.
    budget.auto_compact_threshold().saturating_mul(85) / 100
}

pub(crate) fn growth_is_ready(messages: &[Message], budget: &ContextBudget) -> bool {
    let consumed = consumed_growth_tokens(messages);
    let step = growth_threshold(budget);
    // Keep a minimum expected benefit after a conservative 4:1 summary estimate.
    consumed >= step && consumed.saturating_sub(consumed / 4) >= 5_000
}

#[cfg(test)]
#[path = "incremental_tests.rs"]
mod tests;
