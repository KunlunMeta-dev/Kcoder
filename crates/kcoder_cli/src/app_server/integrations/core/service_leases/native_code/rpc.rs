//! Finite native management controls. No model/SDK callback can construct their owner.
use super::diagnostics::{self, Stage};
use super::*;
use crate::app_server::task_spawn::JoinSetExt as _;
use crate::app_server::*;
use anyhow::{Context, ensure};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use kcoder_app_protocol::integrations::code_services::{
    NativeCodeCurrentOsState, NativeCodeOwnerObservation, NativeCodeServiceMethod as Method,
    NativeCodeServiceMutationResult, NativeCodeServiceReadResult,
};
use kcoder_app_rpc_codec as rpc_codec;
pub(crate) const PREPARE: &str = Method::Prepare.wire_name();
pub(crate) const READ: &str = Method::Read.wire_name();
pub(crate) const START: &str = Method::Start.wire_name();
pub(crate) const REVOKE: &str = Method::Revoke.wire_name();
type Locator = kcoder_app_protocol::integrations::code_services::NativeCodeServiceLocator;

struct Control {
    native: NativeIntegrationContext,
    request: IntegrationRequest,
    owner: Weak<()>,
    ended: CancellationToken,
    deadline: Instant,
}
impl Control {
    fn capture(
        state: &ConnectionState,
        request: IntegrationRequest,
        mutation: bool,
    ) -> Result<Self> {
        request.validate(mutation)?;
        ensure!(
            state.initialized
                && !state.native_source_dispatch
                && state.native_source_accepted.is_none()
                && !state.input_ended.is_cancelled(),
            "NATIVE_CODE_ORIGINAL_MANAGEMENT_REQUIRED"
        );
        let native = state
            .integration_context
            .as_ref()
            .context("NATIVE_CODE_SCOPE_UNAVAILABLE")?
            .recapture_for_owned_service()?;
        native.validate_scope(&request.scope)?;
        Ok(Self {
            native,
            owner: Arc::downgrade(&state.source_management_owner),
            ended: state.input_ended.clone(),
            deadline: Instant::now() + Duration::from_millis(request.timeout_ms),
            request,
        })
    }
    fn verify(&self) -> Result<()> {
        self.native.validate_scope(&self.request.scope)?;
        ensure!(
            self.owner.upgrade().is_some()
                && !self.ended.is_cancelled()
                && Instant::now() < self.deadline,
            "NATIVE_CODE_MANAGEMENT_OWNER_ENDED"
        );
        Ok(())
    }
    fn run(self, method: &str) -> Result<serde_json::Value> {
        self.verify()?;
        let locator: Locator =
            serde_json::from_value(serde_json::Value::Object(self.request.payload.clone()))?;
        let storage = NativeServiceLeases::load(&self.native)?
            .context("NATIVE_CODE_ORIGINAL_STORE_REQUIRED")?;
        let store = storage.store(&self.native)?;
        let record = store
            .read_native_code(&locator.lease_id)?
            .context("NATIVE_CODE_SERVICE_NOT_FOUND")?;
        let issuer = integrations::core::NativePolicyService::load(&self.native)?
            .context("NATIVE_CODE_ORIGINAL_ISSUER_REQUIRED")?;
        if method == READ {
            let grant =
                issuer.read_native_code_service_issue(&self.native, &record.intent, now()?)?;
            return serde_json::to_value(NativeCodeServiceReadResult {
                record,
                grant,
                owner_observation: NativeCodeOwnerObservation::LastPersisted,
                current_os_state: NativeCodeCurrentOsState::Unknown,
            })
            .map_err(Into::into);
        }
        let expected = self
            .request
            .expected_revision
            .as_ref()
            .and_then(|value| value.parse::<u64>().ok())
            .context("NATIVE_CODE_EXPECTED_REVISION_REQUIRED")?;
        let operations = integrations::core::NativeOperations::load(&self.native)?
            .context("NATIVE_CODE_ORIGINAL_OPERATION_STORE_REQUIRED")?;
        let operation = self
            .request
            .operation_id
            .as_deref()
            .context("NATIVE_CODE_OPERATION_REQUIRED")?;
        let prior = operations.read(&self.native, operation)?;
        // A new enable intent must pass the same current native source and
        // grant checks before any persistent mutation. Known receipts remain
        // readable when the feature is disabled; they cannot launch again.
        let start_authority = if method == START && prior.is_none() {
            self.verify()?;
            let launch = store.read_native_code_launch(&locator.lease_id)?;
            let source = diagnostics::mark(
                Stage::OwnerSource,
                super::source::NativeSavedCodeSource::from_launch(
                    &self.native,
                    &launch,
                    &self.ended,
                ),
            )?;
            let permit = issuer.authorize_native_code_service(
                &self.native,
                &record,
                &source.snapshot()?,
                now()?,
            )?;
            self.verify()?;
            Some((launch, source, permit))
        } else {
            None
        };
        let (receipt, execute) =
            operations.begin(&self.native, &self.request, "P-POLICY", method)?;
        if receipt.phase == IntegrationOperationPhase::Completed {
            return serde_json::to_value(NativeCodeServiceMutationResult {
                record,
                ready: None,
                grant: None,
                reconciled: true,
                cancellation_requested: false,
                cancellation_settled: false,
            })
            .map_err(Into::into);
        }
        ensure!(
            record.revision == expected,
            "NATIVE_CODE_SERVICE_REVISION_CONFLICT"
        );
        if method == REVOKE {
            let grant = issuer.revoke_native_code_service(
                &self.native,
                operation,
                &record.grant_ref,
                now()?,
            )?;
            let record = store.transition_native_code(
                &locator.lease_id,
                record.revision,
                NativeCodeServiceState::Revoked,
                now()?,
            )?;
            operations.transition(
                &self.native,
                &receipt,
                IntegrationOperationPhase::Completed,
                None,
            )?;
            return serde_json::to_value(NativeCodeServiceMutationResult {
                record,
                ready: None,
                grant: Some(grant),
                reconciled: false,
                cancellation_requested: true,
                cancellation_settled: false,
            })
            .map_err(Into::into);
        }
        ensure!(
            method == START && execute && prior.is_none(),
            "NATIVE_CODE_START_REQUIRES_ORIGINAL_READ"
        );
        self.verify()?;
        let (launch, source, permit) =
            start_authority.context("NATIVE_CODE_START_REQUIRES_ORIGINAL_READ")?;
        issuer.revalidate_native_code_service(
            &self.native,
            &permit,
            &source.snapshot()?,
            now()?,
        )?;
        self.verify()?;
        let enabled = if record.enabled {
            record.clone()
        } else {
            store.set_native_code_enabled(&locator.lease_id, record.revision, true, now()?)?
        };
        let ready = diagnostics::mark(
            Stage::ManagerCall,
            super::manager::request_start(
                &launch.profile_path,
                &launch.workspace_path,
                &enabled.intent.lease_id,
                self.deadline.saturating_duration_since(Instant::now()),
            ),
        )?;
        operations.transition(
            &self.native,
            &receipt,
            IntegrationOperationPhase::Completed,
            None,
        )?;
        serde_json::to_value(NativeCodeServiceMutationResult {
            record: store
                .read_native_code(&locator.lease_id)?
                .context("NATIVE_CODE_SERVICE_NOT_FOUND")?,
            ready: Some(serde_json::from_value(ready)?),
            grant: None,
            reconciled: false,
            cancellation_requested: false,
            cancellation_settled: false,
        })
        .map_err(Into::into)
    }
}

pub(in crate::app_server) async fn dispatch(
    method: &str,
    id: &Value,
    params: &Value,
    origin: &QueryEngine,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    if !matches!(method, PREPARE | READ | START | REVOKE) {
        return Ok(false);
    }
    let captured = (|| -> Result<_> {
        ensure!(
            state.knowledge_rpc_tasks.len() < 64,
            "NATIVE_CODE_CONTROL_BUSY"
        );
        ensure!(
            state.native_code_services_v1,
            "NATIVE_CODE_CAPABILITY_REQUIRED"
        );
        let request: IntegrationRequest = rpc_codec::decode(params.clone())?;
        Method::parse(method)
            .context("NATIVE_CODE_METHOD_UNAVAILABLE")?
            .validate_request(&request)
            .map_err(|_| anyhow::anyhow!("NATIVE_CODE_SERVICE_REQUEST_INVALID"))?;
        let action = if method == PREPARE {
            Action::Prepare(Box::new(NativeCodeServiceApproval::capture(
                state, origin, request,
            )?))
        } else {
            Action::Control(Box::new(Control::capture(state, request, method != READ)?))
        };
        Ok(action)
    })();
    let action = match captured {
        Ok(action) => action,
        Err(error) => {
            let failure = diagnostics::mark::<()>(Stage::RpcCapture, Err(error)).unwrap_err();
            let mut response =
                error_response(id.clone(), -32094, "NATIVE_CODE_SERVICE_UNAVAILABLE");
            response["error"]["data"] = serde_json::to_value(diagnostics::describe(&failure))?;
            send(outbound, response).await?;
            return Ok(true);
        }
    };
    let method = method.to_owned();
    let id = id.clone();
    let outbound = outbound.clone();
    state.knowledge_rpc_tasks.spawn_shared(async move {
        let result = crate::app_server::task_spawn::spawn_blocking(move || match action {
            Action::Prepare(approval) => diagnostics::mark(
                Stage::Approval,
                (*approval)
                    .prepare()
                    .and_then(|record| serde_json::to_value(record).map_err(Into::into)),
            ),
            Action::Control(control) => {
                diagnostics::mark(Stage::RpcControl, (*control).run(&method))
            }
        })
        .await;
        let response = match result {
            Ok(Ok(value)) => success_response(id, value),
            failure => {
                let error = match failure {
                    Ok(Err(error)) => error,
                    Err(_) => anyhow::anyhow!("NATIVE_CODE_DIAGNOSTIC_UNCLASSIFIED"),
                    _ => unreachable!(),
                };
                let mut response = error_response(id, -32094, "NATIVE_CODE_SERVICE_UNCONFIRMED");
                response["error"]["data"] =
                    serde_json::to_value(diagnostics::describe(&error)).unwrap_or(Value::Null);
                response
            }
        };
        let _ = send(&outbound, response).await;
    });
    Ok(true)
}
enum Action {
    Prepare(Box<NativeCodeServiceApproval>),
    Control(Box<Control>),
}
