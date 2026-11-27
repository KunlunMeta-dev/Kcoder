use kcoder_config::{CONFIG_DIR_ENV, PluginsSettings};
use kcoder_plugins::{PluginRegistry, PluginStore};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

static CONFIG_ENV_LOCK: Mutex<()> = Mutex::new(());

struct ConfigDirGuard {
    previous: Option<OsString>,
    previous_trust_all: Option<OsString>,
    _lock: MutexGuard<'static, ()>,
}

impl ConfigDirGuard {
    fn set(path: &Path) -> Self {
        let lock = CONFIG_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = std::env::var_os(CONFIG_DIR_ENV);
        let previous_trust_all = std::env::var_os("KCODER_TRUST_ALL");
        // This integration test binary serializes access to its private profile.
        unsafe {
            std::env::set_var(CONFIG_DIR_ENV, path);
            std::env::remove_var("KCODER_TRUST_ALL");
        }
        Self {
            previous,
            previous_trust_all,
            _lock: lock,
        }
    }
}

impl Drop for ConfigDirGuard {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(path) => unsafe { std::env::set_var(CONFIG_DIR_ENV, path) },
            None => unsafe { std::env::remove_var(CONFIG_DIR_ENV) },
        }
        match self.previous_trust_all.take() {
            Some(value) => unsafe { std::env::set_var("KCODER_TRUST_ALL", value) },
            None => unsafe { std::env::remove_var("KCODER_TRUST_ALL") },
        }
    }
}

fn agent_plugin_fixture() -> PathBuf {
    PathBuf::from(
        std::env::var_os("KCODER_WORKSPACE_ROOT")
            .expect("Cargo must provide the runtime workspace root"),
    )
    .join("crates/kcoder_plugins/tests/fixtures/plugins/agent-v1")
}

fn copy_tree(source: &Path, target: &Path) {
    std::fs::create_dir_all(target).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&source_path, &target_path);
        } else {
            std::fs::copy(source_path, target_path).unwrap();
        }
    }
}

fn write_unique_plugin(root: &Path) {
    std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
    std::fs::write(
        root.join(".claude-plugin/plugin.json"),
        r#"{"name":"unique-plugin"}"#,
    )
    .unwrap();
}

#[test]
fn runtime_disable_and_duplicate_unmanaged_ids_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().join("workspace");
    let config_dir = cwd.join(".kcoder");
    std::fs::create_dir_all(&config_dir).unwrap();
    let _config = ConfigDirGuard::set(&config_dir);

    let disabled_plugin = cwd.join(".kcoder/plugins/runtime-disabled");
    copy_tree(&agent_plugin_fixture(), &disabled_plugin);
    let store = PluginStore::open(&config_dir.join("runtime-store")).unwrap();

    let mut settings = PluginsSettings::default();
    settings.runtime.enabled = false;
    let disabled =
        PluginRegistry::discover_with_store_and_settings(&cwd, true, &store, &settings).unwrap();
    let disabled_snapshot = disabled.effective_snapshot();
    assert_eq!(disabled.plugins().len(), 1);
    assert_eq!(disabled.plugins()[0].id, "agent-demo");
    assert!(!disabled.plugins()[0].enabled);
    assert!(disabled_snapshot.plugin_ids.is_empty());
    assert!(disabled_snapshot.skill_roots.is_empty());
    assert!(disabled_snapshot.mcp_configs.is_empty());
    assert!(disabled_snapshot.hook_matchers.is_empty());
    assert_eq!(disabled.generation(), store.generation().unwrap());
    assert!(!store.root().join("data/.unmanaged").exists());

    settings.runtime.enabled = true;
    let aliased_root =
        PluginRegistry::discover_with_store_and_settings(&cwd, true, &store, &settings).unwrap();
    assert_eq!(aliased_root.effective_snapshot().plugin_ids, ["agent-demo"]);
    assert!(
        aliased_root
            .diagnostics()
            .iter()
            .all(|diagnostic| diagnostic.code != "duplicate_plugin_id")
    );
    std::fs::remove_dir_all(&disabled_plugin).unwrap();

    let first_duplicate = temp.path().join(".kcoder/plugins/duplicate-one");
    let second_duplicate = cwd.join(".kcoder/plugins/duplicate-two");
    copy_tree(&agent_plugin_fixture(), &first_duplicate);
    copy_tree(&agent_plugin_fixture(), &second_duplicate);
    let healthy = cwd.join(".kcoder/plugins/healthy");
    write_unique_plugin(&healthy);

    let untrusted_store = PluginStore::open(&config_dir.join("untrusted-store")).unwrap();
    let untrusted =
        PluginRegistry::discover_with_store_and_settings(&cwd, false, &untrusted_store, &settings)
            .unwrap();
    assert!(untrusted.plugins().is_empty());
    assert!(untrusted.effective_snapshot().plugin_ids.is_empty());
    assert!(!untrusted_store.root().join("data/.unmanaged").exists());

    let mut trust = kcoder_config::FolderTrustStore::load(&config_dir);
    trust.trust(temp.path()).unwrap();
    let registry =
        PluginRegistry::discover_with_store_and_settings(&cwd, true, &store, &settings).unwrap();
    let snapshot = registry.effective_snapshot();
    assert_eq!(snapshot.plugin_ids, ["unique-plugin"]);
    assert!(snapshot.mcp_configs.is_empty());
    assert!(snapshot.hook_matchers.is_empty());

    let duplicate_diagnostics = registry
        .diagnostics()
        .iter()
        .filter(|diagnostic| diagnostic.code == "duplicate_plugin_id")
        .collect::<Vec<_>>();
    assert_eq!(duplicate_diagnostics.len(), 2);
    assert!(
        duplicate_diagnostics
            .iter()
            .any(|diagnostic| diagnostic.root == first_duplicate)
    );
    assert!(
        duplicate_diagnostics
            .iter()
            .any(|diagnostic| diagnostic.root == second_duplicate)
    );
}
