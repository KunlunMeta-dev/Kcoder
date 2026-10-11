//! Idempotent, bounded host controls tied to observed leased runs, never to parsed Agent IDs.
use super::{MAX_RECORD, read_record, transaction_lock};
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_workflow::store::WorkflowStore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, io::Read, path::Path};

const MAX_CONTROLS: usize = 4096;
const MAX_ENTRY: u64 = 4096;
const MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowControlAssociation {
    pub run_id: String,
    pub node_id: String,
    pub resume_count: u32,
    /// Prepared means enqueue may not have succeeded. It is never proof of application.
    pub phase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    thread_id: String,
    agent_id: String,
    client_id: String,
    content_sha256: String,
    association: WorkflowControlAssociation,
}

pub(super) fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

fn key(thread: &str, agent: &str, client: &str) -> Result<String> {
    for value in [thread, agent, client] {
        ensure!(
            !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control),
            "workflow_control_invalid: identity must be 1–256 bytes without control characters"
        );
    }
    Ok(format!(
        "{:x}.json",
        Sha256::digest(serde_json::to_vec(&(thread, agent, client))?)
    ))
}

fn read_receipt(directory: &PrivateDirectory, leaf: &str) -> Result<Receipt> {
    let file = directory.open_regular_file(OsStr::new(leaf))?;
    ensure!(
        file.metadata()?.len() <= MAX_ENTRY,
        "workflow_control_quota: entry too large"
    );
    let receipt: Receipt = serde_json::from_reader(file.take(MAX_ENTRY + 1))?;
    ensure!(
        key(&receipt.thread_id, &receipt.agent_id, &receipt.client_id)? == leaf
            && matches!(receipt.association.phase.as_str(), "prepared" | "queued"),
        "workflow_control_corrupt: receipt identity/phase mismatch"
    );
    Ok(receipt)
}

fn check_budget(directory: &PrivateDirectory, leaf: &str, bytes: &[u8], run: &str) -> Result<()> {
    ensure!(
        bytes.len() as u64 <= MAX_ENTRY,
        "workflow_control_quota: entry too large"
    );
    let files = directory.open_regular_files(|name| {
        name.to_string_lossy().ends_with(".json") || name.to_string_lossy().ends_with(".modified")
    })?;
    let mut count = 1;
    let mut flags = 1;
    let mut total = bytes.len() as u64 + 1;
    let flag = format!("{run}.modified");
    for (name, file) in files {
        if name == OsStr::new(leaf) || name == OsStr::new(&flag) {
            continue;
        }
        let size = file.metadata()?.len();
        ensure!(
            size <= MAX_ENTRY,
            "workflow_control_quota: existing entry too large"
        );
        total = total.saturating_add(size);
        if name.to_string_lossy().ends_with(".json") {
            count += 1;
        } else {
            flags += 1;
        }
    }
    ensure!(
        count <= MAX_CONTROLS && flags <= super::MAX_RUNS && total <= MAX_BYTES,
        "workflow_control_quota: control journal is full; existing prepared/unknown history retained"
    );
    Ok(())
}

pub(super) fn modified(directory: &PrivateDirectory, run: &str) -> Result<bool> {
    let controls = match directory.open_child(OsStr::new("user-controls"), false) {
        Ok(value) => value,
        Err(error) if missing(&error) => return Ok(false),
        Err(error) => return Err(error),
    };
    let file = match controls.open_regular_file(OsStr::new(&format!("{run}.modified"))) {
        Ok(value) => value,
        Err(error) if missing(&error) => return Ok(false),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(2).read_to_end(&mut bytes)?;
    ensure!(bytes == b"1", "workflow_control_corrupt: modification flag");
    Ok(true)
}

fn active(directory: &PrivateDirectory, receipt: &Receipt) -> Result<()> {
    let record = read_record(directory, &receipt.association.run_id)?;
    ensure!(
        record.thread_id == receipt.thread_id
            && record.resume_count == receipt.association.resume_count
            && record.status == "running"
            && record.node_states.iter().any(|node| {
                node.node_id == receipt.association.node_id
                    && node.agent_id.as_deref() == Some(&receipt.agent_id)
                    && matches!(node.status.as_str(), "running" | "retrying")
            }),
        "workflow_control_conflict: original run/node is no longer active"
    );
    ensure!(
        directory
            .try_exclusive_lock(OsStr::new(&format!("{}.lease", record.run_id)))?
            .is_none(),
        "workflow_control_conflict: original runtime no longer owns the run"
    );
    Ok(())
}

/// The host supplies its authenticated thread, actual Agent identity, and queue's stable ID/hash.
/// Call before enqueue. Any storage failure rejects enqueue; None means no Workflow association.
pub fn prepare_user_control(
    root: &Path,
    library_root: &Path,
    thread: &str,
    agent: &str,
    client: &str,
    content_sha256: &str,
) -> Result<Option<WorkflowControlAssociation>> {
    let leaf = key(thread, agent, client)?;
    ensure!(
        content_sha256.len() == 64 && content_sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "workflow_control_invalid: expected content SHA-256"
    );
    let directory = match PrivateDirectory::open_existing(root) {
        Ok(value) => value,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let controls = directory.open_child(OsStr::new("user-controls"), true)?;
    let _control_lock = transaction_lock(&controls, "controls.lock")?;
    let _admission = transaction_lock(&directory, "admission.lock")?;
    let receipt = match read_receipt(&controls, &leaf) {
        Ok(previous) => {
            ensure!(
                previous.thread_id == thread
                    && previous.agent_id == agent
                    && previous.client_id == client
                    && previous.content_sha256 == content_sha256,
                "workflow_control_conflict: client ID content changed"
            );
            if previous.association.phase == "queued" {
                return Ok(Some(previous.association));
            }
            active(&directory, &previous)?;
            previous
        }
        Err(error) if missing(&error) => {
            let files =
                directory.open_regular_files(|name| name.to_string_lossy().ends_with(".json"))?;
            ensure!(
                files.len() <= super::MAX_RUNS,
                "workflow_quota: too many run records"
            );
            let mut matching = Vec::new();
            for (name, file) in files {
                ensure!(
                    file.metadata()?.len() <= MAX_RECORD,
                    "workflow_quota: run record too large"
                );
                let id = name.to_string_lossy();
                let record = read_record(&directory, id.strip_suffix(".json").unwrap())?;
                if record.thread_id != thread || record.status != "running" {
                    continue;
                }
                if directory
                    .try_exclusive_lock(OsStr::new(&format!("{}.lease", record.run_id)))?
                    .is_some()
                {
                    continue;
                }
                for node in record.node_states.iter().filter(|node| {
                    node.agent_id.as_deref() == Some(agent)
                        && matches!(node.status.as_str(), "running" | "retrying")
                }) {
                    matching.push(WorkflowControlAssociation {
                        run_id: record.run_id.clone(),
                        node_id: node.node_id.clone(),
                        resume_count: record.resume_count,
                        phase: "prepared".into(),
                    });
                }
            }
            ensure!(
                matching.len() <= 1,
                "workflow_control_conflict: ambiguous active Agent association"
            );
            let Some(association) = matching.pop() else {
                return Ok(None);
            };
            Receipt {
                thread_id: thread.into(),
                agent_id: agent.into(),
                client_id: client.into(),
                content_sha256: content_sha256.into(),
                association,
            }
        }
        Err(error) => return Err(error),
    };
    let bytes = serde_json::to_vec(&receipt)?;
    check_budget(&controls, &leaf, &bytes, &receipt.association.run_id)?;
    // The durable flag also protects an in-flight projection from overwriting true with false.
    controls.atomic_replace(
        OsStr::new(&format!("{}.modified", receipt.association.run_id)),
        b"1",
    )?;
    controls.atomic_replace(OsStr::new(&leaf), &bytes)?;
    WorkflowStore::new(library_root).mark_run_attempt_interaction_modified(
        &receipt.association.run_id,
        receipt.association.resume_count,
    )?;
    // Publish the actual run before enqueue. Read and replace under the same projection lock.
    let _projection = transaction_lock(&directory, "quota.lock")?;
    let mut record = read_record(&directory, &receipt.association.run_id)?;
    record.revision = record
        .revision
        .checked_add(1)
        .context("workflow_quota: revision exhausted")?;
    let bytes = serde_json::to_vec(&record)?;
    ensure!(
        bytes.len() as u64 <= MAX_RECORD,
        "workflow_quota: projection too large"
    );
    // The record replaces an existing record and only adds a boolean/default field plus an ordinal.
    let files = directory.open_regular_files(|_| true)?;
    let total = files
        .into_iter()
        .filter(|(name, _)| name != OsStr::new(&super::name(&record.run_id)))
        .try_fold(bytes.len() as u64, |sum, (_, file)| -> Result<u64> {
            Ok(sum.saturating_add(file.metadata()?.len()))
        })?;
    ensure!(
        total <= 64 * 1024 * 1024,
        "workflow_quota: run observation storage exceeds 64 MiB"
    );
    directory.atomic_replace(OsStr::new(&super::name(&record.run_id)), &bytes)?;
    Ok(Some(receipt.association))
}

/// Call only after the queue returns its persisted receipt. A failed ack remains prepared/unknown.
pub fn acknowledge_user_control(
    root: &Path,
    thread: &str,
    agent: &str,
    client: &str,
    content_sha256: &str,
) -> Result<WorkflowControlAssociation> {
    let directory = PrivateDirectory::open_existing(root)?;
    let controls = directory.open_child(OsStr::new("user-controls"), false)?;
    let _lock = transaction_lock(&controls, "controls.lock")?;
    let leaf = key(thread, agent, client)?;
    let mut receipt = read_receipt(&controls, &leaf)?;
    ensure!(
        receipt.content_sha256 == content_sha256,
        "workflow_control_conflict: client ID content changed"
    );
    receipt.association.phase = "queued".into();
    let bytes = serde_json::to_vec(&receipt)?;
    check_budget(&controls, &leaf, &bytes, &receipt.association.run_id)?;
    controls.atomic_replace(OsStr::new(&leaf), &bytes)?;
    Ok(receipt.association)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow_runs::{RunObservation, read};
    use kcoder_types::workflow_runs::WorkflowRunSnapshot;

    fn snapshot(run: &str, thread: &str, resume: u32) -> WorkflowRunSnapshot {
        serde_json::from_value(serde_json::json!({
            "runId":run,"threadId":thread,"workspace":"isolated","status":"running",
            "startedAtMs":1,"updatedAtMs":1,"resumeCount":resume,"nodeStates":[{
                "nodeId":"actual-node","agentId":"opaque-agent","status":"running","attempt":1,"reused":false
            }]
        })).unwrap()
    }
    fn hash() -> String {
        format!("{:x}", Sha256::digest(b"private command not stored"))
    }
    fn prepare(
        root: &Path,
        library: &Path,
        client: &str,
    ) -> Result<Option<WorkflowControlAssociation>> {
        prepare_user_control(
            root,
            library,
            "actual-thread",
            "opaque-agent",
            client,
            &hash(),
        )
    }

    #[test]
    fn ordinary_run_persists_modification_before_enqueue_and_projection_cannot_erase_it() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runs");
        let run =
            RunObservation::start(root.clone(), snapshot("run-first", "actual-thread", 0)).unwrap();
        let association = prepare(&root, &temp.path().join("absent-library"), "client")
            .unwrap()
            .unwrap();
        assert_eq!(association.run_id, "run-first");
        assert_eq!(association.node_id, "actual-node");
        assert_eq!(association.phase, "prepared");
        assert!(
            read(root.clone(), "run-first")
                .unwrap()
                .interaction_modified
        );
        run.update(|state| {
            state.interaction_modified = false;
            state.node_states[0].status = "completed".into();
        })
        .unwrap();
        assert!(
            read(root.clone(), "run-first")
                .unwrap()
                .interaction_modified
        );
        let stored: WorkflowRunSnapshot =
            serde_json::from_slice(&std::fs::read(root.join("run-first.json")).unwrap()).unwrap();
        assert!(stored.interaction_modified);
        let raw = std::fs::read_to_string(
            root.join("user-controls")
                .join(key("actual-thread", "opaque-agent", "client").unwrap()),
        )
        .unwrap();
        assert!(!raw.contains("private command"));
        assert!(raw.contains(&hash()));
    }

    #[test]
    fn control_marks_exact_active_evidence_without_rewriting_an_old_terminal_attempt() {
        use kcoder_workflow::store::{RuntimeVerification, definition_fingerprint};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runs");
        let library_root = temp.path().join("library");
        let library = WorkflowStore::new(&library_root);
        let draft = library.create("Pinned", "").unwrap();
        let node = serde_json::from_value(serde_json::json!({
            "id":"actual-node","kind":"code","title":"Code","config":{"code":{"source":"return 1;"}}
        }))
        .unwrap();
        let draft = library
            .upsert_node(&draft.id, draft.revision, node)
            .unwrap();
        let saved = library.save(&draft.id, draft.revision).unwrap();
        for (attempt, status) in [(0, "completed"), (1, "running")] {
            let evidence: RuntimeVerification = serde_json::from_value(serde_json::json!({
                "definitionId":saved.id,"savedVersion":1,"definitionSha256":definition_fingerprint(&saved).unwrap(),
                "runId":"actual-run","resumeCount":attempt,"startedAtMs":1,"updatedAtMs":2,
                "executionStatus":status,"outcomeCertainty":"known","checkStatus":"not_requested",
                "scope":"configured_result_checks","checkedNodes":[],"skippedNodes":[],"inputSha256":"fixture",
                "privateInputRef":"private","outputSha256":null,"privateOutputRef":null,"modelSnapshot":{},
                "safetySha256":null,"interactionModified":false
            })).unwrap();
            library.record_verification(&evidence).unwrap();
        }
        let old = std::fs::read(library_root.join("verification/actual-run-0.json")).unwrap();
        let _run = RunObservation::start(root.clone(), snapshot("actual-run", "actual-thread", 1))
            .unwrap();
        prepare(&root, &library_root, "client").unwrap().unwrap();
        let summary = library.verification(&saved.id, 1).unwrap();
        assert!(
            summary
                .runs
                .iter()
                .find(|e| e.resume_count == 1)
                .unwrap()
                .interaction_modified
        );
        assert!(
            !summary
                .runs
                .iter()
                .find(|e| e.resume_count == 0)
                .unwrap()
                .interaction_modified
        );
        assert_eq!(
            std::fs::read(library_root.join("verification/actual-run-0.json")).unwrap(),
            old
        );
        assert_eq!(
            library.read_saved(&saved.id, Some(1)).unwrap().nodes,
            saved.nodes
        );
    }

    #[test]
    fn queued_duplicate_returns_original_run_and_content_conflict_cannot_mark_a_new_run() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runs");
        let library = temp.path().join("library");
        let first =
            RunObservation::start(root.clone(), snapshot("original", "actual-thread", 0)).unwrap();
        prepare(&root, &library, "client").unwrap();
        acknowledge_user_control(&root, "actual-thread", "opaque-agent", "client", &hash())
            .unwrap();
        first
            .update(|state| state.status = "completed".into())
            .unwrap();
        let _next =
            RunObservation::start(root.clone(), snapshot("new-run", "actual-thread", 0)).unwrap();
        let duplicate = prepare(&root, &library, "client").unwrap().unwrap();
        assert_eq!(duplicate.run_id, "original");
        assert_eq!(duplicate.phase, "queued");
        assert!(!read(root.clone(), "new-run").unwrap().interaction_modified);
        let different = format!("{:x}", Sha256::digest(b"different"));
        assert!(
            prepare_user_control(
                &root,
                &library,
                "actual-thread",
                "opaque-agent",
                "client",
                &different
            )
            .is_err()
        );
        assert!(!read(root, "new-run").unwrap().interaction_modified);
    }

    #[test]
    fn prepared_retry_cannot_move_to_a_new_run_or_resume_attempt() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runs");
        let library = temp.path().join("library");
        let first =
            RunObservation::start(root.clone(), snapshot("original", "actual-thread", 0)).unwrap();
        prepare(&root, &library, "client").unwrap();
        assert_eq!(
            prepare(&root, &library, "client").unwrap().unwrap().run_id,
            "original"
        );
        first
            .update(|state| state.status = "failed".into())
            .unwrap();
        let _resumed =
            RunObservation::start(root.clone(), snapshot("original", "actual-thread", 1)).unwrap();
        assert!(prepare(&root, &library, "client").is_err());
    }

    #[test]
    fn matching_requires_real_thread_node_agent_and_live_lease() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runs");
        let library = temp.path().join("library");
        let run = RunObservation::start(root.clone(), snapshot("run", "actual-thread", 0)).unwrap();
        assert!(
            prepare_user_control(
                &root,
                &library,
                "different-thread",
                "opaque-agent",
                "client",
                &hash()
            )
            .unwrap()
            .is_none()
        );
        assert!(
            prepare_user_control(
                &root,
                &library,
                "actual-thread",
                "actual-node",
                "client",
                &hash()
            )
            .unwrap()
            .is_none()
        );
        assert!(!read(root.clone(), "run").unwrap().interaction_modified);
        drop(run);
        assert!(prepare(&root, &library, "client").unwrap().is_none());
    }

    #[test]
    fn quota_and_evidence_failure_reject_enqueue_and_retain_prepared_uncertainty() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runs");
        let run = RunObservation::start(root.clone(), snapshot("run", "actual-thread", 0)).unwrap();
        let controls = PrivateDirectory::open_existing(&root)
            .unwrap()
            .open_child(OsStr::new("user-controls"), true)
            .unwrap();
        controls
            .atomic_replace(
                OsStr::new("oversized.json"),
                &vec![b'x'; MAX_ENTRY as usize + 1],
            )
            .unwrap();
        assert!(prepare(&root, &temp.path().join("library"), "client").is_err());
        assert!(!read(root.clone(), "run").unwrap().interaction_modified);
        controls
            .remove_regular_file(OsStr::new("oversized.json"))
            .unwrap();
        let broken_library = temp.path().join("broken-library");
        std::fs::write(&broken_library, b"not a directory").unwrap();
        assert!(prepare(&root, &broken_library, "client").is_err());
        assert!(read(root.clone(), "run").unwrap().interaction_modified);
        let receipt = read_receipt(
            &controls,
            &key("actual-thread", "opaque-agent", "client").unwrap(),
        )
        .unwrap();
        assert_eq!(receipt.association.phase, "prepared");
        assert_eq!(
            prepare(&root, &temp.path().join("healthy-library"), "client")
                .unwrap()
                .unwrap()
                .run_id,
            "run"
        );
        drop(run);
    }
}
