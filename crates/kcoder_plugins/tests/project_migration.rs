use kcoder_config::{FolderTrustStore, PluginPolicySettings, PluginsSettings, PrivateDirectory};
use kcoder_plugins::{
    InstallLimits, PluginCancellationToken, PluginProjectBinding, PluginRegistry, PluginStore,
    migration::{self, PluginMigrationNativeState},
};
use std::path::{Path, PathBuf};
struct Fixture {
    _temp: tempfile::TempDir,
    profile: PathBuf,
    project: PathBuf,
    peer: PathBuf,
    source: PathBuf,
    store: PluginStore,
    binding: PluginProjectBinding,
    revision: String,
    cancel: PluginCancellationToken,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("profile");
        let project = temp.path().join("project");
        let peer = temp.path().join("peer");
        let source = temp.path().join("source");
        for root in [&profile, &project, &peer, &source] {
            PrivateDirectory::open_or_create(root).unwrap();
        }
        std::fs::create_dir(source.join(".claude-plugin")).unwrap();
        std::fs::write(
            source.join(".claude-plugin/plugin.json"),
            r#"{"name":"sample","version":"1.0.0"}"#,
        )
        .unwrap();
        std::fs::write(source.join("payload"), "original inert package").unwrap();
        FolderTrustStore::load(&profile).trust(&project).unwrap();
        let binding = PluginProjectBinding::capture(&profile, &project).unwrap();
        let cancel = PluginCancellationToken::default();
        let revision = migration::package_revision(&source, InstallLimits::default(), &cancel)
            .unwrap()
            .sha256;
        let store = PluginStore::open_for_migration(&profile.join("plugin_store")).unwrap();
        Self {
            _temp: temp,
            profile,
            project,
            peer,
            source,
            store,
            binding,
            revision,
            cancel,
        }
    }
    fn install(&self, operation: &str) -> kcoder_plugins::InstalledPluginRecord {
        self.store
            .install_migration_snapshot_for_project(
                &self.source,
                "sample@migrated-project".parse().unwrap(),
                operation,
                &self.revision,
                &self.binding,
                &self.cancel,
            )
            .unwrap()
    }
    fn registry(&self, root: &Path, trusted: bool, settings: &PluginsSettings) -> PluginRegistry {
        PluginRegistry::discover_with_store_and_settings(root, trusted, &self.store, settings)
            .unwrap()
    }
}
#[test]
fn project_installation_is_disabled_and_runtime_never_promotes_it_to_another_workspace() {
    let f = Fixture::new();
    let operation = uuid::Uuid::new_v4().simple().to_string();
    let record = f.install(&operation);
    assert_eq!(record.project_identity, Some(f.binding.identity()));
    assert!(!record.enabled_by_default);
    let settings = PluginsSettings::default();
    let registry = f.registry(&f.project, true, &settings);
    let plugin = registry
        .plugins()
        .iter()
        .find(|p| p.id == record.plugin_id.to_string())
        .unwrap();
    assert!(!plugin.enabled);
    assert_eq!(
        plugin.required_trust_directory.as_deref(),
        Some(f.binding.root())
    );
    drop(registry);
    let child = f.project.join("child");
    PrivateDirectory::open_or_create(&child).unwrap();
    assert_eq!(f.registry(&child, true, &settings).plugins().len(), 1);
    assert!(f.registry(&f.peer, true, &settings).plugins().is_empty());
    assert!(
        f.registry(&f.project, false, &settings)
            .plugins()
            .is_empty()
    );
    let mut enabled = settings;
    enabled.installed.insert(
        record.plugin_id.to_string(),
        PluginPolicySettings {
            enabled: Some(true),
            ..Default::default()
        },
    );
    assert_eq!(
        f.registry(&f.project, true, &enabled)
            .enabled_plugins()
            .count(),
        1
    );
    assert_eq!(
        f.registry(&f.peer, true, &enabled)
            .enabled_plugins()
            .count(),
        0
    );
}
#[test]
fn project_install_receipt_reconciles_the_same_scope_and_rejects_global_or_other_target_replay() {
    let f = Fixture::new();
    let operation = uuid::Uuid::new_v4().simple().to_string();
    let original = f.install(&operation);
    assert_eq!(f.install(&operation), original);
    assert!(
        f.store
            .install_migration_snapshot(
                &f.source,
                original.plugin_id.clone(),
                &operation,
                &f.revision,
                &f.cancel
            )
            .is_err()
    );
    FolderTrustStore::load(&f.profile).trust(&f.peer).unwrap();
    let other = PluginProjectBinding::capture(&f.profile, &f.peer).unwrap();
    assert!(
        f.store
            .install_migration_snapshot_for_project(
                &f.source,
                original.plugin_id.clone(),
                &operation,
                &f.revision,
                &other,
                &f.cancel
            )
            .is_err()
    );
    std::fs::rename(&f.source, f.source.with_extension("withheld")).unwrap();
    assert!(matches!(
        migration::observe_installation_receipt(
            f.store.root(),
            &original.plugin_id,
            &operation,
            &f.revision,
            &f.cancel
        )
        .unwrap(),
        Some(PluginMigrationNativeState::Installed)
    ));
    assert!(
        f.store
            .uninstall_migration_owned(&original.plugin_id, &operation, &f.revision, &f.cancel)
            .unwrap()
    );
    assert!(f.store.read(&original.plugin_id).unwrap().is_none());
}
#[test]
fn project_trust_and_directory_replacement_are_fresh_install_preconditions() {
    let f = Fixture::new();
    FolderTrustStore::load(&f.profile)
        .never(&f.project)
        .unwrap();
    assert!(f.binding.verify().is_err());
    assert!(
        f.store
            .install_migration_snapshot_for_project(
                &f.source,
                "sample@denied".parse().unwrap(),
                &uuid::Uuid::new_v4().simple().to_string(),
                &f.revision,
                &f.binding,
                &f.cancel
            )
            .is_err()
    );
    assert!(f.store.snapshot().unwrap().installed.is_empty());
    FolderTrustStore::load(&f.profile)
        .trust(&f.project)
        .unwrap();
    std::fs::rename(&f.project, f.project.with_extension("old")).unwrap();
    PrivateDirectory::open_or_create(&f.project).unwrap();
    assert!(f.binding.verify().is_err());
    assert!(
        f.store
            .install_migration_snapshot_for_project(
                &f.source,
                "sample@changed".parse().unwrap(),
                &uuid::Uuid::new_v4().simple().to_string(),
                &f.revision,
                &f.binding,
                &f.cancel
            )
            .is_err()
    );
    assert!(f.store.snapshot().unwrap().installed.is_empty());
}
#[test]
fn ordinary_updates_preserve_project_scope_and_invalidate_the_original_undo_owner() {
    let f = Fixture::new();
    let operation = uuid::Uuid::new_v4().simple().to_string();
    let original = f.install(&operation);
    let updated = f
        .store
        .install_local(&f.source, "migrated-project")
        .unwrap();
    assert_eq!(updated.project_identity, original.project_identity);
    assert_ne!(updated.operation_id, original.operation_id);
    assert!(
        f.store
            .uninstall_migration_owned(&original.plugin_id, &operation, &f.revision, &f.cancel)
            .is_err()
    );
    assert_eq!(f.store.read(&original.plugin_id).unwrap(), Some(updated));
}
#[cfg(unix)]
#[test]
fn a_project_symlink_never_grants_installation_authority() {
    let f = Fixture::new();
    let link = f.profile.join("link");
    std::os::unix::fs::symlink(&f.project, &link).unwrap();
    assert!(PluginProjectBinding::capture(&f.profile, &link).is_err());
}

#[test]
fn trusting_the_current_child_does_not_reauthorize_a_revoked_plugin_ancestor() {
    let f = Fixture::new();
    let operation = uuid::Uuid::new_v4().simple().to_string();
    let record = f.install(&operation);
    let child = f.project.join("child");
    PrivateDirectory::open_or_create(&child).unwrap();
    let mut settings = PluginsSettings::default();
    settings.installed.insert(
        record.plugin_id.to_string(),
        PluginPolicySettings {
            enabled: Some(true),
            ..Default::default()
        },
    );
    assert_eq!(
        f.registry(&child, true, &settings)
            .enabled_plugins()
            .count(),
        1
    );
    let mut trust = FolderTrustStore::load(&f.profile);
    trust.revoke(&f.project).unwrap();
    trust.trust(&child).unwrap();
    assert_eq!(trust.check(&child), kcoder_config::FolderTrust::Trusted);
    assert_ne!(trust.check(&f.project), kcoder_config::FolderTrust::Trusted);
    assert_eq!(
        f.registry(&child, true, &settings)
            .enabled_plugins()
            .count(),
        0
    );
    trust.trust(&f.project).unwrap();
    assert_eq!(
        f.registry(&child, true, &settings)
            .enabled_plugins()
            .count(),
        1
    );
}
