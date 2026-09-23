use crate::ReplApp;
use kcoder_config::{GoalProTestScope, MemoryObserverMode, PermissionMode};
use kcoder_engine::QueryEngine;
use kcoder_types::{MessageRole, ReasoningEffort};
use std::collections::BTreeMap;
use tracing::warn;

use super::{SlashCommand, SlashResult};

#[derive(Default)]
pub(super) struct SettingsCommand;

#[async_trait::async_trait]
impl SlashCommand for SettingsCommand {
    fn name(&self) -> &'static str {
        "/settings"
    }
    fn description(&self) -> &'static str {
        "Open the settings inspector overlay."
    }
    fn usage(&self) -> &'static str {
        "/settings"
    }
    async fn run(&self, _args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let settings = engine.settings.read().unwrap();
        let observer_stats = engine.memory_observer_queue_stats();
        let worker_diagnostics = engine.memory_observer_worker_diagnostics();
        let observer_failure = engine.memory_observer_last_validation_failure();
        let (
            observer_failure_issue_count,
            observer_failure_first_issue_path,
            observer_failure_first_issue_message,
            observer_failure_occurred_at_epoch,
        ) = match observer_failure {
            Some(failure) => (
                failure.issue_count,
                failure
                    .first_issue_path
                    .unwrap_or_else(|| "none".to_string()),
                failure
                    .first_issue_message
                    .unwrap_or_else(|| "none".to_string()),
                failure.occurred_at_epoch.to_string(),
            ),
            None => (
                0,
                "none".to_string(),
                "none".to_string(),
                "none".to_string(),
            ),
        };
        let mcp_names: Vec<String> = settings
            .mcp_servers
            .iter()
            .map(|s| format!("{} ({})", s.name, s.transport))
            .collect();
        let lines = vec![
            format!("model: {}", settings.model),
            format!(
                "model_reasoning_effort: {}",
                format_reasoning_effort(settings.model_reasoning_effort.as_ref())
            ),
            format!("permission_mode: {:?}", settings.permission_mode),
            format!("tool_timeout_ms: {}", settings.tool_timeout_ms),
            format!(
                "tool_limits.foreground_budget_ms: default={} tools={:?}",
                settings.tool_limits.foreground_budget_ms.default_ms,
                settings.tool_limits.foreground_budget_ms.tools
            ),
            format!(
                "tool_limits.task_output_timeout_ms: default={} min={} max={}",
                settings.tool_limits.task_output_timeout_ms.default_ms,
                settings.tool_limits.task_output_timeout_ms.min_ms,
                settings.tool_limits.task_output_timeout_ms.max_ms
            ),
            format!("max_retries: {}", settings.max_retries),
            format!("retry_base_delay_ms: {}", settings.retry_base_delay_ms),
            format!(
                "summary_profile: {}",
                settings.summary_profile.as_deref().unwrap_or("current")
            ),
            format!(
                "summary_provider: {}",
                settings.summary_provider.as_deref().unwrap_or("current")
            ),
            format!(
                "summary_model: {}",
                settings.summary_model.as_deref().unwrap_or("current")
            ),
            format!("summary_max_tokens: {}", settings.summary_max_tokens),
            format!(
                "goal_pro.verifier_profile: {}",
                settings
                    .goal_pro
                    .verifier_profile
                    .as_deref()
                    .unwrap_or("current")
            ),
            format!(
                "goal_pro.verifier_provider: {}",
                settings
                    .goal_pro
                    .verifier_provider
                    .as_deref()
                    .unwrap_or("current")
            ),
            format!(
                "goal_pro.verifier_model: {}",
                settings
                    .goal_pro
                    .verifier_model
                    .as_deref()
                    .unwrap_or("current")
            ),
            format!(
                "goal_pro.verifier_max_turns: {}",
                settings.goal_pro.verifier_max_turns
            ),
            format!(
                "goal_pro.completion_rejection_limit: {}",
                settings.goal_pro.completion_rejection_limit
            ),
            format!(
                "goal_pro.verification.require_tests: {}",
                settings.goal_pro.verification.require_tests
            ),
            format!(
                "goal_pro.verification.minimum_test_scope: {}",
                match settings.goal_pro.verification.minimum_test_scope {
                    GoalProTestScope::Focused => "focused",
                    GoalProTestScope::TargetSuite => "target_suite",
                }
            ),
            format!(
                "goal_pro.verification.require_raw_exit_code: {}",
                settings.goal_pro.verification.require_raw_exit_code
            ),
            format!(
                "goal_pro.verification.allow_workspace_changes: {}",
                settings.goal_pro.verification.allow_workspace_changes
            ),
            format!(
                "goal_pro.verification.isolate_environment: {}",
                settings.goal_pro.verification.isolate_environment
            ),
            format!(
                "goal_pro.verification.allow_dependency_changes: {}",
                settings.goal_pro.verification.allow_dependency_changes
            ),
            format!(
                "goal_pro.verification.allow_network_only_failures: {}",
                settings.goal_pro.verification.allow_network_only_failures
            ),
            format!(
                "tools.luna.allowed: {}",
                if settings.tools.luna.allowed.is_empty() {
                    "none".to_string()
                } else {
                    settings.tools.luna.allowed.join(", ")
                }
            ),
            format!("history_enabled: {}", settings.history_enabled),
            format!("history_max_messages: {}", settings.history_max_messages),
            format!("auto_memory_enabled: {}", settings.auto_memory_enabled),
            format!(
                "auto_tool_memory_enabled: {}",
                settings.auto_tool_memory_enabled
            ),
            format!(
                "memory.structured_enabled: {}",
                settings.memory.structured_enabled
            ),
            format!(
                "memory.skip_tools: {}",
                if settings.memory.skip_tools.is_empty() {
                    "none".to_string()
                } else {
                    settings.memory.skip_tools.join(", ")
                }
            ),
            format!(
                "memory.private_by_default: {}",
                settings.memory.private_by_default
            ),
            format!(
                "memory.private_file_paths: {}",
                settings.memory.private_file_paths
            ),
            format!(
                "memory.private_verification_targets: {}",
                settings.memory.private_verification_targets
            ),
            format!(
                "memory.record_prompt_placeholders: {}",
                settings.memory.record_prompt_placeholders
            ),
            format!(
                "memory.observer_mode: {}",
                settings.memory.observer_mode.as_str()
            ),
            format!(
                "memory.observer_queue_size: {}",
                settings.memory.observer_queue_size
            ),
            format!(
                "memory.observer_model: {}",
                settings.memory.observer_model.as_deref().unwrap_or("none")
            ),
            format!(
                "memory.observer_queue.capacity: {}",
                observer_stats.capacity
            ),
            format!("memory.observer_queue.queued: {}", observer_stats.queued),
            format!(
                "memory.observer_queue.submitted: {}",
                observer_stats.submitted
            ),
            format!(
                "memory.observer_queue.enqueued: {}",
                observer_stats.enqueued
            ),
            format!("memory.observer_queue.drained: {}", observer_stats.drained),
            format!(
                "memory.observer_queue.overflowed: {}",
                observer_stats.overflowed
            ),
            format!(
                "memory.observer_queue.inline_fallbacks: {}",
                observer_stats.inline_fallbacks
            ),
            format!(
                "memory.observer_queue.dropped_newest: {}",
                observer_stats.dropped_newest
            ),
            format!(
                "memory.observer_queue.dropped_oldest: {}",
                observer_stats.dropped_oldest
            ),
            format!(
                "memory.observer.worker.model_successes: {}",
                worker_diagnostics.model_successes
            ),
            format!(
                "memory.observer.worker.model_fallbacks: {}",
                worker_diagnostics.model_fallbacks
            ),
            format!(
                "memory.observer.worker.model_provider_failures: {}",
                worker_diagnostics.model_provider_failures
            ),
            format!(
                "memory.observer.worker.model_parse_failures: {}",
                worker_diagnostics.model_parse_failures
            ),
            format!(
                "memory.observer.worker.model_validation_failures: {}",
                worker_diagnostics.model_validation_failures
            ),
            format!(
                "memory.observer.worker.last_fallback_reason: {}",
                worker_diagnostics
                    .last_fallback_reason
                    .as_deref()
                    .unwrap_or("none")
            ),
            format!(
                "memory.observer.worker.last_fallback_at_epoch: {}",
                worker_diagnostics
                    .last_fallback_at_epoch
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "none".to_string())
            ),
            format!(
                "memory.observer.last_validation_failure.issue_count: {}",
                observer_failure_issue_count
            ),
            format!(
                "memory.observer.last_validation_failure.first_issue_path: {}",
                observer_failure_first_issue_path
            ),
            format!(
                "memory.observer.last_validation_failure.first_issue_message: {}",
                observer_failure_first_issue_message
            ),
            format!(
                "memory.observer.last_validation_failure.occurred_at_epoch: {}",
                observer_failure_occurred_at_epoch
            ),
            format!(
                "memory.legacy_prompt_enabled: {}",
                settings.memory.legacy_prompt_enabled
            ),
            format!("goal_enabled: {}", settings.goal_enabled),
            format!(
                "auto_skill_review_enabled: {} (startup-only: --skill-review)",
                settings.auto_skill_review_enabled
            ),
            format!(
                "auto_skill_review_interval: {}",
                settings.auto_skill_review_interval
            ),
            format!(
                "skills.auto_skill_review_enabled: {}",
                settings.skills.auto_skill_review_enabled
            ),
            format!(
                "skills.auto_skill_review_interval: {}",
                settings.skills.auto_skill_review_interval
            ),
            format!(
                "skills.auto_curator_enabled: {}",
                settings.skills.auto_curator_enabled
            ),
            format!(
                "skills.auto_curator_interval_hours: {}",
                settings.skills.auto_curator_interval_hours
            ),
            format!(
                "skills.auto_curator_min_idle_hours: {}",
                settings.skills.auto_curator_min_idle_hours
            ),
            format!(
                "skills.stale_after_days: {}",
                settings.skills.stale_after_days
            ),
            format!(
                "skills.archive_after_days: {}",
                settings.skills.archive_after_days
            ),
            format!("skills.prune_builtins: {}", settings.skills.prune_builtins),
            format!("skills.trust_external: {}", settings.skills.trust_external),
            format!(
                "skills.auto_lessons_learned: {}",
                settings.skills.auto_lessons_learned
            ),
            format!("skills.guard.enabled: {}", settings.skills.guard.enabled),
            format!(
                "skills.guard.block_high_risk: {}",
                settings.skills.guard.block_high_risk
            ),
            format!(
                "skills.guard.block_medium_risk_for_community: {}",
                settings.skills.guard.block_medium_risk_for_community
            ),
            format!("render_markdown: {}", settings.render_markdown),
            format!("code_theme: {}", settings.code_theme),
            format!(
                "model_discovery.enabled: {}",
                settings.model_discovery.enabled
            ),
            format!(
                "model_discovery.request_timeout_secs: {}",
                settings.model_discovery.request_timeout_secs
            ),
            format!(
                "model_discovery.cache_ttl_secs: {}",
                settings.model_discovery.cache_ttl_secs
            ),
            format!(
                "model_discovery.max_models_per_provider: {}",
                settings.model_discovery.max_models_per_provider
            ),
            format!(
                "context_window_tokens: {}",
                settings
                    .context_window_tokens
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "default".to_string())
            ),
            format!(
                "mcp_servers: {}",
                if mcp_names.is_empty() {
                    "none".to_string()
                } else {
                    mcp_names.join(", ")
                }
            ),
        ];
        app.open_settings_inspector(lines);
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct SetCommand;

#[async_trait::async_trait]
impl SlashCommand for SetCommand {
    fn needs_arguments(&self) -> bool {
        true
    }
    fn name(&self) -> &'static str {
        "/set"
    }
    fn description(&self) -> &'static str {
        "Change a runtime setting."
    }
    fn usage(&self) -> &'static str {
        "/set <key> <value>"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let trimmed = args.trim();
        let (key, value) = match trimmed.split_once(|c: char| c.is_whitespace()) {
            Some((k, v)) => (k.trim(), v.trim()),
            None => {
                app.push_message(MessageRole::System, "Usage: /set <key> <value>".to_string());
                return SlashResult::Handled;
            }
        };

        let settings_clone = {
            let mut settings = engine.settings.write().unwrap();
            match key {
                "model" => settings.model = value.to_string(),
                "model_reasoning_effort" => {
                    let next_effort = match parse_reasoning_effort_setting(value) {
                        Ok(effort) => effort,
                        Err(()) => {
                            app.push_message(
                                MessageRole::System,
                                "model_reasoning_effort must be default, none, minimal, low, medium, high, xhigh, or a custom non-empty value".to_string(),
                            );
                            return SlashResult::Handled;
                        }
                    };
                    if let Err(error) = kcoder_config::validate_reasoning_policy(settings.model_reasoning_policy.as_ref(), next_effort.as_ref(), &settings.provider_extra_body) {
                        app.push_message(MessageRole::System, format!("Cannot set reasoning: {error}"));
                        return SlashResult::Handled;
                    }
                    settings.model_reasoning_effort = next_effort;
                }
                "permission_mode" => match PermissionMode::parse(value) {
                    Some(mode) => settings.permission_mode = mode,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "Invalid permission mode. Use: ask, auto, accept-edits, dont-ask, bypass, yolo".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "tool_timeout_ms" => match value.parse::<u64>() {
                    Ok(v) => settings.tool_timeout_ms = v,
                    Err(_) => {
                        app.push_message(
                            MessageRole::System,
                            "tool_timeout_ms must be a number".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "tool_limits.foreground_budget_ms.default_ms" => match value.parse::<u64>() {
                    Ok(v) if v > 0 => settings.tool_limits.foreground_budget_ms.default_ms = v,
                    _ => {
                        app.push_message(
                            MessageRole::System,
                            "tool_limits.foreground_budget_ms.default_ms must be a positive number"
                                .to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "tool_limits.foreground_budget_ms.tools" => {
                    match serde_json::from_str::<BTreeMap<String, u64>>(value) {
                        Ok(tools) if tools.values().all(|budget| *budget > 0) => {
                            settings.tool_limits.foreground_budget_ms.tools = tools;
                        }
                        _ => {
                            app.push_message(
                                MessageRole::System,
                                "tool_limits.foreground_budget_ms.tools must be a JSON object mapping tool names to positive numbers".to_string(),
                            );
                            return SlashResult::Handled;
                        }
                    }
                }
                "tool_limits.task_output_timeout_ms.default_ms"
                | "tool_limits.task_output_timeout_ms.min_ms"
                | "tool_limits.task_output_timeout_ms.max_ms" => match value.parse::<u64>() {
                    Ok(v) if v > 0 => match key {
                        "tool_limits.task_output_timeout_ms.default_ms" => {
                            settings.tool_limits.task_output_timeout_ms.default_ms = v
                        }
                        "tool_limits.task_output_timeout_ms.min_ms" => {
                            settings.tool_limits.task_output_timeout_ms.min_ms = v
                        }
                        _ => settings.tool_limits.task_output_timeout_ms.max_ms = v,
                    },
                    _ => {
                        app.push_message(
                            MessageRole::System,
                            format!("{} must be a positive number", key),
                        );
                        return SlashResult::Handled;
                    }
                },
                // Compatibility alias for the old /set key. New values are
                // stored in the per-tool map for both supported shells.
                "bash_foreground_budget_ms" => match value.parse::<u64>() {
                    Ok(v) if v > 0 => {
                        settings
                            .tool_limits
                            .foreground_budget_ms
                            .tools
                            .insert("bash".to_string(), v);
                        settings
                            .tool_limits
                            .foreground_budget_ms
                            .tools
                            .insert("PowerShell".to_string(), v);
                    }
                    _ => {
                        app.push_message(
                            MessageRole::System,
                            "bash_foreground_budget_ms must be a positive number".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "max_retries" => match value.parse::<usize>() {
                    Ok(v) => settings.max_retries = v,
                    Err(_) => {
                        app.push_message(
                            MessageRole::System,
                            "max_retries must be a number".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "retry_base_delay_ms" => match value.parse::<u64>() {
                    Ok(v) => settings.retry_base_delay_ms = v,
                    Err(_) => {
                        app.push_message(
                            MessageRole::System,
                            "retry_base_delay_ms must be a number".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "summary_profile" => {
                    settings.summary_profile = parse_optional_setting(value);
                }
                "summary_provider" => {
                    settings.summary_provider = parse_optional_setting(value);
                }
                "summary_model" => {
                    settings.summary_model = parse_optional_setting(value);
                }
                "summary_max_tokens" => match value.parse::<u32>() {
                    Ok(v) if v > 0 => settings.summary_max_tokens = v,
                    _ => {
                        app.push_message(
                            MessageRole::System,
                            "summary_max_tokens must be a positive number".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "goal_pro.verifier_profile" => {
                    settings.goal_pro.verifier_profile = parse_optional_setting(value);
                }
                "goal_pro.verifier_provider" => {
                    settings.goal_pro.verifier_provider = parse_optional_setting(value);
                }
                "goal_pro.verifier_model" => {
                    settings.goal_pro.verifier_model = parse_optional_setting(value);
                }
                "goal_pro.verifier_max_turns" => match value.parse::<usize>() {
                    Ok(v) if v > 0 => settings.goal_pro.verifier_max_turns = v,
                    _ => {
                        app.push_message(
                            MessageRole::System,
                            "goal_pro.verifier_max_turns must be a positive number".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "goal_pro.completion_rejection_limit" => match value.parse::<usize>() {
                    Ok(v) if v > 0 => settings.goal_pro.completion_rejection_limit = v,
                    _ => {
                        app.push_message(
                            MessageRole::System,
                            "goal_pro.completion_rejection_limit must be a positive number"
                                .to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "goal_pro.verification.require_tests" => match parse_bool(value) {
                    Some(v) => settings.goal_pro.verification.require_tests = v,
                    None => return invalid_boolean_setting(app),
                },
                "goal_pro.verification.minimum_test_scope" => match value {
                    "focused" => {
                        settings.goal_pro.verification.minimum_test_scope =
                            GoalProTestScope::Focused
                    }
                    "target_suite" => {
                        settings.goal_pro.verification.minimum_test_scope =
                            GoalProTestScope::TargetSuite
                    }
                    _ => {
                        app.push_message(
                            MessageRole::System,
                            "goal_pro.verification.minimum_test_scope must be focused or target_suite"
                                .to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "goal_pro.verification.require_raw_exit_code" => match parse_bool(value) {
                    Some(v) => settings.goal_pro.verification.require_raw_exit_code = v,
                    None => return invalid_boolean_setting(app),
                },
                "goal_pro.verification.allow_workspace_changes" => match parse_bool(value) {
                    Some(v) => settings.goal_pro.verification.allow_workspace_changes = v,
                    None => return invalid_boolean_setting(app),
                },
                "goal_pro.verification.isolate_environment" => match parse_bool(value) {
                    Some(v) => settings.goal_pro.verification.isolate_environment = v,
                    None => return invalid_boolean_setting(app),
                },
                "goal_pro.verification.allow_dependency_changes" => match parse_bool(value) {
                    Some(v) => settings.goal_pro.verification.allow_dependency_changes = v,
                    None => return invalid_boolean_setting(app),
                },
                "goal_pro.verification.allow_network_only_failures" => match parse_bool(value) {
                    Some(v) => settings.goal_pro.verification.allow_network_only_failures = v,
                    None => return invalid_boolean_setting(app),
                },
                "history_enabled" => match parse_bool(value) {
                    Some(v) => settings.history_enabled = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "history_max_messages" => match value.parse::<usize>() {
                    Ok(v) if v > 0 => {
                        settings.history_max_messages = v;
                        engine.state.set_history_max_messages(v);
                    }
                    _ => {
                        app.push_message(
                            MessageRole::System,
                            "history_max_messages must be a positive number".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "auto_memory_enabled" => match parse_bool(value) {
                    Some(v) => settings.auto_memory_enabled = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "auto_tool_memory_enabled" => match parse_bool(value) {
                    Some(v) => settings.auto_tool_memory_enabled = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "memory.structured_enabled" => match parse_bool(value) {
                    Some(v) => settings.memory.structured_enabled = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "memory.skip_tools" => {
                    settings.memory.skip_tools = parse_csv_list(value);
                }
                "memory.private_by_default" => match parse_bool(value) {
                    Some(v) => settings.memory.private_by_default = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "memory.private_file_paths" => match parse_bool(value) {
                    Some(v) => settings.memory.private_file_paths = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "memory.private_verification_targets" => match parse_bool(value) {
                    Some(v) => settings.memory.private_verification_targets = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "memory.record_prompt_placeholders" => match parse_bool(value) {
                    Some(v) => settings.memory.record_prompt_placeholders = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "memory.observer_mode" => match MemoryObserverMode::parse(value) {
                    Some(v) => settings.memory.observer_mode = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "memory.observer_mode must be deterministic, disabled, or model"
                                .to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "memory.observer_queue_size" => match value.parse::<usize>() {
                    Ok(v) if v > 0 => settings.memory.observer_queue_size = v,
                    _ => {
                        app.push_message(
                            MessageRole::System,
                            "memory.observer_queue_size must be a positive integer".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "memory.observer_model" => {
                    let trimmed = value.trim();
                    settings.memory.observer_model = if trimmed.eq_ignore_ascii_case("default")
                        || trimmed.eq_ignore_ascii_case("unset")
                        || trimmed.eq_ignore_ascii_case("clear")
                        || trimmed.eq_ignore_ascii_case("none")
                    {
                        None
                    } else {
                        Some(trimmed.to_string())
                    };
                }
                "memory.legacy_prompt_enabled" => match parse_bool(value) {
                    Some(v) => settings.memory.legacy_prompt_enabled = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "goal_enabled" => match parse_bool(value) {
                    Some(v) => settings.goal_enabled = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "auto_skill_review_enabled" => {
                    app.push_message(
                        MessageRole::System,
                        "auto_skill_review_enabled is startup-only. Restart with --skill-review."
                            .to_string(),
                    );
                    return SlashResult::Handled;
                }
                "auto_skill_review_interval" => match value.parse::<usize>() {
                    Ok(v) if v > 0 => settings.auto_skill_review_interval = v,
                    _ => {
                        app.push_message(
                            MessageRole::System,
                            "auto_skill_review_interval must be a positive number".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "skills.auto_skill_review_enabled" => match parse_bool(value) {
                    Some(v) => settings.skills.auto_skill_review_enabled = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "skills.auto_skill_review_interval" => match value.parse::<usize>() {
                    Ok(v) if v > 0 => settings.skills.auto_skill_review_interval = v,
                    _ => {
                        app.push_message(
                            MessageRole::System,
                            "skills.auto_skill_review_interval must be a positive number"
                                .to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "skills.auto_curator_enabled" => match parse_bool(value) {
                    Some(v) => settings.skills.auto_curator_enabled = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "skills.auto_curator_interval_hours" => match value.parse::<u64>() {
                    Ok(v) if v > 0 => settings.skills.auto_curator_interval_hours = v,
                    _ => {
                        app.push_message(
                            MessageRole::System,
                            "skills.auto_curator_interval_hours must be a positive number"
                                .to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "skills.auto_curator_min_idle_hours" => match value.parse::<u64>() {
                    Ok(v) => settings.skills.auto_curator_min_idle_hours = v,
                    _ => {
                        app.push_message(
                            MessageRole::System,
                            "skills.auto_curator_min_idle_hours must be a number".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "skills.stale_after_days" => match value.parse::<u64>() {
                    Ok(v) => settings.skills.stale_after_days = v,
                    _ => {
                        app.push_message(
                            MessageRole::System,
                            "skills.stale_after_days must be a number".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "skills.archive_after_days" => match value.parse::<u64>() {
                    Ok(v) => settings.skills.archive_after_days = v,
                    _ => {
                        app.push_message(
                            MessageRole::System,
                            "skills.archive_after_days must be a number".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "skills.prune_builtins" => match parse_bool(value) {
                    Some(v) => settings.skills.prune_builtins = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "skills.trust_external" => match parse_bool(value) {
                    Some(v) => settings.skills.trust_external = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "skills.auto_lessons_learned" => match parse_bool(value) {
                    Some(v) => settings.skills.auto_lessons_learned = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "skills.guard.enabled" => match parse_bool(value) {
                    Some(v) => settings.skills.guard.enabled = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "skills.guard.block_high_risk" => match parse_bool(value) {
                    Some(v) => settings.skills.guard.block_high_risk = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "skills.guard.block_medium_risk_for_community" => match parse_bool(value) {
                    Some(v) => settings.skills.guard.block_medium_risk_for_community = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "render_markdown" => match parse_bool(value) {
                    Some(v) => settings.render_markdown = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "code_theme" => settings.code_theme = value.to_string(),
                "model_discovery.enabled" => match parse_bool(value) {
                    Some(v) => settings.model_discovery.enabled = v,
                    None => {
                        app.push_message(
                            MessageRole::System,
                            "value must be true or false".to_string(),
                        );
                        return SlashResult::Handled;
                    }
                },
                "context_window_tokens" => {
                    settings.context_window_tokens = if value.eq_ignore_ascii_case("default") {
                        None
                    } else {
                        match value.parse::<usize>() {
                            Ok(v) => Some(v),
                            Err(_) => {
                                app.push_message(
                                    MessageRole::System,
                                    "context_window_tokens must be a number or 'default'"
                                        .to_string(),
                                );
                                return SlashResult::Handled;
                            }
                        }
                    };
                }
                _ => {
                    app.push_message(
                        MessageRole::System,
                        format!(
                            "Unknown setting: {}. Use /settings to see available keys.",
                            key
                        ),
                    );
                    return SlashResult::Handled;
                }
            }
            engine
                .permissions
                .write()
                .unwrap()
                .refresh_persisted_settings(&settings);
            settings.clone()
        };

        app.model_name = settings_clone.model.clone();
        app.reasoning_effort = settings_clone.model_reasoning_effort.clone();
        app.render_markdown = settings_clone.render_markdown;
        app.set_code_theme(settings_clone.code_theme.clone());
        if key == "model_discovery.enabled" {
            app.model_discovery_cache = None;
        }

        let persistence_keys: &[&str] = if key == "bash_foreground_budget_ms" {
            &[
                "tool_limits.foreground_budget_ms.tools.bash",
                "tool_limits.foreground_budget_ms.tools.PowerShell",
            ]
        } else {
            &[key]
        };
        if let Err(e) = engine
            .persist_settings_fields(settings_clone, persistence_keys)
            .await
        {
            warn!("failed to save setting: {}", e);
        }

        app.push_message(MessageRole::System, format!("Set {} to {}.", key, value));
        SlashResult::Handled
    }
}

fn parse_bool(value: &str) -> Option<bool> {
    match value.to_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn invalid_boolean_setting(app: &mut ReplApp) -> SlashResult {
    app.push_message(
        MessageRole::System,
        "value must be true or false".to_string(),
    );
    SlashResult::Handled
}

fn parse_optional_setting(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("default")
        || trimmed.eq_ignore_ascii_case("unset")
        || trimmed.eq_ignore_ascii_case("clear")
        || trimmed.eq_ignore_ascii_case("none")
        || trimmed.eq_ignore_ascii_case("current")
    {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_csv_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn parse_reasoning_effort_setting(value: &str) -> Result<Option<ReasoningEffort>, ()> {
    let trimmed = value.trim();
    if trimmed.eq_ignore_ascii_case("default")
        || trimmed.eq_ignore_ascii_case("unset")
        || trimmed.eq_ignore_ascii_case("clear")
    {
        return Ok(None);
    }
    trimmed.parse().map(Some).map_err(|_| ())
}

fn format_reasoning_effort(effort: Option<&ReasoningEffort>) -> String {
    effort
        .map(ToString::to_string)
        .unwrap_or_else(|| "default".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
    use kcoder_config::{
        MemoryObserverMode, MemorySettings, Settings, SkillGuardSettings, SkillsSettings,
    };
    use kcoder_memory::{MemoryManager, MemoryStore};
    use kcoder_permissions::PermissionEngine;
    use kcoder_skills::SkillRegistry;
    use kcoder_state::AppState;
    use kcoder_tools::{DenyAllUserQuestioner, ToolRegistry};
    use kcoder_types::{MessagesRequest, ReasoningEffort};
    use std::path::Path;
    use std::sync::Arc;

    #[tokio::test]
    async fn settings_slash_inspector_lists_skill_lifecycle_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let settings = Settings {
            model: "GLM-5.2".to_string(),
            skills: SkillsSettings {
                auto_skill_review_enabled: true,
                auto_skill_review_interval: 9,
                auto_curator_enabled: false,
                auto_curator_interval_hours: 24,
                auto_curator_min_idle_hours: 4,
                stale_after_days: 12,
                archive_after_days: 34,
                prune_builtins: true,
                trust_external: true,
                auto_lessons_learned: true,
                guard: SkillGuardSettings {
                    enabled: true,
                    block_high_risk: true,
                    block_medium_risk_for_community: false,
                },
                ..SkillsSettings::default()
            },
            model_reasoning_effort: Some(ReasoningEffort::High),
            memory: MemorySettings {
                structured_enabled: false,
                skip_tools: vec!["bash".to_string(), "write".to_string()],
                legacy_prompt_enabled: false,
                private_by_default: true,
                private_file_paths: true,
                private_verification_targets: true,
                record_prompt_placeholders: false,
                observer_mode: MemoryObserverMode::Model,
                observer_queue_size: 64,
                observer_model: Some("observer-mini".to_string()),
            },
            ..Settings::default()
        };
        let engine = test_engine(tmp.path(), settings);
        let mut app = ReplApp::default();

        let result = SettingsCommand.run("", &mut app, &engine).await;

        assert_eq!(result, SlashResult::Handled);
        let inspector = app
            .settings_inspector
            .as_ref()
            .expect("/settings should open the inspector");
        let text = inspector.lines.join("\n");
        for expected in [
            "skills.auto_skill_review_enabled: true",
            "skills.auto_skill_review_interval: 9",
            "skills.auto_curator_enabled: false",
            "skills.auto_curator_interval_hours: 24",
            "skills.auto_curator_min_idle_hours: 4",
            "skills.stale_after_days: 12",
            "skills.archive_after_days: 34",
            "skills.prune_builtins: true",
            "skills.trust_external: true",
            "skills.auto_lessons_learned: true",
            "skills.guard.enabled: true",
            "skills.guard.block_high_risk: true",
            "skills.guard.block_medium_risk_for_community: false",
            "model_reasoning_effort: high",
            "context_window_tokens: 1048576",
            "summary_profile: current",
            "summary_provider: current",
            "summary_model: current",
            "summary_max_tokens: 20000",
            "goal_pro.completion_rejection_limit: 8",
            "memory.structured_enabled: false",
            "memory.skip_tools: bash, write",
            "memory.legacy_prompt_enabled: false",
            "memory.private_by_default: true",
            "memory.private_file_paths: true",
            "memory.private_verification_targets: true",
            "memory.record_prompt_placeholders: false",
            "memory.observer_mode: model",
            "memory.observer_queue_size: 64",
            "memory.observer_model: observer-mini",
            "memory.observer_queue.capacity: 64",
            "memory.observer_queue.queued: 0",
            "memory.observer_queue.submitted: 0",
            "memory.observer_queue.enqueued: 0",
            "memory.observer_queue.drained: 0",
            "memory.observer_queue.overflowed: 0",
            "memory.observer_queue.inline_fallbacks: 0",
            "memory.observer_queue.dropped_newest: 0",
            "memory.observer_queue.dropped_oldest: 0",
            "memory.observer.worker.model_successes: 0",
            "memory.observer.worker.model_fallbacks: 0",
            "memory.observer.worker.model_provider_failures: 0",
            "memory.observer.worker.model_parse_failures: 0",
            "memory.observer.worker.model_validation_failures: 0",
            "memory.observer.worker.last_fallback_reason: none",
            "memory.observer.worker.last_fallback_at_epoch: none",
            "memory.observer.last_validation_failure.issue_count: 0",
            "memory.observer.last_validation_failure.first_issue_path: none",
            "memory.observer.last_validation_failure.first_issue_message: none",
            "memory.observer.last_validation_failure.occurred_at_epoch: none",
        ] {
            assert!(text.contains(expected), "missing {expected} in {text}");
        }
    }

    #[tokio::test]
    async fn set_memory_settings_updates_runtime_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = test_engine(tmp.path(), Settings::default());
        let mut app = ReplApp::default();

        assert_eq!(
            SetCommand
                .run("memory.structured_enabled false", &mut app, &engine)
                .await,
            SlashResult::Handled
        );
        assert_eq!(
            SetCommand
                .run("memory.skip_tools bash, write", &mut app, &engine)
                .await,
            SlashResult::Handled
        );
        assert_eq!(
            SetCommand
                .run("memory.private_by_default true", &mut app, &engine)
                .await,
            SlashResult::Handled
        );
        assert_eq!(
            SetCommand
                .run("memory.private_file_paths true", &mut app, &engine)
                .await,
            SlashResult::Handled
        );
        assert_eq!(
            SetCommand
                .run(
                    "memory.private_verification_targets true",
                    &mut app,
                    &engine
                )
                .await,
            SlashResult::Handled
        );
        assert_eq!(
            SetCommand
                .run("memory.record_prompt_placeholders false", &mut app, &engine)
                .await,
            SlashResult::Handled
        );
        assert_eq!(
            SetCommand
                .run("memory.observer_mode disabled", &mut app, &engine)
                .await,
            SlashResult::Handled
        );
        assert_eq!(
            SetCommand
                .run("memory.observer_queue_size 33", &mut app, &engine)
                .await,
            SlashResult::Handled
        );
        assert_eq!(
            SetCommand
                .run("memory.observer_model observer-mini", &mut app, &engine)
                .await,
            SlashResult::Handled
        );
        assert_eq!(
            SetCommand
                .run("memory.legacy_prompt_enabled false", &mut app, &engine)
                .await,
            SlashResult::Handled
        );

        let settings = engine.settings.read().unwrap();
        assert!(!settings.memory.structured_enabled);
        assert_eq!(settings.memory.skip_tools, vec!["bash", "write"]);
        assert!(settings.memory.private_by_default);
        assert!(settings.memory.private_file_paths);
        assert!(settings.memory.private_verification_targets);
        assert!(!settings.memory.record_prompt_placeholders);
        assert_eq!(settings.memory.observer_mode, MemoryObserverMode::Disabled);
        assert_eq!(settings.memory.observer_queue_size, 33);
        assert_eq!(
            settings.memory.observer_model.as_deref(),
            Some("observer-mini")
        );
        assert!(!settings.memory.legacy_prompt_enabled);
    }

    #[tokio::test]
    async fn set_goal_pro_completion_rejection_limit_validates_and_persists() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = test_engine(tmp.path(), Settings::default());
        let mut app = ReplApp::default();

        let result = SetCommand
            .run("goal_pro.completion_rejection_limit 3", &mut app, &engine)
            .await;
        assert_eq!(result, SlashResult::Handled);
        assert_eq!(
            engine
                .settings
                .read()
                .unwrap()
                .goal_pro
                .completion_rejection_limit,
            3
        );
        let persisted = std::fs::read_to_string(tmp.path().join("test-config/settings.json"))
            .expect("/set should write to the Settings path owned by the test");
        let persisted: serde_json::Value = serde_json::from_str(&persisted).unwrap();
        assert_eq!(persisted["goal_pro"]["completion_rejection_limit"], 3);

        let result = SetCommand
            .run("goal_pro.completion_rejection_limit 0", &mut app, &engine)
            .await;
        assert_eq!(result, SlashResult::Handled);
        assert_eq!(
            engine
                .settings
                .read()
                .unwrap()
                .goal_pro
                .completion_rejection_limit,
            3
        );
    }

    #[tokio::test]
    async fn set_model_reasoning_effort_updates_settings_and_app() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = test_engine(tmp.path(), Settings::default());
        let mut app = ReplApp::default();

        let result = SetCommand
            .run("model_reasoning_effort xhigh", &mut app, &engine)
            .await;

        assert_eq!(result, SlashResult::Handled);
        assert_eq!(
            engine.settings.read().unwrap().model_reasoning_effort,
            Some(ReasoningEffort::XHigh)
        );
        assert_eq!(app.reasoning_effort, Some(ReasoningEffort::XHigh));
        let persisted = std::fs::read_to_string(tmp.path().join("test-config/settings.json"))
            .expect("/set should only write to the Settings path owned by the test");
        let persisted: serde_json::Value =
            serde_json::from_str(&persisted).expect("persisted Settings should be valid JSON");
        assert_eq!(persisted["model_reasoning_effort"], "xhigh");
    }

    #[tokio::test]
    async fn set_model_reasoning_effort_default_clears_override() {
        let tmp = tempfile::tempdir().unwrap();
        let settings = Settings {
            model_reasoning_effort: Some(ReasoningEffort::High),
            ..Settings::default()
        };
        let engine = test_engine(tmp.path(), settings);
        let mut app = ReplApp::default();

        let result = SetCommand
            .run("model_reasoning_effort default", &mut app, &engine)
            .await;

        assert_eq!(result, SlashResult::Handled);
        assert_eq!(engine.settings.read().unwrap().model_reasoning_effort, None);
        assert_eq!(app.reasoning_effort, None);
    }

    #[tokio::test]
    async fn set_summary_profile_supports_selection_and_main_model_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = test_engine(tmp.path(), Settings::default());
        let mut app = ReplApp::default();

        SetCommand
            .run("summary_profile minimax-summary", &mut app, &engine)
            .await;
        assert_eq!(
            engine.settings.read().unwrap().summary_profile.as_deref(),
            Some("minimax-summary")
        );

        SetCommand
            .run("summary_profile current", &mut app, &engine)
            .await;
        assert_eq!(engine.settings.read().unwrap().summary_profile, None);
    }

    fn test_engine(cwd: &Path, settings: Settings) -> QueryEngine {
        QueryEngine::new(
            Arc::new(EmptyProvider),
            AppState::new(cwd),
            ToolRegistry::new(),
            PermissionEngine::from_settings(&settings),
            settings,
            MemoryManager::global_only(MemoryStore::empty()),
            SkillRegistry::load(cwd).unwrap(),
            Arc::new(DenyAllUserQuestioner),
            cwd.to_path_buf(),
        )
        .with_settings_persistence_path(cwd.join("test-config/settings.json"))
    }

    struct EmptyProvider;

    impl Provider for EmptyProvider {
        fn name(&self) -> &'static str {
            "empty"
        }

        fn stream_messages(
            &self,
            _request: MessagesRequest,
        ) -> Result<ProviderStream, ApiErrorKind> {
            Ok(Box::pin(futures::stream::empty()))
        }
    }
}
