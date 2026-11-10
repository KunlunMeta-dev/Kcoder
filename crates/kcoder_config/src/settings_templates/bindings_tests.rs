use super::*;

const ORIGINAL: &str = r#"{"tools":{"disabled":["bash"]}}"#;
const UPDATED: &str = r#"{"tools":{"disabled":["write"]}}"#;

fn save(store: &SettingsTemplateStore, content: &str) {
    store
        .save(&SettingsTemplateSaveParams {
            id: Some("alpha".into()),
            name: "Alpha".into(),
            description: None,
            content: content.into(),
        })
        .unwrap();
}

#[test]
fn session_versions_survive_template_edits_deletion_and_store_reopen() {
    let root = tempfile::tempdir().unwrap();
    let store = SettingsTemplateStore::open(root.path()).unwrap();
    assert!(store.freeze_default_for_session().unwrap().is_none());
    assert!(!store.root().exists());
    save(&store, ORIGINAL);
    store.set_default(Some("alpha")).unwrap();
    let original = store.freeze_default_for_session().unwrap().unwrap();
    assert_ne!(original.0, store.template_path("alpha").unwrap());
    save(&store, UPDATED);
    let updated = store.freeze_default_for_session().unwrap().unwrap();
    assert_ne!(original.0, updated.0);
    assert_ne!(original.1.revision_sha256, updated.1.revision_sha256);
    store.delete("alpha").unwrap();
    assert!(store.freeze_default_for_session().unwrap().is_none());
    assert!(store.list().unwrap().templates.is_empty());
    drop(store);
    let reopened = SettingsTemplateStore::open(root.path()).unwrap();
    for (version, content) in [(original, ORIGINAL), (updated, UPDATED)] {
        assert_eq!(
            reopened.recorded_session_path(&version.1).unwrap(),
            version.0
        );
        assert_eq!(fs::read_to_string(version.0).unwrap(), content);
    }
}

#[test]
fn legacy_bindings_upgrade_only_from_the_recorded_content() {
    for state in ["unchanged", "changed", "deleted"] {
        let root = tempfile::tempdir().unwrap();
        let store = SettingsTemplateStore::open(root.path()).unwrap();
        save(&store, ORIGINAL);
        let binding = store.binding("alpha").unwrap();
        if state == "changed" {
            save(&store, UPDATED);
        } else if state == "deleted" {
            store.delete("alpha").unwrap();
        }
        let result = store.recorded_session_path(&binding);
        if state == "unchanged" {
            assert_eq!(fs::read_to_string(result.unwrap()).unwrap(), ORIGINAL);
        } else {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("snapshot_unavailable"),
                "{state}"
            );
            assert!(!store.root().join(".bindings").exists());
        }
    }
}

#[test]
fn damaged_snapshots_are_not_overwritten_or_replaced_with_the_mutable_template() {
    for state in ["changed", "hard_link"] {
        let root = tempfile::tempdir().unwrap();
        let store = SettingsTemplateStore::open(root.path()).unwrap();
        save(&store, ORIGINAL);
        let (path, binding) = store.freeze_for_session("alpha").unwrap();
        if state == "hard_link" {
            fs::hard_link(&path, root.path().join("linked-copy")).unwrap();
        } else {
            fs::write(&path, UPDATED).unwrap();
        }
        assert!(store.recorded_session_path(&binding).is_err(), "{state}");
        assert!(store.freeze_for_session("alpha").is_err(), "{state}");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            if state == "changed" {
                UPDATED
            } else {
                ORIGINAL
            }
        );
        assert_eq!(store.read("alpha").unwrap().content, ORIGINAL);
    }
}

#[cfg(unix)]
#[test]
fn snapshot_links_do_not_redirect_reads_or_writes() {
    for directory_link in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let store = SettingsTemplateStore::open(root.path()).unwrap();
        save(&store, ORIGINAL);
        let (path, binding) = store.freeze_for_session("alpha").unwrap();
        let external = tempfile::tempdir().unwrap();
        let external_file = external.path().join(path.file_name().unwrap());
        fs::write(&external_file, ORIGINAL).unwrap();
        if directory_link {
            fs::remove_dir_all(path.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(external.path(), path.parent().unwrap()).unwrap();
        } else {
            fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(&external_file, &path).unwrap();
        }
        assert!(store.recorded_session_path(&binding).is_err());
        assert!(store.freeze_for_session("alpha").is_err());
        assert_eq!(fs::read_to_string(&external_file).unwrap(), ORIGINAL);
    }
}

#[test]
fn snapshot_limits_reject_allocation_and_preserve_existing_versions() {
    for budget in ["entries", "bytes"] {
        let root = tempfile::tempdir().unwrap();
        let store = SettingsTemplateStore::open(root.path()).unwrap();
        save(&store, ORIGINAL);
        let (path, binding) = store.freeze_for_session("alpha").unwrap();
        let cache = path.parent().unwrap();
        if budget == "entries" {
            for ordinal in 1..1024 {
                fs::write(cache.join(format!("fixture-{ordinal}")), []).unwrap();
            }
        } else {
            fs::File::create(cache.join("fixture-large"))
                .unwrap()
                .set_len(16 * 1024 * 1024)
                .unwrap();
        }
        save(&store, UPDATED);
        assert!(
            store
                .freeze_for_session("alpha")
                .unwrap_err()
                .to_string()
                .contains("snapshot_budget_exceeded"),
            "{budget}"
        );
        assert_eq!(store.recorded_session_path(&binding).unwrap(), path);
        assert_eq!(fs::read_to_string(path).unwrap(), ORIGINAL);
        assert_eq!(store.read("alpha").unwrap().content, UPDATED);
    }
}

#[test]
fn invalid_or_missing_default_content_must_not_become_an_unrestricted_session() {
    for content in [None, Some(r#"{"api_key":"fixture-only"}"#)] {
        let root = tempfile::tempdir().unwrap();
        let store = SettingsTemplateStore::open(root.path()).unwrap();
        save(&store, ORIGINAL);
        store.set_default(Some("alpha")).unwrap();
        let path = store.template_path("alpha").unwrap();
        match content {
            Some(content) => fs::write(path, content).unwrap(),
            None => fs::remove_file(path).unwrap(),
        }
        assert!(store.freeze_default_for_session().is_err());
        assert!(!store.root().join(".bindings").exists());
    }
}

#[test]
fn invalid_recorded_binding_cannot_select_a_path_or_fall_back_to_a_different_version() {
    let root = tempfile::tempdir().unwrap();
    let store = SettingsTemplateStore::open(root.path()).unwrap();
    save(&store, ORIGINAL);
    let (_, binding) = store.freeze_for_session("alpha").unwrap();
    for invalid in [
        SettingsTemplateBinding {
            id: "../alpha".into(),
            ..binding.clone()
        },
        SettingsTemplateBinding {
            revision_sha256: "../escape".into(),
            ..binding.clone()
        },
        SettingsTemplateBinding {
            revision_sha256: "0".repeat(64),
            ..binding.clone()
        },
    ] {
        assert!(store.recorded_session_path(&invalid).is_err());
    }
    assert_eq!(store.read("alpha").unwrap().content, ORIGINAL);
}
