use kcoder_config::{CONFIG_DIR_ENV, PluginsSettings};
use kcoder_plugins::{PluginManager, PluginStore};
use std::ffi::OsString;
use std::path::PathBuf;

struct ConfigDirGuard(Option<OsString>);

impl ConfigDirGuard {
    fn set(path: &std::path::Path) -> Self {
        let previous = std::env::var_os(CONFIG_DIR_ENV);
        // This integration test binary contains one test and owns this process environment.
        unsafe { std::env::set_var(CONFIG_DIR_ENV, path) };
        Self(previous)
    }
}

impl Drop for ConfigDirGuard {
    fn drop(&mut self) {
        match self.0.take() {
            Some(path) => unsafe { std::env::set_var(CONFIG_DIR_ENV, path) },
            None => unsafe { std::env::remove_var(CONFIG_DIR_ENV) },
        }
    }
}

#[test]
fn runtime_disable_keeps_managed_plugin_visible_without_creating_data() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().join("workspace");
    let config_dir = temp.path().join("profile");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&config_dir).unwrap();
    let _config = ConfigDirGuard::set(&config_dir);

    let store = PluginStore::open(&config_dir.join("plugin_store")).unwrap();
    // Resolve the checkout at runtime so renamed checkouts never reuse a stale compiled path.
    let fixture = PathBuf::from(
        std::env::var_os("KCODER_WORKSPACE_ROOT")
            .expect("Cargo must provide the runtime workspace root"),
    )
    .join("crates/kcoder_plugins/tests/fixtures/plugins/agent-v1");
    let installed = store.install_local(&fixture, "managed").unwrap();
    let mut settings = PluginsSettings::default();
    settings.runtime.enabled = false;

    let manager = PluginManager::open_for_profile(&cwd, &config_dir, settings).unwrap();
    let listed = manager.list(&cwd, true).unwrap();
    let item = listed
        .plugins
        .iter()
        .find(|plugin| plugin.id == installed.plugin_id.to_string())
        .expect("the installed plugin remains inspectable while runtime is disabled");
    assert!(item.managed);
    assert!(!item.enabled);

    let snapshot = manager.effective_snapshot(&cwd, true).unwrap();
    assert!(snapshot.plugin_ids.is_empty());
    assert!(snapshot.version_leases.is_empty());
    assert!(snapshot.skill_roots.is_empty());
    assert!(snapshot.mcp_configs.is_empty());
    assert!(!store.data_root(&installed.plugin_id).unwrap().exists());
}
