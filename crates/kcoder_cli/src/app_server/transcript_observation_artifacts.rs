//! Copy bounded projection inputs while the caller owns both existing writer fences.

#[path = "../internal/transcript_observation/indexed.rs"]
pub mod indexed;
#[path = "../internal/transcript_observation/observed.rs"]
pub mod observed;
#[path = "../internal/transcript_observation/tool_recovery.rs"]
pub mod tool_recovery;
use anyhow::{Context, Result, ensure};
use kcoder_attachment_retention::acceptance::TurnClientMessageArtifact;
use kcoder_cli_storage::{
    file_capture_validation::{MAX_CAPTURE_RECORD_BYTES, decode_file_capture},
    private_files::{error_is_not_found, hex_sha256},
    review_validation::{MAX_REVIEW_BYTES, decode_review},
};
use kcoder_config::PrivateDirectory;
use kcoder_state::{
    history_index::transcript_input_identity, turn_attempt_store::TurnAttemptRecord,
};
use kcoder_thread_metadata::{
    MAX_THREAD_METADATA_BYTES, THREAD_METADATA_FILE, ThreadClientMetadata, same_workspace_form,
};
use kcoder_transcript::{ApprovalDecisionArtifact, TurnOutcomeArtifact, transcript_window};
use kcoder_workspace_resources::managed_worktrees::{valid_artifact_id, validate_thread_id};
use kcoder_workspace_resources::snapshots::{MAX_TURN_FILE_CHANGES_BYTES, TurnFileChangesArtifact};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    ffi::OsStr,
    io::Read,
    path::Path,
    time::{Duration, Instant},
};

pub const KINDS: [&str; 8] = [
    "turn-attempts",
    "turn-admissions",
    "turn-client-messages",
    "turn-outcomes",
    "approval-decisions",
    "turn-file-changes",
    "turn-file-captures",
    "turn-review-evidence",
];
const MAX_CAPTURE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CAPTURE_ENTRIES: usize = 2048;
const MAX_CAPTURE_TIME: Duration = Duration::from_millis(50);

pub struct CaptureBudget {
    started: Instant,
    bytes: usize,
    entries: usize,
}

impl CaptureBudget {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            bytes: 0,
            entries: 0,
        }
    }

    pub fn check(&self) -> Result<()> {
        anyhow::ensure!(
            self.started.elapsed() <= MAX_CAPTURE_TIME,
            "transcript observation copy exceeded time budget"
        );
        Ok(())
    }

    pub fn reserve(&mut self, bytes: usize) -> Result<()> {
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .context("transcript observation byte overflow")?;
        anyhow::ensure!(
            self.bytes <= MAX_CAPTURE_BYTES,
            "transcript observation metadata exceeded byte budget"
        );
        self.check()
    }

    pub fn remaining_bytes(&self) -> usize {
        MAX_CAPTURE_BYTES.saturating_sub(self.bytes)
    }

    fn entry(&mut self) -> Result<()> {
        self.entries += 1;
        anyhow::ensure!(
            self.entries <= MAX_CAPTURE_ENTRIES,
            "transcript observation inventory exceeded entry budget"
        );
        self.check()
    }
}

struct RawArtifact {
    kind: &'static str,
    name: String,
    bytes: Vec<u8>,
}

pub struct CapturedArtifacts {
    thread_id: String,
    raw: Vec<RawArtifact>,
    metadata: Option<Vec<u8>>,
    patch_available: HashMap<String, bool>,
    inventory: Vec<Value>,
}

/// No parsing, async yield, file creation or skipped read errors are allowed in this phase.
pub fn capture(
    client_root: &Path,
    thread_id: &str,
    budget: &mut CaptureBudget,
) -> Result<CapturedArtifacts> {
    validate_thread_id(thread_id)?;
    let mut inventory = vec![json!("kcoder.transcript-artifact-observation.v1")];
    let parent = PrivateDirectory::open_existing(client_root)?;
    let directory = match parent.open_child(OsStr::new(thread_id), false) {
        Ok(directory) => directory,
        Err(error) if error_is_not_found(&error) => {
            budget.check()?;
            inventory.push(json!(["thread-directory", "missing"]));
            return Ok(CapturedArtifacts {
                thread_id: thread_id.to_owned(),
                raw: Vec::new(),
                metadata: None,
                patch_available: HashMap::new(),
                inventory,
            });
        }
        Err(error) => return Err(error),
    };
    inventory.push(json!(["thread-directory", "present"]));
    let metadata = copy_optional(
        &directory,
        OsStr::new(THREAD_METADATA_FILE),
        MAX_THREAD_METADATA_BYTES,
        budget,
    )?;
    inventory.push(json!([
        THREAD_METADATA_FILE,
        metadata.as_ref().map(|(_, witness)| witness)
    ]));
    let mut captured = CapturedArtifacts {
        thread_id: thread_id.to_owned(),
        raw: Vec::new(),
        metadata: metadata.map(|(bytes, _)| bytes),
        patch_available: HashMap::new(),
        inventory: Vec::new(),
    };
    for kind in KINDS {
        budget.check()?;
        let child = match directory.open_child(OsStr::new(kind), false) {
            Ok(child) => child,
            Err(error) if error_is_not_found(&error) => {
                inventory.push(json!([kind, "missing"]));
                continue;
            }
            Err(error) => return Err(error),
        };
        let mut names = Vec::new();
        child.visit_entry_names_bounded(MAX_CAPTURE_ENTRIES, |name| {
            budget.entry()?;
            let name = name
                .to_str()
                .context("transcript inventory name is not UTF-8")?
                .to_owned();
            anyhow::ensure!(
                name.len() <= 512,
                "transcript inventory name exceeds budget"
            );
            budget.reserve(name.len())?;
            names.push(name);
            Ok(())
        })?;
        names.sort();
        inventory.push(json!([kind, "present", names.len()]));
        for name in names {
            budget.check()?;
            let used = name.ends_with(".json")
                && (kind != "turn-attempts" || name.ends_with(".attempt.json"));
            if used {
                let limit = if kind == "turn-review-evidence" {
                    MAX_REVIEW_BYTES as u64
                } else if kind == "turn-file-captures" {
                    MAX_CAPTURE_RECORD_BYTES
                } else if matches!(
                    kind,
                    "turn-client-messages" | "turn-outcomes" | "turn-admissions"
                ) {
                    64 * 1024
                } else {
                    1024 * 1024
                };
                let (bytes, witness) = copy_required(&child, OsStr::new(&name), limit, budget)?;
                inventory.push(json!([kind, name, witness]));
                captured.raw.push(RawArtifact { kind, name, bytes });
            } else {
                // Patch bytes are not projected. Their exact availability is a display input.
                let file = child.open_regular_file(OsStr::new(&name))?;
                let metadata = file.metadata()?;
                let identity = transcript_input_identity(&file)?;
                budget.check()?;
                let available =
                    metadata.len() > 0 && metadata.len() <= MAX_TURN_FILE_CHANGES_BYTES as u64;
                inventory.push(json!([kind, name, "regular", identity, metadata.len()]));
                if kind == "turn-file-changes" && name.ends_with(".patch") {
                    captured.patch_available.insert(name, available);
                }
            }
        }
    }
    budget.check()?;
    captured.inventory = inventory;
    Ok(captured)
}

fn copy_optional(
    directory: &PrivateDirectory,
    name: &OsStr,
    limit: u64,
    budget: &mut CaptureBudget,
) -> Result<Option<(Vec<u8>, Value)>> {
    let file = match directory.open_regular_file(name) {
        Ok(file) => file,
        Err(error) if error_is_not_found(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    copy_handle(directory, name, file, limit, budget).map(Some)
}

fn copy_required(
    directory: &PrivateDirectory,
    name: &OsStr,
    limit: u64,
    budget: &mut CaptureBudget,
) -> Result<(Vec<u8>, Value)> {
    budget.check()?;
    let file = directory.open_regular_file(name)?;
    copy_handle(directory, name, file, limit, budget)
}

fn copy_handle(
    directory: &PrivateDirectory,
    name: &OsStr,
    mut file: std::fs::File,
    limit: u64,
    budget: &mut CaptureBudget,
) -> Result<(Vec<u8>, Value)> {
    budget.check()?;
    let before = file.metadata()?;
    anyhow::ensure!(
        before.len() <= limit,
        "transcript artifact exceeds per-file budget"
    );
    budget.reserve(usize::try_from(before.len())?)?;
    let identity = transcript_input_identity(&file)?;
    budget.check()?;
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file).take(before.len()).read_to_end(&mut bytes)?;
    budget.check()?;
    let after = file.metadata()?;
    anyhow::ensure!(
        bytes.len() as u64 <= limit
            && before.len() == bytes.len() as u64
            && after.len() == before.len()
            && after.modified().ok() == before.modified().ok()
            && transcript_input_identity(&directory.open_regular_file(name)?)? == identity,
        "transcript artifact changed during observation"
    );
    let witness = json!([identity, bytes.len()]);
    Ok((bytes, witness))
}

impl CapturedArtifacts {
    /// Hash exactly the bytes that will be parsed, after releasing both fences.
    pub fn digest(&self) -> Result<String> {
        use sha2::{Digest, Sha256};
        let mut hash = Sha256::new();
        hash.update(serde_json::to_vec(&self.inventory)?);
        if let Some(metadata) = &self.metadata {
            hash.update((metadata.len() as u64).to_le_bytes());
            hash.update(metadata);
        }
        for raw in &self.raw {
            hash.update((raw.bytes.len() as u64).to_le_bytes());
            hash.update(&raw.bytes);
        }
        Ok(format!("{:x}", hash.finalize()))
    }

    /// Decode only the copied bytes after the caller has released both writer fences.
    pub async fn decode(
        self,
        workspace: &str,
    ) -> Result<(transcript_window::Artifacts, Option<ThreadClientMetadata>)> {
        let stored = self
            .metadata
            .map(|bytes| serde_json::from_slice::<ThreadClientMetadata>(&bytes))
            .transpose()?;
        if let Some(stored) = &stored {
            anyhow::ensure!(
                stored.version == 1
                    && stored.thread_id == self.thread_id
                    && same_workspace_form(&stored.workspace, workspace),
                "thread metadata observation scope differs"
            );
        }
        let mut result = transcript_window::Artifacts {
            thread_id: self.thread_id,
            ..Default::default()
        };
        for (index, raw) in self.raw.into_iter().enumerate() {
            if index % 16 == 0 {
                tokio::task::yield_now().await;
            }
            let available = if raw.kind == "turn-file-changes" {
                let artifact: TurnFileChangesArtifact = serde_json::from_slice(&raw.bytes)?;
                self.patch_available
                    .get(&format!("{}.patch", artifact.artifact_id))
                    .copied()
                    .unwrap_or(false)
            } else {
                false
            };
            apply_record(&mut result, raw.kind, &raw.name, &raw.bytes, available)?;
        }
        finish_records(&mut result)?;
        Ok((result, stored))
    }
}

pub fn apply_record(
    result: &mut transcript_window::Artifacts,
    kind: &str,
    name: &str,
    bytes: &[u8],
    patch_available: bool,
) -> Result<()> {
    let thread_id = &result.thread_id;
    match kind {
        "turn-attempts" => {
            let record: kcoder_state::turn_attempt_store::TurnAttemptRecord =
                serde_json::from_slice(bytes)?;
            record.validate()?;
            anyhow::ensure!(
                record.identity.thread_id == *thread_id,
                "attempt belongs to another thread"
            );
            anyhow::ensure!(
                name == format!(
                    "{}.attempt.json",
                    hex_sha256(record.identity.attempt_id.as_bytes())
                ),
                "attempt artifact filename mismatch"
            );
            result.attempts.push(record);
        }
        "turn-admissions" => {
            let binding: Binding = serde_json::from_slice(bytes)?;
            anyhow::ensure!(
                binding.version == 1
                    && binding.thread_id == *thread_id
                    && !binding.user_message_uuid.is_empty(),
                "invalid turn admission binding"
            );
            anyhow::ensure!(
                result
                    .turn_ids
                    .insert(binding.user_message_uuid, binding.turn_id)
                    .is_none(),
                "duplicate turn admission binding"
            );
        }
        "turn-client-messages" => {
            let artifact: TurnClientMessageArtifact = serde_json::from_slice(bytes)?;
            anyhow::ensure!(
                artifact.version == 1
                    && artifact.thread_id == *thread_id
                    && !artifact.client_message_id.trim().is_empty(),
                "invalid client message artifact"
            );
            anyhow::ensure!(
                result
                    .client_ids
                    .insert(artifact.turn_id, artifact.client_message_id)
                    .is_none(),
                "duplicate client message binding"
            );
        }
        "turn-outcomes" => {
            let artifact: TurnOutcomeArtifact = serde_json::from_slice(bytes)?;
            anyhow::ensure!(
                artifact.version == 1 && artifact.thread_id == *thread_id,
                "invalid turn outcome"
            );
            if matches!(artifact.status.as_str(), "interrupted" | "failed") {
                result.outcomes.insert(artifact.turn_id.clone(), artifact);
            }
        }
        "approval-decisions" => {
            let artifact: ApprovalDecisionArtifact = serde_json::from_slice(bytes)?;
            anyhow::ensure!(
                artifact.version == 1
                    && artifact.thread_id == *thread_id
                    && valid_artifact_id(&artifact.artifact_id),
                "invalid approval artifact"
            );
            result.approvals.push(artifact);
        }
        "turn-file-changes" => {
            let mut artifact: TurnFileChangesArtifact = serde_json::from_slice(bytes)?;
            anyhow::ensure!(
                artifact.thread_id == *thread_id && valid_artifact_id(&artifact.artifact_id),
                "invalid file changes artifact"
            );
            if !patch_available {
                artifact.status = "artifact_missing".into();
            }
            result.file_changes.insert(
                artifact.turn_id.clone(),
                turn_file_changes_summary(&artifact),
            );
        }
        "turn-review-evidence" => {
            let record = decode_review(bytes, thread_id, OsStr::new(name))?;
            anyhow::ensure!(
                result
                    .review_evidence
                    .insert(record.attempt_id.clone(), record)
                    .is_none(),
                "duplicate review attempt"
            );
        }
        "turn-file-captures" => {
            let capture = decode_file_capture(bytes, thread_id, OsStr::new(name))?;
            anyhow::ensure!(
                result
                    .file_captures
                    .insert(capture.attempt_id.clone(), capture)
                    .is_none(),
                "duplicate capture attempt"
            );
        }
        _ => anyhow::bail!("unknown transcript artifact kind"),
    }
    Ok(())
}

pub fn finish_records(result: &mut transcript_window::Artifacts) -> Result<()> {
    result
        .approvals
        .sort_by_key(|artifact| artifact.requested_at_ms);
    result.attempts = validate_records(std::mem::take(&mut result.attempts))?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
pub struct Binding {
    pub version: u8,
    pub thread_id: String,
    pub turn_id: String,
    pub user_message_uuid: String,
}

pub fn turn_file_changes_summary(artifact: &TurnFileChangesArtifact) -> Value {
    let workspace_path = dunce::simplified(Path::new(&artifact.workspace_path))
        .to_string_lossy()
        .into_owned();
    json!({
        "version": artifact.version,
        "status": artifact.status,
        "artifact_id": artifact.artifact_id,
        "device_id": "kcoder",
        "workspace_path": workspace_path,
        "file_count": artifact.file_count,
        "additions": artifact.additions,
        "deletions": artifact.deletions,
        "files": artifact.files,
        "reverted_at": artifact.reverted_at,
        "revertible": false,
    })
}

pub fn validate_records(mut records: Vec<TurnAttemptRecord>) -> Result<Vec<TurnAttemptRecord>> {
    let by_id = records
        .iter()
        .map(|record| (record.identity.attempt_id.as_str(), record))
        .collect::<HashMap<_, _>>();
    ensure!(by_id.len() == records.len(), "duplicate attempt identity");
    let mut children = HashSet::new();
    let mut depths = HashMap::new();
    for record in &records {
        record.validate()?;
        let mut depth = 0usize;
        let mut current = record;
        while let Some(parent_id) = &current.parent_attempt_id {
            let parent = by_id
                .get(parent_id.as_str())
                .context("attempt parent is missing")?;
            ensure!(
                parent.identity.turn_id == record.identity.turn_id,
                "attempt parent belongs to another turn"
            );
            depth += 1;
            ensure!(depth < records.len(), "attempt history cycle");
            current = parent;
        }
        depths.insert(record.identity.attempt_id.clone(), depth);
        if let Some(parent) = &record.parent_attempt_id {
            ensure!(
                children.insert(parent),
                "attempt history has conflicting branches"
            );
        }
    }
    records.sort_by_key(|record| depths[&record.identity.attempt_id]);
    Ok(records)
}

pub async fn load_artifacts(
    session_directory: &Path,
    thread_id: &str,
) -> Result<transcript_window::Artifacts> {
    let mut result = transcript_window::Artifacts {
        thread_id: thread_id.to_owned(),
        ..Default::default()
    };
    let mut total = 0usize;
    for kind in [
        "turn-attempts",
        "turn-admissions",
        "turn-client-messages",
        "turn-outcomes",
        "approval-decisions",
        "turn-file-changes",
        "turn-file-captures",
        "turn-review-evidence",
    ] {
        let path = session_directory.join(kind);
        let entries = match std::fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let directory = kcoder_config::PrivateDirectory::open_existing(&path)?;
        for (index, entry) in entries.enumerate() {
            if index % 32 == 0 {
                tokio::task::yield_now().await;
            }
            anyhow::ensure!(index < 10_000, "artifact enumeration exceeds budget");
            let entry = entry?;
            if kind == "turn-attempts"
                && !entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".attempt.json")
            {
                continue;
            }
            if entry.path().extension().and_then(|name| name.to_str()) != Some("json") {
                continue;
            }
            let limit = if kind == "turn-review-evidence" {
                MAX_REVIEW_BYTES as u64
            } else if kind == "turn-file-captures" {
                MAX_CAPTURE_RECORD_BYTES
            } else if matches!(
                kind,
                "turn-client-messages" | "turn-outcomes" | "turn-admissions"
            ) {
                64 * 1024
            } else {
                1024 * 1024
            };
            let mut bytes = Vec::new();
            directory
                .open_regular_file(&entry.file_name())?
                .take(limit + 1)
                .read_to_end(&mut bytes)?;
            total += bytes.len();
            anyhow::ensure!(
                bytes.len() as u64 <= limit && total <= 64 * 1024 * 1024,
                "artifact input exceeds budget"
            );
            match kind {
                "turn-attempts" => {
                    let record: kcoder_state::turn_attempt_store::TurnAttemptRecord =
                        serde_json::from_slice(&bytes)?;
                    record.validate()?;
                    anyhow::ensure!(
                        record.identity.thread_id == thread_id,
                        "attempt belongs to another thread"
                    );
                    anyhow::ensure!(
                        entry.file_name()
                            == std::ffi::OsString::from(format!(
                                "{}.attempt.json",
                                hex_sha256(record.identity.attempt_id.as_bytes())
                            )),
                        "attempt artifact filename mismatch"
                    );
                    result.attempts.push(record);
                }
                "turn-admissions" => {
                    let binding: Binding = serde_json::from_slice(&bytes)?;
                    anyhow::ensure!(
                        binding.version == 1
                            && binding.thread_id == thread_id
                            && !binding.user_message_uuid.is_empty(),
                        "invalid turn admission binding"
                    );
                    anyhow::ensure!(
                        result
                            .turn_ids
                            .insert(binding.user_message_uuid, binding.turn_id)
                            .is_none(),
                        "duplicate turn admission binding"
                    );
                }
                "turn-client-messages" => {
                    let artifact: TurnClientMessageArtifact = serde_json::from_slice(&bytes)?;
                    anyhow::ensure!(
                        artifact.version == 1
                            && artifact.thread_id == thread_id
                            && !artifact.client_message_id.trim().is_empty(),
                        "invalid client message artifact"
                    );
                    result
                        .client_ids
                        .insert(artifact.turn_id, artifact.client_message_id);
                }
                "turn-outcomes" => {
                    let artifact: TurnOutcomeArtifact = serde_json::from_slice(&bytes)?;
                    anyhow::ensure!(
                        artifact.version == 1 && artifact.thread_id == thread_id,
                        "invalid turn outcome"
                    );
                    if matches!(artifact.status.as_str(), "interrupted" | "failed") {
                        result.outcomes.insert(artifact.turn_id.clone(), artifact);
                    }
                }
                "approval-decisions" => {
                    let artifact: ApprovalDecisionArtifact = serde_json::from_slice(&bytes)?;
                    anyhow::ensure!(
                        artifact.version == 1
                            && artifact.thread_id == thread_id
                            && valid_artifact_id(&artifact.artifact_id),
                        "invalid approval artifact"
                    );
                    result.approvals.push(artifact);
                }
                "turn-review-evidence" => {
                    let record = decode_review(&bytes, thread_id, &entry.file_name())?;
                    anyhow::ensure!(
                        result
                            .review_evidence
                            .insert(record.attempt_id.clone(), record)
                            .is_none(),
                        "duplicate review attempt"
                    );
                }
                "turn-file-captures" => {
                    let capture = decode_file_capture(&bytes, thread_id, &entry.file_name())?;
                    anyhow::ensure!(
                        result
                            .file_captures
                            .insert(capture.attempt_id.clone(), capture)
                            .is_none(),
                        "duplicate capture attempt"
                    );
                }
                _ => {
                    let mut artifact: TurnFileChangesArtifact = serde_json::from_slice(&bytes)?;
                    anyhow::ensure!(
                        artifact.thread_id == thread_id && valid_artifact_id(&artifact.artifact_id),
                        "invalid file changes artifact"
                    );
                    if !std::fs::symlink_metadata(
                        path.join(format!("{}.patch", artifact.artifact_id)),
                    )
                    .ok()
                    .is_some_and(|m| {
                        m.file_type().is_file()
                            && m.len() > 0
                            && m.len() <= MAX_TURN_FILE_CHANGES_BYTES as u64
                    }) {
                        artifact.status = "artifact_missing".into();
                    }
                    result.file_changes.insert(
                        artifact.turn_id.clone(),
                        turn_file_changes_summary(&artifact),
                    );
                }
            }
        }
    }
    result
        .approvals
        .sort_by_key(|artifact| artifact.requested_at_ms);
    result.attempts = validate_records(result.attempts)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn preserves_distinct_duplicate_client_message_rules() {
        let thread = "thread-1";
        let dir = tempfile::tempdir().unwrap();
        let records = dir.path().join("turn-client-messages");
        std::fs::create_dir(&records).unwrap();
        let mut captured = transcript_window::Artifacts {
            thread_id: thread.into(),
            ..Default::default()
        };
        for (index, client) in ["client-one", "client-two"].into_iter().enumerate() {
            let name = format!("{index}.json");
            let bytes = serde_json::to_vec(&TurnClientMessageArtifact {
                version: 1,
                thread_id: thread.into(),
                turn_id: "turn-1".into(),
                client_message_id: client.into(),
            })
            .unwrap();
            std::fs::write(records.join(&name), &bytes).unwrap();
            let result = apply_record(&mut captured, "turn-client-messages", &name, &bytes, false);
            if index == 0 {
                result.unwrap();
            } else {
                assert_eq!(
                    result.unwrap_err().to_string(),
                    "duplicate client message binding"
                );
            }
        }
        let legacy = load_artifacts(dir.path(), thread).await.unwrap();
        assert_eq!(legacy.client_ids.len(), 1);
        assert!(["client-one", "client-two"].contains(&legacy.client_ids["turn-1"].as_str()));
    }
}
