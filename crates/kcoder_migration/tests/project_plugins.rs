use kcoder_config::{FolderTrustStore, PrivateDirectory};
use kcoder_migration::{
    assets::AssetTarget,
    batch::{BatchSource, default_resolution},
    mcp::McpTarget,
    plugin_migration::{
        PluginMigrationCandidate, PluginMigrationStage as Stage, PluginMigrationStore,
        PluginSourceProject, discover, discover_with_project,
    },
    providers::ProviderTarget,
    store::{BatchTargets, MigrationStore},
};
use kcoder_plugins::{PluginCancellationToken, PluginProjectBinding, PluginRegistry, PluginStore};
use kcoder_types::migration::{MigrationJobStatus, MigrationSourceKind as Kind};
use std::path::PathBuf;
struct Fixture {
    _root: tempfile::TempDir,
    source_profile: PathBuf,
    product: PathBuf,
    source_project: PathBuf,
    profile: PathBuf,
    project: PathBuf,
    kind: Kind,
}
impl Fixture {
    fn new(kind: Kind, scope: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let source_profile = root.path().join("source-profile");
        let product = root.path().join("product");
        let source_project = root.path().join("source-project");
        let profile = root.path().join("target-profile");
        let project = root.path().join("target-project");
        for path in [
            &source_profile,
            &product,
            &source_project,
            &profile,
            &project,
        ] {
            PrivateDirectory::open_or_create(path).unwrap();
        }
        FolderTrustStore::load(&source_profile)
            .trust(&source_project)
            .unwrap();
        FolderTrustStore::load(&profile).trust(&project).unwrap();
        let package = product.join("plugins/cache/market/sample/1.0.0");
        let format = if kind == Kind::ClaudeCode {
            ".claude-plugin"
        } else {
            ".codex-plugin"
        };
        std::fs::create_dir_all(package.join(format)).unwrap();
        std::fs::create_dir_all(package.join("skills/check")).unwrap();
        std::fs::write(
            package.join(format).join("plugin.json"),
            r#"{"name":"sample","version":"1.0.0"}"#,
        )
        .unwrap();
        std::fs::write(
            package.join("skills/check/SKILL.md"),
            "---\nname: check\ndescription: Review supplied facts\n---\nInert fixture.",
        )
        .unwrap();
        if kind == Kind::ClaudeCode {
            std::fs::create_dir(source_project.join(".claude")).unwrap();
            std::fs::write(product.join("plugins/installed_plugins.json"), serde_json::json!({"version":2,"plugins":{"sample@market":[{"scope":scope,"projectPath":source_project,"installPath":package,"version":"1.0.0"}]}}).to_string()).unwrap();
            std::fs::write(
                product.join("settings.json"),
                r#"{"enabledPlugins":{"sample@market":false}}"#,
            )
            .unwrap();
            std::fs::write(
                source_project.join(".claude/settings.json"),
                r#"{"enabledPlugins":{"sample@market":true}}"#,
            )
            .unwrap();
            std::fs::write(
                source_project.join(".claude/settings.local.json"),
                r#"{"enabledPlugins":{"sample@market":false}}"#,
            )
            .unwrap();
        } else {
            // Project-only policy is valid without an unrelated user config file.
            std::fs::create_dir(source_project.join(".codex")).unwrap();
            std::fs::write(
                source_project.join(".codex/config.toml"),
                "[plugins.\"sample@market\"]\nenabled=true\n",
            )
            .unwrap();
        }
        Self {
            _root: root,
            source_profile,
            product,
            source_project,
            profile,
            project,
            kind,
        }
    }
    fn candidate(&self) -> PluginMigrationCandidate {
        let grant =
            PluginSourceProject::capture(&self.source_profile, &self.source_project, self.kind)
                .unwrap();
        let catalog = discover_with_project(
            &self.product,
            self.kind,
            &grant,
            &PluginCancellationToken::default(),
        )
        .unwrap();
        assert_eq!(catalog.candidates.len(), 1);
        catalog.candidates.into_iter().next().unwrap()
    }
    fn target(&self) -> PluginProjectBinding {
        PluginProjectBinding::capture(&self.profile, &self.project).unwrap()
    }
    fn native(&self) -> PluginMigrationStore {
        PluginMigrationStore::open(&self.profile).unwrap()
    }
    fn ready(
        &self,
        candidate: &PluginMigrationCandidate,
        id: &str,
    ) -> kcoder_migration::plugin_migration::PluginMigrationView {
        let store = self.native();
        let prepared = store
            .prepare_mapped(id, candidate, None, Some(&self.target()))
            .unwrap();
        assert_eq!(prepared.stage, Stage::Prepared, "{:?}", prepared.pending);
        let ready = store
            .capture(id, prepared.sequence, &PluginCancellationToken::default())
            .unwrap();
        assert_eq!(ready.stage, Stage::Ready, "{:?}", ready.pending);
        ready
    }
}
#[test]
fn claude_project_local_and_codex_project_require_separate_source_and_target_authority() {
    for (kind, scope) in [
        (Kind::ClaudeCode, "project"),
        (Kind::ClaudeCode, "local"),
        (Kind::Codex, "project"),
    ] {
        let f = Fixture::new(kind, scope);
        let candidate = f.candidate();
        assert_eq!(candidate.scope, scope);
        assert_eq!(candidate.source_enabled, Some(scope != "local"));
        let native = f.native();
        let pending = native
            .prepare(&uuid::Uuid::new_v4().to_string(), &candidate)
            .unwrap();
        assert_eq!(pending.stage, Stage::Pending);
        assert!(!f.profile.join("plugin_store").exists());
        let id = uuid::Uuid::new_v4().to_string();
        let ready = f.ready(&candidate, &id);
        let installed = native
            .apply(&id, ready.sequence, &PluginCancellationToken::default())
            .unwrap();
        assert!(installed.imported);
        let store = PluginStore::open_for_migration(&f.profile.join("plugin_store")).unwrap();
        let target = installed.target_id.as_ref().unwrap().parse().unwrap();
        let record = store.read(&target).unwrap().unwrap();
        assert_eq!(record.project_identity, Some(f.target().identity()));
        assert!(!record.enabled_by_default);
        assert_eq!(
            PluginRegistry::discover_with_store_and_settings(
                &f.project,
                true,
                &store,
                &Default::default()
            )
            .unwrap()
            .plugins()
            .len(),
            1
        );
        assert!(
            PluginRegistry::discover_with_store_and_settings(
                &f.source_project,
                true,
                &store,
                &Default::default()
            )
            .unwrap()
            .plugins()
            .is_empty()
        );
        std::fs::rename(&f.product, f.product.with_extension("withheld")).unwrap();
        std::fs::rename(
            &f.source_project,
            f.source_project.with_extension("withheld"),
        )
        .unwrap();
        let observed = f
            .native()
            .read(&id, &PluginCancellationToken::default())
            .unwrap();
        assert!(observed.imported);
        let undone = f
            .native()
            .undo(&id, observed.sequence, &PluginCancellationToken::default())
            .unwrap();
        assert_eq!(undone.stage, Stage::Undone);
        assert!(undone.imported);
        assert!(store.read(&target).unwrap().is_none());
    }
}
#[test]
fn source_trust_revocation_or_source_metadata_change_cannot_publish_a_mapped_plugin() {
    for kind in [Kind::ClaudeCode, Kind::Codex] {
        let f = Fixture::new(kind, "project");
        let candidate = f.candidate();
        let id = uuid::Uuid::new_v4().to_string();
        let ready = f.ready(&candidate, &id);
        FolderTrustStore::load(&f.source_profile)
            .revoke(&f.source_project)
            .unwrap();
        assert!(
            f.native()
                .apply(&id, ready.sequence, &PluginCancellationToken::default())
                .is_err()
        );
        assert!(!f.profile.join("plugin_store").exists());
        FolderTrustStore::load(&f.source_profile)
            .trust(&f.source_project)
            .unwrap();
        let path = f.source_project.join(if kind == Kind::ClaudeCode {
            ".claude/settings.json"
        } else {
            ".codex/config.toml"
        });
        std::fs::write(path, if kind == Kind::ClaudeCode { "{}" } else { "" }).unwrap();
        let current = f
            .native()
            .read(&id, &PluginCancellationToken::default())
            .unwrap();
        assert!(
            f.native()
                .apply(&id, current.sequence, &PluginCancellationToken::default())
                .is_err()
        );
        assert!(!f.profile.join("plugin_store").exists());
    }
}
#[test]
fn project_path_provenance_is_not_a_source_project_grant_and_target_choice_is_fixed() {
    let f = Fixture::new(Kind::ClaudeCode, "project");
    let ungranted = discover(&f.product, f.kind, &PluginCancellationToken::default())
        .unwrap()
        .candidates
        .remove(0);
    let pending = f
        .native()
        .prepare_mapped(
            &uuid::Uuid::new_v4().to_string(),
            &ungranted,
            None,
            Some(&f.target()),
        )
        .unwrap();
    assert_eq!(pending.stage, Stage::Pending);
    let candidate = f.candidate();
    let id = uuid::Uuid::new_v4().to_string();
    let ready = f.ready(&candidate, &id);
    let other = f._root.path().join("other-target-project");
    PrivateDirectory::open_or_create(&other).unwrap();
    FolderTrustStore::load(&f.profile).trust(&other).unwrap();
    let mapping = PluginProjectBinding::capture(&f.profile, &other).unwrap();
    assert!(
        f.native()
            .prepare_mapped(&id, &candidate, None, Some(&mapping))
            .is_err()
    );
    assert!(f.native().prepare(&id, &candidate).is_err());
    let second = f
        .native()
        .prepare_mapped(
            &uuid::Uuid::new_v4().to_string(),
            &candidate,
            None,
            Some(&mapping),
        )
        .unwrap();
    assert_ne!(ready.target_id, second.target_id);
    FolderTrustStore::load(&f.profile)
        .revoke(&f.project)
        .unwrap();
    assert!(
        f.native()
            .apply(&id, ready.sequence, &PluginCancellationToken::default())
            .is_err()
    );
    assert!(!f.profile.join("plugin_store").exists());
}
#[test]
fn mapped_plugin_uses_the_same_ordinary_batch_owner_install_receipt_and_undo() {
    for kind in [Kind::ClaudeCode, Kind::Codex] {
        let f = Fixture::new(kind, "project");
        let candidate = f.candidate();
        let id = uuid::Uuid::new_v4().to_string();
        let ready = f.ready(&candidate, &id);
        let native = f.native();
        let source = native.batch_source(&id, ready.sequence).unwrap();
        let journal = MigrationStore::open_or_create(&f.profile).unwrap();
        let job = journal
            .create_batch_scan(vec![BatchSource::Plugin(Box::new(source))])
            .unwrap();
        let choices = job
            .inventory
            .items
            .iter()
            .filter_map(|item| default_resolution(&job, item))
            .collect::<Vec<_>>();
        assert_eq!(choices.len(), 1);
        let provider = ProviderTarget::open(&f.profile).unwrap();
        let mcp = McpTarget::open(&f.profile).unwrap();
        let assets = AssetTarget::open(&f.profile).unwrap();
        let targets = BatchTargets {
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            history: None,
            credentials: None,
        };
        let planned = journal
            .prepare_batch(&job.job_id, job.sequence, &choices, &targets)
            .unwrap();
        let plan = planned.batch.as_ref().unwrap().plan_id.as_deref().unwrap();
        let done = journal
            .run_batch(
                &job.job_id,
                plan,
                "owned-project-install",
                planned.sequence,
                false,
                &targets,
            )
            .unwrap();
        assert_eq!(
            done.inventory
                .items
                .iter()
                .filter(|item| item.preview.status
                    == kcoder_types::migration::MigrationItemStatus::Committed)
                .count(),
            1
        );
        assert!(
            native
                .apply(
                    &id,
                    native
                        .read(&id, &PluginCancellationToken::default())
                        .unwrap()
                        .sequence,
                    &PluginCancellationToken::default()
                )
                .is_err(),
            "standalone apply cannot cross the parent claim"
        );
        std::fs::rename(&f.product, f.product.with_extension("withheld")).unwrap();
        std::fs::rename(
            &f.source_project,
            f.source_project.with_extension("withheld"),
        )
        .unwrap();
        let undone = journal
            .run_batch(
                &job.job_id,
                plan,
                "owned-project-undo",
                done.sequence,
                true,
                &targets,
            )
            .unwrap();
        assert_eq!(undone.status, MigrationJobStatus::RolledBack);
        assert!(
            native
                .read(&id, &PluginCancellationToken::default())
                .unwrap()
                .imported
        );
    }
}

#[test]
fn registry_project_catalogs_preserve_their_original_trust_scope_and_opaque_grants() {
    use kcoder_migration::discovery::{DiscoveryRoots, SourceRegistry};
    let f = Fixture::new(Kind::ClaudeCode, "local");
    let mut registry = SourceRegistry::new(DiscoveryRoots {
        home: f._root.path().to_owned(),
        claude_config_dir: Some(f.product.clone()),
        codex_home: None,
        project: Some(f.source_project.clone()),
    });
    let token = PluginCancellationToken::default();
    let page = registry
        .discover_plugins_in_project(
            &[f.kind],
            None,
            &f.source_profile,
            &f.source_project,
            &token,
        )
        .unwrap();
    assert_eq!(page.candidates.len(), 1);
    let grant = &page.candidates[0].candidate_id;
    assert!(grant.starts_with("plug-"));
    assert_eq!(registry.selected_plugin(grant).unwrap().scope, "local");
    FolderTrustStore::load(&f.source_profile)
        .revoke(&f.source_project)
        .unwrap();
    assert!(registry.selected_plugin(grant).is_err());
    assert!(
        registry
            .discover_plugins_in_project(
                &[f.kind],
                None,
                &f.source_profile,
                &f.source_project,
                &token
            )
            .is_err()
    );
}
#[test]
fn explicitly_selected_product_plugin_roots_do_not_fall_back_or_authorize_another_product() {
    use kcoder_migration::discovery::SourceRegistry;
    let f = Fixture::new(Kind::ClaudeCode, "project");
    let mut registry = SourceRegistry::from_selected_product_directory(&f.product, f.kind).unwrap();
    let token = PluginCancellationToken::default();
    let pending = registry.discover_plugins(&[f.kind], None, &token).unwrap();
    assert_eq!(pending.candidates.len(), 1);
    assert!(
        pending.candidates[0]
            .candidate
            .pending
            .contains(&"plugin_project_mapping_required".into())
    );
    assert!(
        registry
            .discover_plugins(&[Kind::Codex], None, &token)
            .is_err()
    );
    registry
        .authorize_selected_project(&f.source_profile, Some(&f.source_project))
        .unwrap();
    assert_eq!(
        registry
            .discover_plugins_in_project(
                &[f.kind],
                None,
                &f.source_profile,
                &f.source_project,
                &token
            )
            .unwrap()
            .candidates
            .len(),
        1
    );
    std::fs::rename(&f.product, f.product.with_extension("old")).unwrap();
    PrivateDirectory::open_or_create(&f.product).unwrap();
    assert!(registry.discover_plugins(&[f.kind], None, &token).is_err());
}

#[test]
fn source_policy_revisions_refresh_the_grant_without_changing_the_project_installation_origin() {
    for kind in [Kind::ClaudeCode, Kind::Codex] {
        let f = Fixture::new(kind, "project");
        let first = f.candidate();
        let export = first.export_selection().unwrap();
        let first_id = uuid::Uuid::new_v4().to_string();
        let first_ready = f.ready(&first, &first_id);
        let policy = f.source_project.join(if kind == Kind::ClaudeCode {
            ".claude/settings.json"
        } else {
            ".codex/config.toml"
        });
        std::fs::write(
            policy,
            if kind == Kind::ClaudeCode {
                "{\"enabledPlugins\":{\"sample@market\":false}}"
            } else {
                "[plugins.\"sample@market\"]\nenabled=false\n"
            },
        )
        .unwrap();
        let second = f.candidate();
        assert_ne!(first.id, second.id);
        assert_eq!(second.source_enabled, Some(false));
        let next_export = second.export_selection().unwrap();
        assert_eq!(
            export.logical_identity().unwrap(),
            next_export.logical_identity().unwrap()
        );
        let second_ready = f.ready(&second, &uuid::Uuid::new_v4().to_string());
        assert_eq!(first_ready.target_id, second_ready.target_id);
        assert!(
            f.native()
                .prepare_mapped(&first_id, &second, None, Some(&f.target()))
                .is_err()
        );
    }
}
#[test]
fn export_grants_fix_metadata_and_stream_the_authorized_project_package_without_a_target_mapping() {
    for kind in [Kind::ClaudeCode, Kind::Codex] {
        let f = Fixture::new(kind, "project");
        let candidate = f.candidate();
        let export = candidate.export_selection().unwrap();
        let mut bytes = Vec::new();
        let origin = export
            .write_package(&mut bytes, &PluginCancellationToken::default())
            .unwrap();
        assert_eq!(origin.source, kind);
        assert_eq!(origin.scope, "project");
        assert!(
            origin
                .pending
                .contains(&"plugin_project_mapping_required".into())
        );
        assert!(!f.profile.join("plugin_store").exists());
        assert!(bytes.len() as u64 <= export.reserved_bytes().unwrap());
        let serialized = serde_json::to_string(&origin).unwrap();
        assert!(!serialized.contains(f.source_project.to_str().unwrap()));
        assert!(!serialized.contains(f.source_profile.to_str().unwrap()));
        assert!(!serialized.contains(f.product.to_str().unwrap()));
        std::fs::write(
            f.product
                .join("plugins/cache/market/sample/1.0.0/new-resource"),
            b"changed input",
        )
        .unwrap();
        assert!(
            export
                .write_package(&mut Vec::new(), &PluginCancellationToken::default())
                .is_err()
        );
    }
}

#[test]
fn mapped_project_cancel_reopen_and_resume_keep_the_same_source_target_and_watermark() {
    for kind in [Kind::ClaudeCode, Kind::Codex] {
        let f = Fixture::new(kind, "project");
        let candidate = f.candidate();
        let id = uuid::Uuid::new_v4().to_string();
        let prepared = f
            .native()
            .prepare_mapped(&id, &candidate, None, Some(&f.target()))
            .unwrap();
        let cancelled = f.native().cancel(&id, prepared.sequence).unwrap();
        assert!(cancelled.cancel_requested);
        assert!(cancelled.cancel_revision > 0);
        let reopened = f
            .native()
            .read(&id, &PluginCancellationToken::default())
            .unwrap();
        assert!(reopened.cancel_requested);
        let resumed = f.native().resume(&id, reopened.sequence).unwrap();
        assert!(!resumed.cancel_requested);
        assert!(resumed.cancel_revision > cancelled.cancel_revision);
        assert_eq!(resumed.target_id, prepared.target_id);
        let ready = f
            .native()
            .capture(&id, resumed.sequence, &PluginCancellationToken::default())
            .unwrap();
        assert_eq!(ready.stage, Stage::Ready);
        assert!(
            f.native()
                .capture(&id, prepared.sequence, &PluginCancellationToken::default())
                .is_err()
        );
    }
}
