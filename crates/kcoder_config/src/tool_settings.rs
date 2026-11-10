//! Typed setting values exposed by the Config tool.

use crate::{
    GoalProSettings, GoalProTestScope, GoalProVerificationSettings, MemoryObserverMode,
    PermissionMode, ReasoningEffort, Settings, TuiAltScreenMode, expand_home_path,
};
use serde_json::Value;

#[derive(Debug)]
pub struct InvalidToolSettingValue(pub String);

pub enum ToolSettingUpdate {
    Applied,
    Unknown,
    EmptyModel,
    SkillReviewStartupOnly,
}

pub fn is_secret_setting(setting: &str) -> bool {
    let normalized = setting.trim().to_ascii_lowercase().replace(['.', '-'], "_");
    normalized == "api_key" || normalized.ends_with("_api_key")
}

pub fn read_setting_value(setting: &str, settings: &Settings) -> Option<Value> {
    let value = match setting {
        "model" => Value::String(settings.model.clone()),
        "model_reasoning_effort" => settings
            .model_reasoning_effort
            .as_ref()
            .map_or(Value::Null, |effort| Value::String(effort.to_string())),
        "permission_mode" | "permissions.defaultMode" => {
            Value::String(format!("{:?}", settings.permission_mode).to_lowercase())
        }
        "auto_memory_enabled" => Value::Bool(settings.auto_memory_enabled),
        "auto_tool_memory_enabled" => Value::Bool(settings.auto_tool_memory_enabled),
        "goal_enabled" => Value::Bool(settings.goal_enabled),
        "auto_skill_review_enabled" => Value::Bool(settings.auto_skill_review_enabled),
        "auto_skill_review_interval" => Value::Number(settings.auto_skill_review_interval.into()),
        "history_enabled" => Value::Bool(settings.history_enabled),
        "history_max_messages" => Value::Number(settings.history_max_messages.into()),
        "render_markdown" => Value::Bool(settings.render_markdown),
        "rich_terminal" => Value::Bool(settings.rich_terminal),
        "tui" => serde_json::to_value(&settings.tui).unwrap_or(Value::Null),
        "tui.alternate_screen" => {
            serde_json::to_value(settings.tui.alternate_screen).unwrap_or(Value::Null)
        }
        "code_theme" => Value::String(settings.code_theme.clone()),
        "context_window_tokens" => settings
            .context_window_tokens
            .map_or(Value::Null, |v| Value::Number(v.into())),
        "context_system_tokens" => settings
            .context_system_tokens
            .map_or(Value::Null, |v| Value::Number(v.into())),
        "context_tools_tokens" => settings
            .context_tools_tokens
            .map_or(Value::Null, |v| Value::Number(v.into())),
        "context_output_headroom" => settings
            .context_output_headroom
            .map_or(Value::Null, |v| Value::Number(v.into())),
        "summary_provider" => settings
            .summary_provider
            .as_ref()
            .map_or(Value::Null, |v| Value::String(v.clone())),
        "summary_profile" => settings
            .summary_profile
            .as_ref()
            .map_or(Value::Null, |v| Value::String(v.clone())),
        "summary_model" => settings
            .summary_model
            .as_ref()
            .map_or(Value::Null, |v| Value::String(v.clone())),
        "summary_max_tokens" => Value::Number(settings.summary_max_tokens.into()),
        "goal_pro" => serde_json::to_value(&settings.goal_pro).unwrap_or(Value::Null),
        "goal_pro.verifier_profile" => settings
            .goal_pro
            .verifier_profile
            .as_ref()
            .map_or(Value::Null, |value| Value::String(value.clone())),
        "goal_pro.verifier_provider" => settings
            .goal_pro
            .verifier_provider
            .as_ref()
            .map_or(Value::Null, |value| Value::String(value.clone())),
        "goal_pro.verifier_model" => settings
            .goal_pro
            .verifier_model
            .as_ref()
            .map_or(Value::Null, |value| Value::String(value.clone())),
        "goal_pro.verifier_max_turns" => Value::Number(settings.goal_pro.verifier_max_turns.into()),
        "goal_pro.completion_rejection_limit" => {
            Value::Number(settings.goal_pro.completion_rejection_limit.into())
        }
        "goal_pro.verification" => {
            serde_json::to_value(&settings.goal_pro.verification).unwrap_or(Value::Null)
        }
        "goal_pro.verification.require_tests" => {
            Value::Bool(settings.goal_pro.verification.require_tests)
        }
        "goal_pro.verification.require_behavior_delta" => {
            Value::Bool(settings.goal_pro.verification.require_behavior_delta)
        }
        "goal_pro.verification.minimum_test_scope" => {
            serde_json::to_value(settings.goal_pro.verification.minimum_test_scope)
                .unwrap_or(Value::Null)
        }
        "goal_pro.verification.require_raw_exit_code" => {
            Value::Bool(settings.goal_pro.verification.require_raw_exit_code)
        }
        "goal_pro.verification.allow_workspace_changes" => {
            Value::Bool(settings.goal_pro.verification.allow_workspace_changes)
        }
        "goal_pro.verification.isolate_environment" => {
            Value::Bool(settings.goal_pro.verification.isolate_environment)
        }
        "goal_pro.verification.allow_dependency_changes" => {
            Value::Bool(settings.goal_pro.verification.allow_dependency_changes)
        }
        "goal_pro.verification.allow_network_only_failures" => {
            Value::Bool(settings.goal_pro.verification.allow_network_only_failures)
        }
        "max_retries" => Value::Number(settings.max_retries.into()),
        "retry_base_delay_ms" => Value::Number(settings.retry_base_delay_ms.into()),
        "tool_timeout_ms" => Value::Number(settings.tool_timeout_ms.into()),
        "tool_limits" => serde_json::to_value(&settings.tool_limits).unwrap_or(Value::Null),
        "tool_limits.execution_timeout_ms" => {
            serde_json::to_value(&settings.tool_limits.execution_timeout_ms).unwrap_or(Value::Null)
        }
        "tool_limits.foreground_budget_ms" => {
            serde_json::to_value(&settings.tool_limits.foreground_budget_ms).unwrap_or(Value::Null)
        }
        "tool_limits.foreground_budget_ms.default_ms" => {
            Value::Number(settings.tool_limits.foreground_budget_ms.default_ms.into())
        }
        "tool_limits.foreground_budget_ms.tools" => {
            serde_json::to_value(&settings.tool_limits.foreground_budget_ms.tools)
                .unwrap_or(Value::Null)
        }
        "tool_limits.task_output_timeout_ms" => {
            serde_json::to_value(&settings.tool_limits.task_output_timeout_ms)
                .unwrap_or(Value::Null)
        }
        "tool_limits.task_output_timeout_ms.default_ms" => Value::Number(
            settings
                .tool_limits
                .task_output_timeout_ms
                .default_ms
                .into(),
        ),
        "tool_limits.task_output_timeout_ms.min_ms" => {
            Value::Number(settings.tool_limits.task_output_timeout_ms.min_ms.into())
        }
        "tool_limits.task_output_timeout_ms.max_ms" => {
            Value::Number(settings.tool_limits.task_output_timeout_ms.max_ms.into())
        }
        "default_subagent_max_turns" | "subagent_max_turns" => {
            Value::Number(settings.default_subagent_max_turns.into())
        }
        "allowed_tools" => Value::Array(
            settings
                .allowed_tools
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
        "denied_tools" => Value::Array(
            settings
                .denied_tools
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
        "permission_rules" | "permissions.rules" => {
            serde_json::to_value(&settings.permission_rules).unwrap_or(Value::Null)
        }
        "memory_directory" | "memory.directory" => settings
            .memory_directory
            .as_ref()
            .map_or(Value::Null, |p| Value::String(p.display().to_string())),
        "knowledge" => serde_json::to_value(&settings.knowledge).unwrap_or(Value::Null),
        "knowledge.enabled" => Value::Bool(settings.knowledge.is_available()),
        "knowledge.retrieval_enabled" => Value::Bool(settings.knowledge.can_retrieve()),
        "knowledge.organization_enabled" => Value::Bool(settings.knowledge.can_organize()),
        "memory" => serde_json::to_value(&settings.memory).unwrap_or(Value::Null),
        "memory.structured_enabled" => Value::Bool(settings.memory.structured_enabled),
        "memory.skip_tools" => Value::Array(
            settings
                .memory
                .skip_tools
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
        "memory.legacy_prompt_enabled" => Value::Bool(settings.memory.legacy_prompt_enabled),
        "memory.private_by_default" => Value::Bool(settings.memory.private_by_default),
        "memory.private_file_paths" => Value::Bool(settings.memory.private_file_paths),
        "memory.private_verification_targets" => {
            Value::Bool(settings.memory.private_verification_targets)
        }
        "memory.record_prompt_placeholders" => {
            Value::Bool(settings.memory.record_prompt_placeholders)
        }
        "memory.observer_mode" => Value::String(settings.memory.observer_mode.as_str().to_string()),
        "memory.observer_queue_size" => Value::Number(settings.memory.observer_queue_size.into()),
        "memory.observer_model" => settings
            .memory
            .observer_model
            .as_ref()
            .map_or(Value::Null, |model| Value::String(model.clone())),
        "session_memory" => serde_json::to_value(&settings.session_memory).unwrap_or(Value::Null),
        "session_memory.enabled" => Value::Bool(settings.session_memory.enabled),
        "session_memory.update_enabled" => Value::Bool(settings.session_memory.update_enabled),
        "session_memory.compact_enabled" => Value::Bool(settings.session_memory.compact_enabled),
        "session_memory.update_interval_turns" => {
            Value::Number(settings.session_memory.update_interval_turns.into())
        }
        "session_memory.init_min_tokens" => {
            Value::Number(settings.session_memory.init_min_tokens.into())
        }
        "session_memory.update_min_token_delta" => {
            Value::Number(settings.session_memory.update_min_token_delta.into())
        }
        "session_memory.tool_call_threshold" => {
            Value::Number(settings.session_memory.tool_call_threshold.into())
        }
        "session_memory.max_update_messages" => {
            Value::Number(settings.session_memory.max_update_messages.into())
        }
        "session_memory.update_max_tokens" => {
            Value::Number(settings.session_memory.update_max_tokens.into())
        }
        "session_memory.compact_min_chars" => {
            Value::Number(settings.session_memory.compact_min_chars.into())
        }
        "session_memory.compact_min_recent_tokens" => {
            Value::Number(settings.session_memory.compact_min_recent_tokens.into())
        }
        "session_memory.compact_max_recent_tokens" => {
            Value::Number(settings.session_memory.compact_max_recent_tokens.into())
        }
        "session_memory.compact_min_recent_messages" => {
            Value::Number(settings.session_memory.compact_min_recent_messages.into())
        }
        "history_directory" | "history.directory" => settings
            .history_directory
            .as_ref()
            .map_or(Value::Null, |p| Value::String(p.display().to_string())),
        "mcp_servers" => serde_json::to_value(&settings.mcp_servers).unwrap_or(Value::Null),
        "tools.profile" => Value::String(settings.tools.profile.as_str().to_string()),
        "tools.luna" => serde_json::to_value(&settings.tools.luna).unwrap_or(Value::Null),
        "tools.file_edit_tool" => Value::String(settings.tools.file_edit_tool.as_str().to_string()),
        "tools.luna.allowed" => Value::Array(
            settings
                .tools
                .luna
                .allowed
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
        "tools.coerce" => serde_json::to_value(&settings.tools.coerce).unwrap_or(Value::Null),
        "tools.coerce.semantic_boolean" => Value::Bool(settings.tools.coerce.semantic_boolean),
        "tools.coerce.semantic_number" => Value::Bool(settings.tools.coerce.semantic_number),
        "tools.coerce.semantic_integer" => Value::Bool(settings.tools.coerce.semantic_integer),
        "tools.coerce.stringify_mismatched_scalar" => {
            Value::Bool(settings.tools.coerce.stringify_mismatched_scalar)
        }
        "skills" => serde_json::to_value(&settings.skills).unwrap_or(Value::Null),
        "skills.auto_skill_review_enabled" => {
            Value::Bool(settings.skills.auto_skill_review_enabled)
        }
        "skills.auto_skill_review_interval" => {
            Value::Number(settings.skills.auto_skill_review_interval.into())
        }
        "skills.auto_curator_enabled" => Value::Bool(settings.skills.auto_curator_enabled),
        "skills.auto_curator_interval_hours" => {
            Value::Number(settings.skills.auto_curator_interval_hours.into())
        }
        "skills.auto_curator_min_idle_hours" => {
            Value::Number(settings.skills.auto_curator_min_idle_hours.into())
        }
        "skills.stale_after_days" => Value::Number(settings.skills.stale_after_days.into()),
        "skills.archive_after_days" => Value::Number(settings.skills.archive_after_days.into()),
        "skills.prune_builtins" => Value::Bool(settings.skills.prune_builtins),
        "skills.trust_external" => Value::Bool(settings.skills.trust_external),
        "skills.auto_lessons_learned" => Value::Bool(settings.skills.auto_lessons_learned),
        "skills.external_dirs" => Value::Array(
            settings
                .skills
                .external_dirs
                .iter()
                .map(|path| Value::String(path.display().to_string()))
                .collect(),
        ),
        "skills.guard" => serde_json::to_value(&settings.skills.guard).unwrap_or(Value::Null),
        "skills.guard.enabled" => Value::Bool(settings.skills.guard.enabled),
        "skills.guard.block_high_risk" => Value::Bool(settings.skills.guard.block_high_risk),
        "skills.guard.block_medium_risk_for_community" => {
            Value::Bool(settings.skills.guard.block_medium_risk_for_community)
        }
        _ => return None,
    };

    Some(redact_config_value_for_display(setting, &value))
}

pub fn update_setting_value(
    setting: &str,
    value: &Value,
    settings: &mut Settings,
) -> Result<ToolSettingUpdate, InvalidToolSettingValue> {
    match setting {
        "model" => {
            let s = coerce_string(value)?;
            if s.trim().is_empty() {
                return Ok(ToolSettingUpdate::EmptyModel);
            }
            settings.model = s;
        }
        "model_reasoning_effort" => {
            settings.model_reasoning_effort = coerce_optional_reasoning_effort(value)?;
        }
        "permission_mode" | "permissions.defaultMode" => {
            let s = coerce_string(value)?;
            let mode = PermissionMode::parse(&s).ok_or_else(|| {
                InvalidToolSettingValue(format!(
                    "invalid permission mode '{}'. Valid options: ask, auto, accept-edits, dont-ask, bypass, yolo",
                    s
                ))
            })?;
            settings.permission_mode = mode;
        }
        "knowledge" => {
            settings.knowledge = serde_json::from_value(value.clone())
                .map_err(|error| InvalidToolSettingValue(format!("invalid knowledge config: {error}")))?;
        }
        "knowledge.enabled" => {
            let enabled = value.as_bool().ok_or_else(|| InvalidToolSettingValue("knowledge.enabled must be a boolean".into()))?;
            settings.knowledge.set_both(enabled);
        }
        "knowledge.retrieval_enabled" => {
            settings.knowledge.retrieval_enabled = Some(value.as_bool().ok_or_else(|| InvalidToolSettingValue("knowledge.retrieval_enabled must be a boolean".into()))?);
        }
        "knowledge.organization_enabled" => {
            settings.knowledge.organization_enabled = Some(value.as_bool().ok_or_else(|| InvalidToolSettingValue("knowledge.organization_enabled must be a boolean".into()))?);
        }
        "auto_memory_enabled" => settings.auto_memory_enabled = coerce_bool(value)?,
        "auto_tool_memory_enabled" => settings.auto_tool_memory_enabled = coerce_bool(value)?,
        "goal_enabled" => settings.goal_enabled = coerce_bool(value)?,
        "auto_skill_review_enabled" => {
            return Ok(ToolSettingUpdate::SkillReviewStartupOnly);
        }
        "auto_skill_review_interval" => {
            settings.auto_skill_review_interval = coerce_usize(value)?.max(1);
        }
        "history_enabled" => settings.history_enabled = coerce_bool(value)?,
        "history_max_messages" => {
            settings.history_max_messages = coerce_usize(value)?.max(1);
        }
        "render_markdown" => settings.render_markdown = coerce_bool(value)?,
        "rich_terminal" => settings.rich_terminal = coerce_bool(value)?,
        "tui" => {
            settings.tui = serde_json::from_value(value.clone())
                .map_err(|e| InvalidToolSettingValue(format!("invalid tui config: {}", e)))?;
        }
        "tui.alternate_screen" => {
            settings.tui.alternate_screen = coerce_tui_alt_screen_mode(value)?;
        }
        "code_theme" => settings.code_theme = coerce_string(value)?,
        "context_window_tokens" => settings.context_window_tokens = Some(coerce_usize(value)?),
        "context_system_tokens" => settings.context_system_tokens = Some(coerce_usize(value)?),
        "context_tools_tokens" => settings.context_tools_tokens = Some(coerce_usize(value)?),
        "context_output_headroom" => settings.context_output_headroom = Some(coerce_usize(value)?),
        "summary_provider" => {
            settings.summary_provider = coerce_optional_setting_text(value)?;
        }
        "summary_profile" => {
            settings.summary_profile = coerce_optional_setting_text(value)?;
        }
        "summary_model" => {
            settings.summary_model = coerce_optional_setting_text(value)?;
        }
        "summary_max_tokens" => settings.summary_max_tokens = coerce_u32(value)?.max(1),
        "goal_pro" => {
            settings.goal_pro = serde_json::from_value::<GoalProSettings>(value.clone())
                .map_err(|e| InvalidToolSettingValue(format!("invalid goal_pro config: {}", e)))?;
            settings.goal_pro.verifier_max_turns = settings.goal_pro.verifier_max_turns.max(1);
            settings.goal_pro.completion_rejection_limit =
                settings.goal_pro.completion_rejection_limit.max(1);
        }
        "goal_pro.verifier_profile" => {
            settings.goal_pro.verifier_profile = coerce_optional_setting_text(value)?;
        }
        "goal_pro.verifier_provider" => {
            settings.goal_pro.verifier_provider = coerce_optional_setting_text(value)?;
        }
        "goal_pro.verifier_model" => {
            settings.goal_pro.verifier_model = coerce_optional_setting_text(value)?;
        }
        "goal_pro.verifier_max_turns" => {
            settings.goal_pro.verifier_max_turns = coerce_usize(value)?.max(1)
        }
        "goal_pro.completion_rejection_limit" => {
            settings.goal_pro.completion_rejection_limit = coerce_usize(value)?.max(1)
        }
        "goal_pro.verification" => {
            settings.goal_pro.verification = serde_json::from_value::<GoalProVerificationSettings>(
                value.clone(),
            )
            .map_err(|error| {
                InvalidToolSettingValue(format!("invalid goal_pro.verification config: {error}"))
            })?;
        }
        "goal_pro.verification.require_tests" => {
            settings.goal_pro.verification.require_tests = coerce_bool(value)?
        }
        "goal_pro.verification.require_behavior_delta" => {
            settings.goal_pro.verification.require_behavior_delta = coerce_bool(value)?
        }
        "goal_pro.verification.minimum_test_scope" => {
            settings.goal_pro.verification.minimum_test_scope =
                serde_json::from_value::<GoalProTestScope>(value.clone()).map_err(|error| {
                    InvalidToolSettingValue(format!(
                        "invalid goal_pro.verification.minimum_test_scope: {error}"
                    ))
                })?;
        }
        "goal_pro.verification.require_raw_exit_code" => {
            settings.goal_pro.verification.require_raw_exit_code = coerce_bool(value)?
        }
        "goal_pro.verification.allow_workspace_changes" => {
            settings.goal_pro.verification.allow_workspace_changes = coerce_bool(value)?
        }
        "goal_pro.verification.isolate_environment" => {
            settings.goal_pro.verification.isolate_environment = coerce_bool(value)?
        }
        "goal_pro.verification.allow_dependency_changes" => {
            settings.goal_pro.verification.allow_dependency_changes = coerce_bool(value)?
        }
        "goal_pro.verification.allow_network_only_failures" => {
            settings.goal_pro.verification.allow_network_only_failures = coerce_bool(value)?
        }
        "max_retries" => settings.max_retries = coerce_usize(value)?,
        "retry_base_delay_ms" => settings.retry_base_delay_ms = coerce_u64(value)?,
        "tool_timeout_ms" => settings.tool_timeout_ms = coerce_u64(value)?,
        "tool_limits.execution_timeout_ms" => {
            settings.tool_limits.execution_timeout_ms = serde_json::from_value(value.clone())
                .map_err(|error| InvalidToolSettingValue(format!("invalid tool execution timeouts: {error}")))?;
        }
        "tool_limits" => {
            settings.tool_limits = serde_json::from_value(value.clone()).map_err(|e| {
                InvalidToolSettingValue(format!("invalid tool_limits config: {}", e))
            })?;
        }
        "tool_limits.foreground_budget_ms" => {
            settings.tool_limits.foreground_budget_ms = serde_json::from_value(value.clone())
                .map_err(|e| {
                    InvalidToolSettingValue(format!(
                        "invalid tool_limits.foreground_budget_ms config: {}",
                        e
                    ))
                })?;
        }
        "tool_limits.foreground_budget_ms.default_ms" => {
            settings.tool_limits.foreground_budget_ms.default_ms = coerce_u64(value)?.max(1);
        }
        "tool_limits.foreground_budget_ms.tools" => {
            settings.tool_limits.foreground_budget_ms.tools = serde_json::from_value(value.clone())
                .map_err(|e| {
                    InvalidToolSettingValue(format!(
                        "invalid tool_limits.foreground_budget_ms.tools config: {}",
                        e
                    ))
                })?;
        }
        "tool_limits.task_output_timeout_ms" => {
            settings.tool_limits.task_output_timeout_ms = serde_json::from_value(value.clone())
                .map_err(|e| {
                    InvalidToolSettingValue(format!(
                        "invalid tool_limits.task_output_timeout_ms config: {}",
                        e
                    ))
                })?;
        }
        "tool_limits.task_output_timeout_ms.default_ms" => {
            settings.tool_limits.task_output_timeout_ms.default_ms = coerce_u64(value)?;
        }
        "tool_limits.task_output_timeout_ms.min_ms" => {
            settings.tool_limits.task_output_timeout_ms.min_ms = coerce_u64(value)?;
        }
        "tool_limits.task_output_timeout_ms.max_ms" => {
            settings.tool_limits.task_output_timeout_ms.max_ms = coerce_u64(value)?;
        }
        "default_subagent_max_turns" | "subagent_max_turns" => {
            settings.default_subagent_max_turns = coerce_usize(value)?.clamp(
                crate::MIN_SUBAGENT_MAX_TURNS,
                crate::MAX_SUBAGENT_MAX_TURNS,
            );
        }
        "allowed_tools" => settings.allowed_tools = coerce_string_array(value)?,
        "denied_tools" => settings.denied_tools = coerce_string_array(value)?,
        "permission_rules" | "permissions.rules" => {
            settings.permission_rules = serde_json::from_value(value.clone())
                .map_err(|e| InvalidToolSettingValue(format!("invalid permission rules: {}", e)))?;
        }
        "memory_directory" | "memory.directory" => {
            settings.memory_directory = coerce_optional_path(value)?;
        }
        "memory" => {
            settings.memory = serde_json::from_value(value.clone())
                .map_err(|e| InvalidToolSettingValue(format!("invalid memory config: {}", e)))?;
        }
        "memory.structured_enabled" => {
            settings.memory.structured_enabled = coerce_bool(value)?;
        }
        "memory.skip_tools" => {
            settings.memory.skip_tools = coerce_string_array(value)?;
        }
        "memory.legacy_prompt_enabled" => {
            settings.memory.legacy_prompt_enabled = coerce_bool(value)?;
        }
        "memory.private_by_default" => {
            settings.memory.private_by_default = coerce_bool(value)?;
        }
        "memory.private_file_paths" => {
            settings.memory.private_file_paths = coerce_bool(value)?;
        }
        "memory.private_verification_targets" => {
            settings.memory.private_verification_targets = coerce_bool(value)?;
        }
        "memory.record_prompt_placeholders" => {
            settings.memory.record_prompt_placeholders = coerce_bool(value)?;
        }
        "memory.observer_mode" => {
            let raw = coerce_string(value)?;
            settings.memory.observer_mode = MemoryObserverMode::parse(&raw).ok_or_else(|| {
                InvalidToolSettingValue(format!(
                    "invalid memory.observer_mode '{}': expected deterministic, disabled, or model",
                    raw
                ))
            })?;
        }
        "memory.observer_queue_size" => {
            settings.memory.observer_queue_size = coerce_usize(value)?.max(1);
        }
        "memory.observer_model" => {
            settings.memory.observer_model = if value.is_null() {
                None
            } else {
                let raw = coerce_string(value)?;
                let trimmed = raw.trim();
                if trimmed.is_empty()
                    || trimmed.eq_ignore_ascii_case("default")
                    || trimmed.eq_ignore_ascii_case("unset")
                    || trimmed.eq_ignore_ascii_case("clear")
                    || trimmed.eq_ignore_ascii_case("null")
                {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            };
        }
        "session_memory" => {
            settings.session_memory = serde_json::from_value(value.clone()).map_err(|e| {
                InvalidToolSettingValue(format!("invalid session_memory config: {}", e))
            })?;
        }
        "session_memory.enabled" => {
            settings.session_memory.enabled = coerce_bool(value)?;
        }
        "session_memory.update_enabled" => {
            settings.session_memory.update_enabled = coerce_bool(value)?;
        }
        "session_memory.compact_enabled" => {
            settings.session_memory.compact_enabled = coerce_bool(value)?;
        }
        "session_memory.update_interval_turns" => {
            settings.session_memory.update_interval_turns = coerce_usize(value)?.max(1);
        }
        "session_memory.init_min_tokens" => {
            settings.session_memory.init_min_tokens = coerce_usize(value)?;
        }
        "session_memory.update_min_token_delta" => {
            settings.session_memory.update_min_token_delta = coerce_usize(value)?;
        }
        "session_memory.tool_call_threshold" => {
            settings.session_memory.tool_call_threshold = coerce_usize(value)?.max(1);
        }
        "session_memory.max_update_messages" => {
            settings.session_memory.max_update_messages = coerce_usize(value)?.max(1);
        }
        "session_memory.update_max_tokens" => {
            settings.session_memory.update_max_tokens = coerce_u32(value)?.max(1);
        }
        "session_memory.compact_min_chars" => {
            settings.session_memory.compact_min_chars = coerce_usize(value)?;
        }
        "session_memory.compact_min_recent_tokens" => {
            settings.session_memory.compact_min_recent_tokens = coerce_usize(value)?;
        }
        "session_memory.compact_max_recent_tokens" => {
            settings.session_memory.compact_max_recent_tokens = coerce_usize(value)?;
        }
        "session_memory.compact_min_recent_messages" => {
            settings.session_memory.compact_min_recent_messages = coerce_usize(value)?;
        }
        "history_directory" | "history.directory" => {
            settings.history_directory = coerce_optional_path(value)?;
        }
        "mcp_servers" => {
            settings.mcp_servers = serde_json::from_value(value.clone()).map_err(|e| {
                InvalidToolSettingValue(format!("invalid MCP server config: {}", e))
            })?;
        }
        "tools.profile" => return Err(InvalidToolSettingValue("tools.profile is startup-only; start a new TUI process or Studio conversation after changing the settings file".into())),
        "tools.luna" => {
            settings.tools.luna = serde_json::from_value(value.clone()).map_err(|e| {
                InvalidToolSettingValue(format!("invalid tools.luna config: {}", e))
            })?;
        }
        "tools.file_edit_tool" => {
            let text = coerce_string(value)?;
            settings.tools.file_edit_tool = serde_json::from_value(Value::String(text.clone()))
                .map_err(|_| {
                    InvalidToolSettingValue(format!(
                        "tools.file_edit_tool must be \"edit\" or \"apply_patch\", got {text:?}"
                    ))
                })?;
        }
        "tools.luna.allowed" => {
            settings.tools.luna.allowed = coerce_string_array(value)?;
        }
        "tools.coerce" => {
            settings.tools.coerce = serde_json::from_value(value.clone()).map_err(|e| {
                InvalidToolSettingValue(format!("invalid tools.coerce config: {}", e))
            })?;
        }
        "tools.coerce.semantic_boolean" => {
            settings.tools.coerce.semantic_boolean = coerce_bool(value)?;
        }
        "tools.coerce.semantic_number" => {
            settings.tools.coerce.semantic_number = coerce_bool(value)?;
        }
        "tools.coerce.semantic_integer" => {
            settings.tools.coerce.semantic_integer = coerce_bool(value)?;
        }
        "tools.coerce.stringify_mismatched_scalar" => {
            settings.tools.coerce.stringify_mismatched_scalar = coerce_bool(value)?;
        }
        "skills" => {
            settings.skills = serde_json::from_value(value.clone())
                .map_err(|e| InvalidToolSettingValue(format!("invalid skills config: {}", e)))?;
        }
        "skills.auto_curator_enabled" => {
            settings.skills.auto_curator_enabled = coerce_bool(value)?;
        }
        "skills.auto_skill_review_enabled" => {
            settings.skills.auto_skill_review_enabled = coerce_bool(value)?;
        }
        "skills.auto_skill_review_interval" => {
            settings.skills.auto_skill_review_interval = coerce_usize(value)?.max(1);
        }
        "skills.auto_curator_interval_hours" => {
            settings.skills.auto_curator_interval_hours = coerce_u64(value)?.max(1);
        }
        "skills.auto_curator_min_idle_hours" => {
            settings.skills.auto_curator_min_idle_hours = coerce_u64(value)?;
        }
        "skills.stale_after_days" => {
            settings.skills.stale_after_days = coerce_u64(value)?;
        }
        "skills.archive_after_days" => {
            settings.skills.archive_after_days = coerce_u64(value)?;
        }
        "skills.prune_builtins" => {
            settings.skills.prune_builtins = coerce_bool(value)?;
        }
        "skills.trust_external" => {
            settings.skills.trust_external = coerce_bool(value)?;
        }
        "skills.auto_lessons_learned" => {
            settings.skills.auto_lessons_learned = coerce_bool(value)?;
        }
        "skills.external_dirs" => {
            settings.skills.external_dirs = coerce_path_array(value)?;
        }
        "skills.guard" => {
            settings.skills.guard = serde_json::from_value(value.clone()).map_err(|e| {
                InvalidToolSettingValue(format!("invalid skills.guard config: {}", e))
            })?;
        }
        "skills.guard.enabled" => {
            settings.skills.guard.enabled = coerce_bool(value)?;
        }
        "skills.guard.block_high_risk" => {
            settings.skills.guard.block_high_risk = coerce_bool(value)?;
        }
        "skills.guard.block_medium_risk_for_community" => {
            settings.skills.guard.block_medium_risk_for_community = coerce_bool(value)?;
        }
        _ => return Ok(ToolSettingUpdate::Unknown),
    }

    Ok(ToolSettingUpdate::Applied)
}

pub fn redact_config_value_for_display(setting: &str, value: &Value) -> Value {
    if is_secret_setting(setting) {
        return Value::String("[redacted]".to_string());
    }
    redact_sensitive_json(value)
}

fn redact_sensitive_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| {
                    if is_sensitive_json_key(key) {
                        (key.clone(), Value::String("[redacted]".to_string()))
                    } else {
                        (key.clone(), redact_sensitive_json(value))
                    }
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(redact_sensitive_json).collect()),
        _ => value.clone(),
    }
}

fn is_sensitive_json_key(key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase().replace(['-', '.'], "_");
    normalized == "authorization"
        || normalized == "secret"
        || normalized == "token"
        || normalized == "password"
        || normalized == "auth_token"
        || normalized == "api_key"
        || normalized.ends_with("_api_key")
        || normalized.ends_with("_token")
        || normalized.ends_with("_secret")
        || normalized.ends_with("_password")
        || normalized.contains("access_token")
        || normalized.contains("refresh_token")
}

fn coerce_string(value: &Value) -> Result<String, InvalidToolSettingValue> {
    match value {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        _ => Err(InvalidToolSettingValue(
            "expected string, number, or boolean value".to_string(),
        )),
    }
}

fn coerce_optional_setting_text(value: &Value) -> Result<Option<String>, InvalidToolSettingValue> {
    if value.is_null() {
        return Ok(None);
    }
    let raw = coerce_string(value)?;
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("default")
        || trimmed.eq_ignore_ascii_case("unset")
        || trimmed.eq_ignore_ascii_case("clear")
        || trimmed.eq_ignore_ascii_case("null")
    {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

fn coerce_bool(value: &Value) -> Result<bool, InvalidToolSettingValue> {
    match value {
        Value::Bool(b) => Ok(*b),
        Value::String(s) => match s.trim().to_lowercase().as_str() {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(InvalidToolSettingValue(format!(
                "cannot coerce '{}' to boolean",
                s
            ))),
        },
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                match i {
                    0 => Ok(false),
                    1 => Ok(true),
                    _ => Err(InvalidToolSettingValue(format!(
                        "cannot coerce number {} to boolean",
                        n
                    ))),
                }
            } else {
                Err(InvalidToolSettingValue(format!(
                    "cannot coerce number {} to boolean",
                    n
                )))
            }
        }
        _ => Err(InvalidToolSettingValue(
            "expected boolean or string 'true'/'false'".to_string(),
        )),
    }
}

fn coerce_optional_reasoning_effort(
    value: &Value,
) -> Result<Option<ReasoningEffort>, InvalidToolSettingValue> {
    if value.is_null() {
        return Ok(None);
    }
    let raw = coerce_string(value)?;
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("default")
        || trimmed.eq_ignore_ascii_case("unset")
        || trimmed.eq_ignore_ascii_case("clear")
    {
        return Ok(None);
    }
    trimmed.parse().map(Some).map_err(|e| {
        InvalidToolSettingValue(format!("invalid model_reasoning_effort '{}': {}", raw, e))
    })
}

fn coerce_tui_alt_screen_mode(value: &Value) -> Result<TuiAltScreenMode, InvalidToolSettingValue> {
    match value {
        Value::Bool(true) => Ok(TuiAltScreenMode::Always),
        Value::Bool(false) => Ok(TuiAltScreenMode::Never),
        _ => {
            let raw = coerce_string(value)?;
            match raw.trim().to_ascii_lowercase().as_str() {
                "auto" => Ok(TuiAltScreenMode::Auto),
                "always" | "true" | "1" | "on" | "yes" => Ok(TuiAltScreenMode::Always),
                "never" | "false" | "0" | "off" | "no" => Ok(TuiAltScreenMode::Never),
                _ => Err(InvalidToolSettingValue(format!(
                    "invalid tui.alternate_screen '{}'. Valid options: auto, always, never",
                    raw
                ))),
            }
        }
    }
}

fn coerce_usize(value: &Value) -> Result<usize, InvalidToolSettingValue> {
    match value {
        Value::Number(n) => n
            .as_u64()
            .and_then(|u| usize::try_from(u).ok())
            .ok_or_else(|| InvalidToolSettingValue(format!("invalid integer value {}", n))),
        Value::String(s) => s
            .parse::<usize>()
            .map_err(|e| InvalidToolSettingValue(format!("invalid integer value '{}': {}", s, e))),
        _ => Err(InvalidToolSettingValue(
            "expected positive integer value".to_string(),
        )),
    }
}

fn coerce_u64(value: &Value) -> Result<u64, InvalidToolSettingValue> {
    match value {
        Value::Number(n) => n
            .as_u64()
            .ok_or_else(|| InvalidToolSettingValue(format!("invalid integer value {}", n))),
        Value::String(s) => s
            .parse::<u64>()
            .map_err(|e| InvalidToolSettingValue(format!("invalid integer value '{}': {}", s, e))),
        _ => Err(InvalidToolSettingValue(
            "expected positive integer value".to_string(),
        )),
    }
}

fn coerce_u32(value: &Value) -> Result<u32, InvalidToolSettingValue> {
    match value {
        Value::Number(n) => n
            .as_u64()
            .and_then(|u| u32::try_from(u).ok())
            .ok_or_else(|| InvalidToolSettingValue(format!("invalid integer value {}", n))),
        Value::String(s) => s
            .parse::<u32>()
            .map_err(|e| InvalidToolSettingValue(format!("invalid integer value '{}': {}", s, e))),
        _ => Err(InvalidToolSettingValue(
            "expected positive integer value".to_string(),
        )),
    }
}

fn coerce_string_array(value: &Value) -> Result<Vec<String>, InvalidToolSettingValue> {
    match value {
        Value::Array(arr) => arr
            .iter()
            .map(|v| match v {
                Value::String(s) => Ok(s.clone()),
                Value::Number(n) => Ok(n.to_string()),
                Value::Bool(b) => Ok(b.to_string()),
                _ => Err(InvalidToolSettingValue(
                    "expected array of strings".to_string(),
                )),
            })
            .collect(),
        _ => Err(InvalidToolSettingValue(
            "expected array of strings".to_string(),
        )),
    }
}

fn coerce_optional_path(
    value: &Value,
) -> Result<Option<std::path::PathBuf>, InvalidToolSettingValue> {
    match value {
        Value::Null => Ok(None),
        Value::String(s) => {
            if s.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(expand_home_path(&std::path::PathBuf::from(s))))
            }
        }
        _ => Err(InvalidToolSettingValue(
            "expected path string or null".to_string(),
        )),
    }
}

fn coerce_path_array(value: &Value) -> Result<Vec<std::path::PathBuf>, InvalidToolSettingValue> {
    match value {
        Value::Array(arr) => arr
            .iter()
            .map(|v| match v {
                Value::String(s) => Ok(expand_home_path(&std::path::PathBuf::from(s))),
                _ => Err(InvalidToolSettingValue(
                    "expected array of path strings".to_string(),
                )),
            })
            .collect(),
        _ => Err(InvalidToolSettingValue(
            "expected array of path strings".to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coerce_bool_accepts_strings() {
        assert!(coerce_bool(&Value::String("true".to_string())).unwrap());
        assert!(!coerce_bool(&Value::String("FALSE".to_string())).unwrap());
        assert!(coerce_bool(&Value::Bool(true)).unwrap());
    }

    #[test]
    fn coerce_u32_accepts_string_numbers() {
        assert_eq!(
            coerce_u32(&Value::String("20000".to_string())).unwrap(),
            20_000
        );
        assert_eq!(coerce_u32(&Value::Number(128.into())).unwrap(), 128);
    }

    #[test]
    fn coerce_path_array_expands_home_prefix() {
        let paths = coerce_path_array(&serde_json::json!(["~/team-skills"])).unwrap();
        let expected = dirs::home_dir()
            .map(|home| home.join("team-skills"))
            .unwrap_or_else(|| std::path::PathBuf::from("~/team-skills"));

        assert_eq!(paths, vec![expected]);
    }
}
