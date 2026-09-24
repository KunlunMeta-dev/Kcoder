//! Account-scoped durable observation, separate from the execution journal.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::workflow_runs::WorkflowRunSnapshot;
use std::{ffi::OsStr, io::Read, path::PathBuf, sync::Mutex};
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
    let record: WorkflowRunSnapshot = serde_json::from_reader(file.take(MAX_RECORD + 1))?;
    ensure!(
        record.run_id == id,
        "workflow_corrupt: run identity mismatch"
    );
    Ok(record)
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
    let files = directory.open_regular_files(|_| true)?;
    let mut total = 0u64;
    for (leaf, file) in files {
        if leaf != OsStr::new(name) {
            total = total.saturating_add(file.metadata()?.len());
        }
    }
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
        let directory = PrivateDirectory::open_or_create(&root)?;
        let admission = transaction_lock(&directory, "admission.lock")?;
        let count = directory
            .open_regular_files(|n| n.to_string_lossy().ends_with(".json"))?
            .len();
        let previous = match read_record(&directory, &snapshot.run_id) {
            Ok(value) => Some(value),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                None
            }
            Err(error) => return Err(error),
        };
        if let Some(previous) = previous {
            ensure!(
                previous.thread_id == snapshot.thread_id
                    && previous.definition_id == snapshot.definition_id
                    && previous.version == snapshot.version,
                "workflow_owner_mismatch"
            );
            snapshot.node_states = previous.node_states;
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
            f(&mut state);
            state.revision = revision;
        }
        // A failed terminal projection must not retain a live lease through a
        // completed task's cancellation callback and appear to run forever.
        let persisted = self.persist();
        if self.state.lock().unwrap().status != "running"
            && let Some(lease) = self._lease.lock().unwrap().take()
        {
            fs2::FileExt::unlock(&lease)?;
        }
        persisted
    }
    pub fn clear_output(&self, node_id: &str) -> Result<()> {
        valid(node_id)?;
        let id = self.state.lock().unwrap().run_id.clone();
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
    let mut record = read_record(&directory, id)?;
    if record.status == "running"
        && let Some(lease) = directory.try_exclusive_lock(OsStr::new(&format!("{id}.lease")))?
    {
        record = read_record(&directory, id)?;
        if record.status != "running" {
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
    let files = directory.open_regular_files(|n| n.to_string_lossy().ends_with(".json"))?;
    ensure!(
        files.len() <= MAX_RUNS,
        "workflow_quota: too many run records"
    );
    let mut result = Vec::new();
    for (file, _) in files {
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
    let record = read_record(&directory, run)?;
    ensure!(
        record
            .node_states
            .iter()
            .any(|n| n.node_id == node && matches!(n.status.as_str(), "completed" | "failed")),
        "workflow_not_found: node"
    );
    let file = directory.open_regular_file(OsStr::new(&format!("{run}--{node}.output")))?;
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
            node_states: vec![],
        }
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
        let resumed = RunObservation::start(root.clone(), snapshot()).unwrap();
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
