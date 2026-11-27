//! Workflow parents are proved by their actual installed native runtime authority.
use super::{NativeToolAuthorizationError, NativeToolExecutionWitness};
use crate::QueryEngine;
use kcoder_state::AppStateLifecycleIdentity;
use kcoder_types::BackgroundRunKey;

pub use kcoder_workflow::native_parent_facts::NativeWorkflowParentFacts;

/// Only Core constructs this request from actual parent State/run records.
pub struct NativeWorkflowParentRequest<'a> {
    parent: &'a QueryEngine,
    execution: &'a NativeToolExecutionWitness,
    run: BackgroundRunKey,
}
impl NativeWorkflowParentRequest<'_> {
    pub fn parent(&self) -> &QueryEngine {
        self.parent
    }
    pub fn parent_execution(&self) -> &NativeToolExecutionWitness {
        self.execution
    }
    pub fn run(&self) -> &BackgroundRunKey {
        &self.run
    }
    pub fn agent_id(&self) -> &str {
        &self.run.agent_id
    }
}
/// A native runtime's successful verification is sealed here with actual State
/// lifecycle and the original allocated run. No JSON/struct literal constructor.
pub struct NativeWorkflowParentWitness {
    state: AppStateLifecycleIdentity,
    run: BackgroundRunKey,
    facts: NativeWorkflowParentFacts,
}
impl NativeWorkflowParentWitness {
    pub fn facts(&self) -> &NativeWorkflowParentFacts {
        &self.facts
    }
    pub fn matches_parent(&self, parent: &QueryEngine) -> bool {
        self.state.matches(&parent.state) && self.run.parent_session_id == parent.session_id()
    }
    pub fn matches_run(&self, run: &BackgroundRunKey) -> bool {
        self.run == *run
    }
}
impl QueryEngine {
    pub(crate) async fn capture_native_workflow_parent(
        &self,
        original: &NativeToolExecutionWitness,
        agent_id: &str,
    ) -> Result<NativeWorkflowParentWitness, NativeToolAuthorizationError> {
        let authority = self
            .native_tool_authorization
            .as_ref()
            .ok_or(NativeToolAuthorizationError::Unavailable)?;
        if !original.matches_state(&self.state)
            || original.session_id() != self.session_id()
            || original.attempt().is_some()
        {
            return Err(NativeToolAuthorizationError::Denied);
        }
        let task = self
            .state
            .task(agent_id)
            .ok_or(NativeToolAuthorizationError::Unavailable)?;
        let run = task
            .background_run
            .ok_or(NativeToolAuthorizationError::Unavailable)?;
        let current = || {
            original.matches_state(&self.state)
                && self.state.task(agent_id).is_some_and(|task| {
                    task.background_run.as_ref() == Some(&run)
                        && task
                            .parent_session_id
                            .as_deref()
                            .is_none_or(|id| id == self.session_id())
                        && matches!(
                            task.status,
                            kcoder_types::TaskStatus::Pending | kcoder_types::TaskStatus::Running
                        )
                })
                && self
                    .state
                    .background_run_record(&run)
                    .is_some_and(|record| record.terminal.is_none() && !record.imported_history)
        };
        if !current() {
            return Err(NativeToolAuthorizationError::Denied);
        }
        let request = NativeWorkflowParentRequest {
            parent: self,
            execution: original,
            run: run.clone(),
        };
        let facts = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            authority.workflow_parent_origin(&request),
        )
        .await
        .unwrap_or(Err(NativeToolAuthorizationError::Unavailable))?;
        if !facts.valid() || !current() {
            return Err(NativeToolAuthorizationError::Denied);
        }
        Ok(NativeWorkflowParentWitness {
            state: self.state.inspection_lifecycle_identity(),
            run,
            facts,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::core::{NativeToolAuthorization, NativeToolAuthorizationRequest};
    use crate::test_support::engine_builder::TestEngineBuilder;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    // This checks Core's native capability boundary only. D's real private
    // operation/workflow/source authority supplies production verification.
    struct NativeAuthorityFixture {
        state: kcoder_state::AppState,
        enabled: AtomicBool,
    }
    #[async_trait::async_trait]
    impl NativeToolAuthorization for NativeAuthorityFixture {
        async fn authorize(
            &self,
            _: &NativeToolAuthorizationRequest<'_>,
        ) -> Result<(), NativeToolAuthorizationError> {
            Err(NativeToolAuthorizationError::Denied)
        }
        async fn workflow_parent_origin(
            &self,
            request: &NativeWorkflowParentRequest<'_>,
        ) -> Result<NativeWorkflowParentFacts, NativeToolAuthorizationError> {
            if !self.enabled.load(Ordering::SeqCst)
                || !request.parent_execution().matches_state(&self.state)
                || request.parent_execution().attempt().is_some()
            {
                return Err(NativeToolAuthorizationError::Denied);
            }
            Ok(NativeWorkflowParentFacts {
                operation_id: "owned-native-operation".into(),
                receipt_revision: 2,
                runtime_acceptance_sha256: "a".repeat(64),
                workflow_task_id: "owned-workflow-run".into(),
                definition_id: "owned-definition".into(),
                definition_version: 1,
                node_id: "owned-node".into(),
                source_revision: "b".repeat(64),
            })
        }
    }
    fn parent() -> (tempfile::TempDir, QueryEngine, Arc<NativeAuthorityFixture>) {
        let temp = tempfile::tempdir().unwrap();
        let engine = TestEngineBuilder::new(temp.path()).build_with_profile_directory();
        let mut task = kcoder_state::Task::new("actual-node-agent", "native node fixture");
        task.kind = kcoder_state::TaskKind::Subagent;
        task.parent_session_id = Some(engine.session_id());
        engine.state.start_background_task_run(task).unwrap();
        let authority = Arc::new(NativeAuthorityFixture {
            state: engine.state.clone(),
            enabled: AtomicBool::new(true),
        });
        (
            temp,
            engine.with_native_tool_authorization(authority.clone()),
            authority,
        )
    }
    #[tokio::test]
    async fn native_workflow_seal_binds_actual_state_and_original_allocated_run_without_user_ti() {
        let (_temp, parent, authority) = parent();
        let frame = parent.native_tool_execution_witness();
        assert!(frame.attempt().is_none());
        let proof = parent
            .capture_native_workflow_parent(&frame, "actual-node-agent")
            .await
            .unwrap();
        assert!(proof.matches_parent(&parent));
        let run = parent
            .state
            .task("actual-node-agent")
            .unwrap()
            .background_run
            .unwrap();
        assert!(proof.matches_run(&run));
        assert_eq!(proof.facts().operation_id, "owned-native-operation");
        authority.enabled.store(false, Ordering::SeqCst);
        assert!(
            parent
                .capture_native_workflow_parent(&frame, "actual-node-agent")
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn matching_labels_or_missing_live_native_run_never_construct_workflow_origin() {
        let (temp, parent, _) = parent();
        let peer = TestEngineBuilder::new(temp.path()).build_with_profile_directory();
        let peer_frame = peer.native_tool_execution_witness();
        assert!(
            parent
                .capture_native_workflow_parent(&peer_frame, "actual-node-agent")
                .await
                .is_err()
        );
        let frame = parent.native_tool_execution_witness();
        assert!(
            parent
                .capture_native_workflow_parent(&frame, "display-name-only")
                .await
                .is_err()
        );
        let run = parent
            .state
            .task("actual-node-agent")
            .unwrap()
            .background_run
            .unwrap();
        parent
            .state
            .commit_background_terminal(
                &kcoder_types::BackgroundEventIdentity::terminal(run),
                kcoder_types::TaskStatus::Completed,
                None,
            )
            .unwrap();
        assert!(
            parent
                .capture_native_workflow_parent(&frame, "actual-node-agent")
                .await
                .is_err()
        );
    }
    struct ToolOnly;
    #[async_trait::async_trait]
    impl NativeToolAuthorization for ToolOnly {
        async fn authorize(
            &self,
            _: &NativeToolAuthorizationRequest<'_>,
        ) -> Result<(), NativeToolAuthorizationError> {
            Ok(())
        }
    }
    #[tokio::test]
    async fn none_attempt_is_not_native_workflow_permission_without_required_verifier() {
        let (_temp, parent, _) = parent();
        let parent = parent.with_native_tool_authorization(Arc::new(ToolOnly));
        let frame = parent.native_tool_execution_witness();
        assert!(matches!(
            parent
                .capture_native_workflow_parent(&frame, "actual-node-agent")
                .await,
            Err(NativeToolAuthorizationError::Unavailable)
        ));
    }
    #[tokio::test]
    async fn real_chat_attempt_keeps_the_original_chat_path_and_cannot_be_relabelled_workflow() {
        let (_temp, parent, _) = parent();
        let identity = kcoder_types::TurnAttemptIdentity {
            thread_id: parent.session_id(),
            turn_id: "actual-chat-turn".into(),
            attempt_id: "actual-chat-attempt".into(),
        };
        parent
            .state
            .history_attempt_scope(identity)
            .unwrap()
            .run(async {
                let frame = parent.native_tool_execution_witness();
                assert!(frame.attempt().is_some());
                assert!(matches!(
                    parent
                        .capture_native_workflow_parent(&frame, "actual-node-agent")
                        .await,
                    Err(NativeToolAuthorizationError::Denied)
                ));
            })
            .await;
    }
}
