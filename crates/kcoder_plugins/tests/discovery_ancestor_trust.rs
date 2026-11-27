use kcoder_config::{CONFIG_DIR_ENV, FolderTrust, FolderTrustStore, PluginsSettings};
use kcoder_plugins::{PluginRegistry, PluginStore};
use std::ffi::OsString;

struct EnvironmentGuard {
    config: Option<OsString>,
    trust_all: Option<OsString>,
}

impl EnvironmentGuard {
    fn set_config(path: &std::path::Path) -> Self {
        let config = std::env::var_os(CONFIG_DIR_ENV);
        let trust_all = std::env::var_os("KCODER_TRUST_ALL");
        unsafe {
            std::env::set_var(CONFIG_DIR_ENV, path);
            std::env::remove_var("KCODER_TRUST_ALL");
        }
        Self { config, trust_all }
    }
}

impl Drop for EnvironmentGuard {
    fn drop(&mut self) {
        match self.config.take() {
            Some(value) => unsafe { std::env::set_var(CONFIG_DIR_ENV, value) },
            None => unsafe { std::env::remove_var(CONFIG_DIR_ENV) },
        }
        match self.trust_all.take() {
            Some(value) => unsafe { std::env::set_var("KCODER_TRUST_ALL", value) },
            None => unsafe { std::env::remove_var("KCODER_TRUST_ALL") },
        }
    }
}

fn write_plugin(owner: &std::path::Path, id: &str) {
    let plugin = owner.join(".kcoder/plugins").join(id);
    std::fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
    std::fs::write(
        plugin.join(".claude-plugin/plugin.json"),
        serde_json::json!({
            "name": id,
            "hooks": {
                "ConfigChange": [{
                    "hooks": [{"type": "command", "command": "true"}]
                }]
            }
        })
        .to_string(),
    )
    .unwrap();
}

#[test]
fn ancestor_plugin_roots_require_their_own_trust_and_keep_that_provenance() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let cwd = repo.join("subproject");
    let profile = temp.path().join("profile");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&profile).unwrap();
    let _environment = EnvironmentGuard::set_config(&profile);
    let repo = dunce::canonicalize(&repo).unwrap();
    let cwd = dunce::canonicalize(&cwd).unwrap();
    write_plugin(&repo, "parent-plugin");
    write_plugin(&cwd, "child-plugin");
    let store = PluginStore::open(&profile.join("plugin_store")).unwrap();
    let settings = PluginsSettings::default();

    let mut trust = FolderTrustStore::load(&profile);
    trust.revoke(&repo).unwrap();
    assert_eq!(trust.check(&repo), FolderTrust::Unknown);
    trust.trust(&cwd).unwrap();
    let child_only = PluginRegistry::discover_with_store_and_settings(
        &cwd,
        trust.check(&cwd) == FolderTrust::Trusted,
        &store,
        &settings,
    )
    .unwrap();
    let child_only_snapshot = child_only.effective_snapshot();
    assert!(
        child_only_snapshot
            .plugin_ids
            .contains(&"child-plugin".to_string())
    );
    assert!(
        !child_only_snapshot
            .plugin_ids
            .contains(&"parent-plugin".to_string())
    );

    trust.trust(&repo).unwrap();
    let trusted_parent = PluginRegistry::discover_with_store_and_settings(
        &cwd,
        trust.check(&cwd) == FolderTrust::Trusted,
        &store,
        &settings,
    )
    .unwrap();
    let parent = trusted_parent
        .plugins()
        .iter()
        .find(|plugin| plugin.id == "parent-plugin")
        .expect("a separately trusted ancestor plugin should load");
    assert_eq!(
        parent
            .required_trust_directory
            .as_deref()
            .map(dunce::canonicalize)
            .transpose()
            .unwrap(),
        Some(dunce::canonicalize(&repo).unwrap())
    );
    let parent_hook = trusted_parent
        .hook_matchers()
        .into_iter()
        .find(|(_, matcher)| {
            matcher
                .source
                .as_ref()
                .is_some_and(|source| source.id == "parent-plugin")
        })
        .expect("the ancestor plugin hook should retain trust provenance");
    assert_eq!(
        dunce::canonicalize(
            &parent_hook
                .1
                .source
                .as_ref()
                .unwrap()
                .required_trust
                .as_ref()
                .unwrap()
                .directory
        )
        .unwrap(),
        dunce::canonicalize(&repo).unwrap()
    );

    trust.revoke(&repo).unwrap();
    assert_eq!(trust.check(&repo), FolderTrust::Unknown);
    assert_eq!(trust.check(&cwd), FolderTrust::Trusted);
    let after_parent_revocation = PluginRegistry::discover_with_store_and_settings(
        &cwd,
        trust.check(&cwd) == FolderTrust::Trusted,
        &store,
        &settings,
    )
    .unwrap();
    let snapshot = after_parent_revocation.effective_snapshot();
    assert!(snapshot.plugin_ids.contains(&"child-plugin".to_string()));
    assert!(!snapshot.plugin_ids.contains(&"parent-plugin".to_string()));
}
