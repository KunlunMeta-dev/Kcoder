//! Explicit, recoverable archival of observations; execution artifacts are retained.
use super::*;
use kcoder_types::workflow_runs::{
    WorkflowRunArchiveEntry, WorkflowRunArchivePreview, WorkflowRunArchiveResult,
};
use kcoder_workflow::store::{RunReferenceState, WorkflowStore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path};

const JOURNAL: &str = "pending.archive";
const MAX_BATCH: usize = 32;
#[derive(Debug, Serialize, Deserialize)]
struct ArchivedFile {
    leaf: String,
    retained_leaf: String,
    sha256: String,
}
#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    files: Vec<ArchivedFile>,
    result: WorkflowRunArchiveResult,
}

fn selected(ids: &[String]) -> Result<Vec<String>> {
    ensure!(
        (1..=MAX_BATCH).contains(&ids.len()),
        "workflow_invalid: select 1–32 run IDs"
    );
    for id in ids {
        valid(id)?;
    }
    let unique: BTreeSet<_> = ids.iter().cloned().collect();
    ensure!(
        unique.len() == ids.len(),
        "workflow_invalid: duplicate selected run ID"
    );
    Ok(unique.into_iter().collect())
}
fn bytes(directory: &PrivateDirectory, leaf: &str, maximum: u64) -> Result<Vec<u8>> {
    let file = directory.open_regular_file(OsStr::new(leaf))?;
    file_bytes(&file, maximum)
}
fn file_bytes(file: &std::fs::File, maximum: u64) -> Result<Vec<u8>> {
    ensure!(
        file.metadata()?.len() <= maximum,
        "workflow_quota: archived file too large"
    );
    let mut result = vec![];
    file.take(maximum + 1).read_to_end(&mut result)?;
    ensure!(
        result.len() as u64 <= maximum,
        "workflow_quota: archived file grew during read"
    );
    Ok(result)
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn archive_directory(directory: &PrivateDirectory, create: bool) -> Result<PrivateDirectory> {
    directory.open_child(OsStr::new("archive"), create)
}
fn pending(archive: &PrivateDirectory) -> Result<Option<Journal>> {
    match bytes(archive, JOURNAL, 2 * 1024 * 1024) {
        Ok(value) => Ok(Some(serde_json::from_slice(&value)?)),
        Err(e) if user_controls::missing(&e) => Ok(None),
        Err(e) => Err(e),
    }
}
/// Call with admission and quota ownership. A committed journal only removes
/// originals after every exact retained copy has been verified again.
pub(super) fn recover_locked(directory: &PrivateDirectory) -> Result<()> {
    let archive = match archive_directory(directory, false) {
        Ok(value) => value,
        Err(e) if user_controls::missing(&e) => return Ok(()),
        Err(e) => return Err(e),
    };
    let Some(journal) = pending(&archive)? else {
        return Ok(());
    };
    selected(&journal.result.archived_run_ids)?;
    ensure!(
        journal.result.preview_token.len() == 64
            && journal
                .result
                .preview_token
                .bytes()
                .all(|c| c.is_ascii_hexdigit()),
        "workflow_corrupt: archive token"
    );
    let mut leases = vec![];
    for id in &journal.result.archived_run_ids {
        leases.push(
            directory
                .try_exclusive_lock(OsStr::new(&format!("{id}.lease")))?
                .context("workflow_busy: archived run was resumed before recovery")?,
        );
    }
    for file in &journal.files {
        ensure!(
            journal
                .result
                .archived_run_ids
                .iter()
                .any(|id| file.leaf == name(id)
                    || (file.leaf.starts_with(&format!("{id}--"))
                        && file.leaf.ends_with(".output"))),
            "workflow_corrupt: archive file identity"
        );
        ensure!(
            digest(&bytes(&archive, &file.retained_leaf, MAX_OUTPUT as u64)?) == file.sha256,
            "workflow_corrupt: retained archive content changed"
        );
        match bytes(directory, &file.leaf, MAX_OUTPUT as u64) {
            Ok(value) => ensure!(
                digest(&value) == file.sha256,
                "workflow_conflict: run changed during committed archival"
            ),
            Err(e) if user_controls::missing(&e) => {}
            Err(e) => return Err(e),
        }
    }
    for file in &journal.files {
        let exact = bytes(&archive, &file.retained_leaf, MAX_OUTPUT as u64)?;
        // Latest read aliases are separate from immutable, per-revision copies.
        archive.atomic_replace(OsStr::new(&file.leaf), &exact)?;
        match directory.remove_regular_file(OsStr::new(&file.leaf)) {
            Err(e) if user_controls::missing(&e) => {}
            result => result?,
        }
    }
    let mut receipt = journal.result;
    receipt.recovery_pending = false;
    archive.atomic_replace(
        OsStr::new(&format!("{}.receipt", receipt.preview_token)),
        &serde_json::to_vec(&receipt)?,
    )?;
    archive.remove_regular_file(OsStr::new(JOURNAL))?;
    directory.sync()?;
    drop(leases);
    Ok(())
}
fn preview_locked(
    root: &Path,
    directory: &PrivateDirectory,
    library: &WorkflowStore,
    ids: &[String],
) -> Result<WorkflowRunArchivePreview> {
    let mut all = vec![];
    let mut observation_bytes = 0u64;
    let mut active_records = 0;
    let mut fingerprints = vec![];
    directory.visit_regular_files(
        |_| true,
        |leaf, file| {
            let size = file.metadata()?.len();
            all.push((leaf.to_os_string(), size));
            let leaf = leaf.to_string_lossy();
            observation_bytes = observation_bytes.saturating_add(size);
            if leaf.ends_with(".json") {
                active_records += 1;
            }
            if leaf.ends_with(".lease") || leaf.ends_with(".lock") {
                return Ok(());
            }
            if leaf.ends_with(".json") || ids.iter().any(|id| leaf.starts_with(&format!("{id}--")))
            {
                fingerprints.push((
                    leaf.to_string(),
                    size,
                    digest(&file_bytes(file, MAX_OUTPUT as u64)?),
                ));
            } else {
                fingerprints.push((leaf.to_string(), size, String::new()));
            }
            Ok(())
        },
    )?;
    fingerprints.sort();
    let mut entries = vec![];
    let mut evidence = vec![];
    for id in ids {
        let snapshot = read_record(directory, id)?;
        let mut blockers = vec![];
        let lease = directory.try_exclusive_lock(OsStr::new(&format!("{id}.lease")))?;
        if lease.is_none() {
            blockers.push("live_lease".into());
        }
        if known_lifecycle(&snapshot).is_err() {
            blockers.push("unknown_lifecycle".into());
        }
        if !matches!(
            snapshot.status.as_str(),
            "completed" | "failed" | "cancelled"
        ) {
            blockers.push("active_or_unknown_effects".into());
        }
        let mut references = vec!["execution_artifacts_and_checkpoints".into()];
        if let (Some(definition), Some(version)) = (&snapshot.definition_id, snapshot.version) {
            let known = library.verification_run_references(definition, version)?;
            let terminal = known.iter().any(|reference| {
                reference.run_id == *id
                    && reference.resume_count == snapshot.resume_count
                    && reference.state == RunReferenceState::TerminalKnown
            });
            if !terminal {
                blockers.push("unknown_effects_or_missing_verification".into());
            }
            references.push(format!("saved_version:{definition}:{version}"));
            references.push("verification_evidence".into());
            evidence.push(serde_json::to_value(known)?);
        } else if snapshot.status != "completed" {
            blockers.push("unknown_effects_or_missing_verification".into());
        }
        let size = all
            .iter()
            .filter(|(leaf, _)| {
                let leaf = leaf.to_string_lossy();
                leaf == name(id)
                    || (leaf.starts_with(&format!("{id}--")) && leaf.ends_with(".output"))
            })
            .fold(0u64, |total, (_, size)| total.saturating_add(*size));
        entries.push(WorkflowRunArchiveEntry {
            run_id: id.clone(),
            revision: snapshot.revision,
            status: snapshot.status,
            bytes: size,
            blockers,
            retained_references: references,
        });
    }
    // Canonical owner identity prevents cloned profiles from sharing confirmation.
    // Equivalent lexical paths to the same profile retain a stable token.
    let scope = root
        .canonicalize()
        .context("workflow_invalid: cannot resolve archive profile")?;
    // Tokens also bind exact selected identities, observed content, leases and evidence.
    let token = digest(&serde_json::to_vec(&(
        "workflow_run_archive_v1",
        scope.as_os_str().as_encoded_bytes(),
        ids,
        fingerprints,
        &entries,
        evidence,
    ))?);
    let releasable_bytes = entries
        .iter()
        .filter(|entry| entry.blockers.is_empty())
        .map(|entry| entry.bytes)
        .sum();
    Ok(WorkflowRunArchivePreview {
        preview_token: token,
        entries,
        active_records,
        maximum_records: MAX_RUNS,
        observation_bytes,
        maximum_observation_bytes: 64 * 1024 * 1024,
        releasable_bytes,
        retained_recovery_artifacts: true,
    })
}
pub fn archive_preview(
    root: &Path,
    library: &WorkflowStore,
    run_ids: &[String],
) -> Result<WorkflowRunArchivePreview> {
    let ids = selected(run_ids)?;
    let directory = PrivateDirectory::open_existing(root)?;
    let _admission = transaction_lock(&directory, "admission.lock")?;
    let _quota = transaction_lock(&directory, "quota.lock")?;
    recover_locked(&directory)?;
    preview_locked(root, &directory, library, &ids)
}
pub fn archive_runs(
    root: &Path,
    library: &WorkflowStore,
    run_ids: &[String],
    token: &str,
    confirm: bool,
) -> Result<WorkflowRunArchiveResult> {
    ensure!(
        confirm,
        "workflow_confirmation_required: run archival needs explicit confirmation"
    );
    ensure!(
        token.len() == 64 && token.bytes().all(|c| c.is_ascii_hexdigit()),
        "workflow_invalid: invalid preview token"
    );
    let ids = selected(run_ids)?;
    let directory = PrivateDirectory::open_existing(root)?;
    let _admission = transaction_lock(&directory, "admission.lock")?;
    let _quota = transaction_lock(&directory, "quota.lock")?;
    recover_locked(&directory)?;
    let archive = archive_directory(&directory, true)?;
    match bytes(&archive, &format!("{token}.receipt"), MAX_RECORD) {
        Ok(value) => {
            let receipt: WorkflowRunArchiveResult = serde_json::from_slice(&value)?;
            ensure!(
                receipt.archived_run_ids == ids && receipt.preview_token == token,
                "workflow_conflict: archive receipt does not match selection"
            );
            return Ok(receipt);
        }
        Err(e) if user_controls::missing(&e) => {}
        Err(e) => return Err(e),
    }
    let preview = preview_locked(root, &directory, library, &ids)?;
    ensure!(
        preview.preview_token == token,
        "workflow_conflict: archive preview is stale; preview selected runs again"
    );
    ensure!(
        preview
            .entries
            .iter()
            .all(|entry| entry.blockers.is_empty()),
        "workflow_blocked: active or unknown run effects cannot be archived"
    );
    let mut leases = vec![];
    for id in &ids {
        leases.push(
            directory
                .try_exclusive_lock(OsStr::new(&format!("{id}.lease")))?
                .context("workflow_busy: selected run became active")?,
        );
    }
    let mut files = vec![];
    directory.visit_regular_files(
        |leaf| {
            let leaf = leaf.to_string_lossy();
            ids.iter().any(|id| {
                leaf == name(id)
                    || (leaf.starts_with(&format!("{id}--")) && leaf.ends_with(".output"))
            })
        },
        |leaf, file| {
            let leaf = leaf.to_string_lossy().into_owned();
            let value = file_bytes(file, MAX_OUTPUT as u64)?;
            let retained_leaf =
                format!("{}.retained", digest(&serde_json::to_vec(&(token, &leaf))?));
            match bytes(&archive, &retained_leaf, MAX_OUTPUT as u64) {
                Ok(existing) => ensure!(
                    existing == value,
                    "workflow_conflict: retained archive copy differs"
                ),
                Err(e) if user_controls::missing(&e) => {
                    archive.atomic_publish_from_reader(
                        OsStr::new(&retained_leaf),
                        &mut value.as_slice(),
                        false,
                        || Ok(None),
                    )?;
                }
                Err(e) => return Err(e),
            }
            files.push(ArchivedFile {
                leaf,
                retained_leaf,
                sha256: digest(&value),
            });
            Ok(())
        },
    )?;
    let mut result = WorkflowRunArchiveResult {
        preview_token: token.into(),
        archived_run_ids: ids,
        released_bytes: preview.releasable_bytes,
        retained_recovery_artifacts: true,
        recovery_pending: false,
    };
    // Every recovery copy is durable before this explicit commit point.
    let journal_bytes = serde_json::to_vec(&Journal {
        files,
        result: result.clone(),
    })?;
    if let Err(error) = archive.atomic_replace(OsStr::new(JOURNAL), &journal_bytes)
        && bytes(&archive, JOURNAL, 2 * 1024 * 1024)?.as_slice() != journal_bytes.as_slice()
    {
        return Err(error);
    }
    drop(leases);
    if let Err(error) = recover_locked(&directory) {
        result.recovery_pending = true;
        tracing::warn!("workflow archival committed; recovery pending: {error:#}");
    }
    Ok(result)
}
pub fn read_archived(root: &Path, id: &str) -> Result<WorkflowRunSnapshot> {
    valid(id)?;
    let directory = PrivateDirectory::open_existing(root)?;
    let mut record = read_record(&archive_directory(&directory, false)?, id)?;
    record.interaction_modified |= user_controls::modified(&directory, id)?;
    Ok(record)
}
pub fn list_archived(root: &Path) -> Result<Vec<WorkflowRunSnapshot>> {
    let owner = match PrivateDirectory::open_existing(root) {
        Ok(value) => value,
        Err(e) if user_controls::missing(&e) => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    let directory = match archive_directory(&owner, false) {
        Ok(value) => value,
        Err(e) if user_controls::missing(&e) => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    let mut records = vec![];
    directory.visit_regular_files(
        |name| name.to_string_lossy().ends_with(".json"),
        |leaf, _| {
            let leaf = leaf.to_string_lossy();
            let id = leaf.strip_suffix(".json").unwrap();
            let mut record = read_record(&directory, id)?;
            record.interaction_modified |= user_controls::modified(&owner, id)?;
            records.push(record);
            Ok(())
        },
    )?;
    records.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then(left.run_id.cmp(&right.run_id))
    });
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(id: &str) -> WorkflowRunSnapshot {
        serde_json::from_value(serde_json::json!({"runId":id,"definitionId":null,"version":null,"threadId":"thread","workspace":"/fixture","revision":1,"status":"completed","startedAtMs":1,"updatedAtMs":2,"resumeCount":0,"nodeStates":[]})).unwrap()
    }
    fn fixture(count: usize) -> (tempfile::TempDir, PathBuf, WorkflowStore) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runs");
        let directory = PrivateDirectory::open_or_create(&root).unwrap();
        for i in 0..count {
            let id = format!("run-{i}");
            directory
                .atomic_replace(
                    OsStr::new(&name(&id)),
                    &serde_json::to_vec(&record(&id)).unwrap(),
                )
                .unwrap();
        }
        let library = WorkflowStore::new(temp.path().join("library"));
        (temp, root, library)
    }
    #[test]
    fn explicit_archive_releases_full_record_quota_without_losing_history() {
        #[cfg(unix)]
        {
            const CHILD: &str = "KCODER_ARCHIVE_DESCRIPTOR_CHILD";
            if std::env::var_os(CHILD).is_none() {
                let output = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "workflow_runs::run_archive::tests::explicit_archive_releases_full_record_quota_without_losing_history", "--test-threads=1"])
                    .env(CHILD, "1")
                    .output().unwrap();
                let stdout = String::from_utf8_lossy(&output.stdout);
                assert!(
                    output.status.success() && stdout.contains("1 passed;"),
                    "{stdout}{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                return;
            }
            let mut limits = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            // SAFETY: only this isolated child changes its descriptor budget.
            assert_eq!(
                unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limits) },
                0
            );
            limits.rlim_cur = limits.rlim_max.min(64);
            assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limits) }, 0);
        }
        let (_temp, root, library) = fixture(MAX_RUNS);
        let ids = vec!["run-0".to_string()];
        let preview = archive_preview(&root, &library, &ids).unwrap();
        assert_eq!(preview.active_records, MAX_RUNS);
        assert!(preview.entries[0].blockers.is_empty());
        let result = archive_runs(&root, &library, &ids, &preview.preview_token, true).unwrap();
        assert!(result.released_bytes > 0);
        assert_eq!(list(root.clone()).unwrap().len(), MAX_RUNS - 1);
        assert_eq!(read_archived(&root, "run-0").unwrap().status, "completed");
        let mut next = record("new-run");
        next.status = "running".into();
        let _new = RunObservation::start(root, next).unwrap();
    }
    #[test]
    fn unchanged_preview_is_stable_and_missing_confirmation_preserves_every_record() {
        let (_temp, root, library) = fixture(2);
        let ids = vec!["run-0".into()];
        let preview = archive_preview(&root, &library, &ids).unwrap();
        let next = archive_preview(&root, &library, &ids).unwrap();
        assert_eq!(preview.preview_token, next.preview_token);
        assert!(archive_runs(&root, &library, &ids, &preview.preview_token, false).is_err());
        assert_eq!(list(root).unwrap().len(), 2);
    }
    #[test]
    fn live_leases_and_unknown_effects_cannot_be_archived() {
        let (_temp, root, library) = fixture(2);
        let directory = PrivateDirectory::open_existing(&root).unwrap();
        let lease = directory
            .try_exclusive_lock(OsStr::new("run-0.lease"))
            .unwrap()
            .unwrap();
        let ids = vec!["run-0".into()];
        let preview = archive_preview(&root, &library, &ids).unwrap();
        assert!(preview.entries[0].blockers.contains(&"live_lease".into()));
        assert!(archive_runs(&root, &library, &ids, &preview.preview_token, true).is_err());
        drop(lease);
        for status in ["failed", "cancelled", "interrupted", "future_status"] {
            let mut value = record("run-1");
            value.status = status.into();
            directory
                .atomic_replace(
                    OsStr::new("run-1.json"),
                    &serde_json::to_vec(&value).unwrap(),
                )
                .unwrap();
            let ids = vec!["run-1".into()];
            let preview = archive_preview(&root, &library, &ids).unwrap();
            assert!(!preview.entries[0].blockers.is_empty());
            assert!(archive_runs(&root, &library, &ids, &preview.preview_token, true).is_err());
        }
    }
    #[test]
    fn late_revision_invalidates_preview_without_removing_records() {
        let (_temp, root, library) = fixture(2);
        let ids = vec!["run-0".into()];
        let preview = archive_preview(&root, &library, &ids).unwrap();
        let directory = PrivateDirectory::open_existing(&root).unwrap();
        let mut value = record("run-0");
        value.revision = 2;
        directory
            .atomic_replace(
                OsStr::new("run-0.json"),
                &serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
        assert!(
            archive_runs(&root, &library, &ids, &preview.preview_token, true)
                .unwrap_err()
                .to_string()
                .contains("stale")
        );
        assert_eq!(list(root).unwrap().len(), 2);
    }
    #[test]
    fn byte_quota_can_be_released_while_every_output_remains_readable() {
        let (_temp, root, library) = fixture(1);
        let directory = PrivateDirectory::open_existing(&root).unwrap();
        for node in 0..64 {
            directory
                .atomic_replace(
                    OsStr::new(&format!("run-0--node-{node}.output")),
                    &vec![b'x'; MAX_OUTPUT],
                )
                .unwrap();
        }
        let mut next = record("next");
        next.status = "running".into();
        assert!(RunObservation::start(root.clone(), next.clone()).is_err());
        let ids = vec!["run-0".into()];
        let preview = archive_preview(&root, &library, &ids).unwrap();
        assert!(preview.observation_bytes >= 64 * 1024 * 1024);
        let result = archive_runs(&root, &library, &ids, &preview.preview_token, true).unwrap();
        assert!(result.released_bytes >= 64 * 1024 * 1024);
        let archive = archive_directory(&directory, false).unwrap();
        assert_eq!(
            bytes(&archive, "run-0--node-63.output", MAX_OUTPUT as u64)
                .unwrap()
                .len(),
            MAX_OUTPUT
        );
        let _next = RunObservation::start(root, next).unwrap();
    }
    #[test]
    fn committed_interruption_recovers_before_admission_and_receipt_is_idempotent() {
        let (_temp, root, library) = fixture(1);
        let ids = vec!["run-0".into()];
        let preview = archive_preview(&root, &library, &ids).unwrap();
        let directory = PrivateDirectory::open_existing(&root).unwrap();
        let archive = archive_directory(&directory, true).unwrap();
        let source = bytes(&directory, "run-0.json", MAX_RECORD).unwrap();
        archive
            .atomic_replace(OsStr::new("retained.copy"), &source)
            .unwrap();
        let result = WorkflowRunArchiveResult {
            preview_token: preview.preview_token.clone(),
            archived_run_ids: ids.clone(),
            released_bytes: source.len() as u64,
            retained_recovery_artifacts: true,
            recovery_pending: false,
        };
        let journal = Journal {
            files: vec![ArchivedFile {
                leaf: "run-0.json".into(),
                retained_leaf: "retained.copy".into(),
                sha256: digest(&source),
            }],
            result,
        };
        archive
            .atomic_replace(OsStr::new(JOURNAL), &serde_json::to_vec(&journal).unwrap())
            .unwrap();
        let mut next = record("next");
        next.status = "running".into();
        let _next = RunObservation::start(root.clone(), next).unwrap();
        assert!(!root.join("run-0.json").exists());
        let receipt = archive_runs(&root, &library, &ids, &preview.preview_token, true).unwrap();
        assert_eq!(receipt.archived_run_ids, ids);
        assert!(!receipt.recovery_pending);
        assert_eq!(read_archived(&root, "run-0").unwrap().status, "completed");
    }
    #[test]
    fn retained_copy_corruption_never_removes_the_original() {
        let (_temp, root, _library) = fixture(1);
        let directory = PrivateDirectory::open_existing(&root).unwrap();
        let archive = archive_directory(&directory, true).unwrap();
        archive
            .atomic_replace(OsStr::new("retained.copy"), b"corrupt")
            .unwrap();
        let result = WorkflowRunArchiveResult {
            preview_token: "a".repeat(64),
            archived_run_ids: vec!["run-0".into()],
            released_bytes: 1,
            retained_recovery_artifacts: true,
            recovery_pending: false,
        };
        let journal = Journal {
            files: vec![ArchivedFile {
                leaf: "run-0.json".into(),
                retained_leaf: "retained.copy".into(),
                sha256: "expected".into(),
            }],
            result,
        };
        archive
            .atomic_replace(OsStr::new(JOURNAL), &serde_json::to_vec(&journal).unwrap())
            .unwrap();
        assert!(recover_locked(&directory).is_err());
        assert!(root.join("run-0.json").exists());
        assert!(root.join("archive").join(JOURNAL).exists());
    }
    #[test]
    fn archived_run_can_resume_with_a_new_attempt_without_recycling_its_identity() {
        let (_temp, root, library) = fixture(1);
        let ids = vec!["run-0".into()];
        let preview = archive_preview(&root, &library, &ids).unwrap();
        archive_runs(&root, &library, &ids, &preview.preview_token, true).unwrap();
        let mut next = record("run-0");
        next.status = "running".into();
        next.resume_count = 1;
        let resumed = RunObservation::start(root.clone(), next).unwrap();
        assert_eq!(read(root.clone(), "run-0").unwrap().resume_count, 1);
        resumed
            .update(|state| state.status = "completed".into())
            .unwrap();
        assert_eq!(read_archived(&root, "run-0").unwrap().resume_count, 0);
        let preview = archive_preview(&root, &library, &ids).unwrap();
        archive_runs(&root, &library, &ids, &preview.preview_token, true).unwrap();
        assert_eq!(read_archived(&root, "run-0").unwrap().resume_count, 1);
    }
    #[test]
    fn saved_version_evidence_and_run_references_survive_observation_archival() {
        use kcoder_workflow::store::{RuntimeVerification, definition_fingerprint};
        let (_temp, root, library) = fixture(1);
        let draft = library.create("Saved evidence", "").unwrap();
        let node = serde_json::from_value(serde_json::json!({"id":"code","kind":"code","title":"Code","config":{"code":{"source":"return 1;"}}})).unwrap();
        let draft = library
            .upsert_node(&draft.id, draft.revision, node)
            .unwrap();
        let saved = library.save(&draft.id, draft.revision).unwrap();
        let parent = library.create("Pinned parent", "").unwrap();
        let pin = serde_json::from_value(serde_json::json!({"id":"call","kind":"subworkflow","title":"Pinned child","config":{"subworkflow":{"definitionId":saved.id,"version":1,"arguments":{}}}})).unwrap();
        let parent = library
            .upsert_node(&parent.id, parent.revision, pin)
            .unwrap();
        let _parent = library.save(&parent.id, parent.revision).unwrap();
        let pins_before = library
            .version_references(&saved.id, 1, &[])
            .unwrap()
            .pin_count;
        assert!(pins_before > 0);
        let directory = PrivateDirectory::open_existing(&root).unwrap();
        let mut value = record("run-0");
        value.definition_id = Some(saved.id.clone());
        value.version = Some(1);
        directory
            .atomic_replace(
                OsStr::new("run-0.json"),
                &serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
        let ids = vec!["run-0".into()];
        assert!(
            archive_preview(&root, &library, &ids).unwrap().entries[0]
                .blockers
                .contains(&"unknown_effects_or_missing_verification".into())
        );
        let evidence: RuntimeVerification = serde_json::from_value(serde_json::json!({"definitionId":saved.id,"savedVersion":1,"definitionSha256":definition_fingerprint(&saved).unwrap(),"runId":"run-0","resumeCount":0,"startedAtMs":1,"updatedAtMs":2,"executionStatus":"completed","outcomeCertainty":"known","checkStatus":"not_requested","scope":"configured_result_checks","checkedNodes":[],"skippedNodes":[],"inputSha256":"fixture","privateInputRef":"private","outputSha256":null,"privateOutputRef":null,"modelSnapshot":{},"safetySha256":null,"interactionModified":false})).unwrap();
        library.record_verification(&evidence).unwrap();
        let preview = archive_preview(&root, &library, &ids).unwrap();
        assert!(preview.entries[0].blockers.is_empty());
        archive_runs(&root, &library, &ids, &preview.preview_token, true).unwrap();
        let references = version_references(root, &library, &saved.id, 1).unwrap();
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].state, RunReferenceState::TerminalKnown);
        assert_eq!(library.read_saved(&saved.id, Some(1)).unwrap(), saved);
        assert_eq!(
            library
                .version_references(&saved.id, 1, &references)
                .unwrap()
                .pin_count,
            pins_before
        );
        assert_eq!(
            library
                .verification_run_references(&saved.id, 1)
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn cloned_profiles_cannot_share_preview_confirmation() {
        let (_first_temp, first_root, first_library) = fixture(1);
        let (_second_temp, second_root, second_library) = fixture(1);
        let ids = vec!["run-0".into()];
        let first = archive_preview(&first_root, &first_library, &ids).unwrap();
        let second = archive_preview(&second_root, &second_library, &ids).unwrap();
        assert_ne!(first.preview_token, second.preview_token);
        assert!(
            archive_runs(
                &second_root,
                &second_library,
                &ids,
                &first.preview_token,
                true
            )
            .is_err()
        );
        assert!(second_root.join("run-0.json").exists());
        assert!(!second_root.join("archive/run-0.json").exists());
    }
    #[test]
    fn equivalent_profile_paths_keep_the_same_preview_and_receipt_identity() {
        let (_temp, root, library) = fixture(1);
        let ids = vec!["run-0".into()];
        let first = archive_preview(&root, &library, &ids).unwrap();
        let alias = root.join(".");
        let second = archive_preview(&alias, &library, &ids).unwrap();
        assert_eq!(first.preview_token, second.preview_token);
        let result = archive_runs(&alias, &library, &ids, &first.preview_token, true).unwrap();
        let retry = archive_runs(&root, &library, &ids, &first.preview_token, true).unwrap();
        assert_eq!(result.archived_run_ids, retry.archived_run_ids);
        assert_eq!(result.preview_token, retry.preview_token);
    }
}
