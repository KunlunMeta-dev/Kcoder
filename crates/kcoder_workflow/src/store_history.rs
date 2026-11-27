//! Explicit historical version archival with immutable fingerprints and reference gates.
use super::*;
const HISTORY: &str = "history";
pub const MAX_HISTORY_BYTES: usize = 32 * 1024 * 1024;
const MAX_HISTORY_OBJECT: usize = crate::graph::MAX_DEFINITION_BYTES + 64 * 1024 + 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunReferenceState {
    Active,
    Unknown,
    TerminalKnown,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionRunReference {
    pub run_id: String,
    pub definition_id: String,
    pub version: u64,
    pub state: RunReferenceState,
    pub resume_count: u32,
    #[serde(default)]
    pub definition_sha256: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionPin {
    pub definition_id: String,
    pub version: Option<u64>,
    pub node_id: String,
    pub source: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionReferences {
    pub definition_id: String,
    pub version: u64,
    pub definition_sha256: String,
    pub availability: String,
    pub latest: bool,
    pub current_revision: Option<u64>,
    pub pin_count: usize,
    pub pins: Vec<VersionPin>,
    pub run_reference_count: usize,
    pub runs: Vec<VersionRunReference>,
    pub can_archive: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalVersion {
    pub definition: WorkflowDefinition,
    pub definition_sha256: String,
    pub static_check: Option<StaticVerification>,
    pub archived_at_ms: u64,
    pub availability: String,
    pub available_for_new_runs: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionCleanup {
    pub definition_id: String,
    pub version: u64,
    pub definition_sha256: String,
    pub current_revision: u64,
    pub availability: String,
    pub historical_snapshot_retained: bool,
    pub already_archived: bool,
}
fn name(id: &str, version: u64) -> String {
    format!("{id}-{version}.json")
}
fn read_history(
    directory: &PrivateDirectory,
    id: &str,
    version: u64,
) -> Result<Option<HistoricalVersion>> {
    let child = match directory.open_child(OsStr::new(HISTORY), false) {
        Ok(child) => child,
        Err(error) if not_found(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let file = match child.open_regular_file(OsStr::new(&name(id, version))) {
        Ok(file) => file,
        Err(error) if not_found(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    ensure!(
        file.metadata()?.len() <= MAX_HISTORY_OBJECT as u64,
        "workflow_quota: historical version too large"
    );
    let value: HistoricalVersion =
        serde_json::from_reader(file.take((MAX_HISTORY_OBJECT + 1) as u64))
            .context("workflow_corrupt: invalid historical version")?;
    validate_history(&value)?;
    ensure!(
        value.definition.id == id && value.definition.saved_version == Some(version),
        "workflow_corrupt: historical identity mismatch"
    );
    Ok(Some(value))
}
fn validate_history(value: &HistoricalVersion) -> Result<()> {
    crate::graph::validate_stored(&value.definition, true)?;
    ensure!(
        value.availability == "archived_history"
            && !value.available_for_new_runs
            && value.definition.status == WorkflowStatus::Saved
            && value.definition_sha256 == definition_fingerprint(&value.definition)?,
        "workflow_corrupt: historical fingerprint/status mismatch"
    );
    if let Some(check) = &value.static_check {
        ensure!(
            check.saved_version == value.definition.saved_version.context("workflow_corrupt")?
                && check.definition_sha256 == value.definition_sha256,
            "workflow_corrupt: historical static receipt mismatch"
        );
    }
    Ok(())
}
pub(super) fn all_history(directory: &PrivateDirectory) -> Result<Vec<HistoricalVersion>> {
    let child = match directory.open_child(OsStr::new(HISTORY), false) {
        Ok(child) => child,
        Err(error) if not_found(&error) => return Ok(vec![]),
        Err(error) => return Err(error),
    };
    let mut versions = Vec::new();
    for (_, file) in child.open_regular_files(|name| name.to_string_lossy().ends_with(".json"))? {
        ensure!(
            versions.len() < 4096 && file.metadata()?.len() <= MAX_HISTORY_OBJECT as u64,
            "workflow_quota: historical version budget exceeded"
        );
        let value: HistoricalVersion =
            serde_json::from_reader(file.take((MAX_HISTORY_OBJECT + 1) as u64))?;
        validate_history(&value)?;
        versions.push(value);
    }
    Ok(versions)
}
pub(super) fn usage(directory: &PrivateDirectory) -> Result<usize> {
    let child = match directory.open_child(OsStr::new(HISTORY), false) {
        Ok(child) => child,
        Err(error) if not_found(&error) => return Ok(0),
        Err(error) => return Err(error),
    };
    let mut total = 0usize;
    for (_, file) in child.open_regular_files(|name| name.to_string_lossy().ends_with(".json"))? {
        total = total.saturating_add(file.metadata()?.len() as usize);
    }
    Ok(total)
}
fn stage_history(directory: &PrivateDirectory, value: &HistoricalVersion) -> Result<()> {
    validate_history(value)?;
    let version = value.definition.saved_version.context("workflow_unsaved")?;
    if let Some(prior) = read_history(directory, &value.definition.id, version)? {
        ensure!(
            prior.definition_sha256 == value.definition_sha256,
            "workflow_conflict: historical version cannot be overwritten"
        );
        return Ok(());
    }
    let bytes = serde_json::to_vec(value)?;
    ensure!(
        bytes.len() <= MAX_HISTORY_OBJECT
            && usage(directory)?.saturating_add(bytes.len()) <= MAX_HISTORY_BYTES,
        "workflow_quota: retained historical snapshot budget full; source version retained"
    );
    let child = directory.open_child(OsStr::new(HISTORY), true)?;
    ensure!(
        child
            .open_regular_files(|name| name.to_string_lossy().ends_with(".json"))?
            .len()
            < 4096,
        "workflow_quota: too many historical snapshots"
    );
    child.atomic_replace(OsStr::new(&name(&value.definition.id, version)), &bytes)
}
pub(super) fn restore_for_legacy(
    directory: &PrivateDirectory,
    library: &mut Library,
) -> Result<()> {
    for historical in all_history(directory)? {
        let id = &historical.definition.id;
        let version = historical
            .definition
            .saved_version
            .context("workflow_corrupt: archived version missing identity")?;
        if let Some(record) = library.records.get_mut(id) {
            if let Some(existing) = record.versions.get(&version) {
                ensure!(
                    definition_fingerprint(existing)? == historical.definition_sha256,
                    "workflow_conflict: active and historical version differ"
                );
            } else {
                record
                    .versions
                    .insert(version, historical.definition.clone());
            }
            if let Some(check) = historical.static_check {
                record.static_checks.entry(version).or_insert(check);
            }
        }
    }
    for record in library.records.values() {
        ensure!(
            record.versions.len() <= MAX_SAVED_VERSIONS
                && record
                    .versions
                    .iter()
                    .enumerate()
                    .all(|(index, (version, _))| *version == index as u64 + 1),
            "workflow_downgrade_unsupported: immutable version ordinals cannot be represented by the older format; active data and historical snapshots retained"
        );
    }
    library.format_version = if library.records.values().any(|record| {
        crate::graph::is_rich(&record.draft) || record.versions.values().any(crate::graph::is_rich)
    }) {
        2
    } else {
        1
    };
    validate_library(library)
}

fn collect_pins(
    definition: &WorkflowDefinition,
    version: Option<u64>,
    source: &str,
    id: &str,
    target: u64,
    pins: &mut Vec<VersionPin>,
) {
    for node in &definition.nodes {
        if node
            .config
            .subworkflow
            .iter()
            .chain(
                node.config
                    .r#loop
                    .iter()
                    .flat_map(|config| config.body.iter()),
            )
            .any(|reference| reference.definition_id == id && reference.version == target)
        {
            pins.push(VersionPin {
                definition_id: definition.id.clone(),
                version,
                node_id: node.id.clone(),
                source: source.into(),
            });
        }
    }
}
fn evidence_runs(
    directory: &PrivateDirectory,
    id: &str,
    version: u64,
) -> Result<Vec<VersionRunReference>> {
    let child = match directory.open_child(OsStr::new("verification"), false) {
        Ok(child) => child,
        Err(error) if not_found(&error) => return Ok(vec![]),
        Err(error) => return Err(error),
    };
    let mut runs = BTreeMap::new();
    for (_, file) in child.open_regular_files(|name| name.to_string_lossy().ends_with(".json"))? {
        ensure!(
            file.metadata()?.len() <= 64 * 1024,
            "workflow_quota: verification record too large"
        );
        let value: RuntimeVerification = serde_json::from_reader(file.take(64 * 1024 + 1))?;
        if value.definition_id == id && value.saved_version == version {
            let state = if value.execution_status == "running" || value.outcome_certainty != "known"
            {
                RunReferenceState::Unknown
            } else {
                RunReferenceState::TerminalKnown
            };
            let next = VersionRunReference {
                run_id: value.run_id.clone(),
                definition_id: id.into(),
                version,
                state,
                resume_count: value.resume_count,
                definition_sha256: Some(value.definition_sha256.clone()),
            };
            let entry = runs.entry(value.run_id).or_insert((
                value.artifact_attempt.unwrap_or(value.resume_count),
                next.clone(),
            ));
            if value.artifact_attempt.unwrap_or(value.resume_count) >= entry.0 {
                *entry = (value.artifact_attempt.unwrap_or(value.resume_count), next);
            }
        }
    }
    Ok(runs.into_values().map(|(_, run)| run).collect())
}
fn references(
    directory: &PrivateDirectory,
    library: &Library,
    id: &str,
    version: u64,
    host_runs: &[VersionRunReference],
) -> Result<VersionReferences> {
    let record = library.records.get(id);
    let active = record.and_then(|record| record.versions.get(&version));
    let historical = read_history(directory, id, version)?;
    let definition = active
        .or_else(|| historical.as_ref().map(|value| &value.definition))
        .context("workflow_not_found: version")?;
    let mut pins = Vec::new();
    for record in library.records.values() {
        collect_pins(&record.draft, None, "draft", id, version, &mut pins);
        for (saved, definition) in &record.versions {
            collect_pins(
                definition,
                Some(*saved),
                "saved_version",
                id,
                version,
                &mut pins,
            );
        }
    }
    for archived in all_history(directory)? {
        if !library
            .records
            .get(&archived.definition.id)
            .is_some_and(|record| {
                record
                    .versions
                    .contains_key(&archived.definition.saved_version.unwrap())
            })
        {
            collect_pins(
                &archived.definition,
                archived.definition.saved_version,
                "archived_history",
                id,
                version,
                &mut pins,
            );
        }
    }
    let expected_hash = definition_fingerprint(definition)?;
    let mut runs: BTreeMap<_, _> = evidence_runs(directory, id, version)?
        .into_iter()
        .map(|mut run| {
            if run.definition_sha256.as_deref() != Some(expected_hash.as_str()) {
                run.state = RunReferenceState::Unknown;
            }
            (run.run_id.clone(), run)
        })
        .collect();
    for run in host_runs
        .iter()
        .filter(|run| run.definition_id == id && run.version == version)
    {
        // Verified active ownership always blocks; missing or uncertain legacy evidence remains unknown.
        match runs.get(&run.run_id) {
            Some(existing)
                if matches!(existing.state, RunReferenceState::Unknown)
                    && !matches!(run.state, RunReferenceState::Active) => {}
            _ => {
                runs.insert(run.run_id.clone(), run.clone());
            }
        }
    }
    let mut runs: Vec<_> = runs.into_values().collect();
    runs.sort_by_key(|run| match run.state {
        RunReferenceState::Active => 0,
        RunReferenceState::Unknown => 1,
        RunReferenceState::TerminalKnown => 2,
    });
    let latest = record.is_some_and(|record| record.draft.saved_version == Some(version));
    let can_archive = active.is_some()
        && !latest
        && pins.is_empty()
        && runs
            .iter()
            .all(|run| matches!(run.state, RunReferenceState::TerminalKnown));
    Ok(VersionReferences {
        definition_id: id.into(),
        version,
        definition_sha256: definition_fingerprint(definition)?,
        availability: if active.is_some() {
            "saved"
        } else {
            "archived_history"
        }
        .into(),
        latest,
        current_revision: record.map(|record| record.draft.revision),
        pin_count: pins.len(),
        pins: pins.into_iter().take(64).collect(),
        run_reference_count: runs.len(),
        runs: runs.into_iter().take(32).collect(),
        can_archive,
    })
}
impl WorkflowStore {
    pub fn verification_run_references(
        &self,
        id: &str,
        version: u64,
    ) -> Result<Vec<VersionRunReference>> {
        crate::graph::validate_id(id)?;
        let directory = self.open(false)?.context("workflow_not_found: library")?;
        let _lease = library_lease(&directory, false)?;
        evidence_runs(&directory, id, version)
    }
    pub fn version_references(
        &self,
        id: &str,
        version: u64,
        host_runs: &[VersionRunReference],
    ) -> Result<VersionReferences> {
        crate::graph::validate_id(id)?;
        let directory = self.open(false)?.context("workflow_not_found: library")?;
        let _lease = library_lease(&directory, false)?;
        references(&directory, &load(&directory)?, id, version, host_runs)
    }
    pub fn historical_version(&self, id: &str, version: u64) -> Result<HistoricalVersion> {
        crate::graph::validate_id(id)?;
        let directory = self.open(false)?.context("workflow_not_found: library")?;
        let _lease = library_lease(&directory, false)?;
        ensure!(
            !load(&directory)?
                .records
                .get(id)
                .is_some_and(|record| record.versions.contains_key(&version)),
            "workflow_invalid: version is still published in the active library"
        );
        read_history(&directory, id, version)?.context("workflow_not_found: archived version")
    }
    /// Explicitly remove a version from publication while retaining the exact historical snapshot.
    /// Latest/pinned/live/unknown references block before any commit; ordinals are never recycled.
    pub fn archive_version(
        &self,
        id: &str,
        expected_revision: u64,
        version: u64,
        host_runs: &[VersionRunReference],
    ) -> Result<VersionCleanup> {
        crate::graph::validate_id(id)?;
        let directory = self.open(true)?.context("workflow_not_found: library")?;
        let _lease = library_lease(&directory, true)?;
        shards::recover(&directory)?;
        ensure!(
            shards::active(&directory)?,
            "workflow_migration_required: explicit version cleanup requires immutable object storage"
        );
        let mut library = load(&directory)?;
        find_mut(&mut library, id, expected_revision)?;
        let refs = references(&directory, &library, id, version, host_runs)?;
        if refs.availability == "archived_history" {
            return Ok(VersionCleanup {
                definition_id: id.into(),
                version,
                definition_sha256: refs.definition_sha256,
                current_revision: expected_revision,
                availability: "archived_history".into(),
                historical_snapshot_retained: true,
                already_archived: true,
            });
        }
        ensure!(
            refs.can_archive,
            "workflow_referenced: latest, fixed pins, active or unknown run references prevent cleanup; inspect version references"
        );
        let record = library.records.get_mut(id).context("workflow_not_found")?;
        let definition = record
            .versions
            .get(&version)
            .context("workflow_not_found: version")?
            .clone();
        let historical = HistoricalVersion {
            definition_sha256: definition_fingerprint(&definition)?,
            definition,
            static_check: record.static_checks.get(&version).cloned(),
            archived_at_ms: now_ms()?,
            availability: "archived_history".into(),
            available_for_new_runs: false,
        };
        stage_history(&directory, &historical)?;
        record.versions.remove(&version);
        record.static_checks.remove(&version);
        // Content revision/positions are independent; the retained latest ordinal is the high-water mark.
        library.format_version = 3;
        validate_library(&library)?;
        shards::commit(&directory, &library)?;
        Ok(VersionCleanup {
            definition_id: id.into(),
            version,
            definition_sha256: historical.definition_sha256,
            current_revision: expected_revision,
            availability: "archived_history".into(),
            historical_snapshot_retained: true,
            already_archived: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn initial(store: &WorkflowStore, title: &str) -> WorkflowDefinition {
        let draft = store.create(title, "").unwrap();
        let node:WorkflowNode=serde_json::from_value(serde_json::json!({"id":"code","title":"Code","kind":"code","config":{"code":{"source":"return 1;"}}})).unwrap();
        let draft = store.upsert_node(&draft.id, draft.revision, node).unwrap();
        store.save(&draft.id, draft.revision).unwrap()
    }
    fn next(store: &WorkflowStore, definition: &WorkflowDefinition) -> WorkflowDefinition {
        let draft = store
            .update_metadata(
                &definition.id,
                definition.revision,
                &definition.title,
                &format!("revision {}", definition.revision),
                None,
            )
            .unwrap();
        store.save(&draft.id, draft.revision).unwrap()
    }
    #[test]
    fn explicit_archive_is_reference_checked_fingerprint_exact_and_never_reuses_ordinals() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let first = initial(&store, "History");
        let second = next(&store, &first);
        let before = store
            .verification(&first.id, 1)
            .unwrap()
            .static_check
            .unwrap();
        assert!(
            store
                .archive_version(&first.id, second.revision, 1, &[])
                .unwrap_err()
                .to_string()
                .contains("migration_required")
        );
        store.migrate_storage().unwrap();
        assert!(
            store
                .archive_version(&first.id, second.revision, 2, &[])
                .unwrap_err()
                .to_string()
                .contains("workflow_referenced")
        );
        let refs = store.version_references(&first.id, 1, &[]).unwrap();
        assert!(refs.can_archive);
        assert!(!refs.latest);
        let archived = store
            .archive_version(&first.id, second.revision, 1, &[])
            .unwrap();
        assert!(archived.historical_snapshot_retained);
        assert_eq!(
            archived.definition_sha256,
            definition_fingerprint(&first).unwrap()
        );
        assert!(store.read_saved(&first.id, Some(1)).is_err());
        assert_eq!(
            store.historical_version(&first.id, 1).unwrap().definition,
            first
        );
        let evidence = store.verification(&first.id, 1).unwrap();
        assert_eq!(evidence.availability, "archived_history");
        assert_eq!(
            evidence.static_check.unwrap().checked_at_ms,
            before.checked_at_ms
        );
        assert!(
            store
                .archive_version(&first.id, second.revision, 1, &[])
                .unwrap()
                .already_archived
        );
        let third = next(&store, &second);
        assert_eq!(third.saved_version, Some(3));
        assert_eq!(store.versions(&first.id).unwrap().len(), 2);
        assert_eq!(store.read(&first.id).unwrap(), third);
        // Rollback restores retained contiguous history to the actual old-compatible format.
        store.rollback_storage().unwrap();
        assert_eq!(store.read_saved(&first.id, Some(1)).unwrap(), first);
        assert_eq!(store.versions(&first.id).unwrap().len(), 3);
    }
    #[test]
    fn draft_saved_and_archived_pins_block_child_version_cleanup() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let child = initial(&store, "Child");
        let child_latest = next(&store, &child);
        let parent = store.create("Parent", "").unwrap();
        let call:WorkflowNode=serde_json::from_value(serde_json::json!({"id":"call","title":"Call","kind":"subworkflow","config":{"subworkflow":{"definitionId":child.id,"version":1,"arguments":{}}}})).unwrap();
        let parent = store
            .upsert_node(&parent.id, parent.revision, call)
            .unwrap();
        let parent_saved = store.save(&parent.id, parent.revision).unwrap();
        store.migrate_storage().unwrap();
        let refs = store.version_references(&child.id, 1, &[]).unwrap();
        assert!(!refs.can_archive);
        assert!(refs.pins.iter().any(|pin| pin.source == "draft"));
        assert!(refs.pins.iter().any(|pin| pin.source == "saved_version"));
        assert!(
            store
                .archive_version(&child.id, child_latest.revision, 1, &[])
                .is_err()
        );
        let code:WorkflowNode=serde_json::from_value(serde_json::json!({"id":"code","title":"Code","kind":"code","config":{"code":{"source":"return 2;"}}})).unwrap();
        let parent = store
            .patch_nodes(
                &parent_saved.id,
                parent_saved.revision,
                vec![code],
                vec!["call".into()],
            )
            .unwrap();
        let parent_latest = store.save(&parent.id, parent.revision).unwrap();
        store
            .archive_version(&parent.id, parent_latest.revision, 1, &[])
            .unwrap();
        let refs = store.version_references(&child.id, 1, &[]).unwrap();
        assert!(refs.pins.iter().any(|pin| pin.source == "archived_history"));
        assert!(
            store
                .archive_version(&child.id, child_latest.revision, 1, &[])
                .is_err()
        );
    }
    #[test]
    fn active_and_unknown_run_references_prevent_cleanup_before_any_source_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let first = initial(&store, "Runs");
        let latest = next(&store, &first);
        store.migrate_storage().unwrap();
        for state in [RunReferenceState::Active, RunReferenceState::Unknown] {
            let run = VersionRunReference {
                run_id: "run".into(),
                definition_id: first.id.clone(),
                version: 1,
                state,
                resume_count: 0,
                definition_sha256: None,
            };
            let refs = store
                .version_references(&first.id, 1, std::slice::from_ref(&run))
                .unwrap();
            assert!(!refs.can_archive);
            assert!(
                store
                    .archive_version(&first.id, latest.revision, 1, &[run])
                    .is_err()
            );
            assert_eq!(store.read_saved(&first.id, Some(1)).unwrap(), first);
        }
        let run = VersionRunReference {
            run_id: "known".into(),
            definition_id: first.id.clone(),
            version: 1,
            state: RunReferenceState::TerminalKnown,
            resume_count: 0,
            definition_sha256: None,
        };
        assert!(
            store
                .version_references(&first.id, 1, std::slice::from_ref(&run))
                .unwrap()
                .can_archive
        );
        store
            .archive_version(&first.id, latest.revision, 1, &[run])
            .unwrap();
    }
    #[test]
    fn sparse_high_water_exceeding_old_limit_refuses_downgrade_without_dropping_active_data() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let first = initial(&store, "Many versions");
        let mut latest = first.clone();
        for _ in 1..MAX_SAVED_VERSIONS {
            latest = next(&store, &latest);
        }
        store.migrate_storage().unwrap();
        store
            .archive_version(&first.id, latest.revision, 1, &[])
            .unwrap();
        let newer = next(&store, &latest);
        assert_eq!(newer.saved_version, Some(33));
        assert!(
            store
                .rollback_storage()
                .unwrap_err()
                .to_string()
                .contains("downgrade_unsupported")
        );
        assert_eq!(store.storage_backend().unwrap(), "immutable_objects");
        assert_eq!(store.read(&first.id).unwrap(), newer);
        assert_eq!(
            store.historical_version(&first.id, 1).unwrap().definition,
            first
        );
    }
    #[test]
    fn admitted_unknown_run_blocks_archive_and_archive_blocks_delayed_new_start() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let first = initial(&store, "Admission");
        let latest = next(&store, &first);
        store.migrate_storage().unwrap();
        let mut evidence:RuntimeVerification=serde_json::from_value(serde_json::json!({"definitionId":first.id,"savedVersion":1,"definitionSha256":definition_fingerprint(&first).unwrap(),"runId":"admitted","resumeCount":0,"startedAtMs":1,"updatedAtMs":1,"executionStatus":"running","checkStatus":"pending","scope":"configured_result_checks","checkedNodes":[],"skippedNodes":[],"inputSha256":"fingerprint","privateInputRef":"private","outputSha256":null,"privateOutputRef":null,"modelSnapshot":{},"safetySha256":null,"interactionModified":false})).unwrap();
        store.admit_verification(&evidence, &first).unwrap();
        assert!(
            store
                .archive_version(&first.id, latest.revision, 1, &[])
                .is_err()
        );
        evidence.execution_status = "not_started".into();
        evidence.check_status = "incomplete".into();
        evidence.outcome_certainty = "known".into();
        store.record_verification_pinned(&evidence, &first).unwrap();
        store
            .archive_version(&first.id, latest.revision, 1, &[])
            .unwrap();
        let mut delayed = evidence;
        delayed.run_id = "delayed".into();
        delayed.execution_status = "running".into();
        delayed.check_status = "pending".into();
        delayed.outcome_certainty = "unknown".into();
        assert!(
            store
                .admit_verification(&delayed, &first)
                .unwrap_err()
                .to_string()
                .contains("version_archived")
        );
    }
}
