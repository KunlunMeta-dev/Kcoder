use fs2::FileExt;
use kcoder_config::CONFIG_DIR_ENV;
use kcoder_plugins::{PluginRegistry, PluginStore};
use std::time::{Duration, Instant};

#[test]
fn prompt_snapshot_reports_busy_temp_storage_then_recovers() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("profile");
    let workspace = temp.path().join("workspace");
    kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
    // This binary contains one test; no peer test uses this process environment.
    unsafe { std::env::set_var(CONFIG_DIR_ENV, &profile) };
    let existing = kcoder_config::create_private_temp_dir("prompt-deadline-fixture").unwrap();
    let manager = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(profile.join("tmp/.manager.lock"))
        .unwrap();
    manager.lock_exclusive().unwrap();
    let source = workspace.join(".kcoder/plugins/prompt");
    std::fs::create_dir_all(source.join(".claude-plugin")).unwrap();
    std::fs::create_dir(source.join("commands")).unwrap();
    std::fs::write(
        source.join(".claude-plugin/plugin.json"),
        r#"{"name":"snapshot-deadline"}"#,
    )
    .unwrap();
    std::fs::write(
        source.join("commands/demo.md"),
        "---\ndescription: fixture\n---\nUnique snapshot deadline fixture",
    )
    .unwrap();
    let store = PluginStore::open(&temp.path().join("store")).unwrap();
    let registry = PluginRegistry::discover_with_store(&workspace, true, &store).unwrap();
    let started = Instant::now();
    let blocked = registry.effective_snapshot();
    assert!(started.elapsed() < Duration::from_secs(4));
    assert!(blocked.prompt_leases.is_empty());
    assert!(
        blocked
            .diagnostics
            .iter()
            .any(|d| d.code == "prompt_adapter_failed" && d.message.contains("timed out"))
    );
    FileExt::unlock(&manager).unwrap();
    let recovered = registry.effective_snapshot();
    assert_eq!(recovered.prompt_leases.len(), 1);
    assert!(
        !recovered
            .diagnostics
            .iter()
            .any(|d| d.code == "prompt_adapter_failed")
    );
    drop(existing);
}
