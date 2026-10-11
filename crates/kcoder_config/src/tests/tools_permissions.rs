use super::*;

#[test]
fn tool_profile_defaults_and_schema_agree() {
    assert_eq!(Settings::default().tools.profile, ToolProfile::Full);
    assert_eq!(
        serde_json::from_str::<ToolsSettings>("{}").unwrap().profile,
        ToolProfile::Full
    );
    let embedded: serde_json::Value = jsonc_parser::parse_to_serde_value(
        include_str!("../../settting_inline.jsonc"),
        &Default::default(),
    )
    .unwrap();
    assert_eq!(embedded["tools"]["profile"], "full");
    let schema = crate::settings_schema_for_path("tools.profile").unwrap();
    assert_eq!(schema["default"], "full");
    assert_eq!(
        schema["enum"],
        serde_json::json!(["full", "core", "nano", "none"])
    );
    for (value, expected) in [
        ("full", ToolProfile::Full),
        ("core", ToolProfile::Core),
        ("nano", ToolProfile::Nano),
        ("none", ToolProfile::None),
    ] {
        let parsed: ToolProfile = serde_json::from_value(serde_json::json!(value)).unwrap();
        assert_eq!(parsed, expected);
        assert_eq!(parsed.as_str(), value);
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        crate::schema::validate_settings_schema(&serde_json::json!({"tools":{"profile":value}}))
            .unwrap();
    }
    for invalid in ["auto", "minimal", "CORE"] {
        assert!(serde_json::from_value::<ToolProfile>(serde_json::json!(invalid)).is_err());
        assert!(
            crate::schema::validate_settings_schema(
                &serde_json::json!({"tools":{"profile":invalid}})
            )
            .is_err()
        );
    }
}

#[test]
fn permission_mode_parsing() {
    assert_eq!(PermissionMode::parse("auto"), Some(PermissionMode::Auto));
    assert_eq!(
        PermissionMode::parse("accept-edits"),
        Some(PermissionMode::AcceptEdits)
    );
    assert_eq!(
        PermissionMode::parse("accept_edits"),
        Some(PermissionMode::AcceptEdits)
    );
    assert_eq!(PermissionMode::parse("yolo"), Some(PermissionMode::Yolo));
    assert_eq!(PermissionMode::parse("BOGUS"), None);
}

#[test]
fn default_permission_mode_is_ask() {
    assert_eq!(PermissionMode::default(), PermissionMode::Ask);
    assert_eq!(Settings::default().permission_mode, PermissionMode::Ask);
}

#[test]
fn default_shell_timeout_and_foreground_budget_are_five_minutes() {
    let settings = Settings::default();

    assert_eq!(settings.tool_timeout_ms, 300_000);
    assert_eq!(
        settings.tool_limits.foreground_budget_ms.for_tool("bash"),
        300_000
    );
    assert_eq!(
        settings.tool_limits.task_output_timeout_ms.default_ms,
        5_000
    );
}

#[test]
fn obsolete_tool_timeout_cap_is_not_serialized() {
    let value = serde_json::to_value(Settings::default()).unwrap();

    assert!(value.get("max_tool_timeout_ms").is_none());
}

#[test]
fn default_tool_output_keeps_sixty_kib_head_and_forty_kib_tail() {
    let settings = Settings::default();

    assert_eq!(settings.max_tool_output_bytes, 100 * 1024);
    assert_eq!(settings.tool_limits.doom_loop.default_repetitions, 6);
    assert_eq!(settings.tool_limits.permission_denials.consecutive_limit, 2);
    assert_eq!(
        settings.tool_limits.doom_loop.tools.get("TaskOutput"),
        Some(&-1)
    );
    assert_eq!(settings.tool_output_head_bytes, 60 * 1024);
    assert_eq!(settings.tool_output_tail_bytes, 40 * 1024);
}

#[test]
fn permission_denial_limit_parses_and_never_normalizes_below_one() {
    let mut settings: Settings =
        serde_json::from_str(r#"{"tool_limits":{"permission_denials":{"consecutive_limit":0}}}"#)
            .unwrap();
    settings.normalize_runtime_limits();

    assert_eq!(settings.tool_limits.permission_denials.consecutive_limit, 1);
}

#[test]
fn bash_foreground_budget_can_be_overridden_from_config() {
    let settings: Settings = serde_json::from_str(
            r#"{"tool_timeout_ms":90000,"tool_limits":{"doom_loop":{"default_repetitions":8,"tools":{"TaskOutput":12,"Workflow":20}},"foreground_budget_ms":{"default_ms":2500,"tools":{"bash":1800,"PowerShell":2200}},"task_output_timeout_ms":{"default_ms":8000,"min_ms":2000,"max_ms":60000}}}"#,
        )
        .unwrap();

    assert_eq!(settings.tool_timeout_ms, 90_000);
    assert_eq!(
        settings.tool_limits.foreground_budget_ms.for_tool("bash"),
        1_800
    );
    assert_eq!(
        settings
            .tool_limits
            .foreground_budget_ms
            .for_tool("other-tool"),
        2_500
    );
    assert_eq!(
        settings.tool_limits.task_output_timeout_ms.default_ms,
        8_000
    );
    assert_eq!(settings.tool_limits.task_output_timeout_ms.min_ms, 2_000);
    assert_eq!(settings.tool_limits.task_output_timeout_ms.max_ms, 60_000);
    assert_eq!(settings.tool_limits.doom_loop.default_repetitions, 8);
    assert_eq!(
        settings.tool_limits.doom_loop.tools.get("TaskOutput"),
        Some(&12)
    );
    assert_eq!(
        settings.tool_limits.doom_loop.tools.get("Workflow"),
        Some(&20)
    );
}

#[test]
fn tools_disabled_patterns_parse_from_settings_json() {
    let settings: Settings =
        serde_json::from_str(r#"{"tools":{"disabled":["Spec*","memory_*","LocalMemoryRecall"]}}"#)
            .unwrap();

    assert_eq!(
        settings.tools.disabled,
        vec!["Spec*", "memory_*", "LocalMemoryRecall"]
    );
    assert!(Settings::default().tools.disabled.is_empty());
}

#[test]
fn tdd_gate_setting_parses_and_defaults_to_auto() {
    assert_eq!(Settings::default().tdd_gate, TddGateSetting::Auto);
    let settings: Settings = serde_json::from_str(r#"{"tdd_gate":"off"}"#).unwrap();
    assert_eq!(settings.tdd_gate, TddGateSetting::Off);
    let settings: Settings = serde_json::from_str(r#"{"tdd_gate":"preferred"}"#).unwrap();
    assert_eq!(settings.tdd_gate, TddGateSetting::Preferred);
    let settings: Settings = serde_json::from_str(r#"{"tdd_gate":"required"}"#).unwrap();
    assert_eq!(settings.tdd_gate, TddGateSetting::Required);
}

#[test]
fn luna_tool_profile_defaults_to_a_small_platform_specific_allowlist() {
    let allowed = Settings::default().tools.luna.allowed;

    assert_eq!(allowed.len(), 20);
    for required in [
        "glob",
        "grep",
        "read",
        "edit",
        "write",
        "TaskOutput",
        "TaskStop",
        "skill",
        "TodoWrite",
        "spawn_agent",
        "SendMessage",
        "wait",
        "close_agent",
        "WebSearch",
        "WebFetch",
        "DiscoverSkills",
        "explore_agent",
        "ocr",
        "Workflow",
    ] {
        assert!(allowed.iter().any(|name| name == required));
    }
    if cfg!(windows) {
        assert!(allowed.iter().any(|name| name == "PowerShell"));
        assert!(!allowed.iter().any(|name| name == "bash"));
    } else {
        assert!(allowed.iter().any(|name| name == "bash"));
        assert!(!allowed.iter().any(|name| name == "PowerShell"));
    }
}

#[test]
fn luna_tool_profile_can_be_overridden_from_settings_json() {
    let settings: Settings =
        serde_json::from_str(r#"{"tools":{"luna":{"allowed":["read","grep"]}}}"#).unwrap();

    assert_eq!(settings.tools.luna.allowed, vec!["read", "grep"]);
}

#[test]
fn auto_tool_memory_defaults_to_enabled_for_old_configs() {
    let settings: Settings = serde_json::from_str("{}").unwrap();
    assert!(settings.auto_memory_enabled);
    assert!(settings.auto_tool_memory_enabled);
    assert!(settings.memory.structured_enabled);
    assert!(settings.memory.skip_tools.is_empty());
    assert!(settings.memory.legacy_prompt_enabled);
    assert!(!settings.memory.private_by_default);
    assert!(!settings.memory.private_file_paths);
    assert!(!settings.memory.private_verification_targets);
    assert!(settings.memory.record_prompt_placeholders);
    assert_eq!(
        settings.memory.observer_mode,
        MemoryObserverMode::Deterministic
    );
    assert_eq!(settings.memory.observer_queue_size, 128);
    assert!(settings.memory.observer_model.is_none());
}

#[test]
fn orchestrate_main_optional_tool_allowlist_parses_as_a_shrinking_override() {
    let settings = validate_and_resolve_settings_document(&serde_json::json!({
        "orchestrate": {
            "main": {
                "optional_tool_allowlist": ["memory_search", "WebSearch", "skill"]
            }
        }
    }))
    .unwrap();

    assert_eq!(
        settings.orchestrate.main.optional_tool_allowlist.as_deref(),
        Some(
            &[
                "memory_search".to_string(),
                "WebSearch".to_string(),
                "skill".to_string()
            ][..]
        )
    );
}

#[test]
fn orchestrate_main_optional_tool_allowlist_rejects_core_and_unknown_tools() {
    let protected = validate_and_resolve_settings_document(&serde_json::json!({
        "orchestrate": {
            "main": {"optional_tool_allowlist": ["spawn_agent"]}
        }
    }))
    .unwrap_err()
    .to_string();
    assert!(protected.contains("protected core capabilities"));

    let unknown = validate_and_resolve_settings_document(&serde_json::json!({
        "orchestrate": {
            "main": {"optional_tool_allowlist": ["bash"]}
        }
    }))
    .unwrap_err()
    .to_string();
    assert!(unknown.contains("unknown optional tools"));
}

#[test]
fn tools_file_edit_tool_defaults_to_edit_and_parses_apply_patch() {
    let settings: Settings = serde_json::from_value(serde_json::json!({
        "tools": { "file_edit_tool": "apply_patch" }
    }))
    .expect("apply_patch should parse");
    assert_eq!(settings.tools.file_edit_tool, FileEditSurface::ApplyPatch);
    assert_eq!(FileEditSurface::default(), FileEditSurface::Edit);
    assert_eq!(FileEditSurface::ApplyPatch.as_str(), "apply_patch");
    assert_eq!(FileEditSurface::Edit.as_str(), "edit");
    assert!(
        serde_json::from_value::<Settings>(serde_json::json!({
            "tools": { "file_edit_tool": "patch" }
        }))
        .is_err(),
        "unknown surface values must be rejected"
    );
}

#[test]
fn embedded_settings_schema_accepts_the_file_edit_tool_field() {
    // settings.schema.jsonc is the runtime validator (schema.rs:41) and its
    // tools object denies unknown properties, so the new field must be
    // declared there before settings with file_edit_tool can load at all.
    let document = serde_json::json!({ "tools": { "file_edit_tool": "apply_patch" } });
    crate::schema::validate_settings_schema(&document)
        .expect("embedded schema must accept tools.file_edit_tool");
}
