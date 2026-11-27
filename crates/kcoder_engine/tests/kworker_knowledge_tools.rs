//! KWorker exposes the personal Wiki only when the user enabled it.
//!
//! The Wiki tools are registered from the persisted `knowledge` switches, then the
//! KWorker allowlist is applied. Retrieval and organization stay independent opt-ins:
//! the office mode keeps an enabled Wiki tool, but must never add a disabled one.

mod support;

use std::collections::HashSet;
use std::path::Path;

use kcoder_config::Settings;
use kcoder_tools::wiki::WikiTool;
use kcoder_tools::wiki_manage::WikiManageTool;
use kcoder_tools::{ConfigTool, FileReadTool, FileWriteTool, ToolRegistry};

fn office_settings() -> Settings {
    let mut settings = Settings::default();
    settings.tools.luna.allowed = vec!["read".into()];
    settings
}

/// `write` is registered but outside the office allowlist; its absence proves the turn
/// applied the office policy rather than the ordinary host tool set.
fn host_registry() -> ToolRegistry {
    ToolRegistry::new()
        .register(FileReadTool)
        .register(FileWriteTool)
        .register(ConfigTool)
        .register(WikiTool)
        .register(WikiManageTool)
}

fn kworker_turn_names(root: &Path, knowledge: serde_json::Value) -> HashSet<String> {
    let settings_path = root.join("settings.json");
    std::fs::write(
        &settings_path,
        serde_json::to_vec(&serde_json::json!({ "knowledge": knowledge })).unwrap(),
    )
    .unwrap();
    let engine = support::engine(root, office_settings(), host_registry())
        .with_settings_persistence_path(settings_path);
    let names = support::kworker_turn(&engine)
        .active_tool_registry()
        .names()
        .into_iter()
        .collect::<HashSet<_>>();
    assert!(
        !names.contains("write"),
        "the office allowlist must apply, got {names:?}"
    );
    names
}

#[tokio::test]
async fn kworker_keeps_the_wiki_retrieval_tool_the_user_enabled() {
    let root = tempfile::tempdir().unwrap();
    let names = kworker_turn_names(
        root.path(),
        serde_json::json!({"retrieval_enabled": true, "organization_enabled": false}),
    );

    assert!(
        names.contains("Wiki"),
        "enabled retrieval must stay visible, got {names:?}"
    );
    assert!(
        !names.contains("WikiManage"),
        "organization was not enabled, got {names:?}"
    );
}

#[tokio::test]
async fn kworker_keeps_both_wiki_tools_when_both_switches_are_on() {
    let root = tempfile::tempdir().unwrap();
    let names = kworker_turn_names(
        root.path(),
        serde_json::json!({"retrieval_enabled": true, "organization_enabled": true}),
    );

    assert!(names.contains("Wiki"), "got {names:?}");
    assert!(names.contains("WikiManage"), "got {names:?}");
}

#[tokio::test]
async fn kworker_never_adds_wiki_tools_the_user_left_disabled() {
    let root = tempfile::tempdir().unwrap();
    let names = kworker_turn_names(root.path(), serde_json::json!({}));

    assert!(
        !names.contains("Wiki") && !names.contains("WikiManage"),
        "a disabled Wiki must stay hidden, got {names:?}"
    );
    assert!(names.contains("read"), "got {names:?}");
}
