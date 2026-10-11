use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use crate::test_support::providers::EmptyProvider;
use kcoder_api::Provider;
use kcoder_config::Settings;
use std::path::Path;
use std::sync::Arc;

fn lifecycle_test_engine(cwd: &Path) -> QueryEngine {
    TestEngineBuilder::new(cwd).build()
}

fn test_engine_with_settings_and_trust(
    provider: Arc<dyn Provider>,
    cwd: &Path,
    settings: Settings,
    folder_trusted: Option<bool>,
) -> QueryEngine {
    TestEngineBuilder::new(cwd)
        .provider(provider)
        .settings(settings)
        .folder_trusted(folder_trusted)
        .build()
}

#[test]
fn write_and_edit_success_payloads_emit_file_changed() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = lifecycle_test_engine(tmp.path());

    for tool_name in ["write", "edit"] {
        let payloads = engine.success_lifecycle_payloads(
            tool_name,
            &serde_json::json!({ "file_path": "src/lib.rs" }),
            &ToolOutput::text("ok"),
        );

        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0].0, kcoder_hooks::HookEvent::FileChanged);
        assert_eq!(payloads[0].1, "src/lib.rs");
        assert_eq!(payloads[0].2["paths"][0], "src/lib.rs");
        assert_eq!(payloads[0].2["tool"], tool_name);
    }
}

#[test]
fn config_success_payload_only_emits_for_set_operations() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = lifecycle_test_engine(tmp.path());

    let read_payloads = engine.success_lifecycle_payloads(
        "Config",
        &serde_json::json!({ "setting": "model" }),
        &ToolOutput::text("model = \"x\""),
    );
    assert!(read_payloads.is_empty());

    let set_payloads = engine.success_lifecycle_payloads(
        "Config",
        &serde_json::json!({ "setting": "model", "value": "kimi" }),
        &ToolOutput::text("Set model to \"kimi\""),
    );
    assert_eq!(set_payloads.len(), 1);
    assert_eq!(set_payloads[0].0, kcoder_hooks::HookEvent::ConfigChange);
    assert_eq!(set_payloads[0].1, "model");
    assert_eq!(set_payloads[0].2["scope"], "settings");
}

#[test]
fn spec_payloads_are_precise_for_mutating_tools() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = lifecycle_test_engine(tmp.path());

    let status_payloads = engine.success_lifecycle_payloads(
        "SpecStatus",
        &serde_json::json!({ "name": "demo" }),
        &ToolOutput::text("ok"),
    );
    assert!(status_payloads.is_empty());

    let set_payloads = engine.success_lifecycle_payloads(
        "SpecConfig",
        &serde_json::json!({ "action": "set", "key": "schema", "value": "1" }),
        &ToolOutput::text("Set schema in .kcoder/specs/config.yaml"),
    );
    assert_eq!(set_payloads.len(), 2);
    assert_eq!(set_payloads[0].0, kcoder_hooks::HookEvent::FileChanged);
    assert_eq!(set_payloads[1].0, kcoder_hooks::HookEvent::ConfigChange);
    assert_eq!(set_payloads[1].1, "schema");
    assert_eq!(set_payloads[1].2["scope"], "specs");

    let get_payloads = engine.success_lifecycle_payloads(
        "SpecConfig",
        &serde_json::json!({ "action": "get", "key": "schema" }),
        &ToolOutput::text("spec-driven"),
    );
    assert!(get_payloads.is_empty());

    let prepare_payloads = engine.success_lifecycle_payloads(
        "SpecReview",
        &serde_json::json!({ "action": "prepare", "name": "demo" }),
        &ToolOutput::text("ok"),
    );
    assert!(prepare_payloads.is_empty());

    let writeback_payloads = engine.success_lifecycle_payloads(
        "SpecReview",
        &serde_json::json!({ "action": "writeback", "name": "demo" }),
        &ToolOutput::text("ok"),
    );
    assert_eq!(writeback_payloads.len(), 1);
    assert_eq!(
        writeback_payloads[0].0,
        kcoder_hooks::HookEvent::FileChanged
    );
}

#[tokio::test]
async fn stop_hook_failure_triggers_stop_failure_hook() {
    let tmp = tempfile::tempdir().unwrap();
    let kcoder_dir = tmp.path().join(".kcoder");
    std::fs::create_dir_all(&kcoder_dir).unwrap();
    std::fs::write(
        kcoder_dir.join("settings.json"),
        r#"{
          "hooks": {
            "Stop": [{
              "hooks": [{
                "type": "command",
                "command": "echo stop failed >&2; exit 1"
              }]
            }],
            "StopFailure": [{
              "hooks": [{
                "type": "command",
                "command": "printf '{\"systemMessage\":\"stop failure hook fired\"}'"
              }]
            }]
          }
        }"#,
    )
    .unwrap();
    let engine = {
        let provider = Arc::new(EmptyProvider);
        let settings = Settings::default();
        test_engine_with_settings_and_trust(provider, tmp.path(), settings, Some(true))
    };

    let (events, stop) = engine.run_stop_hooks().await;

    assert!(stop);
    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::HookMessage { text, .. }
            if text.contains("stop failure hook fired")
    )));
}

#[test]
fn apply_patch_success_payloads_emit_file_changed_for_every_affected_path() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = lifecycle_test_engine(tmp.path());
    let patch = "*** Begin Patch\n*** Update File: a.rs\n@@\n-x\n+y\n*** Delete File: b.rs\n*** End Patch\n";
    let payloads = engine.success_lifecycle_payloads(
        "apply_patch",
        &serde_json::json!({ "patch": patch }),
        &ToolOutput::text("ok"),
    );
    assert_eq!(payloads.len(), 1);
    assert_eq!(payloads[0].0, kcoder_hooks::HookEvent::FileChanged);
    let paths = payloads[0].2["paths"].as_array().unwrap();
    assert_eq!(paths.len(), 2);
    assert!(paths.iter().any(|p| p.as_str() == Some("a.rs")));
    assert!(paths.iter().any(|p| p.as_str() == Some("b.rs")));
}
