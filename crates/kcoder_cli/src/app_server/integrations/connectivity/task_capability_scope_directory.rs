//! The public connection may observe saved bindings without starting any task.
use super::super::core::NativeIntegrationContext;
use super::native_task_capability_scope::NativeTaskCapabilityScopeBindingStore;
use crate::app_server::ConnectionState;
use anyhow::{Context, Result, ensure};
use kcoder_types::integrations::core::*;
use std::sync::{Arc, Weak};
use tokio_util::sync::CancellationToken;

/// Captured only from the actual connection; the protocol loop keeps no borrow
/// while the owned reader waits for its bounded filesystem observation.
pub(crate) struct NativeSavedTaskCapabilityScopeReader {
    native: NativeIntegrationContext,
    params: IntegrationTaskCapabilityScopeDirectoryReadParams,
    owner: Weak<()>,
    ended: CancellationToken,
}
impl NativeSavedTaskCapabilityScopeReader {
    pub(crate) fn capture(state: &ConnectionState, request: &IntegrationRequest) -> Result<Self> {
        request.validate(false)?;
        ensure!(
            request.operation_id.is_none(),
            "TASK_CAPABILITY_SCOPE_DIRECTORY_READ_ONLY"
        );
        let native = state
            .integration_context
            .as_ref()
            .context("TASK_CAPABILITY_SCOPE_NATIVE_CALLER_UNAVAILABLE")?
            .recapture_for_owned_service()?;
        native.validate_scope(&request.scope)?;
        ensure!(
            native.scope().organization_id.is_none(),
            "TASK_CAPABILITY_SCOPE_ORGANIZATION_POLICY_REQUIRED"
        );
        let params: IntegrationTaskCapabilityScopeDirectoryReadParams =
            serde_json::from_value(serde_json::Value::Object(request.payload.clone()))?;
        params.validate()?;
        let reader = Self {
            native,
            params,
            owner: Arc::downgrade(&state.source_management_owner),
            ended: state.input_ended.child_token(),
        };
        reader.verify_caller()?;
        Ok(reader)
    }
    fn verify_caller(&self) -> Result<()> {
        ensure!(
            self.owner.upgrade().is_some() && !self.ended.is_cancelled(),
            "TASK_CAPABILITY_SCOPE_NATIVE_CALLER_EXPIRED"
        );
        self.native.verify()
    }
    pub(crate) fn cancellation(&self) -> CancellationToken {
        self.ended.clone()
    }
    pub(crate) async fn read(self) -> Result<IntegrationTaskCapabilityScopeDirectorySnapshot> {
        let owner = self.owner.clone();
        let ended = self.ended.clone();
        let result = crate::app_server::task_spawn::spawn_blocking(move || {
            self.verify_caller()?;
            let page = read_existing(&self.native, &self.params)?;
            self.verify_caller()?;
            Ok::<_, anyhow::Error>(page)
        })
        .await
        .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_DIRECTORY_UNAVAILABLE"))??;
        ensure!(
            owner.upgrade().is_some() && !ended.is_cancelled(),
            "TASK_CAPABILITY_SCOPE_NATIVE_CALLER_EXPIRED"
        );
        Ok(result)
    }
}

#[cfg(test)]
pub(crate) async fn read_saved_task_capability_scope_bindings(
    state: &ConnectionState,
    request: &IntegrationRequest,
) -> Result<IntegrationTaskCapabilityScopeDirectorySnapshot> {
    NativeSavedTaskCapabilityScopeReader::capture(state, request)?
        .read()
        .await
}
fn read_existing(
    context: &NativeIntegrationContext,
    params: &IntegrationTaskCapabilityScopeDirectoryReadParams,
) -> Result<IntegrationTaskCapabilityScopeDirectorySnapshot> {
    let Some(store) = NativeTaskCapabilityScopeBindingStore::observe(context)? else {
        return Ok(IntegrationTaskCapabilityScopeDirectorySnapshot {
            entries: vec![],
            next_cursor: None,
            observation_state: IntegrationTaskCapabilityScopeDirectoryState::Unknown,
            reason_code: Some("TASK_CAPABILITY_SCOPE_BINDINGS_NOT_OBSERVED".into()),
        });
    };
    store.read_saved_directory(context, params)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::integrations::core::runtime_driver::test_support::Fixture;

    fn request(context: &NativeIntegrationContext) -> IntegrationRequest {
        IntegrationRequest {
            contract_version: IntegrationContractVersion::ParallelV1,
            request_id: "owned-directory-lifetime".into(),
            scope: context.scope().clone(),
            operation_id: None,
            expected_revision: None,
            timeout_ms: 1000,
            cancellation_ref: None,
            payload: serde_json::Map::new(),
        }
    }
    #[tokio::test]
    async fn captured_reader_does_not_extend_its_connection_or_publish_after_cancellation()
    -> Result<()> {
        for drop_connection in [false, true] {
            let fixture = Fixture::new();
            let request = request(&fixture.context);
            let state = ConnectionState {
                integration_context: Some(fixture.context),
                ..Default::default()
            };
            let reader = NativeSavedTaskCapabilityScopeReader::capture(&state, &request)?;
            if drop_connection {
                drop(state);
            } else {
                state.input_ended.cancel();
            }
            assert!(reader.read().await.is_err());
        }
        Ok(())
    }

    #[tokio::test]
    async fn read_timeout_token_revokes_only_that_reader_and_another_observation_stays_available()
    -> Result<()> {
        let fixture = Fixture::new();
        let request = request(&fixture.context);
        let state = ConnectionState {
            integration_context: Some(fixture.context),
            ..Default::default()
        };
        let timed_out = NativeSavedTaskCapabilityScopeReader::capture(&state, &request)?;
        let peer = NativeSavedTaskCapabilityScopeReader::capture(&state, &request)?;
        timed_out.cancellation().cancel();
        assert!(timed_out.read().await.is_err());
        let observed = peer.read().await?;
        assert_eq!(
            observed.observation_state,
            IntegrationTaskCapabilityScopeDirectoryState::Unknown
        );
        assert!(observed.entries.is_empty());
        assert!(!state.input_ended.is_cancelled());
        Ok(())
    }
}
