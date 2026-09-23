use kcoder_plugins::{PluginId, PluginStore};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
fn package(root: &Path, version: &str) {
    std::fs::create_dir_all(root.join(".codex-plugin")).unwrap();
    std::fs::write(
        root.join(".codex-plugin/plugin.json"),
        serde_json::json!({"name":"race","version":version}).to_string(),
    )
    .unwrap();
    std::fs::write(root.join("payload"), version).unwrap();
}
#[test]
fn process_install_worker() {
    let Ok(root) = std::env::var("KCODER_P3_STORE") else {
        return;
    };
    let source = std::env::var("KCODER_P3_SOURCE").unwrap();
    let barrier = PathBuf::from(std::env::var("KCODER_P3_BARRIER").unwrap());
    let start = Instant::now();
    while !barrier.exists() {
        assert!(start.elapsed() < Duration::from_secs(10));
        std::thread::sleep(Duration::from_millis(5));
    }
    PluginStore::open(Path::new(&root))
        .unwrap()
        .install_local(Path::new(&source), "owned")
        .unwrap();
}
#[test]
fn two_process_installs_preserve_winner_then_uninstall_stays_removed() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    let first = tmp.path().join("a");
    let second = tmp.path().join("b");
    package(&first, "1");
    package(&second, "2");
    let barrier = tmp.path().join("go");
    let mut children = [first, second].map(|source| {
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "process_install_worker", "--nocapture"])
            .env("KCODER_P3_STORE", &store)
            .env("KCODER_P3_SOURCE", source)
            .env("KCODER_P3_BARRIER", &barrier)
            .stdout(Stdio::null())
            .spawn()
            .unwrap()
    });
    std::fs::write(barrier, "").unwrap();
    for child in &mut children {
        assert!(child.wait().unwrap().success());
    }
    let manager = PluginStore::open(&store).unwrap();
    let id: PluginId = "race@owned".parse().unwrap();
    let record = manager.read(&id).unwrap().unwrap();
    let value = std::fs::read_to_string(record.root(&store).join("payload")).unwrap();
    assert!(["1", "2"].contains(&value.as_str()));
    assert_eq!(manager.installed_plugins().unwrap().len(), 1);
    assert!(manager.uninstall(&id, false).unwrap());
    drop(manager);
    let reopened = PluginStore::open(&store).unwrap();
    assert!(reopened.read(&id).unwrap().is_none());
    assert!(reopened.snapshot().unwrap().installed.is_empty());
}
