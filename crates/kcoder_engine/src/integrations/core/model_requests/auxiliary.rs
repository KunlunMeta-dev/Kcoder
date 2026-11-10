//! Native queue ownership is captured before spawning an asynchronous worker.
use super::{NativeModelRequestError, NativeModelRequestPurpose};
use crate::{QueryEngine, integrations::core::NativeToolExecutionWitness};
use std::{future::Future, sync::Arc};

pub struct NativeAuxiliaryModelRequest<'a> {
    engine: &'a QueryEngine,
    execution: NativeToolExecutionWitness,
    purpose: NativeModelRequestPurpose,
}
impl NativeAuxiliaryModelRequest<'_> {
    pub fn engine(&self) -> &QueryEngine {
        self.engine
    }
    pub fn execution(&self) -> &NativeToolExecutionWitness {
        &self.execution
    }
    pub fn purpose(&self) -> NativeModelRequestPurpose {
        self.purpose
    }
}

pub(crate) struct NativeAuxiliaryWork {
    scope: Option<kcoder_state::HistoryAppendScope>,
    lifecycle: kcoder_state::AppStateLifecycleIdentity,
    state: kcoder_state::AppState,
    _retention: Option<Arc<dyn Send + Sync>>,
}
impl NativeAuxiliaryWork {
    pub(crate) async fn run<F: Future>(self, future: F) -> Option<F::Output> {
        if !self.lifecycle.matches(&self.state) {
            return None;
        }
        match self.scope {
            Some(scope) => Some(scope.run(future).await),
            None => Some(future.await),
        }
    }
}
impl QueryEngine {
    pub(crate) fn capture_auxiliary_model_work(
        &self,
        purpose: NativeModelRequestPurpose,
    ) -> Result<NativeAuxiliaryWork, NativeModelRequestError> {
        let request = NativeAuxiliaryModelRequest {
            engine: self,
            execution: self.native_tool_execution_witness(),
            purpose,
        };
        let scope = request
            .execution
            .attempt()
            .cloned()
            .map(|identity| self.state.history_attempt_scope(identity))
            .transpose()
            .map_err(|_| NativeModelRequestError::Unavailable)?;
        let retention = self
            .validated_model_request_binding()
            .map_err(|_| NativeModelRequestError::Unavailable)?
            .map(|binding| binding.observer.retain_auxiliary(&request))
            .transpose()?
            .flatten();
        Ok(NativeAuxiliaryWork {
            scope,
            lifecycle: self.state.inspection_lifecycle_identity(),
            state: self.state.clone(),
            _retention: retention,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::engine_builder::TestEngineBuilder;

    #[tokio::test]
    async fn queued_auxiliary_restores_each_original_task_local_without_changing_the_caller() {
        let root = tempfile::tempdir().unwrap();
        let engine = TestEngineBuilder::new(root.path()).build_with_profile_directory();
        let first = kcoder_types::TurnAttemptIdentity {
            thread_id: engine.session_id(),
            turn_id: "turn-first".into(),
            attempt_id: "attempt-first".into(),
        };
        let second = kcoder_types::TurnAttemptIdentity {
            thread_id: engine.session_id(),
            turn_id: "turn-second".into(),
            attempt_id: "attempt-second".into(),
        };
        let owner = engine
            .state
            .history_attempt_scope(first.clone())
            .unwrap()
            .run(async {
                engine
                    .capture_auxiliary_model_work(NativeModelRequestPurpose::MemoryObserver)
                    .unwrap()
            })
            .await;
        assert!(engine.state.current_history_attempt_identity().is_none());
        let state = engine.state.clone();
        let seen = engine
            .state
            .history_attempt_scope(second.clone())
            .unwrap()
            .run(async {
                let seen = tokio::spawn(async move {
                    owner
                        .run(async { state.current_history_attempt_identity() })
                        .await
                })
                .await
                .unwrap();
                assert_eq!(
                    engine.state.current_history_attempt_identity(),
                    Some(second)
                );
                seen
            })
            .await;
        assert_eq!(seen, Some(Some(first)));
        assert!(engine.state.current_history_attempt_identity().is_none());
    }

    #[tokio::test]
    async fn queued_auxiliary_does_not_execute_after_its_state_session_is_replaced() {
        let root = tempfile::tempdir().unwrap();
        let engine = TestEngineBuilder::new(root.path()).build_with_profile_directory();
        let owner = engine
            .capture_auxiliary_model_work(NativeModelRequestPurpose::MemoryObserver)
            .unwrap();
        engine.start_new_session().unwrap();
        let called = std::sync::atomic::AtomicBool::new(false);
        assert!(
            owner
                .run(async {
                    called.store(true, std::sync::atomic::Ordering::SeqCst);
                })
                .await
                .is_none()
        );
        assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
    }
}
