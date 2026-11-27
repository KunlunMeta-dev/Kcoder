//! One connection-owned pass driven by the existing app-server tick; no extra timer or queue.
use super::{NativeAutomationRuntimePort, NativeKnowledgeRpc};
use crate::app_server::ConnectionState;
use crate::app_server::task_spawn::JoinSetExt as _;
use anyhow::{Context, Result, ensure};
use kcoder_engine::QueryEngine;
use kcoder_types::integrations::core::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

#[derive(Default)]
pub(crate) struct NativeAutomationScheduler {
    running: Arc<AtomicBool>,
}
struct TickOwner(Arc<AtomicBool>);
impl Drop for TickOwner {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl NativeAutomationScheduler {
    /// Only an initialized native connection with the actual enabled settings
    /// may enqueue a bounded pass. Saving a template or feature enable creates
    /// no subscription; the domain reads only existing explicitly agreed runs.
    pub(crate) fn queue_tick(&self, engine: &QueryEngine, state: &mut ConnectionState) -> bool {
        let enabled = engine.settings.read().ok().is_some_and(|settings| {
            !settings.training_mode && settings.integrations.knowledge.business_automation_enabled
        });
        if !enabled
            || !state.initialized
            || state.input_ended.is_cancelled()
            || state.knowledge_rpc_tasks.len() >= 64
            || self
                .running
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
                .is_err()
        {
            return false;
        }
        let owner = TickOwner(self.running.clone());
        let prepared = (|| -> Result<_> {
            let native = state
                .integration_context
                .as_ref()
                .context("AUTOMATION_NATIVE_OWNER_UNAVAILABLE")?
                .recapture_for_owned_service()?;
            let runtime = state
                .integration_runtime
                .clone()
                .context("AUTOMATION_RUNTIME_UNAVAILABLE")?;
            Ok((
                native,
                runtime,
                super::AutomationOfficeFactory::capture(state),
            ))
        })();
        let Ok((mut native, runtime, office)) = prepared else {
            return false;
        };
        let engine = engine.clone();
        let cache = state.integration_knowledge.clone();
        let cancel = state.input_ended.child_token();
        state.knowledge_rpc_tasks.spawn_shared(async move {
            let _owner = owner;
            let operation = async {
                ensure!(!cancel.is_cancelled(), "AUTOMATION_TICK_CANCELLED");
                native.refresh_configuration_revision(
                    engine.active_model_configuration_summary()?.revision,
                )?;
                let host = {
                    let mut shared = cache.lock().await;
                    if !shared.has_native_runtime_binding() {
                        let port = NativeAutomationRuntimePort::capture(
                            &native,
                            &engine,
                            Arc::downgrade(&cache),
                            runtime,
                            None,
                        )?
                        .with_office(office);
                        shared.bind_native_runtime(Arc::new(port));
                    }
                    // Reuse the current host and its real source invalidation epoch.
                    // The mutex is released before any original Runtime queue wait.
                    let mut fork: NativeKnowledgeRpc = shared.request_fork(&mut native, &engine)?;
                    fork.host_for_engine(&native, &engine)?
                };
                ensure!(
                    host.runtime_sources_current() && !cancel.is_cancelled(),
                    "AUTOMATION_TICK_OWNER_CHANGED"
                );
                let request = IntegrationRequest {
                    contract_version: IntegrationContractVersion::ParallelV1,
                    request_id: format!("native-automation-tick-{}", uuid::Uuid::new_v4()),
                    scope: native.scope().clone(),
                    operation_id: None,
                    expected_revision: None,
                    timeout_ms: INTEGRATION_MAX_WAIT_MS,
                    cancellation_ref: None,
                    payload: serde_json::Map::new(),
                };
                let now = u64::try_from(chrono::Utc::now().timestamp_millis())?;
                let replies = host.automation_tick(&request, now, &cancel).await?;
                ensure!(
                    host.runtime_sources_current() && !cancel.is_cancelled(),
                    "AUTOMATION_TICK_OWNER_CHANGED"
                );
                // Only original domain records/receipts carry outcomes. A timer
                // completion is never promoted to task or delivery success.
                Ok::<_, anyhow::Error>(replies.len())
            };
            match tokio::time::timeout(Duration::from_millis(INTEGRATION_MAX_WAIT_MS), operation)
                .await
            {
                Ok(Ok(_)) => {}
                _ => tracing::debug!("native business automation tick remains unconfirmed"),
            }
        });
        true
    }
}

#[cfg(test)]
#[path = "native_scheduler/composition_tests.rs"]
mod composition_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn disabled_actual_feature_never_captures_context_or_creates_a_store_or_job() {
        let directory = tempfile::tempdir().unwrap();
        let engine = crate::app_server::tests::catalog_list_test_engine(directory.path());
        let before = std::fs::read_dir(directory.path()).unwrap().count();
        let mut state = ConnectionState {
            initialized: true,
            ..Default::default()
        };
        assert!(!NativeAutomationScheduler::default().queue_tick(&engine, &mut state));
        assert!(state.integration_context.is_none());
        assert!(state.knowledge_rpc_tasks.is_empty());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), before);
    }

    #[tokio::test]
    async fn training_mode_never_queues_a_tick_even_with_real_enabled_native_owners() {
        let fixture =
            crate::app_server::integrations::core::runtime_driver::test_support::Fixture::new();
        let engine = crate::app_server::tests::catalog_list_test_engine(&fixture.workspace);
        {
            let mut settings = engine.settings.write().unwrap();
            settings.training_mode = true;
            settings.integrations.knowledge.business_automation_enabled = true;
        }
        let (_pump, client) =
            crate::app_server::integrations::core::runtime_pump::NativeRuntimePump::new();
        let mut state = ConnectionState {
            initialized: true,
            integration_context: Some(fixture.context),
            integration_runtime: Some(client),
            ..Default::default()
        };
        assert!(!NativeAutomationScheduler::default().queue_tick(&engine, &mut state));
        assert!(state.knowledge_rpc_tasks.is_empty());
    }
}
