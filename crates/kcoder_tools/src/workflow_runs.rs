//! Account-scoped durable observation, separate from the execution journal.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::domain_status::{WorkflowNodeStatus, WorkflowRunStatus};
use kcoder_types::workflow_runs::WorkflowRunSnapshot;
use std::{ffi::OsStr, io::Read, path::PathBuf, sync::Mutex};
#[path = "workflow/run_archive.rs"]
mod run_archive;
#[path = "workflow/user_controls.rs"]
mod user_controls;
pub use run_archive::{archive_preview, archive_runs, list_archived, read_archived};
pub use user_controls::{
    WorkflowControlAssociation, acknowledge_user_control, prepare_user_control,
};
const MAX_RUNS: usize = 1024;
const MAX_RECORD: u64 = 512 * 1024;
const MAX_OUTPUT: usize = 1024 * 1024;
pub struct RunObservation {
    directory: PrivateDirectory,
    _lease: Mutex<Option<std::fs::File>>,
    state: Mutex<WorkflowRunSnapshot>,
}
fn valid(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
        "workflow_invalid: invalid run/node identity"
    );
    Ok(())
}
fn name(id: &str) -> String {
    format!("{id}.json")
}
fn read_record(directory: &PrivateDirectory, id: &str) -> Result<WorkflowRunSnapshot> {
    valid(id)?;
    let file = directory.open_regular_file(OsStr::new(&name(id)))?;
    ensure!(
        file.metadata()?.len() <= MAX_RECORD,
        "workflow_quota: run record too large"
    );
    let mut record: WorkflowRunSnapshot = serde_json::from_reader(file.take(MAX_RECORD + 1))?;
    ensure!(
        record.run_id == id,
        "workflow_corrupt: run identity mismatch"
    );
    run_status(&record.status)?;
    for node in &record.node_states {
        WorkflowNodeStatus::from_raw(&node.status).map_err(anyhow::Error::msg)?;
        if let Some(status) = &node.iteration_status {
            WorkflowNodeStatus::from_raw(status).map_err(anyhow::Error::msg)?;
        }
    }
    record.interaction_modified |= user_controls::modified(directory, id)?;
    Ok(record)
}
// Domain decisions deliberately preserve raw legacy/wire labels.
fn run_status(raw: &str) -> Result<WorkflowRunStatus> {
    WorkflowRunStatus::from_raw(raw).map_err(anyhow::Error::msg)
}
pub(crate) fn known_lifecycle(snapshot: &WorkflowRunSnapshot) -> Result<()> {
    ensure!(
        run_status(&snapshot.status)?.is_known(),
        "workflow_unknown: run history is read-only"
    );
    for node in &snapshot.node_states {
        ensure!(
            WorkflowNodeStatus::from_raw(&node.status)
                .map_err(anyhow::Error::msg)?
                .is_known(),
            "workflow_unknown: node history is read-only"
        );
        if let Some(status) = &node.iteration_status {
            ensure!(
                WorkflowNodeStatus::from_raw(status)
                    .map_err(anyhow::Error::msg)?
                    .is_known(),
                "workflow_unknown: iteration history is read-only"
            );
        }
    }
    Ok(())
}
fn validate_update(previous: &WorkflowRunSnapshot, next: &WorkflowRunSnapshot) -> Result<()> {
    known_lifecycle(previous)?;
    known_lifecycle(next)?;
    ensure!(
        previous.run_id == next.run_id
            && previous.thread_id == next.thread_id
            && previous.definition_id == next.definition_id
            && previous.version == next.version
            && previous.resume_count == next.resume_count,
        "workflow_conflict: observation identity/attempt changed"
    );
    ensure!(
        run_status(&previous.status)? == WorkflowRunStatus::Running
            || previous.status == next.status,
        "workflow_conflict: stopped attempt cannot restart or change outcome"
    );
    for old in &previous.node_states {
        if let Some(new) = next
            .node_states
            .iter()
            .find(|node| node.node_id == old.node_id)
        {
            let status = WorkflowNodeStatus::from_raw(&old.status).map_err(anyhow::Error::msg)?;
            if matches!(
                status,
                WorkflowNodeStatus::Completed
                    | WorkflowNodeStatus::Failed
                    | WorkflowNodeStatus::Skipped
                    | WorkflowNodeStatus::Cancelled
                    | WorkflowNodeStatus::Interrupted
            ) {
                ensure!(
                    old.status == new.status,
                    "workflow_conflict: stopped node cannot restart within its attempt"
                );
            }
            ensure!(
                new.attempt >= old.attempt,
                "workflow_conflict: stale node attempt"
            );
        }
    }
    Ok(())
}
fn transaction_lock(directory: &PrivateDirectory, name: &str) -> Result<std::fs::File> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if let Some(lock) = directory.try_exclusive_lock(OsStr::new(name))? {
            return Ok(lock);
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "workflow_busy: run observation transaction timed out"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}
fn bounded_write(directory: &PrivateDirectory, name: &str, bytes: &[u8]) -> Result<()> {
    let lock = transaction_lock(directory, "quota.lock")?;
    let mut merged = None;
    if let Some(id) = name.strip_suffix(".json") {
        let mut snapshot: WorkflowRunSnapshot = serde_json::from_slice(bytes)?;
        snapshot.interaction_modified |= user_controls::modified(directory, id)?;
        match read_record(directory, id) {
            Ok(previous) => {
                known_lifecycle(&previous)?;
                known_lifecycle(&snapshot)?;
                ensure!(
                    snapshot.resume_count >= previous.resume_count,
                    "workflow_conflict: stale run attempt"
                );
                if snapshot.resume_count == previous.resume_count {
                    validate_update(&previous, &snapshot)?;
                }
                snapshot.interaction_modified |= previous.interaction_modified;
                if snapshot.interaction_modified && snapshot.revision <= previous.revision {
                    snapshot.revision = previous
                        .revision
                        .checked_add(1)
                        .context("workflow_quota: revision exhausted")?;
                }
                ensure!(
                    snapshot.revision > previous.revision,
                    "workflow_conflict: stale run revision"
                );
            }
            Err(error) if user_controls::missing(&error) => {}
            Err(error) => return Err(error),
        }
        merged = Some(serde_json::to_vec(&snapshot)?);
        ensure!(
            merged.as_ref().unwrap().len() as u64 <= MAX_RECORD,
            "workflow_quota: run projection too large"
        );
    }
    let bytes = merged.as_deref().unwrap_or(bytes);
    ensure!(
        bytes.len() <= MAX_OUTPUT,
        "workflow_quota: projection/output too large"
    );
    let mut total = 0u64;
    directory.visit_regular_files(
        |_| true,
        |leaf, file| {
            if leaf != OsStr::new(name) {
                total = total.saturating_add(file.metadata()?.len());
            }
            Ok(())
        },
    )?;
    ensure!(
        total.saturating_add(bytes.len() as u64) <= 64 * 1024 * 1024,
        "workflow_quota: run observation storage exceeds 64 MiB; existing history retained"
    );
    let result = directory.atomic_replace(OsStr::new(name), bytes);
    fs2::FileExt::unlock(&lock)?;
    result
}
impl RunObservation {
    pub fn start(root: PathBuf, mut snapshot: WorkflowRunSnapshot) -> Result<Self> {
        valid(&snapshot.run_id)?;
        known_lifecycle(&snapshot)?;
        ensure!(
            run_status(&snapshot.status)? == WorkflowRunStatus::Running,
            "workflow_conflict: new observation must be running"
        );
        let directory = PrivateDirectory::open_or_create(&root)?;
        let admission = transaction_lock(&directory, "admission.lock")?;
        {
            let _quota = transaction_lock(&directory, "quota.lock")?;
            run_archive::recover_locked(&directory)?;
        }
        let count = directory.count_regular_files_bounded(
            |n| n.to_string_lossy().ends_with(".json"),
            MAX_RUNS + 1,
        )?;
        let active_record = directory
            .entry_metadata(OsStr::new(&name(&snapshot.run_id)))
            .is_ok();
        if !active_record {
            ensure!(
                count < MAX_RUNS,
                "workflow_quota: run history is full; archive observations before restoring a run"
            );
        }
        let previous = match read_record(&directory, &snapshot.run_id) {
            Ok(value) => Some(value),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                match read_archived(&root, &snapshot.run_id) {
                    Ok(value) => Some(value),
                    Err(error) if user_controls::missing(&error) => None,
                    Err(error) => return Err(error),
                }
            }
            Err(error) => return Err(error),
        };
        if let Some(previous) = previous {
            known_lifecycle(&previous)?;
            ensure!(
                snapshot.resume_count >= previous.resume_count,
                "workflow_conflict: stale run attempt"
            );
            ensure!(
                previous.thread_id == snapshot.thread_id
                    && previous.definition_id == snapshot.definition_id
                    && previous.version == snapshot.version,
                "workflow_owner_mismatch"
            );
            ensure!(
                snapshot.resume_count > previous.resume_count || previous.status == "running",
                "workflow_conflict: resume requires a new attempt"
            );
            snapshot.interaction_modified |= previous.interaction_modified;
            if snapshot.resume_count == previous.resume_count {
                snapshot.node_states = previous.node_states;
            }
            // A new attempt starts with the host's pending root nodes. Only current
            // runtime completion/reuse events establish whether checkpoints still match.
            snapshot.revision = previous
                .revision
                .checked_add(1)
                .context("workflow_quota: revision exhausted")?;
        } else {
            ensure!(
                count < MAX_RUNS,
                "workflow_quota: run history is full; existing runs retained"
            );
        }
        let lease = directory
            .try_exclusive_lock(OsStr::new(&format!("{}.lease", snapshot.run_id)))?
            .context("workflow_busy: run already active")?;
        let result = Self {
            directory,
            _lease: Mutex::new(Some(lease)),
            state: Mutex::new(snapshot),
        };
        result.persist()?;
        fs2::FileExt::unlock(&admission)?;
        Ok(result)
    }
    fn persist(&self) -> Result<()> {
        let state = self.state.lock().unwrap();
        let bytes = serde_json::to_vec(&*state)?;
        ensure!(
            bytes.len() <= MAX_RECORD as usize,
            "workflow_quota: run projection too large"
        );
        bounded_write(&self.directory, &name(&state.run_id), &bytes)
    }
    pub fn update(&self, f: impl FnOnce(&mut WorkflowRunSnapshot)) -> Result<()> {
        {
            let mut state = self.state.lock().unwrap();
            let revision = state
                .revision
                .checked_add(1)
                .context("workflow_quota: revision exhausted")?;
            let mut next = state.clone();
            f(&mut next);
            validate_update(&state, &next)?;
            next.revision = revision;
            *state = next;
        }
        // A failed terminal projection must not retain a live lease through a
        // completed task's cancellation callback and appear to run forever.
        let persisted = self.persist();
        if run_status(&self.state.lock().unwrap().status)? != WorkflowRunStatus::Running
            && let Some(lease) = self._lease.lock().unwrap().take()
        {
            fs2::FileExt::unlock(&lease)?;
        }
        persisted
    }
    pub fn clear_output(&self, node_id: &str) -> Result<()> {
        valid(node_id)?;
        let id = self.state.lock().unwrap().run_id.clone();
        known_lifecycle(&read_record(&self.directory, &id)?)?;
        match self
            .directory
            .remove_regular_file(OsStr::new(&format!("{id}--{node_id}.output")))
        {
            Err(e)
                if e.downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                Ok(())
            }
            result => result,
        }
    }
    pub fn output(&self, node_id: &str, text: &str) -> Result<()> {
        valid(node_id)?;
        let id = self.state.lock().unwrap().run_id.clone();
        known_lifecycle(&read_record(&self.directory, &id)?)?;
        let mut end = text.len().min(MAX_OUTPUT);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        bounded_write(
            &self.directory,
            &format!("{id}--{node_id}.output"),
            &text.as_bytes()[..end],
        )
    }
}
impl Drop for RunObservation {
    fn drop(&mut self) {
        if let Some(lease) = self._lease.lock().unwrap().take() {
            let _ = fs2::FileExt::unlock(&lease);
        }
    }
}
pub fn read(root: PathBuf, id: &str) -> Result<WorkflowRunSnapshot> {
    let directory = PrivateDirectory::open_existing(&root)?;
    let mut record = match read_record(&directory, id) {
        Ok(value) => value,
        Err(error) if user_controls::missing(&error) => return read_archived(&root, id),
        Err(error) => return Err(error),
    };
    if run_status(&record.status)? == WorkflowRunStatus::Running
        && known_lifecycle(&record).is_ok()
        && let Some(lease) = directory.try_exclusive_lock(OsStr::new(&format!("{id}.lease")))?
    {
        record = read_record(&directory, id)?;
        if run_status(&record.status)? != WorkflowRunStatus::Running
            || known_lifecycle(&record).is_err()
        {
            fs2::FileExt::unlock(&lease)?;
            return Ok(record);
        }
        record.revision = record
            .revision
            .checked_add(1)
            .context("workflow_quota: revision exhausted")?;
        record.status = "interrupted".into();
        record.error=Some("workflow_interrupted: original runtime is no longer active; review side effects before resuming in the original conversation".into());
        for node in &mut record.node_states {
            if node.status == "running" || node.status == "retrying" {
                node.status = "interrupted".into();
            }
        }
        bounded_write(&directory, &name(id), &serde_json::to_vec(&record)?)?;
        fs2::FileExt::unlock(&lease)?;
    }
    Ok(record)
}
pub fn list(root: PathBuf) -> Result<Vec<WorkflowRunSnapshot>> {
    let directory = match PrivateDirectory::open_existing(&root) {
        Ok(d) => d,
        Err(e)
            if e.downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(vec![]);
        }
        Err(e) => return Err(e),
    };
    let mut files = Vec::new();
    directory.visit_regular_files(
        |n| n.to_string_lossy().ends_with(".json"),
        |leaf, _| {
            ensure!(
                files.len() < MAX_RUNS,
                "workflow_quota: too many run records"
            );
            files.push(leaf.to_os_string());
            Ok(())
        },
    )?;
    let mut result = Vec::new();
    for file in files {
        let n = file.to_string_lossy();
        let id = n.strip_suffix(".json").unwrap();
        result.push(read(root.clone(), id)?);
    }
    result.sort_by(|a, b| {
        b.updated_at_ms
            .cmp(&a.updated_at_ms)
            .then(a.run_id.cmp(&b.run_id))
    });
    Ok(result)
}
/// Merge all legacy/new observation identities with actual kernel lease ownership.
/// Terminal observation alone cannot prove absence of unknown effects.
pub fn version_references(
    root: PathBuf,
    library: &kcoder_workflow::store::WorkflowStore,
    id: &str,
    version: u64,
) -> Result<Vec<kcoder_workflow::store::VersionRunReference>> {
    use kcoder_workflow::store::{RunReferenceState, VersionRunReference};
    let known = library.verification_run_references(id, version)?;
    let mut observations = match list(root.clone()) {
        Ok(records) => records,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            vec![]
        }
        Err(error) => return Err(error),
    };
    for record in list_archived(&root)? {
        if !observations
            .iter()
            .any(|existing| existing.run_id == record.run_id)
        {
            observations.push(record);
        }
    }
    Ok(observations
        .into_iter()
        .filter(|record| {
            record.definition_id.as_deref() == Some(id) && record.version == Some(version)
        })
        .map(|record| {
            let state = if record.status == "running" {
                RunReferenceState::Active
            } else if matches!(record.status.as_str(), "completed" | "failed" | "cancelled")
                && known.iter().any(|evidence| {
                    evidence.run_id == record.run_id
                        && evidence.resume_count == record.resume_count
                        && evidence.state == RunReferenceState::TerminalKnown
                })
            {
                RunReferenceState::TerminalKnown
            } else {
                RunReferenceState::Unknown
            };
            VersionRunReference {
                run_id: record.run_id,
                definition_id: id.into(),
                version,
                state,
                resume_count: record.resume_count,
                definition_sha256: None,
            }
        })
        .collect())
}

pub fn output(
    root: PathBuf,
    run: &str,
    node: &str,
    offset: usize,
    limit: usize,
) -> Result<serde_json::Value> {
    valid(run)?;
    valid(node)?;
    ensure!(
        (4..=65536).contains(&limit),
        "workflow_invalid: output limit must be 4–65536"
    );
    let directory = PrivateDirectory::open_existing(&root)?;
    let mut archived = false;
    let record = match read_record(&directory, run) {
        Ok(value) => value,
        Err(error) if user_controls::missing(&error) => {
            archived = true;
            read_archived(&root, run)?
        }
        Err(error) => return Err(error),
    };
    ensure!(
        record
            .node_states
            .iter()
            .any(|n| n.node_id == node && matches!(n.status.as_str(), "completed" | "failed")),
        "workflow_not_found: node"
    );
    let leaf = format!("{run}--{node}.output");
    let file = if archived {
        directory
            .open_child(OsStr::new("archive"), false)?
            .open_regular_file(OsStr::new(&leaf))?
    } else {
        directory.open_regular_file(OsStr::new(&leaf))?
    };
    let mut bytes = Vec::new();
    file.take(MAX_OUTPUT as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_OUTPUT,
        "workflow_quota: output too large"
    );
    let text = std::str::from_utf8(&bytes)?;
    let mut start = offset.min(text.len());
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let mut end = (start + limit).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut result = serde_json::json!({"text":&text[start..end],"truncated":end<text.len()||text.len()==MAX_OUTPUT,"scope":"bounded_node_output"});
    if end < text.len() {
        result["nextOffset"] = serde_json::json!(end);
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot() -> WorkflowRunSnapshot {
        WorkflowRunSnapshot {
            revision: 1,
            run_id: "workflow-fixture".into(),
            definition_id: Some("definition".into()),
            version: Some(1),
            thread_id: "thread-fixture".into(),
            workspace: "owned-workspace".into(),
            status: "running".into(),
            error: None,
            started_at_ms: 1,
            updated_at_ms: 1,
            resume_count: 0,
            interaction_modified: false,
            node_states: vec![],
        }
    }
    #[test]
    fn unknown_run_node_and_iteration_are_readable_but_cannot_resume_or_rewrite() {
        for (run_status, node_status, iteration_status) in [
            ("external_wait", "completed", None),
            ("running", "future_node", None),
            ("running", "running", Some("future_iteration")),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("runs");
            std::fs::create_dir(&root).unwrap();
            let mut old = snapshot();
            old.status = run_status.into();
            old.node_states.push(
                serde_json::from_value(serde_json::json!({
                    "nodeId":"node", "status":node_status, "iterationStatus":iteration_status,
                    "attempt":1,"reused":false
                }))
                .unwrap(),
            );
            let file = root.join("workflow-fixture.json");
            let bytes = serde_json::to_vec(&old).unwrap();
            std::fs::write(&file, &bytes).unwrap();
            let actual = read(root.clone(), "workflow-fixture").unwrap();
            assert_eq!(actual.status, run_status);
            assert_eq!(actual.node_states[0].status, node_status);
            assert_eq!(list(root.clone()).unwrap().len(), 1);
            let mut next = snapshot();
            next.resume_count = 1;
            assert!(RunObservation::start(root, next).is_err());
            assert_eq!(std::fs::read(file).unwrap(), bytes);
        }
    }
    #[test]
    fn stopped_attempt_rejects_late_running_and_unknown_updates_without_rewriting() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runs");
        let observation = RunObservation::start(root.clone(), snapshot()).unwrap();
        assert!(
            observation
                .update(|state| state.status = "future_terminal".into())
                .is_err()
        );
        assert_eq!(read(root.clone(), "workflow-fixture").unwrap().revision, 1);
        observation
            .update(|state| state.status = "cancelled".into())
            .unwrap();
        let terminal = std::fs::read(root.join("workflow-fixture.json")).unwrap();
        assert!(
            observation
                .update(|state| state.status = "running".into())
                .is_err()
        );
        assert!(
            observation
                .update(|state| state.status = "completed".into())
                .is_err()
        );
        assert!(observation.update(|state| state.resume_count += 1).is_err());
        assert_eq!(
            std::fs::read(root.join("workflow-fixture.json")).unwrap(),
            terminal
        );
    }
    #[test]
    fn persisted_new_attempt_rejects_late_revision_and_old_epoch_writes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runs");
        let old = RunObservation::start(root.clone(), snapshot()).unwrap();
        old.update(|state| state.status = "failed".into()).unwrap();
        drop(old);
        let mut next = snapshot();
        next.resume_count = 1;
        let _active = RunObservation::start(root.clone(), next).unwrap();
        let directory = PrivateDirectory::open_existing(&root).unwrap();
        let current = read_record(&directory, "workflow-fixture").unwrap();
        let mut late = current.clone();
        late.resume_count = 0;
        late.revision += 1;
        late.status = "cancelled".into();
        assert!(
            bounded_write(
                &directory,
                "workflow-fixture.json",
                &serde_json::to_vec(&late).unwrap()
            )
            .is_err()
        );
        assert!(
            bounded_write(
                &directory,
                "workflow-fixture.json",
                &serde_json::to_vec(&current).unwrap()
            )
            .is_err()
        );
        assert_eq!(
            read_record(&directory, "workflow-fixture").unwrap().status,
            "running"
        );
    }

    #[test]
    fn version_cleanup_references_use_live_leases_and_do_not_bless_legacy_terminal_labels() {
        use kcoder_workflow::store::{
            RunReferenceState, RuntimeVerification, WorkflowStore, definition_fingerprint,
        };
        let temp = tempfile::tempdir().unwrap();
        let library = WorkflowStore::new(temp.path().join("library"));
        let draft = library.create("References", "").unwrap();
        let node=serde_json::from_value(serde_json::json!({"id":"code","kind":"code","title":"Code","config":{"code":{"source":"return 1;"}}})).unwrap();
        let draft = library
            .upsert_node(&draft.id, draft.revision, node)
            .unwrap();
        let saved = library.save(&draft.id, draft.revision).unwrap();
        let root = temp.path().join("runs");
        let mut initial = snapshot();
        initial.definition_id = Some(saved.id.clone());
        let observation = RunObservation::start(root.clone(), initial).unwrap();
        let references = version_references(root.clone(), &library, &saved.id, 1).unwrap();
        assert_eq!(references[0].state, RunReferenceState::Active);
        observation
            .update(|state| state.status = "completed".into())
            .unwrap();
        let references = version_references(root.clone(), &library, &saved.id, 1).unwrap();
        assert_eq!(references[0].state, RunReferenceState::Unknown);
        let evidence:RuntimeVerification=serde_json::from_value(serde_json::json!({"definitionId":saved.id,"savedVersion":1,"definitionSha256":definition_fingerprint(&saved).unwrap(),"runId":"workflow-fixture","resumeCount":0,"startedAtMs":1,"updatedAtMs":2,"executionStatus":"completed","outcomeCertainty":"known","checkStatus":"not_requested","scope":"configured_result_checks","checkedNodes":[],"skippedNodes":[],"inputSha256":"fixture","privateInputRef":"private","outputSha256":null,"privateOutputRef":null,"modelSnapshot":{},"safetySha256":null,"interactionModified":false})).unwrap();
        library.record_verification(&evidence).unwrap();
        let references = version_references(root, &library, &saved.id, 1).unwrap();
        assert_eq!(references[0].state, RunReferenceState::TerminalKnown);
    }

    #[test]
    fn resume_starts_pending_until_current_execution_proves_checkpoint_reuse() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runs");
        let mut initial = snapshot();
        for (id, status) in [("done", "completed"), ("retry", "failed")] {
            initial.node_states.push(
                serde_json::from_value(serde_json::json!({
                    "nodeId": id, "status": status, "attempt": 1, "reused": false,
                    "startedAtMs": 1, "finishedAtMs": 2, "error": "old failure"
                }))
                .unwrap(),
            );
        }
        let run = RunObservation::start(root.clone(), initial).unwrap();
        run.update(|state| state.status = "failed".into()).unwrap();
        drop(run);
        let mut next = snapshot();
        next.resume_count = 1;
        for id in ["done", "retry"] {
            next.node_states.push(
                serde_json::from_value(serde_json::json!({
                    "nodeId": id, "status": "pending", "attempt": 0, "reused": false
                }))
                .unwrap(),
            );
        }
        let _resumed = RunObservation::start(root.clone(), next).unwrap();
        let actual = read(root, "workflow-fixture").unwrap();
        assert_eq!(actual.status, "running");
        assert_eq!(actual.node_states[0].status, "pending");
        assert_eq!(actual.node_states[1].status, "pending");
        assert!(actual.node_states[1].error.is_none());
        assert!(actual.node_states[1].finished_at_ms.is_none());
    }

    #[test]
    fn live_lease_restart_and_owner_isolation() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("owner");
        let run = RunObservation::start(root.clone(), snapshot()).unwrap();
        assert_eq!(
            read(root.clone(), "workflow-fixture").unwrap().status,
            "running"
        );
        assert!(RunObservation::start(root.clone(), snapshot()).is_err());
        assert!(read(t.path().join("other"), "workflow-fixture").is_err());
        drop(run);
        assert_eq!(
            read(root.clone(), "workflow-fixture").unwrap().status,
            "interrupted"
        );
        let mut wrong = snapshot();
        wrong.thread_id = "different-thread".into();
        assert!(RunObservation::start(root.clone(), wrong).is_err());
        let mut next = snapshot();
        next.resume_count = 1;
        let resumed = RunObservation::start(root.clone(), next).unwrap();
        resumed.update(|r| r.status = "completed".into()).unwrap();
        assert_eq!(read(root, "workflow-fixture").unwrap().status, "completed");
    }
    #[test]
    fn terminal_write_failure_releases_the_live_lease() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("owner");
        let run = RunObservation::start(root.clone(), snapshot()).unwrap();
        let oversized = std::fs::File::create(root.join("quota-fixture.output")).unwrap();
        oversized.set_len(64 * 1024 * 1024).unwrap();
        assert!(run.update(|state| state.status = "failed".into()).is_err());
        let directory = PrivateDirectory::open_existing(&root).unwrap();
        let lease = directory
            .try_exclusive_lock(OsStr::new("workflow-fixture.lease"))
            .unwrap()
            .expect("terminal failure must not retain live lease");
        fs2::FileExt::unlock(&lease).unwrap();
    }
    #[test]
    fn node_output_is_bounded_utf8_and_rejects_traversal() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("owner");
        let mut s = snapshot();
        s.node_states
            .push(kcoder_types::workflow_runs::WorkflowNodeRun {
                node_id: "n1".into(),
                status: "completed".into(),
                iteration: None,
                iteration_status: None,
                attempt: 1,
                started_at_ms: None,
                finished_at_ms: None,
                agent_id: Some("real-agent".into()),
                reused: false,
                output_preview: None,
                error: None,
            });
        let run = RunObservation::start(root.clone(), s).unwrap();
        run.output("n1", "你好world").unwrap();
        let first = output(root.clone(), "workflow-fixture", "n1", 0, 4).unwrap();
        assert_eq!(first["text"], "你");
        assert_eq!(first["nextOffset"], 3);
        assert!(output(root.clone(), "workflow-fixture", "../secret", 0, 4).is_err());
        assert!(output(root, "workflow-fixture", "n1", 0, 0).is_err());
    }
}
