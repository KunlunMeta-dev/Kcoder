//! A selected product root and explicitly trusted workspace are distinct Native authorities.
use kcoder_config::PrivateDirectory;
use kcoder_migration::discovery::{ConfigurationBinding, SourceRegistry};
use kcoder_types::migration::MigrationSourceKind as Kind;
use serde_json::json;
use std::{fs, path::PathBuf};

struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    product: PathBuf,
    project: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let product = root.path().join("product");
        let project = root.path().join("workspace");
        PrivateDirectory::open_or_create(&profile).unwrap();
        for path in [&product, &project] {
            fs::create_dir(path).unwrap();
        }
        fs::create_dir(project.join(".claude")).unwrap();
        fs::write(
            product.join("settings.json"),
            r#"{"model":"user-static","env":{"ANTHROPIC_BASE_URL":"https://inert.invalid/v1"}}"#,
        )
        .unwrap();
        fs::write(
            project.join(".claude/settings.json"),
            r#"{"model":"project-static"}"#,
        )
        .unwrap();
        fs::write(
            project.join("CLAUDE.md"),
            "Static project instructions. Never executed.",
        )
        .unwrap();
        fs::write(
            profile.join("trusted-folders.json"),
            json!({"trusted":[project],"never":[]}).to_string(),
        )
        .unwrap();
        Self {
            _root: root,
            profile,
            product,
            project,
        }
    }
    fn registry(&self) -> SourceRegistry {
        SourceRegistry::from_selected_product_directory(&self.product, Kind::ClaudeCode).unwrap()
    }
    fn revoke(&self) {
        fs::write(
            self.profile.join("trusted-folders.json"),
            r#"{"trusted":[],"never":[]}"#,
        )
        .unwrap();
    }
}
fn effective(registry: &mut SourceRegistry) -> ConfigurationBinding {
    let (found, problems) = registry.discover(&[Kind::ClaudeCode], true);
    assert!(problems.is_empty(), "{problems:?}");
    registry
        .selected(
            &found
                .iter()
                .find(|row| row.scope == "project-effective")
                .unwrap()
                .source_id,
        )
        .unwrap()
}

#[test]
fn independent_workspace_configuration_and_assets_keep_both_roots_and_legacy_wire() {
    let f = Fixture::new();
    let mut registry = f.registry();
    let (before, problems) = registry.discover(&[Kind::ClaudeCode], true);
    assert!(problems.is_empty());
    assert!(before.iter().all(|row| !row.scope.starts_with("project")));
    let old = registry.selected(&before[0].source_id).unwrap();
    let old_wire = serde_json::to_value(&old).unwrap();
    assert!(old_wire["selectedRoot"].get("project").is_none());
    assert_eq!(
        serde_json::to_value(
            serde_json::from_value::<ConfigurationBinding>(old_wire.clone()).unwrap()
        )
        .unwrap(),
        old_wire
    );
    registry
        .authorize_selected_project(&f.profile, Some(&f.project))
        .unwrap();
    let layered = effective(&mut registry);
    assert!(layered.read().unwrap().text().contains("project-static"));
    assert_eq!(layered.project_root(), Some(f.project.clone()));
    let (sources, problems) = registry.discover_with_assets(&[Kind::ClaudeCode], true, true);
    assert!(problems.is_empty(), "{problems:?}");
    let asset = sources
        .iter()
        .find(|row| row.scope == "project-instructions")
        .unwrap();
    let asset = registry.selected_asset(&asset.source_id).unwrap();
    let entries = asset.entries().unwrap();
    assert!(!entries.is_empty());
    asset.read(&entries[0]).unwrap();
    assert!(
        old.read().is_ok(),
        "the old user-only grant keeps its original identity"
    );
    f.revoke();
    assert!(
        layered
            .read()
            .unwrap_err()
            .to_string()
            .contains("project_source_not_trusted")
    );
    assert!(
        asset.read(&entries[0]).is_err(),
        "project assets cannot outlive revoked workspace authority"
    );
    assert!(
        old.read().is_ok(),
        "revoking later project authorization cannot revoke a prior user-only snapshot"
    );
}

#[test]
fn authorization_cannot_refresh_a_replaced_workspace_or_product_root() {
    for replace_product in [false, true] {
        let f = Fixture::new();
        let mut registry = f.registry();
        registry
            .authorize_selected_project(&f.profile, Some(&f.project))
            .unwrap();
        let selected = effective(&mut registry);
        let root = if replace_product {
            &f.product
        } else {
            &f.project
        };
        let saved = root.with_extension("original");
        fs::rename(root, &saved).unwrap();
        fs::create_dir(root).unwrap();
        for entry in fs::read_dir(&saved).unwrap() {
            let entry = entry.unwrap();
            fs::rename(entry.path(), root.join(entry.file_name())).unwrap();
        }
        assert!(
            selected.read().is_err(),
            "moving the unchanged children cannot transfer directory identity"
        );
        assert!(
            registry
                .authorize_selected_project(&f.profile, Some(&f.project))
                .is_err(),
            "same-path authorization cannot refresh an old grant"
        );
    }
}

#[test]
fn untrusted_missing_or_different_authority_cannot_attach_a_workspace() {
    let f = Fixture::new();
    let mut registry = f.registry();
    assert!(
        registry
            .authorize_selected_project(&f.profile, None)
            .is_err()
    );
    f.revoke();
    assert!(
        registry
            .authorize_selected_project(&f.profile, Some(&f.project))
            .is_err()
    );
    assert!(
        registry
            .discover(&[Kind::ClaudeCode], false)
            .0
            .iter()
            .all(|row| !row.scope.starts_with("project"))
    );
    let f = Fixture::new();
    let mut registry = f.registry();
    registry
        .authorize_selected_project(&f.profile, Some(&f.project))
        .unwrap();
    let other = f._root.path().join("different");
    fs::create_dir(&other).unwrap();
    assert!(
        registry
            .authorize_selected_project(&f.profile, Some(&other))
            .is_err()
    );
    let other_profile = f._root.path().join("different-profile");
    PrivateDirectory::open_or_create(&other_profile).unwrap();
    assert!(
        registry
            .authorize_selected_project(&other_profile, Some(&f.project))
            .is_err()
    );
}

#[test]
fn materialized_upload_does_not_authorize_reading_an_additional_host_workspace() {
    use kcoder_migration::source_upload::SourceUploads;
    use kcoder_types::migration_source_upload::{SourceUploadFile, SourceUploadManifest};
    use sha2::{Digest, Sha256};
    let f = Fixture::new();
    let store = SourceUploads::open(&f.profile).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let body = b"model='synthetic-upload'\n";
    let view = store
        .prepare(
            &id,
            SourceUploadManifest {
                version: 1,
                source: Kind::Codex,
                files: vec![SourceUploadFile {
                    relative_path: "config.toml".into(),
                    bytes: body.len() as u64,
                    sha256: format!("{:x}", Sha256::digest(body)),
                }],
            },
        )
        .unwrap();
    store.part(&id, 0, 0, 0, body).unwrap();
    store.finish(&id, 0, |_, _| true).unwrap();
    let (_, worker) = store
        .prepare_materialization(&id, &view.manifest_sha256)
        .unwrap();
    worker.unwrap().run(|_, _| true).unwrap();
    let mut registry = store.product_registry(&id, &view.manifest_sha256).unwrap();
    assert!(
        registry
            .authorize_selected_project(&f.profile, Some(&f.project))
            .unwrap_err()
            .to_string()
            .contains("source_upload_project_selection_forbidden")
    );
    assert!(
        registry
            .discover(&[Kind::Codex], true)
            .0
            .iter()
            .all(|row| !row.scope.starts_with("project"))
    );
}
