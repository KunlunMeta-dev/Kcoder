use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use tracing::debug;

use crate::{Tool, ToolContext, ToolError, ToolOutput, clean_schema, parse_input};
use kcoder_config::{
    GoalProSettings, GoalProTestScope, GoalProVerificationSettings, MemoryObserverMode,
    PermissionMode, ReasoningEffort, Settings, TuiAltScreenMode, dotted_value, expand_home_path,
    remove_dotted_value, set_dotted_value, update_settings_file,
};

/// Get or set KCoder configuration settings.
#[derive(Debug, Default)]
pub struct ConfigTool;

const SUPPORTED_CONFIG_SETTINGS: &[&str] = &[
    "model",
    "model_reasoning_effort",
    "permission_mode",
    "permissions.defaultMode",
    "auto_memory_enabled",
    "auto_tool_memory_enabled",
    "goal_enabled",
    "auto_skill_review_enabled",
    "auto_skill_review_interval",
    "history_enabled",
    "history_max_messages",
    "render_markdown",
    "rich_terminal",
    "tui",
    "tui.alternate_screen",
    "code_theme",
    "context_window_tokens",
    "context_system_tokens",
    "context_tools_tokens",
    "context_output_headroom",
    "summary_provider",
    "summary_profile",
    "summary_model",
    "summary_max_tokens",
    "goal_pro",
    "goal_pro.verifier_profile",
    "goal_pro.verifier_provider",
    "goal_pro.verifier_model",
    "goal_pro.verifier_max_turns",
    "goal_pro.completion_rejection_limit",
    "goal_pro.verification",
    "goal_pro.verification.require_tests",
    "goal_pro.verification.require_behavior_delta",
    "goal_pro.verification.minimum_test_scope",
    "goal_pro.verification.require_raw_exit_code",
    "goal_pro.verification.allow_workspace_changes",
    "goal_pro.verification.isolate_environment",
    "goal_pro.verification.allow_dependency_changes",
    "goal_pro.verification.allow_network_only_failures",
    "max_retries",
    "retry_base_delay_ms",
    "tool_timeout_ms",
    "tool_limits",
    "tool_limits.foreground_budget_ms",
    "tool_limits.foreground_budget_ms.default_ms",
    "tool_limits.foreground_budget_ms.tools",
    "tool_limits.task_output_timeout_ms",
    "tool_limits.task_output_timeout_ms.default_ms",
    "tool_limits.task_output_timeout_ms.min_ms",
    "tool_limits.task_output_timeout_ms.max_ms",
    "default_subagent_max_turns",
    "subagent_max_turns",
    "allowed_tools",
    "denied_tools",
    "permission_rules",
    "permissions.rules",
    "memory_directory",
    "memory.directory",
    "memory",
    "memory.structured_enabled",
    "memory.skip_tools",
    "memory.legacy_prompt_enabled",
    "memory.private_by_default",
    "memory.private_file_paths",
    "memory.private_verification_targets",
    "memory.record_prompt_placeholders",
    "memory.observer_mode",
    "memory.observer_queue_size",
    "memory.observer_model",
    "session_memory",
    "session_memory.enabled",
    "session_memory.update_enabled",
    "session_memory.compact_enabled",
    "session_memory.update_interval_turns",
    "session_memory.init_min_tokens",
    "session_memory.update_min_token_delta",
    "session_memory.tool_call_threshold",
    "session_memory.max_update_messages",
    "session_memory.update_max_tokens",
    "session_memory.compact_min_chars",
    "session_memory.compact_min_recent_tokens",
    "session_memory.compact_max_recent_tokens",
    "session_memory.compact_min_recent_messages",
    "history_directory",
    "history.directory",
    "mcp_servers",
    "tools.luna",
    "tools.luna.allowed",
    "tools.coerce",
    "tools.coerce.semantic_boolean",
    "tools.coerce.semantic_number",
    "tools.coerce.semantic_integer",
    "tools.coerce.stringify_mismatched_scalar",
    "tools.file_edit_tool",
    "skills",
    "skills.auto_skill_review_enabled",
    "skills.auto_skill_review_interval",
    "skills.auto_curator_enabled",
    "skills.auto_curator_interval_hours",
    "skills.auto_curator_min_idle_hours",
    "skills.stale_after_days",
    "skills.archive_after_days",
    "skills.prune_builtins",
    "skills.trust_external",
    "skills.auto_lessons_learned",
    "skills.external_dirs",
    "skills.guard",
    "skills.guard.enabled",
    "skills.guard.block_high_risk",
    "skills.guard.block_medium_risk_for_community",
];

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConfigAction {
    /// Read or write a value using the existing omit-value/read convention.
    #[default]
    Value,
    /// Discover the authoritative type, enum, and nested property schema.
    Describe,
    /// List supported tool settings, optionally filtered by setting prefix.
    List,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ConfigInput {
    #[serde(default)]
    pub action: ConfigAction,
    /// Dotted setting path; optional prefix for list. Required for value/describe.
    #[serde(default)]
    pub setting: String,
    /// New value for action=value. Omit to read; explicit null retains clear semantics.
    pub value: Option<Value>,
}

#[async_trait]
impl Tool for ConfigTool {
    fn name(&self) -> String {
        "Config".to_string()
    }

    fn description(&self) -> String {
        "Read or update configuration. Omit the value parameter to read, e.g. {\"setting\":\"model\"}; write with {\"setting\":\"permissions.defaultMode\",\"value\":\"yolo\"}. Use action=list to discover supported paths, or action=describe with a setting path to inspect enums, nested properties and write restrictions before changing it. Discovery does not read credentials or change configuration.".into()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(ConfigInput))
    }

    fn is_read_only(&self) -> bool {
        // The actual read-only status depends on the input; this is the conservative default.
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        // `Option<Value>` alone cannot distinguish an omitted field (read) from
        // an explicit JSON null (clear an optional setting). Preserve that
        // distinction before schema-driven deserialization.
        let requested_value = input
            .as_object()
            .and_then(|object| object.get("value"))
            .cloned();
        let input: ConfigInput = parse_input(&input)?;
        let setting = input.setting;
        if matches!(input.action, ConfigAction::Value)
            && setting.is_empty()
            && requested_value.is_none()
        {
            return config_discovery(&ConfigAction::List, "");
        }

        if !matches!(input.action, ConfigAction::Value) {
            if requested_value.is_some() {
                return Err(ToolError::InvalidInput(
                    "Config discovery does not accept value".into(),
                ));
            }
            return config_discovery(&input.action, &setting);
        }

        let debug_value = requested_value
            .as_ref()
            .map(|value| redact_config_value_for_display(&setting, value));
        debug!("config tool: setting={} value={:?}", setting, debug_value);

        if requested_value.is_some() && is_secret_setting(&setting) {
            return Ok(secret_setting_write_output(&setting));
        }

        // The file-edit surface is chosen when the session starts and pinned
        // for the engine's lifetime: GET reports the pinned surface (what the
        // model actually sees) and SET is rejected mid-session.
        if setting == "tools.file_edit_tool" {
            let pinned = ctx.file_edit_surface.as_str();
            if requested_value.is_none() {
                return Ok(ToolOutput::text(format!(
                    "tools.file_edit_tool = {pinned} (pinned for this session)"
                )));
            }
            return Ok(ToolOutput::error(format!(
                "tools.file_edit_tool cannot be switched mid-session: this session is pinned \
                 to `{pinned}`. To use the other file-edit tool, set tools.file_edit_tool in \
                 your settings file and start a new session."
            )));
        }

        let runtime_settings = ctx.runtime_settings.as_ref().ok_or_else(|| {
            ToolError::Execution(
                "Config tool is unavailable because the host did not provide runtime settings"
                    .to_string(),
            )
        })?;
        let Some(value) = requested_value else {
            let settings = runtime_settings
                .read()
                .map_err(|_| ToolError::Execution("runtime settings lock is poisoned".to_string()))?
                .clone();
            return get_setting(&setting, &settings);
        };

        let Some(settings_path) = ctx.settings_persistence_path.clone() else {
            return Ok(ToolOutput::error(
                "Configuration write rejected because this host did not provide an explicit user settings path",
            ));
        };
        if let Some(sandbox) = ctx.sandbox.as_deref()
            && let Err(reason) = sandbox.check_path(&settings_path, true)
        {
            return Ok(ToolOutput::error(format!(
                "Configuration write rejected by the active sandbox: {reason}"
            )));
        }

        let order = ctx.settings_persistence_order.as_ref().ok_or_else(|| {
            ToolError::Execution(
                "Config tool cannot write because the host did not provide a settings transaction lock"
                    .to_string(),
            )
        })?;
        let _transaction = order.lock().await;
        let settings = runtime_settings
            .read()
            .map_err(|_| ToolError::Execution("runtime settings lock is poisoned".to_string()))?
            .clone();

        let mut updated_settings = settings;
        if let Some(output) = apply_setting(&setting, &value, &mut updated_settings)? {
            return Ok(output);
        }
        let persistence_key = canonical_persistence_key(&setting);
        let serialized = serde_json::to_value(&updated_settings).map_err(|error| {
            ToolError::Execution(format!("failed to serialize runtime settings: {error}"))
        })?;
        let persisted_value = dotted_value(&serialized, persistence_key)
            .map_err(|error| {
                ToolError::Execution(format!(
                    "failed to resolve configuration field `{persistence_key}`: {error}"
                ))
            })?
            .filter(|value| !value.is_null())
            .cloned();

        let persisted_key = persistence_key.to_string();
        tokio::task::spawn_blocking(move || {
            update_settings_file(&settings_path, move |document| {
                if let Some(persisted_value) = persisted_value {
                    set_dotted_value(document, &persisted_key, persisted_value)
                } else {
                    remove_dotted_value(document, &persisted_key).map(|_| ())
                }
            })
            .map(|_| ())
        })
        .await
        .map_err(|error| {
            ToolError::Execution(format!("configuration persistence task failed: {error}"))
        })?
        .map_err(|error| {
            ToolError::Execution(format!("failed to persist configuration: {error}"))
        })?;

        // Publish the new runtime value only after the disk commit succeeds, so the UI cannot show a change while the file remains stale.
        *runtime_settings
            .write()
            .map_err(|_| ToolError::Execution("runtime settings lock is poisoned".to_string()))? =
            updated_settings.clone();
        if let Some(observer) = &ctx.runtime_settings_observer {
            observer(&updated_settings);
        }

        Ok(ToolOutput::text(format!(
            "Set {} to {}",
            setting,
            pretty_json(&redact_config_value_for_display(&setting, &value))
        )))
    }
}

fn config_discovery(action: &ConfigAction, setting: &str) -> Result<ToolOutput, ToolError> {
    let settings: Vec<_> = SUPPORTED_CONFIG_SETTINGS
        .iter()
        .filter(|key| {
            setting.is_empty() || **key == setting || key.starts_with(&format!("{setting}."))
        })
        .copied()
        .collect();
    if matches!(action, ConfigAction::List) {
        return Ok(ToolOutput::text(pretty_json(
            &serde_json::json!({"settings": settings}),
        )));
    }
    if !SUPPORTED_CONFIG_SETTINGS.contains(&setting) {
        return Ok(unknown_setting_output(setting));
    }
    let canonical = canonical_persistence_key(setting);
    let startup_only = setting == "auto_skill_review_enabled";
    let schema = if startup_only {
        Some(
            serde_json::json!({"type":"boolean", "description":"Runtime startup switch, not a persisted settings key. Set with --skill-review when starting KCoder."}),
        )
    } else {
        kcoder_config::settings_schema_for_path(canonical)
    };
    let Some(schema) = schema else {
        return Ok(ToolOutput::error(format!(
            "Schema unavailable for {setting}; no shape has been inferred"
        )));
    };
    Ok(ToolOutput::text(pretty_json(&serde_json::json!({
        "setting": setting, "canonical_setting": canonical, "schema": schema,
        "writable_in_current_session": !startup_only && setting != "tools.file_edit_tool" && !is_secret_setting(setting),
        "schema_source": if startup_only { "startup_flag" } else { "settings.schema.jsonc" },
        "note": "Schema describes persisted values, not current values. Parent objects may contain fields outside this tool's supported individual paths; writes still undergo runtime validation."
    }))))
}

fn canonical_persistence_key(setting: &str) -> &str {
    match setting {
        "permissions.defaultMode" => "permission_mode",
        "permissions.rules" => "permission_rules",
        "subagent_max_turns" => "default_subagent_max_turns",
        "memory.directory" => "memory_directory",
        "history.directory" => "history_directory",
        _ => setting,
    }
}

fn is_secret_setting(setting: &str) -> bool {
    let normalized = setting.trim().to_ascii_lowercase().replace(['.', '-'], "_");
    normalized == "api_key" || normalized.ends_with("_api_key")
}

fn secret_setting_write_output(setting: &str) -> ToolOutput {
    ToolOutput::error(format!(
        "{} is a secret setting and cannot be written to settings.json. Use an environment variable, CLI argument, or OS keyring instead.",
        setting
    ))
}

fn get_setting(setting: &str, settings: &Settings) -> Result<ToolOutput, ToolError> {
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
        _ => return Ok(unknown_setting_output(setting)),
    };

    let value = redact_config_value_for_display(setting, &value);
    Ok(ToolOutput::text(format!(
        "{} = {}",
        setting,
        pretty_json(&value)
    )))
}

fn apply_setting(
    setting: &str,
    value: &Value,
    settings: &mut Settings,
) -> Result<Option<ToolOutput>, ToolError> {
    match setting {
        "model" => {
            let s = coerce_string(value)?;
            if s.trim().is_empty() {
                return Ok(Some(ToolOutput::error("model cannot be empty")));
            }
            settings.model = s;
        }
        "model_reasoning_effort" => {
            settings.model_reasoning_effort = coerce_optional_reasoning_effort(value)?;
        }
        "permission_mode" | "permissions.defaultMode" => {
            let s = coerce_string(value)?;
            let mode = PermissionMode::parse(&s).ok_or_else(|| {
                ToolError::InvalidInput(format!(
                    "invalid permission mode '{}'. Valid options: ask, auto, accept-edits, dont-ask, bypass, yolo",
                    s
                ))
            })?;
            settings.permission_mode = mode;
        }
        "auto_memory_enabled" => settings.auto_memory_enabled = coerce_bool(value)?,
        "auto_tool_memory_enabled" => settings.auto_tool_memory_enabled = coerce_bool(value)?,
        "goal_enabled" => settings.goal_enabled = coerce_bool(value)?,
        "auto_skill_review_enabled" => {
            return Ok(Some(ToolOutput::text(
                "auto_skill_review_enabled is startup-only. Restart KCoder with --skill-review."
                    .to_string(),
            )));
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
                .map_err(|e| ToolError::InvalidInput(format!("invalid tui config: {}", e)))?;
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
                .map_err(|e| ToolError::InvalidInput(format!("invalid goal_pro config: {}", e)))?;
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
                ToolError::InvalidInput(format!("invalid goal_pro.verification config: {error}"))
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
                    ToolError::InvalidInput(format!(
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
        "tool_limits" => {
            settings.tool_limits = serde_json::from_value(value.clone()).map_err(|e| {
                ToolError::InvalidInput(format!("invalid tool_limits config: {}", e))
            })?;
        }
        "tool_limits.foreground_budget_ms" => {
            settings.tool_limits.foreground_budget_ms = serde_json::from_value(value.clone())
                .map_err(|e| {
                    ToolError::InvalidInput(format!(
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
                    ToolError::InvalidInput(format!(
                        "invalid tool_limits.foreground_budget_ms.tools config: {}",
                        e
                    ))
                })?;
        }
        "tool_limits.task_output_timeout_ms" => {
            settings.tool_limits.task_output_timeout_ms = serde_json::from_value(value.clone())
                .map_err(|e| {
                    ToolError::InvalidInput(format!(
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
                kcoder_config::MIN_SUBAGENT_MAX_TURNS,
                kcoder_config::MAX_SUBAGENT_MAX_TURNS,
            );
        }
        "allowed_tools" => settings.allowed_tools = coerce_string_array(value)?,
        "denied_tools" => settings.denied_tools = coerce_string_array(value)?,
        "permission_rules" | "permissions.rules" => {
            settings.permission_rules = serde_json::from_value(value.clone())
                .map_err(|e| ToolError::InvalidInput(format!("invalid permission rules: {}", e)))?;
        }
        "memory_directory" | "memory.directory" => {
            settings.memory_directory = coerce_optional_path(value)?;
        }
        "memory" => {
            settings.memory = serde_json::from_value(value.clone())
                .map_err(|e| ToolError::InvalidInput(format!("invalid memory config: {}", e)))?;
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
                ToolError::InvalidInput(format!(
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
                ToolError::InvalidInput(format!("invalid session_memory config: {}", e))
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
                ToolError::InvalidInput(format!("invalid MCP server config: {}", e))
            })?;
        }
        "tools.luna" => {
            settings.tools.luna = serde_json::from_value(value.clone()).map_err(|e| {
                ToolError::InvalidInput(format!("invalid tools.luna config: {}", e))
            })?;
        }
        "tools.file_edit_tool" => {
            let text = coerce_string(value)?;
            settings.tools.file_edit_tool = serde_json::from_value(Value::String(text.clone()))
                .map_err(|_| {
                    ToolError::InvalidInput(format!(
                        "tools.file_edit_tool must be \"edit\" or \"apply_patch\", got {text:?}"
                    ))
                })?;
        }
        "tools.luna.allowed" => {
            settings.tools.luna.allowed = coerce_string_array(value)?;
        }
        "tools.coerce" => {
            settings.tools.coerce = serde_json::from_value(value.clone()).map_err(|e| {
                ToolError::InvalidInput(format!("invalid tools.coerce config: {}", e))
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
                .map_err(|e| ToolError::InvalidInput(format!("invalid skills config: {}", e)))?;
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
                ToolError::InvalidInput(format!("invalid skills.guard config: {}", e))
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
        _ => return Ok(Some(unknown_setting_output(setting))),
    }

    Ok(None)
}

fn redact_config_value_for_display(setting: &str, value: &Value) -> Value {
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

fn pretty_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn supported_settings_list() -> String {
    SUPPORTED_CONFIG_SETTINGS.join(", ")
}

fn unknown_setting_output(setting: &str) -> ToolOutput {
    let quoted_setting = serde_json::to_string(setting).unwrap_or_else(|_| format!("{setting:?}"));
    ToolOutput::error(format!(
        "Unknown setting: {quoted_setting}. Supported settings: {}. To read a \
         setting, omit the value parameter, for example \
         {{\"setting\":\"model\"}}. To write a setting, include value, for \
         example {{\"setting\":\"permissions.defaultMode\",\"value\":\"yolo\"}}.",
        supported_settings_list()
    ))
}

fn coerce_string(value: &Value) -> Result<String, ToolError> {
    match value {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        _ => Err(ToolError::InvalidInput(
            "expected string, number, or boolean value".to_string(),
        )),
    }
}

fn coerce_optional_setting_text(value: &Value) -> Result<Option<String>, ToolError> {
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

fn coerce_bool(value: &Value) -> Result<bool, ToolError> {
    match value {
        Value::Bool(b) => Ok(*b),
        Value::String(s) => match s.trim().to_lowercase().as_str() {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(ToolError::InvalidInput(format!(
                "cannot coerce '{}' to boolean",
                s
            ))),
        },
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                match i {
                    0 => Ok(false),
                    1 => Ok(true),
                    _ => Err(ToolError::InvalidInput(format!(
                        "cannot coerce number {} to boolean",
                        n
                    ))),
                }
            } else {
                Err(ToolError::InvalidInput(format!(
                    "cannot coerce number {} to boolean",
                    n
                )))
            }
        }
        _ => Err(ToolError::InvalidInput(
            "expected boolean or string 'true'/'false'".to_string(),
        )),
    }
}

fn coerce_optional_reasoning_effort(value: &Value) -> Result<Option<ReasoningEffort>, ToolError> {
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
        ToolError::InvalidInput(format!("invalid model_reasoning_effort '{}': {}", raw, e))
    })
}

fn coerce_tui_alt_screen_mode(value: &Value) -> Result<TuiAltScreenMode, ToolError> {
    match value {
        Value::Bool(true) => Ok(TuiAltScreenMode::Always),
        Value::Bool(false) => Ok(TuiAltScreenMode::Never),
        _ => {
            let raw = coerce_string(value)?;
            match raw.trim().to_ascii_lowercase().as_str() {
                "auto" => Ok(TuiAltScreenMode::Auto),
                "always" | "true" | "1" | "on" | "yes" => Ok(TuiAltScreenMode::Always),
                "never" | "false" | "0" | "off" | "no" => Ok(TuiAltScreenMode::Never),
                _ => Err(ToolError::InvalidInput(format!(
                    "invalid tui.alternate_screen '{}'. Valid options: auto, always, never",
                    raw
                ))),
            }
        }
    }
}

fn coerce_usize(value: &Value) -> Result<usize, ToolError> {
    match value {
        Value::Number(n) => n
            .as_u64()
            .and_then(|u| usize::try_from(u).ok())
            .ok_or_else(|| ToolError::InvalidInput(format!("invalid integer value {}", n))),
        Value::String(s) => s
            .parse::<usize>()
            .map_err(|e| ToolError::InvalidInput(format!("invalid integer value '{}': {}", s, e))),
        _ => Err(ToolError::InvalidInput(
            "expected positive integer value".to_string(),
        )),
    }
}

fn coerce_u64(value: &Value) -> Result<u64, ToolError> {
    match value {
        Value::Number(n) => n
            .as_u64()
            .ok_or_else(|| ToolError::InvalidInput(format!("invalid integer value {}", n))),
        Value::String(s) => s
            .parse::<u64>()
            .map_err(|e| ToolError::InvalidInput(format!("invalid integer value '{}': {}", s, e))),
        _ => Err(ToolError::InvalidInput(
            "expected positive integer value".to_string(),
        )),
    }
}

fn coerce_u32(value: &Value) -> Result<u32, ToolError> {
    match value {
        Value::Number(n) => n
            .as_u64()
            .and_then(|u| u32::try_from(u).ok())
            .ok_or_else(|| ToolError::InvalidInput(format!("invalid integer value {}", n))),
        Value::String(s) => s
            .parse::<u32>()
            .map_err(|e| ToolError::InvalidInput(format!("invalid integer value '{}': {}", s, e))),
        _ => Err(ToolError::InvalidInput(
            "expected positive integer value".to_string(),
        )),
    }
}

fn coerce_string_array(value: &Value) -> Result<Vec<String>, ToolError> {
    match value {
        Value::Array(arr) => arr
            .iter()
            .map(|v| match v {
                Value::String(s) => Ok(s.clone()),
                Value::Number(n) => Ok(n.to_string()),
                Value::Bool(b) => Ok(b.to_string()),
                _ => Err(ToolError::InvalidInput(
                    "expected array of strings".to_string(),
                )),
            })
            .collect(),
        _ => Err(ToolError::InvalidInput(
            "expected array of strings".to_string(),
        )),
    }
}

fn coerce_optional_path(value: &Value) -> Result<Option<std::path::PathBuf>, ToolError> {
    match value {
        Value::Null => Ok(None),
        Value::String(s) => {
            if s.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(expand_home_path(&std::path::PathBuf::from(s))))
            }
        }
        _ => Err(ToolError::InvalidInput(
            "expected path string or null".to_string(),
        )),
    }
}

fn coerce_path_array(value: &Value) -> Result<Vec<std::path::PathBuf>, ToolError> {
    match value {
        Value::Array(arr) => arr
            .iter()
            .map(|v| match v {
                Value::String(s) => Ok(expand_home_path(&std::path::PathBuf::from(s))),
                _ => Err(ToolError::InvalidInput(
                    "expected array of path strings".to_string(),
                )),
            })
            .collect(),
        _ => Err(ToolError::InvalidInput(
            "expected array of path strings".to_string(),
        )),
    }
}

#[cfg(test)]
mod file_edit_tool_tests {
    use super::*;

    #[test]
    fn tools_file_edit_tool_round_trips_through_config_tool() {
        assert!(supported_settings_list().contains("tools.file_edit_tool"));
        let mut settings = Settings::default();
        assert_eq!(
            settings.tools.file_edit_tool,
            kcoder_config::FileEditSurface::Edit
        );

        apply_setting(
            "tools.file_edit_tool",
            &serde_json::json!("apply_patch"),
            &mut settings,
        )
        .expect("valid value should apply");
        assert_eq!(
            settings.tools.file_edit_tool,
            kcoder_config::FileEditSurface::ApplyPatch
        );

        let output = get_setting("tools.file_edit_tool", &settings).expect("readable");
        let rendered = output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("");
        assert!(rendered.contains("apply_patch"), "rendered: {rendered}");

        assert!(
            apply_setting(
                "tools.file_edit_tool",
                &serde_json::json!("patch"),
                &mut settings
            )
            .is_err(),
            "unknown surface must be rejected"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_context(
        cwd: &std::path::Path,
        settings: Settings,
        persistence_path: Option<std::path::PathBuf>,
    ) -> ToolContext {
        ToolContext::new(kcoder_state::AppState::new(cwd))
            .with_runtime_settings(std::sync::Arc::new(std::sync::RwLock::new(settings)))
            .with_settings_persistence_path(persistence_path)
            .with_settings_persistence_order(std::sync::Arc::new(tokio::sync::Mutex::new(())))
    }

    #[test]
    fn config_tool_schema_is_object() {
        let tool = ConfigTool;
        let schema = tool.input_schema();
        assert_eq!(schema.get("type").unwrap(), "object");
        assert!(
            !schema
                .get("properties")
                .unwrap()
                .as_object()
                .unwrap()
                .is_empty()
        );
    }

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

    #[test]
    fn config_tool_exposes_summary_settings() {
        let settings = Settings {
            summary_provider: Some("minimax".to_string()),
            summary_model: Some("summary-small".to_string()),
            summary_max_tokens: 12_345,
            ..Settings::default()
        };

        let provider = get_setting("summary_provider", &settings).unwrap();
        let model = get_setting("summary_model", &settings).unwrap();
        let tokens = get_setting("summary_max_tokens", &settings).unwrap();
        let provider_text = provider
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();
        let model_text = model
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();
        let tokens_text = tokens
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();

        assert!(provider_text.contains("minimax"));
        assert!(model_text.contains("summary-small"));
        assert!(tokens_text.contains("12345"));
    }

    #[test]
    fn config_tool_exposes_goal_pro_verifier_settings() {
        let settings = Settings {
            goal_pro: GoalProSettings {
                verifier_profile: Some("mimo-review".to_string()),
                verifier_provider: Some("minimax".to_string()),
                verifier_model: Some("mimo-v2.5".to_string()),
                verifier_models: Vec::new(),
                verifier_max_turns: 6,
                completion_rejection_limit: 5,
                verification: Default::default(),
                model_escalation: Default::default(),
            },
            ..Settings::default()
        };

        assert!(output_text(&get_setting("goal_pro", &settings).unwrap()).contains("mimo-review"));
        assert!(
            output_text(&get_setting("goal_pro.verifier_provider", &settings).unwrap())
                .contains("minimax")
        );
        assert!(
            output_text(&get_setting("goal_pro.verifier_model", &settings).unwrap())
                .contains("mimo-v2.5")
        );
        assert!(supported_settings_list().contains("goal_pro.verifier_max_turns"));
        assert!(supported_settings_list().contains("goal_pro.completion_rejection_limit"));
        assert!(supported_settings_list().contains("goal_pro.verification.minimum_test_scope"));
        assert!(supported_settings_list().contains("goal_pro.verification.require_behavior_delta"));
        assert!(
            output_text(&get_setting("goal_pro.verification.require_tests", &settings).unwrap())
                .contains("true")
        );
        assert!(
            output_text(&get_setting("goal_pro.completion_rejection_limit", &settings).unwrap())
                .contains('5')
        );
        assert!(
            output_text(
                &get_setting("goal_pro.verification.require_behavior_delta", &settings).unwrap()
            )
            .contains("false")
        );

        let mut updated = Settings::default();
        apply_setting(
            "goal_pro.completion_rejection_limit",
            &serde_json::json!(3),
            &mut updated,
        )
        .unwrap();
        assert_eq!(updated.goal_pro.completion_rejection_limit, 3);
        apply_setting(
            "goal_pro.completion_rejection_limit",
            &serde_json::json!(0),
            &mut updated,
        )
        .unwrap();
        assert_eq!(updated.goal_pro.completion_rejection_limit, 1);
    }

    #[test]
    fn config_tool_exposes_model_reasoning_effort() {
        let settings = Settings {
            model_reasoning_effort: Some(ReasoningEffort::High),
            ..Settings::default()
        };

        let output = get_setting("model_reasoning_effort", &settings).unwrap();
        let text = output_text(&output);

        assert!(text.contains("model_reasoning_effort"));
        assert!(text.contains("high"));
        assert!(supported_settings_list().contains("model_reasoning_effort"));
        assert!(
            output_text(&config_discovery(&ConfigAction::List, "").unwrap())
                .contains("model_reasoning_effort")
        );
    }

    #[test]
    fn config_tool_exposes_goal_enabled() {
        let settings = Settings {
            goal_enabled: false,
            ..Settings::default()
        };

        let output = get_setting("goal_enabled", &settings).unwrap();
        let text = output_text(&output);

        assert!(text.contains("goal_enabled"));
        assert!(text.contains("false"));
        assert!(supported_settings_list().contains("goal_enabled"));
        assert!(
            output_text(&config_discovery(&ConfigAction::List, "").unwrap())
                .contains("goal_enabled")
        );
        let removed_setting = format!("{}_enabled", ["lo", "op"].concat());
        assert!(!supported_settings_list().contains(&removed_setting));
        assert!(
            !output_text(&config_discovery(&ConfigAction::List, "").unwrap())
                .contains(&removed_setting)
        );
    }

    #[test]
    fn config_tool_exposes_session_memory_settings() {
        let settings = Settings {
            session_memory: kcoder_config::SessionMemorySettings {
                enabled: true,
                update_enabled: false,
                compact_enabled: true,
                update_interval_turns: 2,
                init_min_tokens: 10,
                update_min_token_delta: 5,
                tool_call_threshold: 3,
                max_update_messages: 9,
                update_max_tokens: 1234,
                compact_min_chars: 40,
                compact_min_recent_tokens: 100,
                compact_max_recent_tokens: 200,
                compact_min_recent_messages: 3,
            },
            ..Settings::default()
        };

        let all = output_text(&get_setting("session_memory", &settings).unwrap());
        let update_enabled =
            output_text(&get_setting("session_memory.update_enabled", &settings).unwrap());
        let max_tokens =
            output_text(&get_setting("session_memory.update_max_tokens", &settings).unwrap());

        assert!(all.contains("compact_min_recent_tokens"));
        assert!(update_enabled.contains("false"));
        assert!(max_tokens.contains("1234"));
        assert!(supported_settings_list().contains("session_memory.compact_enabled"));
    }

    #[test]
    fn config_tool_exposes_tui_alternate_screen() {
        let settings = Settings {
            tui: kcoder_config::TuiSettings {
                alternate_screen: TuiAltScreenMode::Auto,
                ..kcoder_config::TuiSettings::default()
            },
            ..Settings::default()
        };

        let all = output_text(&get_setting("tui", &settings).unwrap());
        let alternate_screen =
            output_text(&get_setting("tui.alternate_screen", &settings).unwrap());

        assert!(all.contains("alternate_screen"));
        assert!(all.contains("auto"));
        assert!(alternate_screen.contains("tui.alternate_screen"));
        assert!(alternate_screen.contains("auto"));
        assert!(supported_settings_list().contains("tui.alternate_screen"));
        assert!(
            output_text(&config_discovery(&ConfigAction::List, "").unwrap())
                .contains("tui.alternate_screen")
        );
        assert_eq!(
            coerce_tui_alt_screen_mode(&Value::String("always".to_string())).unwrap(),
            TuiAltScreenMode::Always
        );
        assert_eq!(
            coerce_tui_alt_screen_mode(&Value::Bool(false)).unwrap(),
            TuiAltScreenMode::Never
        );
    }

    #[test]
    fn config_tool_exposes_memory_settings() {
        let settings = Settings {
            auto_tool_memory_enabled: false,
            memory: kcoder_config::MemorySettings {
                structured_enabled: false,
                skip_tools: vec!["bash".to_string(), "write".to_string()],
                legacy_prompt_enabled: false,
                private_by_default: true,
                private_file_paths: true,
                private_verification_targets: true,
                record_prompt_placeholders: false,
                observer_mode: kcoder_config::MemoryObserverMode::Model,
                observer_queue_size: 64,
                observer_model: Some("observer-mini".to_string()),
            },
            ..Settings::default()
        };

        let auto_tool = output_text(&get_setting("auto_tool_memory_enabled", &settings).unwrap());
        let memory = output_text(&get_setting("memory", &settings).unwrap());
        let structured = output_text(&get_setting("memory.structured_enabled", &settings).unwrap());
        let skip_tools = output_text(&get_setting("memory.skip_tools", &settings).unwrap());
        let legacy_prompt =
            output_text(&get_setting("memory.legacy_prompt_enabled", &settings).unwrap());
        let private = output_text(&get_setting("memory.private_by_default", &settings).unwrap());
        let private_file_paths =
            output_text(&get_setting("memory.private_file_paths", &settings).unwrap());
        let private_targets =
            output_text(&get_setting("memory.private_verification_targets", &settings).unwrap());
        let prompt_placeholders =
            output_text(&get_setting("memory.record_prompt_placeholders", &settings).unwrap());
        let observer_mode = output_text(&get_setting("memory.observer_mode", &settings).unwrap());
        let observer_queue_size =
            output_text(&get_setting("memory.observer_queue_size", &settings).unwrap());
        let observer_model = output_text(&get_setting("memory.observer_model", &settings).unwrap());

        assert!(auto_tool.contains("auto_tool_memory_enabled"));
        assert!(auto_tool.contains("false"));
        assert!(memory.contains("structured_enabled"));
        assert!(memory.contains("skip_tools"));
        assert!(memory.contains("legacy_prompt_enabled"));
        assert!(memory.contains("private_by_default"));
        assert!(memory.contains("private_file_paths"));
        assert!(memory.contains("private_verification_targets"));
        assert!(memory.contains("record_prompt_placeholders"));
        assert!(memory.contains("observer_mode"));
        assert!(memory.contains("observer_queue_size"));
        assert!(memory.contains("observer_model"));
        assert!(structured.contains("false"));
        assert!(skip_tools.contains("bash"));
        assert!(skip_tools.contains("write"));
        assert!(legacy_prompt.contains("false"));
        assert!(private.contains("true"));
        assert!(private_file_paths.contains("true"));
        assert!(private_targets.contains("true"));
        assert!(prompt_placeholders.contains("false"));
        assert!(observer_mode.contains("model"));
        assert!(observer_queue_size.contains("64"));
        assert!(observer_model.contains("observer-mini"));
        for key in [
            "auto_tool_memory_enabled",
            "memory",
            "memory.structured_enabled",
            "memory.skip_tools",
            "memory.legacy_prompt_enabled",
            "memory.private_by_default",
            "memory.private_file_paths",
            "memory.private_verification_targets",
            "memory.record_prompt_placeholders",
            "memory.observer_mode",
            "memory.observer_queue_size",
            "memory.observer_model",
        ] {
            assert!(supported_settings_list().contains(key), "missing {key}");
            assert!(
                output_text(&config_discovery(&ConfigAction::List, "").unwrap()).contains(key),
                "description missing {key}"
            );
        }
    }

    #[test]
    fn config_tool_exposes_tool_coercion_settings() {
        let settings = Settings::default();

        let output = get_setting("tools.coerce.semantic_boolean", &settings).unwrap();
        let text = output_text(&output);

        assert!(text.contains("tools.coerce.semantic_boolean"));
        assert!(text.contains("true"));
        assert!(supported_settings_list().contains("tools.coerce.semantic_boolean"));
        assert!(
            output_text(&config_discovery(&ConfigAction::List, "").unwrap())
                .contains("tools.coerce")
        );
    }

    #[test]
    fn config_tool_exposes_luna_tool_allowlist() {
        let settings = Settings::default();

        let output = get_setting("tools.luna.allowed", &settings).unwrap();
        let text = output_text(&output);

        assert!(text.contains("tools.luna.allowed"));
        assert!(text.contains("read"));
        assert!(text.contains("grep"));
        assert!(supported_settings_list().contains("tools.luna.allowed"));
        assert!(
            output_text(&config_discovery(&ConfigAction::List, "").unwrap())
                .contains("tools.luna.allowed")
        );
    }

    #[test]
    fn config_tool_exposes_named_tool_limits() {
        let settings = Settings::default();

        let limits = output_text(&get_setting("tool_limits", &settings).unwrap());
        let foreground =
            output_text(&get_setting("tool_limits.foreground_budget_ms", &settings).unwrap());
        let task_output =
            output_text(&get_setting("tool_limits.task_output_timeout_ms", &settings).unwrap());

        assert!(limits.contains("doom_loop"));
        assert!(foreground.contains("default_ms"));
        assert!(task_output.contains("max_ms"));
        for key in [
            "tool_limits",
            "tool_limits.foreground_budget_ms",
            "tool_limits.foreground_budget_ms.tools",
            "tool_limits.task_output_timeout_ms",
            "tool_limits.task_output_timeout_ms.max_ms",
        ] {
            assert!(supported_settings_list().contains(key), "missing {key}");
            assert!(
                output_text(&config_discovery(&ConfigAction::List, "").unwrap()).contains(key),
                "description missing {key}"
            );
        }
    }

    #[test]
    fn config_tool_exposes_auto_lessons_learned_setting() {
        let settings = Settings {
            skills: kcoder_config::SkillsSettings {
                auto_lessons_learned: true,
                ..kcoder_config::SkillsSettings::default()
            },
            ..Settings::default()
        };
        let output = get_setting("skills.auto_lessons_learned", &settings).unwrap();
        let text = output_text(&output);

        assert!(text.contains("skills.auto_lessons_learned"));
        assert!(text.contains("true"));
        assert!(supported_settings_list().contains("skills.auto_lessons_learned"));
        assert!(
            output_text(&config_discovery(&ConfigAction::List, "").unwrap())
                .contains("skills.auto_lessons_learned")
        );
    }

    #[test]
    fn config_tool_exposes_persistent_skill_review_settings() {
        let settings = Settings {
            skills: kcoder_config::SkillsSettings {
                auto_skill_review_enabled: true,
                auto_skill_review_interval: 12,
                ..kcoder_config::SkillsSettings::default()
            },
            ..Settings::default()
        };

        let enabled =
            output_text(&get_setting("skills.auto_skill_review_enabled", &settings).unwrap());
        let interval =
            output_text(&get_setting("skills.auto_skill_review_interval", &settings).unwrap());

        assert!(enabled.contains("skills.auto_skill_review_enabled"));
        assert!(enabled.contains("true"));
        assert!(interval.contains("skills.auto_skill_review_interval"));
        assert!(interval.contains("12"));
        assert!(supported_settings_list().contains("skills.auto_skill_review_enabled"));
        assert!(supported_settings_list().contains("skills.auto_skill_review_interval"));
        assert!(
            output_text(&config_discovery(&ConfigAction::List, "").unwrap())
                .contains("skills.auto_skill_review_enabled")
        );
    }

    #[test]
    fn config_tool_exposes_skill_lifecycle_governance_settings() {
        let settings = Settings {
            skills: kcoder_config::SkillsSettings {
                auto_curator_enabled: true,
                auto_curator_interval_hours: 24,
                auto_curator_min_idle_hours: 3,
                stale_after_days: 14,
                archive_after_days: 45,
                prune_builtins: true,
                trust_external: true,
                external_dirs: vec![std::path::PathBuf::from("/team/skills")],
                guard: kcoder_config::SkillGuardSettings {
                    enabled: true,
                    block_high_risk: true,
                    block_medium_risk_for_community: false,
                },
                ..kcoder_config::SkillsSettings::default()
            },
            ..Settings::default()
        };

        let enabled = output_text(&get_setting("skills.auto_curator_enabled", &settings).unwrap());
        let interval =
            output_text(&get_setting("skills.auto_curator_interval_hours", &settings).unwrap());
        let min_idle =
            output_text(&get_setting("skills.auto_curator_min_idle_hours", &settings).unwrap());
        let stale = output_text(&get_setting("skills.stale_after_days", &settings).unwrap());
        let archive = output_text(&get_setting("skills.archive_after_days", &settings).unwrap());
        let prune = output_text(&get_setting("skills.prune_builtins", &settings).unwrap());
        let trust = output_text(&get_setting("skills.trust_external", &settings).unwrap());
        let dirs = output_text(&get_setting("skills.external_dirs", &settings).unwrap());
        let guard = output_text(
            &get_setting("skills.guard.block_medium_risk_for_community", &settings).unwrap(),
        );

        assert!(enabled.contains("skills.auto_curator_enabled"));
        assert!(enabled.contains("true"));
        assert!(interval.contains("24"));
        assert!(min_idle.contains("3"));
        assert!(stale.contains("14"));
        assert!(archive.contains("45"));
        assert!(prune.contains("true"));
        assert!(trust.contains("true"));
        assert!(dirs.contains("/team/skills"));
        assert!(guard.contains("false"));
        for key in [
            "skills.auto_curator_enabled",
            "skills.auto_curator_interval_hours",
            "skills.auto_curator_min_idle_hours",
            "skills.stale_after_days",
            "skills.archive_after_days",
            "skills.prune_builtins",
            "skills.trust_external",
            "skills.external_dirs",
            "skills.guard",
            "skills.guard.enabled",
            "skills.guard.block_high_risk",
            "skills.guard.block_medium_risk_for_community",
        ] {
            assert!(supported_settings_list().contains(key), "missing {key}");
            assert!(
                output_text(&config_discovery(&ConfigAction::List, "").unwrap()).contains(key),
                "description missing {key}"
            );
        }
    }

    #[test]
    fn config_tool_unknown_setting_reports_supported_keys() {
        let settings = Settings::default();
        let output = get_setting("theme", &settings).unwrap();
        let text = output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();

        assert!(output.is_error);
        assert!(text.contains("Unknown setting"));
        assert!(text.contains("model"));
        assert!(text.contains("permissions.defaultMode"));
        assert!(text.contains(r#"{"setting":"model"}"#));
    }

    #[test]
    fn config_tool_description_lists_supported_shape() {
        let description = ConfigTool.description();

        assert!(description.contains(r#"{"setting":"model"}"#));
        assert!(description.contains(r#"{"setting":"permissions.defaultMode","value":"yolo"}"#));
        assert!(description.contains("action=describe"));
        assert!(description.contains("Omit the value parameter"));
    }

    #[test]
    fn secret_settings_are_detected() {
        assert!(is_secret_setting("api_key"));
        assert!(is_secret_setting("openai_api_key"));
        assert!(is_secret_setting("anthropic.api-key"));
        assert!(!is_secret_setting("openai_base_url"));
        assert!(!is_secret_setting("mcp_servers"));
    }

    #[test]
    fn config_tool_rejects_secret_setting_writes() {
        let output = secret_setting_write_output("openai_api_key");
        let text = output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();

        assert!(output.is_error);
        assert!(text.contains("secret setting"));
        assert!(text.contains("environment variable"));
    }

    #[tokio::test]
    async fn config_tool_rejects_persistent_writes_outside_active_sandbox() {
        let workspace = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        let settings_path = user.path().join("settings.json");
        let sandbox = crate::Sandbox::new(
            workspace.path(),
            kcoder_types::SandboxConfig {
                enabled: true,
                allowed_paths: vec![workspace.path().display().to_string()],
                ..Default::default()
            },
        );
        let context = config_context(
            workspace.path(),
            Settings::default(),
            Some(settings_path.clone()),
        )
        .with_sandbox(std::sync::Arc::new(sandbox));

        let output = ConfigTool
            .call(
                serde_json::json!({
                    "setting": "goal_pro.verifier_max_turns",
                    "value": 999
                }),
                &context,
            )
            .await
            .unwrap();
        let text = output_text(&output);

        assert!(output.is_error, "{text}");
        assert!(text.contains("Configuration write rejected"), "{text}");
        assert!(text.contains("sandbox"), "{text}");
        assert!(!settings_path.exists());
    }

    #[tokio::test]
    async fn config_tool_rejects_writes_without_explicit_user_path() {
        let workspace = tempfile::tempdir().unwrap();
        let context = config_context(workspace.path(), Settings::default(), None);

        let output = ConfigTool
            .call(
                serde_json::json!({"setting": "render_markdown", "value": false}),
                &context,
            )
            .await
            .unwrap();
        let text = output_text(&output);

        assert!(output.is_error, "{text}");
        assert!(text.contains("explicit user settings path"), "{text}");
        assert!(
            context
                .runtime_settings
                .as_ref()
                .unwrap()
                .read()
                .unwrap()
                .render_markdown
        );
        assert!(!workspace.path().join("settings.json").exists());
        assert!(
            !workspace
                .path()
                .join(".config/kcoder/settings.json")
                .exists()
        );
    }

    #[tokio::test]
    async fn config_tool_reads_runtime_settings_and_persists_only_changed_user_field() {
        let workspace = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        let settings_path = user.path().join("settings.json");
        std::fs::write(
            &settings_path,
            r#"{
  "goal_pro": { "verifier_max_turns": 16 }
}"#,
        )
        .unwrap();

        // Simulate a merged project-layer value of 99; the user layer must retain its explicitly declared 16.
        let mut effective = Settings::default();
        effective.goal_pro.verifier_max_turns = 99;
        effective.model = "project-only-model".to_string();
        effective.render_markdown = true;
        let context = config_context(workspace.path(), effective, Some(settings_path.clone()));

        let read = ConfigTool
            .call(
                serde_json::json!({"setting": "goal_pro.verifier_max_turns"}),
                &context,
            )
            .await
            .unwrap();
        assert!(output_text(&read).contains("99"));

        let write = ConfigTool
            .call(
                serde_json::json!({"setting": "render_markdown", "value": false}),
                &context,
            )
            .await
            .unwrap();
        assert!(!write.is_error, "{}", output_text(&write));

        let document: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
        assert_eq!(document["goal_pro"]["verifier_max_turns"], 16);
        assert_eq!(document["render_markdown"], false);
        assert!(document.get("model").is_none());
        assert!(document.get("permission_mode").is_none());

        let runtime = context.runtime_settings.as_ref().unwrap().read().unwrap();
        assert_eq!(runtime.goal_pro.verifier_max_turns, 99);
        assert!(!runtime.render_markdown);
    }

    #[tokio::test]
    async fn config_tool_persists_goal_pro_completion_rejection_limit() {
        let workspace = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        let settings_path = user.path().join("settings.json");
        std::fs::write(&settings_path, "{}").unwrap();
        let context = config_context(
            workspace.path(),
            Settings::default(),
            Some(settings_path.clone()),
        );

        for (input, expected) in [(3, 3), (0, 1)] {
            let output = ConfigTool
                .call(
                    serde_json::json!({
                        "setting": "goal_pro.completion_rejection_limit",
                        "value": input
                    }),
                    &context,
                )
                .await
                .unwrap();
            assert!(!output.is_error, "{}", output_text(&output));

            let document: Value =
                serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
            assert_eq!(document["goal_pro"]["completion_rejection_limit"], expected);
            assert_eq!(
                context
                    .runtime_settings
                    .as_ref()
                    .unwrap()
                    .read()
                    .unwrap()
                    .goal_pro
                    .completion_rejection_limit,
                expected
            );
        }
    }

    #[tokio::test]
    async fn config_tool_clears_optional_user_field_without_materializing_effective_settings() {
        let workspace = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        let settings_path = user.path().join("settings.json");
        std::fs::write(
            &settings_path,
            r#"{
  "goal_pro": { "verifier_max_turns": 16 },
  "model_reasoning_effort": "high"
}"#,
        )
        .unwrap();
        let effective = Settings {
            model_reasoning_effort: Some(ReasoningEffort::High),
            model: "project-only-model".to_string(),
            ..Settings::default()
        };
        let context = config_context(workspace.path(), effective, Some(settings_path.clone()));

        let read = ConfigTool
            .call(
                serde_json::json!({"setting": "model_reasoning_effort"}),
                &context,
            )
            .await
            .unwrap();
        assert!(output_text(&read).contains("high"));
        assert_eq!(
            serde_json::from_str::<Value>(&std::fs::read_to_string(&settings_path).unwrap())
                .unwrap()["model_reasoning_effort"],
            "high"
        );

        let output = ConfigTool
            .call(
                serde_json::json!({"setting": "model_reasoning_effort", "value": null}),
                &context,
            )
            .await
            .unwrap();
        assert!(!output.is_error, "{}", output_text(&output));

        let document: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
        assert!(document.get("model_reasoning_effort").is_none());
        assert_eq!(document["goal_pro"]["verifier_max_turns"], 16);
        assert!(document.get("model").is_none());
        assert!(
            context
                .runtime_settings
                .as_ref()
                .unwrap()
                .read()
                .unwrap()
                .model_reasoning_effort
                .is_none()
        );
    }

    #[tokio::test]
    async fn config_tool_serializes_concurrent_runtime_updates_and_refreshes_observer() {
        let workspace = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        let settings_path = user.path().join("settings.json");
        let observed = std::sync::Arc::new(std::sync::RwLock::new(Settings::default()));
        let context = config_context(
            workspace.path(),
            Settings::default(),
            Some(settings_path.clone()),
        )
        .with_runtime_settings_observer({
            let observed = std::sync::Arc::clone(&observed);
            std::sync::Arc::new(move |settings| {
                *observed.write().unwrap() = settings.clone();
            })
        });

        let first_context = context.clone();
        let second_context = context.clone();
        let (first, second) = tokio::join!(
            ConfigTool.call(
                serde_json::json!({"setting": "render_markdown", "value": false}),
                &first_context,
            ),
            ConfigTool.call(
                serde_json::json!({"setting": "allowed_tools", "value": ["write"]}),
                &second_context,
            )
        );
        assert!(!first.unwrap().is_error);
        assert!(!second.unwrap().is_error);

        let runtime = context.runtime_settings.as_ref().unwrap().read().unwrap();
        assert!(!runtime.render_markdown);
        assert_eq!(runtime.allowed_tools, vec!["write"]);
        let observed = observed.read().unwrap();
        assert!(!observed.render_markdown);
        assert_eq!(observed.allowed_tools, vec!["write"]);
        let document: Value =
            serde_json::from_str(&std::fs::read_to_string(settings_path).unwrap()).unwrap();
        assert_eq!(document["render_markdown"], false);
        assert_eq!(document["allowed_tools"], serde_json::json!(["write"]));
    }

    #[test]
    fn mcp_server_env_secrets_are_redacted_on_read() {
        let settings = Settings {
            mcp_servers: vec![kcoder_types::McpServerConfig {
                name: "internal".to_string(),
                transport: "stdio".to_string(),
                command: "mcp-server".to_string(),
                args: vec![],
                url: String::new(),
                env: [
                    ("OPENAI_API_KEY".to_string(), "sk-secret-value".to_string()),
                    ("PUBLIC_FLAG".to_string(), "visible".to_string()),
                ]
                .into_iter()
                .collect(),
                headers: std::collections::HashMap::new(),
            }],
            ..Settings::default()
        };

        let output = get_setting("mcp_servers", &settings).unwrap();
        let text = output_text(&output);

        assert!(text.contains("OPENAI_API_KEY"));
        assert!(text.contains("[redacted]"));
        assert!(text.contains("PUBLIC_FLAG"));
        assert!(text.contains("visible"));
        assert!(!text.contains("sk-secret-value"));
    }

    #[test]
    fn mcp_server_env_secrets_are_redacted_in_write_echo() {
        let value = serde_json::json!([
            {
                "name": "internal",
                "transport": "stdio",
                "command": "mcp-server",
                "env": {
                    "AUTHORIZATION": "Bearer secret-token",
                    "ACCESS_TOKEN": "token-value",
                    "PUBLIC_FLAG": "visible"
                }
            }
        ]);

        let redacted = redact_config_value_for_display("mcp_servers", &value);
        let text = pretty_json(&redacted);

        assert!(text.contains("AUTHORIZATION"));
        assert!(text.contains("ACCESS_TOKEN"));
        assert!(text.contains("[redacted]"));
        assert!(text.contains("PUBLIC_FLAG"));
        assert!(text.contains("visible"));
        assert!(!text.contains("Bearer secret-token"));
        assert!(!text.contains("token-value"));
    }

    #[test]
    fn mcp_server_header_secrets_are_redacted_on_read() {
        // Redact sensitive keys in HTTP transport headers such as Authorization through the same general path as env.
        let settings = Settings {
            mcp_servers: vec![kcoder_types::McpServerConfig {
                name: "remote".to_string(),
                transport: "http".to_string(),
                command: String::new(),
                args: vec![],
                url: "https://example.com/mcp".to_string(),
                env: std::collections::HashMap::new(),
                headers: [(
                    "Authorization".to_string(),
                    "Bearer secret-token".to_string(),
                )]
                .into_iter()
                .collect(),
            }],
            ..Settings::default()
        };

        let output = get_setting("mcp_servers", &settings).unwrap();
        let text = output_text(&output);

        assert!(text.contains("Authorization"));
        assert!(text.contains("[redacted]"));
        assert!(!text.contains("secret-token"));
    }

    fn output_text(output: &ToolOutput) -> String {
        output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>()
    }

    #[tokio::test]
    async fn config_tool_rejects_mid_session_file_edit_tool_switches() {
        let workspace = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        settings.tools.file_edit_tool = kcoder_config::FileEditSurface::ApplyPatch;
        let context = config_context(workspace.path(), settings, None)
            .with_file_edit_surface(kcoder_config::FileEditSurface::ApplyPatch);

        let output = ConfigTool
            .call(
                serde_json::json!({
                    "setting": "tools.file_edit_tool",
                    "value": "edit"
                }),
                &context,
            )
            .await
            .unwrap();
        let text = output_text(&output);

        assert!(output.is_error, "{text}");
        assert!(text.contains("cannot be switched mid-session"), "{text}");
        assert!(text.contains("apply_patch"), "{text}");
        let live = context
            .runtime_settings
            .as_ref()
            .unwrap()
            .read()
            .unwrap()
            .tools
            .file_edit_tool;
        assert_eq!(
            live,
            kcoder_config::FileEditSurface::ApplyPatch,
            "the live setting must stay untouched"
        );
    }

    #[tokio::test]
    async fn config_tool_reports_the_pinned_file_edit_surface() {
        let workspace = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        settings.tools.file_edit_tool = kcoder_config::FileEditSurface::Edit;
        // The session pin says apply_patch even though the live setting says
        // edit; GET must report what the model actually sees.
        let context = config_context(workspace.path(), settings, None)
            .with_file_edit_surface(kcoder_config::FileEditSurface::ApplyPatch);

        let output = ConfigTool
            .call(
                serde_json::json!({ "setting": "tools.file_edit_tool" }),
                &context,
            )
            .await
            .unwrap();
        let text = output_text(&output);

        assert!(!output.is_error, "{text}");
        assert!(text.contains("apply_patch"), "{text}");
    }
}

#[cfg(test)]
mod discovery_tests {
    use super::*;
    fn json(output: ToolOutput) -> Value {
        let text = output
            .content
            .iter()
            .filter_map(|b| {
                if let kcoder_types::ContentBlock::Text { text } = b {
                    Some(text.as_str())
                } else {
                    None
                }
            })
            .collect::<String>();
        serde_json::from_str(&text).unwrap()
    }
    #[test]
    fn discovers_enums_and_nested_shapes_without_runtime_settings() {
        let permission =
            json(config_discovery(&ConfigAction::Describe, "permissions.defaultMode").unwrap());
        assert_eq!(permission["canonical_setting"], "permission_mode");
        assert!(
            permission["schema"]["enum"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!("ask"))
        );
        let verification =
            json(config_discovery(&ConfigAction::Describe, "goal_pro.verification").unwrap());
        assert_eq!(
            verification["schema"]["properties"]["require_tests"]["type"],
            "boolean"
        );
        assert!(verification["schema"]["properties"]["minimum_test_scope"].is_object());
        let pinned =
            json(config_discovery(&ConfigAction::Describe, "tools.file_edit_tool").unwrap());
        assert_eq!(pinned["writable_in_current_session"], false);
    }
    #[test]
    fn every_supported_setting_is_describable() {
        for setting in SUPPORTED_CONFIG_SETTINGS {
            let result = config_discovery(&ConfigAction::Describe, setting).unwrap();
            assert!(!result.is_error, "{setting}");
            assert!(json(result)["schema"].is_object(), "{setting}");
        }
    }
    #[tokio::test]
    async fn discovery_works_without_runtime_or_mutation_access() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()));
        let listed = ConfigTool.call(serde_json::json!({}), &ctx).await.unwrap();
        assert!(json(listed)["settings"].as_array().unwrap().len() > 10);
        let result = ConfigTool
            .call(
                serde_json::json!({"action":"describe","setting":"permission_mode"}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(json(result)["schema"]["enum"].is_array());
        assert!(matches!(
            ConfigTool
                .call(serde_json::json!({"action":"list","value":true}), &ctx)
                .await,
            Err(ToolError::InvalidInput(_))
        ));
    }
    #[test]
    fn lists_only_supported_paths_and_rejects_unknown_descriptions() {
        let result = json(config_discovery(&ConfigAction::List, "goal_pro.verification").unwrap());
        assert!(
            result["settings"]
                .as_array()
                .unwrap()
                .iter()
                .all(|s| s.as_str().unwrap().starts_with("goal_pro.verification"))
        );
        assert!(
            config_discovery(&ConfigAction::Describe, "providers.arbitrary.password")
                .unwrap()
                .is_error
        );
    }
}
