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
    let mut budget = budget();
    budget.total = 100_000;
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
    assert!(!growth_is_ready(&messages, &budget));
    messages[0] = Message::user_text("consumed evidence ".repeat(16_000));
    assert!(growth_is_ready(&messages, &budget));
}

#[test]
fn growth_threshold_scales_with_model_budget_and_explicit_soft_limit() {
    for (window, expected) in [
        (8_000, 4_845),
        (128_000, 101_745),
        (256_000, 205_105),
        (409_600, 294_491),
        (512_000, 368_475),
        (1_048_576, 667_192),
    ] {
        let mut budget = budget();
        budget.total = window;
        budget.reserved_output = 2_000.min(window / 4);
        assert_eq!(growth_threshold(&budget), expected, "window {window}");
    }
    let mut budget = budget();
    budget.auto_compact_threshold = Some(600_000);
    assert_eq!(growth_threshold(&budget), 510_000);
}
