//! Native proof of one failed member inside the original active Workflow resume.
use super::*;
use crate::AgentKind;
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_state::{AppState, AppStateLifecycleIdentity, TaskDelivery, TaskKind, TaskStatus};
use kcoder_types::BackgroundRunKey;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::{BufRead, BufReader, Read},
    sync::Weak,
};
const MAX_JOURNAL: u64 = 64 * 1024 * 1024;
const MAX_DEFINITION: u64 = 128 * 1024;

/// Not deserializable. Only the Workflow adapter can create this original-store
/// witness; the Engine must additionally supply its real task-local owner.
pub struct WorkflowAgentRecovery {
    store: Weak<WorkflowRunStore>,
    parent: AppStateLifecycleIdentity,
    directory: PrivateDirectory,
    directory_identity: String,
    root: BackgroundRunKey,
    previous: BackgroundRunKey,
    resume_count: usize,
    definition_sha256: String,
    journal_bytes: u64,
    journal_sha256: String,
    request_sha256: String,
    node_id: String,
    prompt_sha256: String,
    max_turns: usize,
    kind: AgentKind,
    options_sha256: String,
    cancellation: CancellationToken,
}
impl std::fmt::Debug for WorkflowAgentRecovery {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WorkflowAgentRecovery { native_store: bound }")
    }
}
fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn request_value(request: &AgentRequest) -> Result<Value> {
    Ok(serde_json::to_value(request)?)
}
fn options_digest(options: &AgentRunOptions) -> Result<String> {
    Ok(digest(serde_json::to_vec(&json!({
        "writePaths":options.allowed_write_paths,"shellPrefixes":options.allowed_shell_prefixes,
        "artifacts":options.artifact_requirements,"blockShellMutation":options.block_shell_file_mutation,
        "arrangement":options.arrangement_mode,"contextMode":options.context_mode,"contextTurns":options.context_turns,
        "worktree":options.worktree_path,"persona":options.persona_name,
        "runtime":options.runtime_selection.as_ref().map(|value|json!({"profile":value.profile,"provider":value.provider,"model":value.model})),
        "allowlist":options.tool_allowlist,"observer":options.configuration_observer.is_some(),
        "reviewChannel":options.review_vote_channel.is_some(),"workId":options.orchestrate_work_id,
        "criticCycles":options.critic_max_cycles,"criticRetries":options.critic_max_infrastructure_retries,
        "delivery":options.delivery.as_ref().map(|value|json!({"message":value.message_id,"lease":value.lease_id})),
        "leaseTimeout":options.delivery_lease_timeout_seconds,"deliveryAttempts":options.delivery_max_attempts
    }))?))
}
fn read(directory: &PrivateDirectory, name: &str, limit: u64) -> Result<Vec<u8>> {
    let file = directory.open_regular_file(OsStr::new(name))?;
    ensure!(
        file.metadata()?.len() <= limit,
        "workflow_recovery: original file exceeds observation budget"
    );
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= limit,
        "workflow_recovery: original file grew during observation"
    );
    Ok(bytes)
}
struct JournalProof {
    bytes: u64,
    sha256: String,
    node_id: String,
}
struct RestartRequest<'a> {
    agent: &'a str,
    prompt: &'a str,
    max_turns: usize,
    kind: AgentKind,
    options: &'a AgentRunOptions,
}
fn journal_proof(
    directory: &PrivateDirectory,
    run: &str,
    count: usize,
    agent: &str,
    request: &Value,
) -> Result<JournalProof> {
    let file = directory.open_regular_file(OsStr::new("journal.jsonl"))?;
    let length = file.metadata()?.len();
    ensure!(
        length <= MAX_JOURNAL,
        "workflow_recovery: journal observation budget exceeded"
    );
    let mut source = BufReader::new(file.take(length));
    let mut bytes = Vec::new();
    let mut sha = Sha256::new();
    let mut prior_request = None;
    let mut prior_failed = false;
    let mut resumed = false;
    let mut current_request = None;
    let mut current_node = None;
    let mut current_ended = false;
    loop {
        bytes.clear();
        if source.read_until(b'\n', &mut bytes)? == 0 {
            break;
        }
        ensure!(
            bytes.len() <= 1024 * 1024 && bytes.last() == Some(&b'\n'),
            "workflow_recovery: incomplete or oversized original journal event"
        );
        sha.update(&bytes);
        let value: Value = serde_json::from_slice(&bytes)?;
        let event = value["type"].as_str().unwrap_or("");
        if event == "workflow_resumed" && value["resume_count"].as_u64() == Some(count as u64) {
            ensure!(
                value["run_id"].as_str() == Some(run) && !resumed,
                "workflow_recovery: resume boundary changed"
            );
            resumed = true;
            continue;
        }
        if value["agent_id"].as_str() != Some(agent) {
            continue;
        }
        if !resumed {
            match event {
                "agent_started" => {
                    prior_request = Some(value["request"].clone());
                    prior_failed = false;
                }
                "agent_failed" => prior_failed = true,
                "agent_completed" => prior_failed = false,
                _ => {}
            }
        } else {
            match event {
                "node_started" => {
                    current_node = value["node_id"].as_str().map(str::to_owned);
                    current_ended = false;
                }
                "agent_started" => current_request = Some(value["request"].clone()),
                "node_completed" | "node_failed" => current_ended = true,
                _ => {}
            }
        }
    }
    ensure!(
        resumed
            && prior_failed
            && prior_request.as_ref() == Some(request)
            && current_request.as_ref() == Some(request)
            && !current_ended,
        "workflow_recovery: original failed member and current request do not match"
    );
    let node_id = current_node.context("workflow_recovery: current native node is unavailable")?;
    Ok(JournalProof {
        bytes: length,
        sha256: format!("{:x}", sha.finalize()),
        node_id,
    })
}
impl WorkflowAgentRecovery {
    pub fn previous_child_run(&self) -> &BackgroundRunKey {
        &self.previous
    }
    /// Checks original continuity only. The manager still owns admission, and
    /// current source, permission, model and budget guards remain mandatory.
    #[expect(
        clippy::too_many_arguments,
        reason = "These distinct native facts match the Engine admission boundary; none comes from business JSON."
    )]
    pub fn verify_restart(
        &self,
        actual_parent: &AppState,
        actual_workflow_owner: &BackgroundRunKey,
        requested_agent_id: &str,
        prompt: &str,
        max_turns: usize,
        kind: AgentKind,
        options: &AgentRunOptions,
    ) -> Result<(), String> {
        self.verify(
            actual_parent,
            actual_workflow_owner,
            RestartRequest {
                agent: requested_agent_id,
                prompt,
                max_turns,
                kind,
                options,
            },
        )
        .map_err(|_| {
            "workflow_recovery: native original resume proof is unavailable or changed".into()
        })
    }
    fn verify(
        &self,
        parent: &AppState,
        owner: &BackgroundRunKey,
        request: RestartRequest<'_>,
    ) -> Result<()> {
        let RestartRequest {
            agent,
            prompt,
            max_turns,
            kind,
            options,
        } = request;
        ensure!(
            !self.cancellation.is_cancelled()
                && self.parent.matches(parent)
                && owner == &self.root
                && agent == self.previous.agent_id
                && digest(prompt) == self.prompt_sha256
                && max_turns == self.max_turns
                && kind == self.kind
                && options_digest(options)? == self.options_sha256,
            "workflow_recovery: current caller differs"
        );
        let store = self
            .store
            .upgrade()
            .context("workflow_recovery: original store owner ended")?;
        let _io = store
            .io
            .lock()
            .map_err(|_| anyhow::anyhow!("workflow_recovery: store lock unavailable"))?;
        let state = store
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("workflow_recovery: state unavailable"))?
            .clone();
        ensure!(
            state.run_id == self.root.agent_id
                && state.status == "running"
                && state.resume_count == self.resume_count
                && state.definition_sha256.as_deref() == Some(self.definition_sha256.as_str()),
            "workflow_recovery: original store attempt changed"
        );
        self.directory.verify_private_directory()?;
        ensure!(
            PrivateDirectory::open_existing(&store.run_dir)?.directory_identity()?
                == self.directory_identity,
            "workflow_recovery: original directory changed"
        );
        ensure!(
            digest(read(&self.directory, "definition.json", MAX_DEFINITION)?)
                == self.definition_sha256,
            "workflow_recovery: original definition changed"
        );
        let disk: Value =
            serde_json::from_slice(&read(&self.directory, "state.json", 256 * 1024)?)?;
        ensure!(
            disk["run_id"].as_str() == Some(state.run_id.as_str())
                && disk["resume_count"].as_u64() == Some(self.resume_count as u64)
                && disk["status"] == "running"
                && disk["definition_sha256"].as_str() == Some(self.definition_sha256.as_str()),
            "workflow_recovery: persisted attempt changed"
        );
        let file = self
            .directory
            .open_regular_file(OsStr::new("journal.jsonl"))?;
        ensure!(
            file.metadata()?.len() >= self.journal_bytes,
            "workflow_recovery: original journal was truncated"
        );
        let mut hashed = Sha256::new();
        let mut reader = file.take(self.journal_bytes);
        let mut consumed = 0_u64;
        let mut buffer = [0_u8; 8192];
        loop {
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            consumed += count as u64;
            hashed.update(&buffer[..count]);
        }
        ensure!(
            consumed == self.journal_bytes
                && format!("{:x}", hashed.finalize()) == self.journal_sha256,
            "workflow_recovery: original journal prefix changed"
        );
        let root = parent
            .task(&self.root.agent_id)
            .context("workflow_recovery: current Workflow task missing")?;
        ensure!(
            root.managed
                && root.kind == TaskKind::Workflow
                && root.background_run.as_ref() == Some(owner)
                && matches!(root.status, TaskStatus::Running | TaskStatus::Pending),
            "workflow_recovery: current Workflow owner changed"
        );
        let old = parent
            .task(agent)
            .context("workflow_recovery: previous member missing")?;
        ensure!(
            old.managed
                && old.kind == TaskKind::Subagent
                && old.status == TaskStatus::Failed
                && old.delivery == TaskDelivery::Foreground
                && old.parent_session_id.as_deref() == Some(self.root.parent_session_id.as_str())
                && old.background_run.as_ref() == Some(&self.previous)
                && old.description == prompt
                && old.allowed_write_paths == options.allowed_write_paths
                && old.allowed_shell_prefixes == options.allowed_shell_prefixes
                && old.worktree_path == options.worktree_path
                && old.agent_kind.as_deref() == Some(kind.as_str())
                && old.max_turns == Some(max_turns)
                && old.message_queue.is_empty()
                && old.pending_messages.is_empty(),
            "workflow_recovery: previous failed member changed"
        );
        let record = parent
            .background_run_record(&self.previous)
            .context("workflow_recovery: previous run receipt missing")?;
        ensure!(
            record.status == TaskStatus::Failed
                && record.delivery == TaskDelivery::Foreground
                && !record.legacy_uncertain
                && !record.imported_history
                && record
                    .terminal
                    .as_ref()
                    .is_some_and(|terminal| terminal.run == self.previous),
            "workflow_recovery: previous terminal unproven"
        );
        // Re-read the fixed node/request binding from the same held original journal.
        let request_file = store
            .run_dir
            .join("agents")
            .join(kcoder_state::artifact_id_path_component(agent))
            .join("request.json");
        let request: Value =
            serde_json::from_slice(&secure_read_file(&request_file, MAX_SCRIPT_BYTES)?)?;
        ensure!(
            digest(serde_json::to_vec(&request)?) == self.request_sha256,
            "workflow_recovery: current request changed"
        );
        let definition: kcoder_types::workflow::WorkflowDefinition =
            serde_json::from_slice(&read(&self.directory, "definition.json", MAX_DEFINITION)?)?;
        ensure!(
            definition.nodes.iter().any(|node| node.id == self.node_id
                && node.kind == kcoder_types::workflow::WorkflowNodeKind::Agent),
            "workflow_recovery: fixed node missing"
        );
        Ok(())
    }
}

pub(super) fn capture(
    executor: &ToolAgentExecutor,
    agent: &str,
    request: &AgentRequest,
    prompt: &str,
    kind: AgentKind,
    options: &AgentRunOptions,
) -> Result<Option<Arc<WorkflowAgentRecovery>>, String> {
    capture_inner(executor, agent, request, prompt, kind, options).map_err(|_| {
        "workflow_recovery: native original resume proof is unavailable or changed".into()
    })
}
fn capture_inner(
    executor: &ToolAgentExecutor,
    agent: &str,
    request: &AgentRequest,
    prompt: &str,
    kind: AgentKind,
    options: &AgentRunOptions,
) -> Result<Option<Arc<WorkflowAgentRecovery>>> {
    let (Some(store), Some(parent), Some(current), Some(checkpoint)) = (
        &executor.verification_store,
        &executor.native_parent_state,
        &executor.tool_run_dir,
        &executor.checkpoint_run_dir,
    ) else {
        return Ok(None);
    };
    if current != checkpoint || &store.run_dir != current {
        return Ok(None);
    }
    let Some(old) = parent.task(agent) else {
        return Ok(None);
    };
    if !old.managed || old.status != TaskStatus::Failed || old.background_run.is_none() {
        return Ok(None);
    }
    let _io = store
        .io
        .lock()
        .map_err(|_| anyhow::anyhow!("workflow_recovery: store unavailable"))?;
    let state = store
        .state
        .lock()
        .map_err(|_| anyhow::anyhow!("workflow_recovery: state unavailable"))?
        .clone();
    ensure!(
        state.run_id == executor.run_id && state.resume_count > 0 && state.status == "running",
        "workflow_recovery: not an original active resume"
    );
    let owner = parent
        .task(&state.run_id)
        .and_then(|task| task.background_run)
        .context("workflow_recovery: current native Workflow owner missing")?;
    let directory = PrivateDirectory::open_existing(current)?;
    directory.verify_private_directory()?;
    let definition_sha256 = state
        .definition_sha256
        .context("workflow_recovery: fixed definition required")?;
    ensure!(
        digest(read(&directory, "definition.json", MAX_DEFINITION)?) == definition_sha256,
        "workflow_recovery: original definition mismatch"
    );
    let max_turns = request.max_turns;
    let request = request_value(request)?;
    let journal = journal_proof(
        &directory,
        &state.run_id,
        state.resume_count,
        agent,
        &request,
    )?;
    let proof = WorkflowAgentRecovery {
        store: Arc::downgrade(store),
        parent: parent.inspection_lifecycle_identity(),
        directory_identity: directory.directory_identity()?,
        directory,
        root: owner.clone(),
        previous: old.background_run.unwrap(),
        resume_count: state.resume_count,
        definition_sha256,
        journal_bytes: journal.bytes,
        journal_sha256: journal.sha256,
        request_sha256: digest(serde_json::to_vec(&request)?),
        node_id: journal.node_id,
        prompt_sha256: digest(prompt),
        max_turns,
        kind,
        options_sha256: options_digest(options)?,
        cancellation: executor.cancellation.clone(),
    };
    drop(_io);
    proof.verify(
        parent,
        &owner,
        RestartRequest {
            agent,
            prompt,
            max_turns: proof.max_turns,
            kind,
            options,
        },
    )?;
    Ok(Some(Arc::new(proof)))
}

#[cfg(test)]
#[path = "agent_recovery/tests.rs"]
mod tests;
