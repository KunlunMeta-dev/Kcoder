use kcoder_config::{FolderTrustStore, PluginsSettings};
use kcoder_plugins::PluginManager;
use serde_json::json;
use std::path::Path;

fn write_plugin(root: &Path, name: &str) {
    std::fs::create_dir_all(root).unwrap();
    std::fs::write(
        root.join("plugin.json"),
        json!({
            "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            "name": name,
            "version": "1.0.0"
        })
        .to_string(),
    )
    .unwrap();
}

#[test]
fn explicit_profiles_keep_user_plugins_separate_without_environment_changes() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().join("workspace");
    std::fs::create_dir_all(&cwd).unwrap();
    let profiles = [temp.path().join("first"), temp.path().join("second")];
    for (profile, name) in profiles.iter().zip(["first-only", "second-only"]) {
        write_plugin(&profile.join("plugins/local"), name);
    }
    for (profile, expected) in profiles.iter().zip(["first-only", "second-only"]) {
        let manager =
            PluginManager::open_for_profile(&cwd, profile, PluginsSettings::default()).unwrap();
        let listed = manager.list(&cwd, false).unwrap();
        assert_eq!(listed.plugins.len(), 1);
        assert_eq!(listed.plugins[0].name, expected);
        assert!(!listed.plugins[0].managed);
        let snapshot = manager.effective_snapshot(&cwd, false).unwrap();
        assert_eq!(snapshot.plugin_ids, vec![expected]);
    }
}

#[test]
fn explicit_profile_controls_ancestor_plugin_trust_and_live_revocation() {
    let temp = tempfile::tempdir().unwrap();
    let parent = temp.path().join("project");
    let cwd = parent.join("nested");
    std::fs::create_dir_all(&cwd).unwrap();
    let plugin = parent.join(".kcoder/plugins/local");
    std::fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
    std::fs::write(plugin.join(".claude-plugin/plugin.json"), json!({
        "name": "ancestor-plugin",
        "hooks": {"ConfigChange": [{"hooks": [{"type":"command", "command":"fixture-not-executed"}]}]}
    }).to_string()).unwrap();
    let approved = temp.path().join("approved");
    let other = temp.path().join("other");
    let first =
        PluginManager::open_for_profile(&cwd, &approved, PluginsSettings::default()).unwrap();
    let second = PluginManager::open_for_profile(&cwd, &other, PluginsSettings::default()).unwrap();
    // Explicit revocation also overrides any inherited default-home trust.
    FolderTrustStore::load(&other).revoke(&parent).unwrap();
    let mut trust = FolderTrustStore::load(&approved);
    trust.trust(&parent).unwrap();
    assert_eq!(first.list(&cwd, true).unwrap().plugins.len(), 1);
    let snapshot = first.effective_snapshot(&cwd, true).unwrap();
    assert_eq!(snapshot.hook_matchers.len(), 1);
    let required = snapshot.hook_matchers[0]
        .1
        .source
        .as_ref()
        .unwrap()
        .required_trust
        .as_ref()
        .unwrap();
    assert_eq!(
        dunce::canonicalize(required.config_dir.as_ref().unwrap()).unwrap(),
        dunce::canonicalize(&approved).unwrap()
    );
    assert_eq!(required.directory, dunce::canonicalize(&parent).unwrap());
    assert!(second.list(&cwd, true).unwrap().plugins.is_empty());
    trust.revoke(&parent).unwrap();
    assert!(first.list(&cwd, true).unwrap().plugins.is_empty());
}
