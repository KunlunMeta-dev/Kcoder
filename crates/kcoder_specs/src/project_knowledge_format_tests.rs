use super::*;
use crate::project_knowledge::ProjectKnowledgeAccess;
use std::{fs, path::PathBuf};

// These required field types match the readers at 3701165cf; unknown optional fields were ignored.
#[derive(Debug, Default, Deserialize)]
struct LegacySnapshot {
    requirements: Vec<RequirementFingerprint>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct LegacyMetadata {
    name: String,
    title: Option<String>,
    schema: Option<String>,
    created_at: String,
    #[serde(default)]
    status: ChangeStatus,
}

fn legacy_sync_decode(bytes: Option<&[u8]>) -> Result<LegacySnapshot> {
    // The old sync propagated parse errors; only an absent file became a default base.
    Ok(bytes
        .map(serde_json::from_slice)
        .transpose()?
        .unwrap_or_default())
}

fn legacy_archive_initial_read(metadata: &[u8], base: Option<&[u8]>) -> Result<()> {
    let _: LegacyMetadata = serde_yaml::from_slice(metadata)?;
    legacy_sync_decode(base)?;
    Ok(())
}

fn guarded_change() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    crate::init(root.path()).unwrap();
    let profile = root.path().join("profile");
    fs::create_dir(&profile).unwrap();
    kcoder_config::FolderTrustStore::load(&profile)
        .trust(root.path())
        .unwrap();
    let access = ProjectKnowledgeAccess::open(root.path(), &profile, None, "format-task").unwrap();
    let path = ".kcoder/specs/specs/core/spec.md";
    let view = access.read(&[path.into()], 65536, || true).unwrap();
    let preview = access
        .propose(
            &view,
            &view.scope,
            path,
            &view.sources[0].revision,
            &view.sources[0].content,
        )
        .unwrap();
    let change = access
        .new_change(
            "guarded-format",
            None,
            preview.change_base.as_ref().unwrap(),
        )
        .unwrap();
    fs::write(change.join("tasks.md"), "- [x] reviewed\n").unwrap();
    (root, change)
}

#[test]
fn project_knowledge_guarded_required_fields_refuse_old_readers_even_when_base_is_missing() {
    let (_root, change) = guarded_change();
    let bytes = fs::read(change.join(".base.json")).unwrap();
    let metadata = fs::read(change.join(".spec.yaml")).unwrap();
    let wire: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(wire["requirements"]["format"], GUARDED_BASE_FORMAT);
    assert!(serde_json::from_slice::<LegacySnapshot>(&bytes).is_err());
    assert!(legacy_sync_decode(Some(&bytes)).is_err());
    assert!(serde_yaml::from_slice::<LegacyMetadata>(&metadata).is_err());
    assert!(legacy_archive_initial_read(&metadata, Some(&bytes)).is_err());
    assert!(legacy_archive_initial_read(&metadata, None).is_err());
    let current: ChangeMetadata = serde_yaml::from_slice(&metadata).unwrap();
    assert!(current.requires_guarded_base);
    assert_eq!(current.schema.as_deref(), Some("spec-driven"));
    // Old explicit sync never inspected metadata. With a missing base it could
    // write an ordinary base, but the retained metadata must keep it unpublishable.
    fs::remove_file(change.join(".base.json")).unwrap();
    assert!(legacy_sync_decode(None).unwrap().requirements.is_empty());
    let recaptured = serde_json::json!({"requirements":wire["requirements"]["entries"]});
    let recaptured = serde_json::to_vec(&recaptured).unwrap();
    legacy_sync_decode(Some(&recaptured)).unwrap();
    fs::write(change.join(".base.json"), &recaptured).unwrap();
    assert!(crate::fingerprint::load_base_snapshot(&change).is_err());
    assert!(legacy_archive_initial_read(&metadata, Some(&recaptured)).is_err());
    assert_eq!(fs::read(change.join(".spec.yaml")).unwrap(), metadata);
}

#[test]
fn project_knowledge_unguarded_legacy_formats_remain_compatible() {
    let root = tempfile::tempdir().unwrap();
    crate::init(root.path()).unwrap();
    let change = crate::new_change(root.path(), "legacy", None).unwrap();
    let bytes = fs::read(change.join(".base.json")).unwrap();
    let metadata = fs::read(change.join(".spec.yaml")).unwrap();
    assert!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["requirements"].is_array()
    );
    let legacy = legacy_sync_decode(Some(&bytes)).unwrap();
    assert!(!legacy.requirements.is_empty());
    legacy_archive_initial_read(&metadata, Some(&bytes)).unwrap();
    assert!(
        !serde_yaml::from_slice::<ChangeMetadata>(&metadata)
            .unwrap()
            .requires_guarded_base
    );
    fs::remove_file(change.join(".base.json")).unwrap();
    assert!(
        crate::fingerprint::load_base_snapshot(&change)
            .unwrap()
            .knowledge_sources
            .is_empty()
    );
    crate::sync(root.path(), "legacy").unwrap();
    let restored = fs::read(change.join(".base.json")).unwrap();
    legacy_sync_decode(Some(&restored)).unwrap();
}

#[test]
fn project_knowledge_missing_downgraded_or_unknown_base_never_falls_back_to_legacy() {
    for damage in ["missing", "legacy", "unknown", "empty-guards"] {
        let (root, change) = guarded_change();
        let path = change.join(".base.json");
        let mut wire: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        match damage {
            "missing" => fs::remove_file(&path).unwrap(),
            "legacy" => fs::write(&path, b"{\"requirements\":[]}").unwrap(),
            "unknown" => {
                wire["requirements"]["format"] = serde_json::json!("future-unknown");
                fs::write(&path, serde_json::to_vec(&wire).unwrap()).unwrap();
            }
            _ => {
                wire["requirements"]["knowledge_sources"] = serde_json::json!([]);
                fs::write(&path, serde_json::to_vec(&wire).unwrap()).unwrap();
            }
        }
        let before = fs::read(&path).ok();
        let spec_path = root.path().join(".kcoder/specs/specs/core/spec.md");
        let source_before = fs::read(&spec_path).unwrap();
        assert!(
            crate::fingerprint::load_base_snapshot(&change).is_err(),
            "{damage}"
        );
        assert!(
            crate::apply_preflight(root.path(), "guarded-format").is_err(),
            "{damage}"
        );
        assert!(
            !crate::status(root.path(), "guarded-format")
                .unwrap()
                .drift_errors
                .is_empty(),
            "{damage}"
        );
        assert!(
            crate::sync(root.path(), "guarded-format").is_err(),
            "{damage}"
        );
        assert!(
            crate::archive(root.path(), "guarded-format").is_err(),
            "{damage}"
        );
        assert!(
            crate::merge_change(&crate::specs_dir_for(root.path()), &change).is_err(),
            "{damage}"
        );
        assert!(
            crate::capture_base_snapshot(&crate::specs_dir_for(root.path()), &change).is_err(),
            "{damage}"
        );
        assert_eq!(fs::read(&path).ok(), before, "{damage}");
        assert_eq!(fs::read(&spec_path).unwrap(), source_before, "{damage}");
        assert!(change.exists());
    }
}

#[test]
fn project_knowledge_unknown_metadata_format_is_not_treated_as_an_old_change() {
    let (root, change) = guarded_change();
    let path = change.join(".spec.yaml");
    let mut metadata: serde_yaml::Value =
        serde_yaml::from_slice(&fs::read(&path).unwrap()).unwrap();
    metadata["schema"]["required_base_format"] =
        serde_yaml::Value::String("unknown-version".into());
    let bytes = serde_yaml::to_string(&metadata).unwrap();
    fs::write(&path, &bytes).unwrap();
    assert!(crate::fingerprint::load_base_snapshot(&change).is_err());
    assert!(crate::sync(root.path(), "guarded-format").is_err());
    assert!(crate::archive(root.path(), "guarded-format").is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), bytes);
}

#[test]
fn project_knowledge_unversioned_optional_guards_are_rejected_instead_of_ignored() {
    let snapshot = serde_json::json!({"requirements":[],"knowledge_sources":[{
        "path":".kcoder/specs/specs/core/spec.md", "revision":"0".repeat(64)
    }]});
    assert!(serde_json::from_value::<BaseSnapshot>(snapshot).is_err());
}
