//! Durable timers and user/event replies scoped to an existing account run index.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::workflow::{WorkflowAwaitRequest, WorkflowPendingRequest, WorkflowResponseValue};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::File,
    io::Read,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;
const LIMIT: u64 = 128 * 1024;
fn now() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_millis()
        .try_into()?)
}
fn valid(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty()
            && id.len() <= 160
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)),
        "workflow_wait: invalid identity"
    );
    Ok(())
}
fn name(run: &str, id: &str) -> String {
    format!("{run}--{:x}.json", Sha256::digest(id))
}
struct Lease(File);
impl Drop for Lease {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}
fn lock(dir: &PrivateDirectory) -> Result<Lease> {
    Ok(Lease(
        dir.try_exclusive_lock(OsStr::new("requests.lock"))?
            .context("workflow_wait: request storage busy; retry")?,
    ))
}
fn read(dir: &PrivateDirectory, run: &str, id: &str) -> Result<WorkflowPendingRequest> {
    let f = dir.open_regular_file(OsStr::new(&name(run, id)))?;
    ensure!(
        f.metadata()?.len() <= LIMIT,
        "workflow_wait: request exceeds limit"
    );
    let value: WorkflowPendingRequest = serde_json::from_reader(f.take(LIMIT + 1))?;
    ensure!(
        value.run_id == run && value.request_id == id,
        "workflow_wait: request identity mismatch"
    );
    Ok(value)
}
fn write(dir: &PrivateDirectory, value: &WorkflowPendingRequest) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure!(
        bytes.len() as u64 <= LIMIT,
        "workflow_wait: request exceeds limit"
    );
    let leaf = name(&value.run_id, &value.request_id);
    let files = dir.open_regular_files(|n| n.to_string_lossy().ends_with(".json"))?;
    let mut total = bytes.len() as u64;
    let mut count = 1;
    for (n, f) in files {
        if n != OsStr::new(&leaf) {
            total = total.saturating_add(f.metadata()?.len());
            count += 1;
        }
    }
    ensure!(
        count <= 1024 && total <= 64 * 1024 * 1024,
        "workflow_wait: request storage quota exceeded"
    );
    dir.atomic_replace(OsStr::new(&leaf), &bytes)
}
fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
}
fn schema(request: &WorkflowAwaitRequest) -> Option<&Value> {
    match request {
        WorkflowAwaitRequest::Human { schema, .. } | WorkflowAwaitRequest::Event { schema, .. } => {
            Some(schema)
        }
        _ => None,
    }
}

pub async fn wait(
    root: &Path,
    run: &str,
    id: &str,
    node: &str,
    request: WorkflowAwaitRequest,
    cancel: CancellationToken,
) -> Result<Value> {
    valid(run)?;
    valid(id)?;
    valid(node)?;
    crate::workflow_runs::read(root.into(), run)?;
    let dir = PrivateDirectory::open_or_create(&root.join("requests"))?;
    {
        let _guard = lock(&dir)?;
        match read(&dir, run, id) {
            Ok(previous) => ensure!(
                previous.request == request && previous.node_id == node,
                "workflow_wait: request changed during resume"
            ),
            Err(error) if missing(&error) => {
                let time = now()?;
                let deadline = match &request {
                    WorkflowAwaitRequest::Wait {
                        delay_ms,
                        until_unix_ms,
                    } => match (delay_ms, until_unix_ms) {
                        (Some(delay), None) if *delay <= 86_400_000 => time
                            .checked_add(*delay)
                            .context("workflow_wait: timestamp overflow")?,
                        (None, Some(until)) if *until <= time.saturating_add(86_400_000) => *until,
                        _ => anyhow::bail!("workflow_wait: invalid timer or more than 24 hours"),
                    },
                    WorkflowAwaitRequest::Human { timeout_ms, .. }
                    | WorkflowAwaitRequest::Event { timeout_ms, .. } => {
                        ensure!(
                            (1..=86_400_000).contains(timeout_ms),
                            "workflow_wait: invalid timeout"
                        );
                        time.checked_add(*timeout_ms)
                            .context("workflow_wait: timestamp overflow")?
                    }
                };
                write(
                    &dir,
                    &WorkflowPendingRequest {
                        run_id: run.into(),
                        request_id: id.into(),
                        node_id: node.into(),
                        request: request.clone(),
                        deadline_unix_ms: deadline,
                        status: "pending".into(),
                        response: None,
                    },
                )?;
            }
            Err(error) => return Err(error),
        }
    }
    loop {
        if cancel.is_cancelled() {
            anyhow::bail!("workflow_wait: cancelled; saved deadline and request retained");
        }
        let current = read(&dir, run, id)?;
        if current.status == "completed" {
            return current
                .response
                .map(|reply| reply.value)
                .context("workflow_wait: completed request has no response");
        }
        ensure!(
            current.status == "pending",
            "workflow_wait: request expired"
        );
        if now()? >= current.deadline_unix_ms {
            let _guard = lock(&dir)?;
            let mut current = read(&dir, run, id)?;
            if current.status == "completed" {
                continue;
            }
            if matches!(current.request, WorkflowAwaitRequest::Wait { .. }) {
                let output = json!({"deadlineUnixMs":current.deadline_unix_ms});
                current.response = Some(WorkflowResponseValue {
                    value: output.clone(),
                });
                current.status = "completed".into();
                write(&dir, &current)?;
                return Ok(output);
            }
            current.status = "expired".into();
            write(&dir, &current)?;
            anyhow::bail!("workflow_wait: response deadline expired");
        }
        let delay = current
            .deadline_unix_ms
            .saturating_sub(now()?)
            .clamp(1, 500);
        tokio::select! {_=cancel.cancelled()=>anyhow::bail!("workflow_wait: cancelled; request retained"),_=tokio::time::sleep(Duration::from_millis(delay))=>{}}
    }
}

pub fn list(root: &Path, run: &str) -> Result<Vec<WorkflowPendingRequest>> {
    valid(run)?;
    crate::workflow_runs::read(root.into(), run)?;
    let dir = match PrivateDirectory::open_existing(&root.join("requests")) {
        Ok(dir) => dir,
        Err(error) if missing(&error) => return Ok(vec![]),
        Err(error) => return Err(error),
    };
    let prefix = format!("{run}--");
    let files = dir.open_regular_files(|n| {
        n.to_string_lossy().starts_with(&prefix) && n.to_string_lossy().ends_with(".json")
    })?;
    ensure!(files.len() <= 256, "workflow_wait: too many run requests");
    let mut output = Vec::new();
    for (_, file) in files {
        ensure!(
            file.metadata()?.len() <= LIMIT,
            "workflow_wait: request too large"
        );
        let mut value: WorkflowPendingRequest = serde_json::from_reader(file.take(LIMIT + 1))?;
        ensure!(value.run_id == run, "workflow_wait: run identity mismatch");
        if value.status == "pending" {
            value.response = None;
            output.push(value);
        }
    }
    Ok(output)
}
pub fn page(root: &Path, run: &str, after: Option<&str>) -> Result<Value> {
    let mut all = list(root, run)?;
    all.sort_by(|a, b| a.request_id.cmp(&b.request_id));
    let mut output = Vec::new();
    let mut bytes = 0;
    let mut more = false;
    for item in all
        .into_iter()
        .filter(|item| after.is_none_or(|cursor| item.request_id.as_str() > cursor))
    {
        let size = serde_json::to_vec(&item)?.len();
        if output.len() >= 16 || bytes + size > 512 * 1024 {
            more = true;
            break;
        }
        bytes += size;
        output.push(item);
    }
    let next = if more {
        output.last().map(|item| item.request_id.clone())
    } else {
        None
    };
    Ok(json!({"supported":true,"requests":output,"nextAfter":next}))
}

pub fn respond(root: &Path, run: &str, id: &str, value: Value) -> Result<()> {
    valid(run)?;
    valid(id)?;
    let snapshot = crate::workflow_runs::read(root.into(), run)?;
    ensure!(
        serde_json::to_vec(&value)?.len() <= 64 * 1024,
        "workflow_wait: response too large"
    );
    let dir = PrivateDirectory::open_existing(&root.join("requests"))?;
    let _guard = lock(&dir)?;
    let mut request = read(&dir, run, id)?;
    let expected =
        schema(&request.request).context("workflow_wait: timers cannot receive replies")?;
    kcoder_workflow::graph::validate_data(expected, &value)?;
    if request.status == "completed" {
        ensure!(
            request.response.as_ref().map(|reply| &reply.value) == Some(&value),
            "workflow_wait: response conflict"
        );
        return Ok(());
    }
    ensure!(
        !matches!(
            snapshot.status.as_str(),
            "completed" | "failed" | "cancelled"
        ),
        "workflow_wait: resume this stopped run before responding"
    );
    ensure!(
        request.status == "pending" && now()? < request.deadline_unix_ms,
        "workflow_wait: response deadline expired"
    );
    request.response = Some(WorkflowResponseValue { value });
    request.status = "completed".into();
    write(&dir, &request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow_runs::RunObservation;
    use kcoder_types::workflow_runs::WorkflowRunSnapshot;
    fn running(root: &Path) -> RunObservation {
        RunObservation::start(
            root.into(),
            WorkflowRunSnapshot {
                revision: 1,
                run_id: "run".into(),
                definition_id: None,
                version: None,
                thread_id: "thread".into(),
                workspace: "workspace".into(),
                status: "running".into(),
                error: None,
                started_at_ms: 0,
                updated_at_ms: 0,
                resume_count: 0,
                node_states: vec![],
            },
        )
        .unwrap()
    }
    async fn pending(root: &Path) {
        for _ in 0..100 {
            if !list(root, "run").unwrap().is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("request not persisted");
    }
    #[tokio::test]
    async fn human_response_is_validated_idempotent_and_reused_after_resume() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runs");
        let observation = running(&root);
        let request = WorkflowAwaitRequest::Human {
            prompt: "Approve?".into(),
            schema: json!({"type":"boolean"}),
            timeout_ms: 2000,
        };
        let task = {
            let root = root.clone();
            let request = request.clone();
            tokio::spawn(async move {
                wait(
                    &root,
                    "run",
                    "req",
                    "node",
                    request,
                    CancellationToken::new(),
                )
                .await
            })
        };
        pending(&root).await;
        assert!(respond(&root, "run", "req", json!("wrong")).is_err());
        assert!(respond(&root, "other", "req", json!(true)).is_err());
        respond(&root, "run", "req", json!(true)).unwrap();
        assert_eq!(task.await.unwrap().unwrap(), json!(true));
        observation
            .update(|state| state.status = "completed".into())
            .unwrap();
        respond(&root, "run", "req", json!(true)).unwrap();
        assert!(respond(&root, "run", "req", json!(false)).is_err());
        assert_eq!(
            wait(
                &root,
                "run",
                "req",
                "node",
                request,
                CancellationToken::new()
            )
            .await
            .unwrap(),
            json!(true)
        );
    }
    #[tokio::test]
    async fn event_accepts_null_without_losing_it_on_disk() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runs");
        let _observation = running(&root);
        let request = WorkflowAwaitRequest::Event {
            name: "done".into(),
            schema: json!({"type":"null"}),
            timeout_ms: 2000,
        };
        let task = {
            let root = root.clone();
            tokio::spawn(async move {
                wait(
                    &root,
                    "run",
                    "req",
                    "node",
                    request,
                    CancellationToken::new(),
                )
                .await
            })
        };
        pending(&root).await;
        respond(&root, "run", "req", Value::Null).unwrap();
        assert_eq!(task.await.unwrap().unwrap(), Value::Null);
    }
    #[tokio::test]
    async fn interrupted_timer_keeps_original_deadline() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runs");
        let _observation = running(&root);
        let deadline = now().unwrap() + 200;
        let request = WorkflowAwaitRequest::Wait {
            delay_ms: None,
            until_unix_ms: Some(deadline),
        };
        let cancel = CancellationToken::new();
        let task = {
            let root = root.clone();
            let request = request.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move { wait(&root, "run", "req", "node", request, cancel).await })
        };
        pending(&root).await;
        assert!(respond(&root, "run", "req", json!({})).is_err());
        cancel.cancel();
        assert!(task.await.unwrap().is_err());
        tokio::time::sleep(Duration::from_millis(220)).await;
        let resumed = wait(
            &root,
            "run",
            "req",
            "node",
            request,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(resumed["deadlineUnixMs"], deadline);
    }
}
