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
    50_000.min(budget.auto_compact_threshold() / 2).max(8_000)
}

pub(crate) fn growth_is_ready(messages: &[Message], budget: &ContextBudget) -> bool {
    let consumed = consumed_growth_tokens(messages);
    let step = growth_threshold(budget);
    // Keep a minimum expected benefit after a conservative 4:1 summary estimate.
    consumed >= step && consumed.saturating_sub(consumed / 4) >= 5_000
}

#[cfg(test)]
mod tests {
    use super::super::history::format_compact_summary_message;
    use super::*;

    fn budget() -> ContextBudget {
        ContextBudget {
            total: 1_000_000,
            system: 2_000,
            tools: 4_000,
            reserved_output: 16_000,
            messages: 984_000,
            auto_compact_threshold: None,
            hard_input_limit: None,
            prefire_threshold: None,
            estimated_tool_growth: 15_000,
        }
    }

    #[test]
    fn selection_keeps_small_summary_and_distills_large_or_emergency_sources() {
        let small = vec![
            Message::compaction_text(format_compact_summary_message("older facts")),
            Message::user_text("new old work"),
        ];
        let plan = summary_plan(&small, &budget(), true);
        assert_eq!(plan.strategy, SummaryStrategy::Incremental);
        assert_eq!(plan.source_start, 1);
        assert!(!plan.no_work);
        assert!(summary_plan(&small[..1], &budget(), true).no_work);
        assert_eq!(
            summary_plan(&small, &budget(), false).strategy,
            SummaryStrategy::Full
        );
        let large = vec![
            Message::compaction_text(format_compact_summary_message(
                &"historical facts ".repeat(8_000),
            )),
            Message::user_text("new old work"),
        ];
        assert_eq!(
            summary_plan(&large, &budget(), true).strategy,
            SummaryStrategy::Distill
        );
    }

    #[test]
    fn growth_gate_ignores_usage_anchors_and_requires_consumed_raw_content() {
        let mut messages = vec![
            Message::user_text("old input"),
            Message::Assistant {
                content: vec![],
                usage: Some(kcoder_types::Usage {
                    input_tokens: 900_000,
                    output_tokens: 1,
                    total_tokens: Some(900_001),
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: None,
                    iterations: None,
                }),
            },
            Message::user_text("recent one"),
            Message::assistant_text("recent answer"),
            Message::user_text("current request"),
            Message::assistant_text("current answer"),
        ];
        assert!(!growth_is_ready(&messages, &budget()));
        messages[0] = Message::user_text("consumed evidence ".repeat(16_000));
        assert!(growth_is_ready(&messages, &budget()));
        let mut tiny = budget();
        tiny.total = 8_000;
        tiny.reserved_output = 2_000;
        assert!(growth_threshold(&tiny) >= tiny.auto_compact_threshold());
    }
}
