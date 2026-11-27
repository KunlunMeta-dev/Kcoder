use kcoder_plugins::{
    InstallLimits, PluginCancellationToken, PluginId, PluginStore,
    migration::{self, PluginMigrationNativeState as Native},
};
use std::path::Path;
fn package(root: &Path) {
    std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
    std::fs::write(
        root.join(".claude-plugin/plugin.json"),
        r#"{"name":"sample","version":"1.0.0"}"#,
    )
    .unwrap();
    std::fs::write(root.join("payload"), "original").unwrap();
}
#[test]
fn stable_native_install_is_disabled_and_owned_undo_preserves_peers() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    package(&source);
    let cancel = PluginCancellationToken::default();
    let revision = migration::package_revision(&source, InstallLimits::default(), &cancel).unwrap();
    let store = PluginStore::open(&temp.path().join("store")).unwrap();
    let id: PluginId = "sample@migrated-test".parse().unwrap();
    let op = uuid::Uuid::new_v4().simple().to_string();
    let first = store
        .install_migration_snapshot(&source, id.clone(), &op, &revision.sha256, &cancel)
        .unwrap();
    assert!(!first.enabled_by_default);
    assert_eq!(
        first,
        store
            .install_migration_snapshot(&source, id.clone(), &op, &revision.sha256, &cancel)
            .unwrap()
    );
    assert!(matches!(
        migration::observe_installation(store.root(), &id, &op, &revision.sha256, &cancel).unwrap(),
        Some(Native::Installed)
    ));
    let peer = store.install_local(&source, "peer").unwrap();
    let (_, lease) = store.snapshot_with_leases().unwrap();
    assert!(
        store
            .uninstall_migration_owned(&id, &op, &revision.sha256, &cancel)
            .is_err()
    );
    drop(lease);
    assert!(
        store
            .uninstall_migration_owned(&id, &op, &revision.sha256, &cancel)
            .unwrap()
    );
    assert!(store.read(&peer.plugin_id).unwrap().is_some());
    assert!(
        !store
            .uninstall_migration_owned(&id, &op, &revision.sha256, &cancel)
            .unwrap()
    );
    assert!(
        store
            .install_migration_snapshot(&source, id.clone(), &op, &revision.sha256, &cancel)
            .is_err()
    );
    assert!(matches!(
        migration::observe_installation(store.root(), &id, &op, &revision.sha256, &cancel).unwrap(),
        Some(Native::Retired)
    ));
}
#[test]
fn native_undo_rejects_user_edit_update_and_cross_target_request() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    package(&source);
    let cancel = PluginCancellationToken::default();
    let revision = migration::package_revision(&source, InstallLimits::default(), &cancel).unwrap();
    let store = PluginStore::open(&temp.path().join("store")).unwrap();
    let id: PluginId = "sample@migrated-test".parse().unwrap();
    let op = uuid::Uuid::new_v4().simple().to_string();
    let original = store
        .install_migration_snapshot(&source, id.clone(), &op, &revision.sha256, &cancel)
        .unwrap();
    assert!(
        store
            .install_migration_snapshot(
                &source,
                "sample@other".parse().unwrap(),
                &op,
                &revision.sha256,
                &cancel
            )
            .is_err()
    );
    std::fs::write(original.root(store.root()).join("payload"), "modified").unwrap();
    assert!(
        store
            .uninstall_migration_owned(&id, &op, &revision.sha256, &cancel)
            .is_err()
    );
    assert!(store.read(&id).unwrap().is_some());
    std::fs::write(original.root(store.root()).join("payload"), "original").unwrap();
    store.install_local(&source, "migrated-test").unwrap();
    assert!(
        store
            .uninstall_migration_owned(&id, &op, &revision.sha256, &cancel)
            .is_err()
    );
    assert!(store.read(&id).unwrap().is_some());
}
#[test]
fn ordinary_mcp_hooks_and_commands_are_static_while_unknown_fields_remain_pending() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("package");
    package(&root);
    std::fs::create_dir(root.join("commands")).unwrap();
    std::fs::write(
        root.join("commands/check.md"),
        "---\ndescription: Check the supplied material\n---\nRead $ARGUMENTS and report evidence.",
    )
    .unwrap();
    let marker = temp.path().join("must-not-exist");
    let manifest = serde_json::json!({"name":"sample","version":"1.0.0","mcpServers":{"docs":{"command":"never-execute-migration-fixture","env":{"REQUIRED_TOKEN":"${REQUIRED_TOKEN}","MODE":"fixture"}}},"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":format!("touch {}",marker.display())}]}]}});
    std::fs::write(
        root.join(".claude-plugin/plugin.json"),
        manifest.to_string(),
    )
    .unwrap();
    let token = PluginCancellationToken::default();
    let result = migration::inspect_package(&root, &token).unwrap();
    assert!(result.compatible, "{:?}", result.pending);
    assert_eq!(result.mcp_servers, 1);
    assert_eq!(result.commands, 1);
    assert_eq!(result.hooks, 1);
    assert_eq!(result.readiness, vec!["plugin_environment_required"]);
    assert!(!marker.exists());
    let mut credential = manifest.clone();
    credential["mcpServers"]["docs"]["policy"] =
        serde_json::json!({"credential_ref":{"id":"source-keyring-reference"}});
    std::fs::write(
        root.join(".claude-plugin/plugin.json"),
        credential.to_string(),
    )
    .unwrap();
    assert!(
        !migration::inspect_package(&root, &token)
            .unwrap()
            .compatible
    );
    let mut credential = manifest.clone();
    credential["mcpServers"]["docs"]["env"]["REQUIRED_TOKEN"] =
        serde_json::json!("literal-private-value");
    std::fs::write(
        root.join(".claude-plugin/plugin.json"),
        credential.to_string(),
    )
    .unwrap();
    assert!(
        !migration::inspect_package(&root, &token)
            .unwrap()
            .compatible
    );
    let mut unknown = manifest.clone();
    unknown["mcpServers"]["docs"]["futureAuthority"] = serde_json::json!(true);
    std::fs::write(root.join(".claude-plugin/plugin.json"), unknown.to_string()).unwrap();
    assert!(
        !migration::inspect_package(&root, &token)
            .unwrap()
            .compatible
    );
    let mut unknown = manifest.clone();
    unknown["interface"] = serde_json::json!({"futureAuthority":true});
    std::fs::write(root.join(".claude-plugin/plugin.json"), unknown.to_string()).unwrap();
    assert!(
        !migration::inspect_package(&root, &token)
            .unwrap()
            .compatible
    );
    std::fs::write(root.join("auth.json"), r#"{"token":"do-not-copy"}"#).unwrap();
    assert!(migration::package_revision(&root, InstallLimits::default(), &token).is_err());
    std::fs::remove_file(root.join("auth.json")).unwrap();
    std::fs::write(
        root.join(".credentials.json"),
        r#"{"claudeAiOauth":{"accessToken":"fixture-private"}}"#,
    )
    .unwrap();
    assert_eq!(
        migration::package_revision(&root, InstallLimits::default(), &token)
            .err()
            .unwrap()
            .to_string(),
        "plugin_migration_private_state_not_copied"
    );
}
#[cfg(unix)]
#[test]
fn private_state_and_links_cannot_be_snapshotted() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("package");
    package(&root);
    let token = PluginCancellationToken::default();
    let outside = temp.path().join("outside");
    std::fs::write(&outside, "private").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
    assert!(migration::package_revision(&root, InstallLimits::default(), &token).is_err());
    std::fs::remove_file(root.join("link")).unwrap();
    std::fs::hard_link(&outside, root.join("link")).unwrap();
    assert!(migration::package_revision(&root, InstallLimits::default(), &token).is_err());
}

#[test]
fn lost_install_receipt_is_reconciled_by_the_same_native_operation_before_undo() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    package(&source);
    let token = PluginCancellationToken::default();
    let revision = migration::package_revision(&source, InstallLimits::default(), &token).unwrap();
    let store = PluginStore::open(&temp.path().join("store")).unwrap();
    let id: PluginId = "sample@migrated-test".parse().unwrap();
    let op = uuid::Uuid::new_v4().simple().to_string();
    store
        .install_migration_snapshot(&source, id.clone(), &op, &revision.sha256, &token)
        .unwrap();
    let receipt = store
        .root()
        .join("migration-installs-v1")
        .join(format!("{op}.json"));
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&receipt).unwrap()).unwrap();
    value["stage"] = serde_json::json!("prepared");
    value["record"] = serde_json::Value::Null;
    std::fs::write(&receipt, serde_json::to_vec(&value).unwrap()).unwrap();
    std::fs::remove_dir_all(&source).unwrap();
    assert!(
        store
            .uninstall_migration_owned(&id, &op, &revision.sha256, &token)
            .unwrap()
    );
    assert!(store.read(&id).unwrap().is_none());
}

#[test]
fn migration_open_apply_and_undo_do_not_collect_an_unrelated_retained_version() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    package(&source);
    let path = temp.path().join("store");
    let ordinary = PluginStore::open(&path).unwrap();
    let peer_old = ordinary.install_local(&source, "peer").unwrap();
    let (_, lease) = ordinary.snapshot_with_leases().unwrap();
    std::fs::write(source.join("payload"), "new peer version").unwrap();
    let peer_current = ordinary.install_local(&source, "peer").unwrap();
    drop(lease);
    assert!(peer_old.root(&path).is_dir());
    let migrating = PluginStore::open_for_migration(&path).unwrap();
    assert!(peer_old.root(&path).is_dir());
    let token = PluginCancellationToken::default();
    let revision = migration::package_revision(&source, InstallLimits::default(), &token).unwrap();
    let op = uuid::Uuid::new_v4().simple().to_string();
    let id: PluginId = "sample@migrated-isolated".parse().unwrap();
    migrating
        .install_migration_snapshot(&source, id.clone(), &op, &revision.sha256, &token)
        .unwrap();
    migrating
        .uninstall_migration_owned(&id, &op, &revision.sha256, &token)
        .unwrap();
    assert!(peer_old.root(&path).is_dir());
    assert_eq!(
        migrating.read(&peer_current.plugin_id).unwrap(),
        Some(peer_current)
    );
}
