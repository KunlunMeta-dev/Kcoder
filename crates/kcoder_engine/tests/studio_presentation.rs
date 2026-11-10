//! Presentation policy for the KWorker office mode.
//!
//! Durable history is not authority: `office_tool_policy_active` reads the *turn*
//! presentation. A stored `studioWorkMode` label, an absent presentation payload, a
//! version-1 payload without a work mode, or an explicit KCoder payload all resolve to a
//! non-office turn, which keeps the ordinary host tool set instead of the office
//! allowlist. Only the KWorker presentation applies that allowlist and the built-in shell
//! the host registered.

mod support;

use std::collections::HashSet;

use kcoder_config::Settings;
use kcoder_tools::{FileReadTool, FileWriteTool, PowerShellTool, ToolRegistry};
use kcoder_types::{ClientPresentationV1, StudioWorkMode};

fn office_settings() -> Settings {
    let mut settings = Settings::default();
    // Deliberately omits the platform shell: the office mode must not depend on a
    // resolved allowlist that was produced on another platform or by an older default.
    settings.tools.luna.allowed = vec!["read".into()];
    settings
}

/// `write` is registered but outside the office allowlist, so its presence proves the
/// turn did not apply the office policy.
fn registered_office_host() -> ToolRegistry {
    ToolRegistry::new()
        .register(FileReadTool)
        .register(FileWriteTool)
        .register(PowerShellTool)
}

fn name_set(engine: &kcoder_engine::QueryEngine) -> HashSet<String> {
    engine
        .active_tool_registry()
        .names()
        .into_iter()
        .collect::<HashSet<_>>()
}

fn engine_in_kworker_history() -> (tempfile::TempDir, kcoder_engine::QueryEngine) {
    let root = tempfile::tempdir().unwrap();
    let engine = support::engine(root.path(), office_settings(), registered_office_host());
    engine
        .state
        .set_studio_work_mode_before_first_message(StudioWorkMode::Kworker)
        .unwrap();
    (root, engine)
}

#[tokio::test]
async fn durable_office_label_without_a_turn_presentation_keeps_the_host_tool_set() {
    let (_root, engine) = engine_in_kworker_history();

    let unlabelled_turn = engine.clone().with_client_presentation(None);
    let names = name_set(&unlabelled_turn);

    assert!(
        names.contains("write"),
        "a durable label must not apply the office allowlist, got {names:?}"
    );
}

#[tokio::test]
async fn version_1_presentation_without_a_work_mode_keeps_the_host_tool_set() {
    let (_root, engine) = engine_in_kworker_history();

    let undefined_mode = engine
        .clone()
        .with_client_presentation(Some(ClientPresentationV1 {
            version: 1,
            studio_work_mode: None,
            inline_widgets: false,
            isolated_widgets: false,
        }));
    let names = name_set(&undefined_mode);

    assert!(
        names.contains("write"),
        "an absent work mode resolves to the default mode, got {names:?}"
    );
}

#[tokio::test]
async fn explicit_kcoder_presentation_keeps_the_host_tool_set() {
    let (_root, engine) = engine_in_kworker_history();

    let kcoder_turn = engine
        .clone()
        .with_client_presentation(Some(ClientPresentationV1 {
            version: 1,
            studio_work_mode: Some(StudioWorkMode::Kcoder),
            inline_widgets: false,
            isolated_widgets: false,
        }));
    let names = name_set(&kcoder_turn);

    assert!(
        names.contains("write"),
        "an explicit KCoder turn keeps the ordinary host tool set, got {names:?}"
    );
}

#[tokio::test]
async fn explicit_disable_still_removes_the_built_in_office_shell() {
    let root = tempfile::tempdir().unwrap();
    let mut settings = office_settings();
    settings.tools.disabled = vec!["PowerShell".into()];
    // The startup registry is where `tools.disabled` is applied, so a disabled shell is
    // absent from the host registry the office policy composes from.
    let registry = registered_office_host().filtered_out_by_patterns(&settings.tools.disabled);
    let engine = support::engine(root.path(), settings, registry);
    engine
        .state
        .set_studio_work_mode_before_first_message(StudioWorkMode::Kworker)
        .unwrap();

    let office = engine
        .clone()
        .with_client_presentation(support::kworker_presentation());

    assert!(
        !name_set(&office).contains("PowerShell"),
        "the office mode must never restore a tool the host disabled"
    );
}
