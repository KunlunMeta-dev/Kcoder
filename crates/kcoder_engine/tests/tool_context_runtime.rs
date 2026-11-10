//! KWorker keeps the Windows office shell among its built-in business tools.
//!
//! The built-in set is `resolved Luna allowlist ∩ registered tools` plus the KWorker
//! workflow, sub-agent and shell tools the host actually registered. A resolved
//! allowlist produced on another platform (or an older default) must not silently
//! leave the office mode without a shell on Windows, while a host that never
//! registered `PowerShell` must never gain it.

mod support;

use std::collections::HashSet;

use kcoder_config::Settings;
use kcoder_tools::{FileReadTool, FileWriteTool, PowerShellTool, ToolRegistry};
use kcoder_types::StudioWorkMode;

fn office_settings() -> Settings {
    let mut settings = Settings::default();
    // A resolved allowlist that omits the platform shell, as an older default or a
    // settings file produced on another platform would.
    settings.tools.luna.allowed = vec!["read".into()];
    settings
}

fn name_set(engine: &kcoder_engine::QueryEngine) -> HashSet<String> {
    engine
        .active_tool_registry()
        .names()
        .into_iter()
        .collect::<HashSet<_>>()
}

#[tokio::test]
async fn office_turn_keeps_registered_powershell_even_when_the_allowlist_omits_it() {
    let root = tempfile::tempdir().unwrap();
    let registry = ToolRegistry::new()
        .register(FileReadTool)
        .register(PowerShellTool);
    let engine = support::engine(root.path(), office_settings(), registry);
    engine
        .state
        .set_studio_work_mode_before_first_message(StudioWorkMode::Kworker)
        .unwrap();

    let office = engine
        .clone()
        .with_client_presentation(support::kworker_presentation());
    let names = name_set(&office);

    assert!(
        names.contains("PowerShell"),
        "KWorker must keep the registered PowerShell tool built in, got {names:?}"
    );
    assert!(
        names.contains("read"),
        "the allowlist entry must survive, got {names:?}"
    );
}

#[tokio::test]
async fn office_turn_never_invents_a_powershell_tool_the_host_did_not_register() {
    let root = tempfile::tempdir().unwrap();
    let registry = ToolRegistry::new().register(FileReadTool);
    let engine = support::engine(root.path(), office_settings(), registry);
    engine
        .state
        .set_studio_work_mode_before_first_message(StudioWorkMode::Kworker)
        .unwrap();

    let office = engine
        .clone()
        .with_client_presentation(support::kworker_presentation());

    assert!(
        !name_set(&office).contains("PowerShell"),
        "registration decides availability; the mode must not add an unregistered tool"
    );
}

#[tokio::test]
async fn office_turn_still_applies_the_allowlist_to_ordinary_tools() {
    let root = tempfile::tempdir().unwrap();
    let registry = ToolRegistry::new()
        .register(FileReadTool)
        .register(FileWriteTool)
        .register(PowerShellTool);
    let engine = support::engine(root.path(), office_settings(), registry);
    engine
        .state
        .set_studio_work_mode_before_first_message(StudioWorkMode::Kworker)
        .unwrap();

    let office = engine
        .clone()
        .with_client_presentation(support::kworker_presentation());
    let names = name_set(&office);

    assert!(
        !names.contains("write"),
        "keeping the office shell must not widen the resolved allowlist, got {names:?}"
    );
    assert!(
        names.contains("read"),
        "the allowlist entry must survive, got {names:?}"
    );
}
