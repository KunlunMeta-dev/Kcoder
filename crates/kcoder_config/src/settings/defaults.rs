//! Defaults configuration types and their defaults.

use crate::*;

pub(crate) fn default_model() -> String {
    default_model_name()
}

pub(crate) fn default_summary_provider() -> Option<String> {
    None
}

pub(crate) fn default_summary_model() -> Option<String> {
    None
}

pub(crate) fn default_true() -> bool {
    true
}

pub(crate) fn default_moa_provider() -> String {
    "current".to_string()
}

pub(crate) fn default_moa_model() -> String {
    "current".to_string()
}

pub(crate) fn default_moa_default_preset() -> String {
    "default".to_string()
}

pub(crate) fn default_moa_max_reference_workers() -> usize {
    8
}

pub(crate) fn default_moa_reference_models() -> Vec<MoaModelConfig> {
    vec![MoaModelConfig::new("current", "current")]
}

pub(crate) fn default_moa_aggregator() -> MoaModelConfig {
    MoaModelConfig::new("current", "current")
}

pub(crate) fn default_moa_reference_max_tokens() -> Option<u32> {
    Some(16_384)
}

pub(crate) fn default_moa_aggregator_max_tokens() -> Option<u32> {
    Some(32_768)
}

pub(crate) fn default_moa_presets() -> BTreeMap<String, MoaPresetConfig> {
    BTreeMap::from([(default_moa_default_preset(), MoaPresetConfig::default())])
}

pub(crate) fn default_moa_plan_preset() -> String {
    "default".to_string()
}

pub(crate) fn default_moa_plan_draft_max_turns() -> usize {
    DEFAULT_SUBAGENT_MAX_TURNS
}

pub(crate) fn default_moa_plan_draft_max_tokens() -> u32 {
    16_384
}

pub(crate) fn default_moa_plan_synthesis_max_tokens() -> u32 {
    32_768
}

pub(crate) fn default_moa_plan_draft_timeout_secs() -> u64 {
    300
}

pub(crate) fn default_moa_plan_max_planner_workers() -> usize {
    4
}

pub(crate) fn default_auto_memory_enabled() -> bool {
    true
}

pub(crate) fn default_auto_tool_memory_enabled() -> bool {
    true
}

pub(crate) fn default_memory_structured_enabled() -> bool {
    true
}

pub(crate) fn default_memory_legacy_prompt_enabled() -> bool {
    true
}

pub(crate) fn default_memory_record_prompt_placeholders() -> bool {
    true
}

pub(crate) fn default_memory_observer_queue_size() -> usize {
    128
}

pub(crate) fn default_session_memory_enabled() -> bool {
    true
}

pub(crate) fn default_session_memory_update_enabled() -> bool {
    true
}

pub(crate) fn default_session_memory_compact_enabled() -> bool {
    true
}

pub(crate) fn default_session_memory_update_interval_turns() -> usize {
    1
}

pub(crate) fn default_session_memory_init_min_tokens() -> usize {
    10_000
}

pub(crate) fn default_session_memory_update_min_token_delta() -> usize {
    5_000
}

pub(crate) fn default_session_memory_tool_call_threshold() -> usize {
    3
}

pub(crate) fn default_session_memory_max_update_messages() -> usize {
    80
}

pub(crate) fn default_session_memory_update_max_tokens() -> u32 {
    12_000
}

pub(crate) fn default_session_memory_compact_min_chars() -> usize {
    80
}

pub(crate) fn default_session_memory_compact_min_recent_tokens() -> usize {
    10_000
}

pub(crate) fn default_session_memory_compact_max_recent_tokens() -> usize {
    40_000
}

pub(crate) fn default_session_memory_compact_min_recent_messages() -> usize {
    5
}

pub(crate) fn default_auto_compact_small_window_percent() -> usize {
    DEFAULT_AUTO_COMPACT_SMALL_WINDOW_PERCENT
}

pub(crate) fn default_auto_compact_medium_window_percent() -> usize {
    DEFAULT_AUTO_COMPACT_MEDIUM_WINDOW_PERCENT
}

pub(crate) fn default_auto_compact_large_window_percent() -> usize {
    DEFAULT_AUTO_COMPACT_LARGE_WINDOW_PERCENT
}

pub(crate) fn default_time_based_micro_compact_enabled() -> bool {
    true
}

pub(crate) fn default_time_based_micro_compact_gap_minutes() -> u64 {
    60
}

pub(crate) fn default_time_based_micro_compact_keep_recent() -> usize {
    5
}

pub(crate) fn default_goal_enabled() -> bool {
    true
}

pub(crate) fn default_goal_max_auto_continuations() -> usize {
    8
}

pub(crate) fn default_auto_skill_review_interval() -> usize {
    10
}

pub(crate) fn default_auto_curator_enabled() -> bool {
    true
}

pub(crate) fn default_auto_curator_interval_hours() -> u64 {
    168
}

pub(crate) fn default_auto_curator_min_idle_hours() -> u64 {
    2
}

pub(crate) fn default_stale_after_days() -> u64 {
    30
}

pub(crate) fn default_archive_after_days() -> u64 {
    90
}

pub(crate) fn default_skill_guard_enabled() -> bool {
    true
}

pub(crate) fn default_skill_guard_block_high_risk() -> bool {
    true
}

pub(crate) fn default_skill_guard_block_medium_risk_for_community() -> bool {
    true
}

pub(crate) fn default_history_enabled() -> bool {
    true
}

pub(crate) fn default_history_max_messages() -> usize {
    99_999
}

pub(crate) fn default_render_markdown() -> bool {
    true
}

pub(crate) fn default_code_theme() -> String {
    "auto".to_string()
}

pub(crate) fn default_max_retries() -> usize {
    // Headless/batch runs share upstream proxies with other sessions; five
    // attempts ride out short transport outages that three would not
    // (observed in parallel-run campaigns).
    5
}

pub(crate) fn default_summary_max_tokens() -> u32 {
    20_000
}

pub(crate) fn default_retry_base_delay_ms() -> u64 {
    1000
}

pub(crate) fn default_semantic_coercion_enabled() -> bool {
    true
}

pub(crate) fn default_stringify_mismatched_scalar() -> bool {
    true
}

pub(crate) fn default_tool_timeout_ms() -> u64 {
    300_000
}

pub(crate) fn default_tool_foreground_budget_ms() -> u64 {
    300_000
}

pub(crate) fn default_task_output_timeout_ms() -> u64 {
    5_000
}

pub(crate) fn default_task_output_min_timeout_ms() -> u64 {
    1_000
}

pub(crate) fn default_task_output_max_timeout_ms() -> u64 {
    15_000
}

/// Default per-tool output cap. 100 KiB keeps even very chatty tools
/// (rg, cargo test, big greps) inside a bounded, renderable result while
/// preserving enough output for the model to work with.
pub(crate) fn default_max_tool_output_bytes() -> usize {
    100 * 1024
}

pub(crate) fn default_doom_loop_repetitions() -> i64 {
    6
}

pub(crate) fn default_permission_denial_consecutive_limit() -> usize {
    2
}

pub(crate) fn default_tool_output_head_bytes() -> usize {
    60 * 1024
}

pub(crate) fn default_tool_output_tail_bytes() -> usize {
    40 * 1024
}

pub(crate) fn default_background_completion_preview_bytes() -> usize {
    512
}

/// Default concurrent sub-agent cap. The engine also treats this as the hard
/// maximum for live forked agents.
pub(crate) fn default_max_concurrent_subagents() -> usize {
    MAX_CONCURRENT_SUBAGENTS
}

pub(crate) fn default_subagent_max_turns() -> usize {
    DEFAULT_SUBAGENT_MAX_TURNS
}
