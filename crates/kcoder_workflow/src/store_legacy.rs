//! Legacy record compatibility: static receipts are immutable sidecars, not new JSON fields.
use super::*;
use std::collections::BTreeSet;
const STATIC: &str = "static-verification";
const MAX_STATIC_BYTES: usize = 16 * 1024 * 1024;
fn leaf(id: &str, version: u64, definition: &WorkflowDefinition) -> Result<String> {
    Ok(format!(
        "{id}-{version}-{}.json",
        definition_fingerprint(definition)?
    ))
}
pub(super) fn merge_checks(directory: &PrivateDirectory, library: &mut Library) -> Result<()> {
    let child = match directory.open_child(OsStr::new(STATIC), false) {
        Ok(child) => child,
        Err(error) if not_found(&error) => return Ok(()),
        Err(error) => return Err(error),
    };
    for (id, record) in &mut library.records {
        for (version, definition) in &record.versions {
            if record.static_checks.contains_key(version) {
                continue;
            }
            let name = leaf(id, *version, definition)?;
            let file = match child.open_regular_file(OsStr::new(&name)) {
                Ok(file) => file,
                Err(error) if not_found(&error) => continue,
                Err(error) => return Err(error),
            };
            ensure!(
                file.metadata()?.len() <= 64 * 1024,
                "workflow_quota: static receipt too large"
            );
            let receipt: StaticVerification = serde_json::from_reader(file.take(64 * 1024 + 1))
                .context("workflow_corrupt: invalid legacy static receipt")?;
            record.static_checks.insert(*version, receipt);
        }
    }
    Ok(())
}
pub(super) fn compatible_bytes(library: &Library) -> Result<Vec<u8>> {
    let mut value = serde_json::to_value(library)?;
    if let Some(records) = value
        .get_mut("records")
        .and_then(serde_json::Value::as_object_mut)
    {
        for record in records.values_mut() {
            if let Some(record) = record.as_object_mut() {
                record.remove("static_checks");
            }
        }
    }
    Ok(serde_json::to_vec(&value)?)
}
pub(super) fn stage_checks(directory: &PrivateDirectory, library: &Library) -> Result<()> {
    if library
        .records
        .values()
        .all(|record| record.static_checks.is_empty())
    {
        return Ok(());
    }
    let child = directory.open_child(OsStr::new(STATIC), true)?;
    let mut planned = BTreeMap::new();
    for (id, record) in &library.records {
        for (version, checks) in &record.static_checks {
            let definition = record
                .versions
                .get(version)
                .context("workflow_corrupt: static receipt without version")?;
            let bytes = serde_json::to_vec(checks)?;
            ensure!(
                bytes.len() <= 64 * 1024,
                "workflow_quota: static receipt too large"
            );
            planned.insert(leaf(id, *version, definition)?, bytes);
        }
    }
    let existing = child.open_regular_files(|name| name.to_string_lossy().ends_with(".json"))?;
    let mut total = planned.values().map(Vec::len).sum::<usize>();
    for (name, file) in &existing {
        if !planned.contains_key(name.to_str().unwrap_or("")) {
            total = total.saturating_add(file.metadata()?.len() as usize);
        }
    }
    ensure!(
        total <= MAX_STATIC_BYTES,
        "workflow_quota: static receipt staging budget full; prior data retained"
    );
    for (name, bytes) in &planned {
        match child.open_regular_file(OsStr::new(name)) {
            Ok(file) => {
                ensure!(
                    file.metadata()?.len() <= 64 * 1024,
                    "workflow_quota: static receipt too large"
                );
                let mut prior = Vec::new();
                file.take(64 * 1024 + 1).read_to_end(&mut prior)?;
                ensure!(
                    prior == *bytes,
                    "workflow_corrupt: immutable static receipt changed"
                );
            }
            Err(error) if not_found(&error) => child.atomic_replace(OsStr::new(name), bytes)?,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
pub(super) fn cleanup_checks(directory: &PrivateDirectory, library: &Library) {
    let Ok(child) = directory.open_child(OsStr::new(STATIC), false) else {
        return;
    };
    let mut referenced = BTreeSet::new();
    for (id, record) in &library.records {
        for (version, definition) in &record.versions {
            if let Ok(name) = leaf(id, *version, definition) {
                referenced.insert(name);
            }
        }
    }
    if let Ok(files) = child.open_regular_files(|name| name.to_string_lossy().ends_with(".json")) {
        for (name, _) in files {
            if !referenced.contains(name.to_str().unwrap_or("")) {
                let _ = child.remove_regular_file(&name);
            }
        }
    }
}
pub(super) fn usage(directory: &PrivateDirectory, library: &Library) -> Result<usize> {
    let mut total = match directory.open_regular_file(OsStr::new(LIBRARY)) {
        Ok(file) => file.metadata()?.len() as usize,
        Err(error) if not_found(&error) => 0,
        Err(error) => return Err(error),
    };
    if let Ok(child) = directory.open_child(OsStr::new(STATIC), false) {
        for (id, record) in &library.records {
            for (version, definition) in &record.versions {
                if record.static_checks.contains_key(version) {
                    let name = leaf(id, *version, definition)?;
                    total = total.saturating_add(
                        child
                            .open_regular_file(OsStr::new(&name))?
                            .metadata()?
                            .len() as usize,
                    );
                }
            }
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct OldLibrary {
        format_version: u32,
        records: BTreeMap<String, OldRecord>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct OldRecord {
        draft: WorkflowDefinition,
        versions: BTreeMap<u64, WorkflowDefinition>,
        #[serde(default)]
        layout_changes: BTreeMap<String, u64>,
    }
    #[test]
    fn legacy_and_rollback_json_are_old_reader_compatible_with_separate_real_static_receipts() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let draft = store.create("Compatibility", "").unwrap();
        let node:WorkflowNode=serde_json::from_value(serde_json::json!({"id":"code","kind":"code","title":"Code","config":{"code":{"source":"return 1;"}}})).unwrap();
        let draft = store.upsert_node(&draft.id, draft.revision, node).unwrap();
        let saved = store.save(&draft.id, draft.revision).unwrap();
        let raw = std::fs::read(store.root.join(LIBRARY)).unwrap();
        let old: OldLibrary = serde_json::from_slice(&raw).unwrap();
        assert_eq!(old.format_version, 2);
        assert_eq!(old.records[&saved.id].draft, saved);
        assert_eq!(old.records[&saved.id].versions[&1], saved);
        assert!(old.records[&saved.id].layout_changes.is_empty());
        assert!(!String::from_utf8(raw).unwrap().contains("static_checks"));
        let before = store
            .verification(&saved.id, 1)
            .unwrap()
            .static_check
            .unwrap();
        store.migrate_storage().unwrap();
        store.rollback_storage().unwrap();
        let old: OldLibrary =
            serde_json::from_slice(&std::fs::read(store.root.join(LIBRARY)).unwrap()).unwrap();
        assert_eq!(old.records[&saved.id].versions[&1], saved);
        let after = store
            .verification(&saved.id, 1)
            .unwrap()
            .static_check
            .unwrap();
        assert_eq!(before.definition_sha256, after.definition_sha256);
        assert_eq!(before.checked_at_ms, after.checked_at_ms);
        assert_eq!(before.checked_nodes, after.checked_nodes);
    }
}
