//! Source-restricted children use the existing actual attempt ledger and job.
use super::NativeToolExecutionWitness;
use crate::QueryEngine;
use anyhow::{Context, Result, ensure};
use kcoder_state::{
    HistoryAppendScope,
    turn_attempt_store::{
        TurnAttemptBeginOutcome, TurnAttemptCompletion, TurnAttemptRecord, TurnAttemptStore,
    },
};
use kcoder_types::{BackgroundRunKey, TurnAttemptIdentity, TurnAttemptStatus};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// Actual Engine/control references and the producer's original parent frame.
/// Only the existing native child execution path constructs this request.
pub struct NativeChildAdmissionRequest<'a> {
    parent: &'a QueryEngine,
    child: &'a QueryEngine,
    parent_execution: &'a NativeToolExecutionWitness,
    workflow_parent: Option<&'a super::NativeWorkflowParentWitness>,
    run: BackgroundRunKey,
    identity: TurnAttemptIdentity,
    input_hash: String,
    fingerprint: String,
}
impl NativeChildAdmissionRequest<'_> {
    pub fn parent(&self) -> &QueryEngine {
        self.parent
    }
    pub fn child(&self) -> &QueryEngine {
        self.child
    }
    pub fn parent_execution(&self) -> &NativeToolExecutionWitness {
        self.parent_execution
    }
    pub fn workflow_parent(&self) -> Option<&super::NativeWorkflowParentWitness> {
        self.workflow_parent
    }

    pub fn run(&self) -> &BackgroundRunKey {
        &self.run
    }
    pub fn identity(&self) -> &TurnAttemptIdentity {
        &self.identity
    }
    pub fn input_hash(&self) -> &str {
        &self.input_hash
    }
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}
impl<'a> NativeChildAdmissionRequest<'a> {
    fn capture(
        parent: &'a QueryEngine,
        child: &'a QueryEngine,
        original: &'a NativeToolExecutionWitness,
        workflow_parent: Option<&'a super::NativeWorkflowParentWitness>,
    ) -> Result<Self> {
        ensure!(
            original.matches_state(&parent.state)
                && original.session_id() == parent.session_id()
                && (original.attempt().is_some() && workflow_parent.is_none()
                    || original.attempt().is_none()
                        && workflow_parent.is_some_and(|proof| proof.matches_parent(parent))),
            "NATIVE_CHILD_ORIGINAL_PARENT_REQUIRED"
        );
        let control = child
            .subagent_runtime_control
            .as_ref()
            .as_ref()
            .context("NATIVE_CHILD_CONTROL_REQUIRED")?;
        let run = control
            .expected_background_run
            .clone()
            .context("NATIVE_CHILD_NATIVE_RUN_REQUIRED")?;
        if let Some(proof) = workflow_parent {
            ensure!(
                proof.matches_run(&run),
                "NATIVE_WORKFLOW_PARENT_RUN_CHANGED"
            );
        }
        let task = parent
            .state
            .task(&run.agent_id)
            .context("NATIVE_CHILD_NATIVE_RUN_REQUIRED")?;
        ensure!(
            run.parent_session_id == parent.session_id()
                && control
                    .parent_state
                    .inspection_identity()
                    .matches(&parent.state)
                && control.agent_id == run.agent_id
                && task
                    .parent_session_id
                    .as_deref()
                    .map_or(workflow_parent.is_some(), |id| id == parent.session_id())
                && task.background_run.as_ref() == Some(&run)
                && matches!(
                    task.status,
                    kcoder_types::TaskStatus::Pending | kcoder_types::TaskStatus::Running
                ),
            "NATIVE_CHILD_NATIVE_RUN_CHANGED"
        );
        ensure!(
            parent
                .state
                .background_run_record(&run)
                .is_some_and(|record| record.terminal.is_none() && !record.imported_history),
            "NATIVE_CHILD_NATIVE_RUN_CHANGED"
        );
        // The UUID was allocated by the real task/run ledger before spawning,
        // not inferred from a display/agent/session label. A retry retains this
        // identity and must reconcile its original private record, never replay.
        uuid::Uuid::parse_str(&run.run_id).context("NATIVE_CHILD_NATIVE_RUN_REQUIRED")?;
        let identity = TurnAttemptIdentity {
            thread_id: child.session_id(),
            turn_id: format!("native-child-turn-{}", run.run_id),
            attempt_id: format!("native-child-attempt-{}", run.run_id),
        };
        identity.validate().map_err(anyhow::Error::msg)?;
        let input_hash = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&child.state.messages())?)
        );
        let fingerprint_bytes = if let Some(workflow) = workflow_parent {
            serde_json::to_vec(&(
                original.attempt(),
                workflow.facts().fingerprint_value(),
                &run,
                &identity,
                &input_hash,
            ))?
        } else {
            // Keep the original chat intent bytes unchanged.
            serde_json::to_vec(&(original.attempt(), &run, &identity, &input_hash))?
        };
        let fingerprint = format!("{:x}", Sha256::digest(fingerprint_bytes));
        Ok(Self {
            parent,
            child,
            parent_execution: original,
            workflow_parent,
            run,
            identity,
            input_hash,
            fingerprint,
        })
    }
}

pub(crate) struct NativeChildAcceptedScope {
    scope: HistoryAppendScope,
    terminal: ChildCompletion,
}
struct ChildCompletion {
    store: Arc<TurnAttemptStore>,
    identity: TurnAttemptIdentity,
    observer: Option<Arc<crate::native_model_requests::ModelRequestBinding>>,
    finished: bool,
}
impl ChildCompletion {
    fn notify(&self) {
        if self
            .observer
            .as_ref()
            .is_some_and(|observer| observer.observe_execution_terminal().is_err())
        {
            tracing::warn!("native child budget terminal reconciliation remains pending");
        }
    }
}
impl Drop for ChildCompletion {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        // Cancellation drops the original owned future. Record that interruption
        // without claiming remote calls ended or refunding their unknown charges.
        let completion = TurnAttemptCompletion {
            status: TurnAttemptStatus::Interrupted,
            finished_at_ms: now_ms(),
            error: Some("NATIVE_CHILD_EXECUTION_DROPPED".into()),
            provider_failure: None,
            partial_output: String::new(),
            partial_output_truncated: false,
            committed_history_uuid: None,
        };
        if self.store.finish(&self.identity, completion).is_ok() {
            self.notify();
        }
    }
}
impl NativeChildAcceptedScope {
    pub(crate) async fn run<T>(
        self,
        future: impl std::future::Future<Output = Result<T>>,
    ) -> Result<T> {
        let mut terminal = self.terminal;
        let result = self.scope.run(future).await;
        let status = if result.is_ok() {
            TurnAttemptStatus::Completed
        } else {
            TurnAttemptStatus::Failed
        };
        let completion = TurnAttemptCompletion {
            status,
            finished_at_ms: now_ms(),
            error: result
                .as_ref()
                .err()
                .map(|_| "NATIVE_CHILD_EXECUTION_STOPPED".into()),
            provider_failure: None,
            partial_output: String::new(),
            partial_output_truncated: false,
            committed_history_uuid: None,
        };
        if terminal
            .store
            .finish(&terminal.identity, completion.clone())
            .is_err()
        {
            let current = terminal
                .store
                .load(&terminal.identity)?
                .context("NATIVE_CHILD_COMPLETION_UNKNOWN")?;
            ensure!(
                current.completion == Some(completion),
                "NATIVE_CHILD_COMPLETION_UNKNOWN"
            );
        }
        terminal.finished = true;
        terminal.notify();
        result
    }
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
impl QueryEngine {
    pub(crate) async fn admit_native_child(
        &self,
        parent: &QueryEngine,
        original: Option<&NativeToolExecutionWitness>,
        workflow_parent: Option<&super::NativeWorkflowParentWitness>,
    ) -> Result<Option<NativeChildAcceptedScope>> {
        let authority = self.native_tool_authorization.as_ref();
        let model_binding = self
            .validated_model_request_binding()?
            .filter(|binding| binding.has_mandatory_guard());
        if authority.is_none() && model_binding.is_none() {
            return Ok(None);
        }
        let original = original.context("NATIVE_CHILD_ORIGINAL_PARENT_REQUIRED")?;
        let request =
            NativeChildAdmissionRequest::capture(parent, self, original, workflow_parent)?;
        // The required source authority durably fixes its original lineage
        // intent before this single Accepted write. Unknown preparation refuses.
        if let Some(binding) = &model_binding {
            binding
                .prepare_native_child(&request)
                .map_err(|_| anyhow::anyhow!("NATIVE_CHILD_MODEL_ADMISSION_UNAVAILABLE"))?;
        }
        if let Some(authority) = authority {
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                authority.authorize_child(&request),
            )
            .await
            .map_err(|_| anyhow::anyhow!("NATIVE_CHILD_ADMISSION_UNAVAILABLE"))??;
        }
        let store = Arc::new(TurnAttemptStore::open(
            &self.session_storage_dir_for(&request.identity.thread_id),
            &request.identity.thread_id,
        )?);
        ensure!(
            store.load(&request.identity)?.is_none(),
            "NATIVE_CHILD_EXISTING_ATTEMPT_REQUIRES_RECONCILIATION"
        );
        let record = TurnAttemptRecord {
            client_presentation: self.client_presentation.clone(),
            version: 1,
            identity: request.identity.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: now_ms(),
            input_context_hash: request.input_hash.clone(),
            request_fingerprint: Some(request.fingerprint.clone()),
            retained_input: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        };
        match store.begin(record.clone()) {
            Ok(TurnAttemptBeginOutcome::Created(_)) => {}
            Ok(TurnAttemptBeginOutcome::Existing(_)) => {
                anyhow::bail!("NATIVE_CHILD_EXISTING_ATTEMPT_REQUIRES_RECONCILIATION")
            }
            Err(_) => ensure!(
                store.load(&request.identity)?.as_ref() == Some(&record),
                "NATIVE_CHILD_ACCEPTED_OUTCOME_UNKNOWN"
            ),
        }
        let observe = self
            .state
            .history_attempt_scope(request.identity.clone())?
            .run(async {
                if let Some(binding) = &model_binding {
                    binding
                        .observe_native_child_accepted(&request)
                        .map_err(|_| anyhow::anyhow!("NATIVE_CHILD_MODEL_ADMISSION_UNAVAILABLE"))?;
                }
                if let Some(authority) = authority {
                    tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        authority.observe_child_accepted(&request),
                    )
                    .await
                    .map_err(|_| anyhow::anyhow!("NATIVE_CHILD_ADMISSION_UNAVAILABLE"))?
                    .map_err(anyhow::Error::from)?;
                }
                Ok::<(), anyhow::Error>(())
            })
            .await;
        if let Err(error) = observe {
            let _ = store.finish(
                &request.identity,
                TurnAttemptCompletion {
                    status: TurnAttemptStatus::Interrupted,
                    finished_at_ms: now_ms(),
                    error: Some("NATIVE_CHILD_UNSTARTED_ADMISSION_FAILED".into()),
                    provider_failure: None,
                    partial_output: String::new(),
                    partial_output_truncated: false,
                    committed_history_uuid: None,
                },
            );
            return Err(error);
        }
        Ok(Some(NativeChildAcceptedScope {
            scope: self.state.history_attempt_scope(request.identity.clone())?,
            terminal: ChildCompletion {
                store,
                identity: request.identity,
                observer: self.model_request_binding.clone(),
                finished: false,
            },
        }))
    }
}

#[cfg(test)]
#[path = "child_admission_tests.rs"]
mod tests;
