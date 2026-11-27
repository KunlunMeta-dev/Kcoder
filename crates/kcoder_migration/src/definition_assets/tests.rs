//! Owned synthetic storage tests exercise receipts and real filesystem identities.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_config::{PrivateDirectory, imported_context::ImportedContextScope};
use kcoder_types::{
    migration::MigrationSourceKind, migration_definitions::MigrationDefinitionFormat,
};
use std::{fs, path::PathBuf};
struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let directory = PrivateDirectory::open_or_create(&profile).unwrap();
        directory
            .open_child(std::ffi::OsStr::new("migrations"), true)
            .unwrap();
        Self {
            _root: root,
            profile,
        }
    }
    fn directory(&self) -> PathBuf {
        self.profile.join("migrations/pending-definitions")
    }
    fn state(&self) -> Vec<u8> {
        fs::read(self.directory().join("migration-pending-definitions.json")).unwrap()
    }
}
fn record() -> DefinitionRecord {
    let bytes =
        b"name='synthetic'\ndescription='fixture'\ndeveloper_instructions='never executed'\n";
    DefinitionRecord {
        id: format!("def-{}", uuid::Uuid::new_v4().simple()),
        operation_id: format!("plan-{}", uuid::Uuid::new_v4().simple()),
        name: "Pending synthetic".into(),
        scope: ImportedContextScope::Global,
        source: MigrationSourceKind::Codex,
        source_revision: "synthetic-content-revision".into(),
        report: crate::definition_adapter::report(MigrationDefinitionFormat::CodexAgentToml, bytes),
        data: STANDARD.encode(bytes),
    }
}
#[test]
fn exact_lost_publication_and_undo_receipts_reconcile_without_republishing() {
    let f = Fixture::new();
    let (store, binding) = DefinitionStore::for_plan(&f.profile).unwrap();
    let record = record();
    assert_eq!(store.observe(&binding, &record).unwrap(), None);
    store.publish(&binding, &record, false, false).unwrap();
    let saved = f.state();
    drop(store);
    let store = DefinitionStore::existing(&f.profile, &binding).unwrap();
    assert_eq!(store.observe(&binding, &record).unwrap(), Some(false));
    store.publish(&binding, &record, true, true).unwrap();
    assert_eq!(f.state(), saved);
    let mut foreign = record.clone();
    foreign.data = STANDARD.encode(b"changed");
    assert_eq!(
        store
            .publish(&binding, &foreign, false, false)
            .unwrap_err()
            .to_string(),
        "migration_receipt_conflict"
    );
    assert_eq!(f.state(), saved);
    store.rollback(&binding, &record).unwrap();
    let undone = f.state();
    assert_eq!(store.observe(&binding, &record).unwrap(), None);
    store.rollback(&binding, &record).unwrap();
    assert_eq!(f.state(), undone);
    assert!(store.publish(&binding, &record, false, false).is_err());
    assert_eq!(f.state(), undone);
}
#[test]
fn changed_content_and_missing_or_replaced_storage_are_not_repaired() {
    for role in ["data", "state", "birth", "lock", "directory", "parent"] {
        let f = Fixture::new();
        let (store, binding) = DefinitionStore::for_plan(&f.profile).unwrap();
        let record = record();
        store.publish(&binding, &record, false, false).unwrap();
        drop(store);
        match role {
            "data" => {
                let mut state: serde_json::Value = serde_json::from_slice(&f.state()).unwrap();
                state["records"][&record.id]["data"] =
                    serde_json::json!(STANDARD.encode(b"user edited definition"));
                fs::write(
                    f.directory().join("migration-pending-definitions.json"),
                    serde_json::to_vec(&state).unwrap(),
                )
                .unwrap();
            }
            "state" => {
                fs::remove_file(f.directory().join("migration-pending-definitions.json")).unwrap();
            }
            "birth" | "lock" => {
                let name = if role == "birth" {
                    ".migration-pending-definitions.birth.json"
                } else {
                    ".migration-pending-definitions.lock"
                };
                let path = f.directory().join(name);
                let bytes = fs::read(&path).unwrap();
                fs::rename(&path, path.with_extension("original")).unwrap();
                fs::write(&path, bytes).unwrap();
            }
            "directory" => {
                let path = f.directory();
                let saved = path.with_extension("original");
                fs::rename(&path, &saved).unwrap();
                PrivateDirectory::open_or_create(&path).unwrap();
                for entry in fs::read_dir(saved).unwrap() {
                    let entry = entry.unwrap();
                    fs::rename(entry.path(), path.join(entry.file_name())).unwrap();
                }
            }
            _ => {
                let path = f.profile.join("migrations");
                let saved = path.with_extension("original");
                fs::rename(&path, &saved).unwrap();
                PrivateDirectory::open_or_create(&path).unwrap();
                for entry in fs::read_dir(saved).unwrap() {
                    let entry = entry.unwrap();
                    fs::rename(entry.path(), path.join(entry.file_name())).unwrap();
                }
            }
        }
        let before = fs::read(f.directory().join("migration-pending-definitions.json")).ok();
        if let Ok(store) = DefinitionStore::existing(&f.profile, &binding) {
            assert!(store.observe(&binding, &record).is_err());
            assert!(store.rollback(&binding, &record).is_err());
        }
        assert_eq!(
            fs::read(f.directory().join("migration-pending-definitions.json")).ok(),
            before,
            "{role} must remain unchanged"
        );
    }
}
#[test]
fn explicit_initialization_recovers_only_empty_interrupted_metadata() {
    for contains_record in [false, true] {
        let f = Fixture::new();
        let (store, binding) = DefinitionStore::for_plan(&f.profile).unwrap();
        if contains_record {
            store.publish(&binding, &record(), false, false).unwrap();
        }
        drop(store);
        let path = f
            .directory()
            .join(".migration-pending-definitions.birth.json");
        let mut birth: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        birth["ready"] = serde_json::Value::Bool(false);
        fs::write(&path, serde_json::to_vec(&birth).unwrap()).unwrap();
        assert!(
            DefinitionStore::existing(&f.profile, &binding).is_err(),
            "read never completes initialization"
        );
        let before = f.state();
        let result = DefinitionStore::for_plan(&f.profile);
        if contains_record {
            assert!(result.is_err());
        } else {
            let (_, new_binding) = result.unwrap();
            assert_eq!(new_binding.instance, binding.instance);
        }
        assert_eq!(f.state(), before);
    }
}
