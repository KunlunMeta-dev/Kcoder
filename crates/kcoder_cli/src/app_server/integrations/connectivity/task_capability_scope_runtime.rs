//! Live source adapters stay attached to the existing resident/native turn owner.
use super::native_task_capability_scope::{
    NativeTaskCapabilityScopeBinding, NativeTaskCapabilityScopeBindingStore,
    NativeTaskCapabilityScopeCallback, NativeTaskCapabilityScopeGuard,
    NativeTaskCapabilityScopePendingTarget,
};
use super::task_capability_scope_control::{
    NativeTaskCapabilityScopeControlMethod, NativeTaskCapabilityScopeControlTarget,
};
use super::{NativeConnectivitySourceCatalog, NativeTaskCapabilityScopeFactory};
use crate::app_server::integrations::core::{
    NativeIntegrationContext,
    task_capability_scope_control::NativeTaskCapabilityScopeManagementPermit,
};
use crate::app_server::thread_runtime::ThreadManager;
use crate::app_server::{ConnectionState, SessionLease, engine_factory::AppServerEngineFactory};
use anyhow::{Context, Result, ensure};
use kcoder_config::{CredentialBackend, OsCredentialBackend};
use kcoder_engine::QueryEngine;
use kcoder_state::turn_attempt_store::TurnAttemptStore;
use kcoder_types::{TurnAttemptIdentity, integrations::core::*};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

const MAX_LIVE_BINDINGS: usize = 256;
struct LiveBinding {
    context: Arc<NativeIntegrationContext>,
    facts: Arc<NativeTaskCapabilityScopeFactory>,
    catalog: Arc<NativeConnectivitySourceCatalog>,
    binding: Arc<NativeTaskCapabilityScopeBinding>,
}
#[derive(Default)]
pub(crate) struct NativeTaskCapabilityScopeRuntime {
    live: Mutex<BTreeMap<String, Arc<LiveBinding>>>,
    choices: choices::Directory,
}
mod choices;
mod continuation;
impl std::fmt::Debug for NativeTaskCapabilityScopeRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeTaskCapabilityScopeRuntime { existing resident source adapters }")
    }
}
pub(crate) struct PreparedTaskCapabilityScopeTurn {
    runtime: Arc<NativeTaskCapabilityScopeRuntime>,
    context: Arc<NativeIntegrationContext>,
    facts: Arc<NativeTaskCapabilityScopeFactory>,
    catalog: Arc<NativeConnectivitySourceCatalog>,
    accepted: Option<super::native_task_capability_scope::NativeAcceptedTaskIdentity>,
    initial: TurnAttemptIdentity,
    native_origin: Option<
        Arc<crate::app_server::integrations::core::runtime_driver::NativeRuntimeAcceptedObserver>,
    >,
    guard: Arc<NativeTaskCapabilityScopeGuard>,
    permit: Option<Arc<NativeTaskCapabilityScopeManagementPermit>>,
    selection: IntegrationTaskCapabilityScopeSelection,
    operation: String,
}
impl NativeTaskCapabilityScopeRuntime {
    /// Called only by the actual turn entry after private Accepted. Internal
    /// origins require the original private ticket observer; public JSON cannot
    /// create it. Both paths retain the actual State and original session lease.
    pub(crate) fn prepare_public_accepted(
        self: &Arc<Self>,
        state: &ConnectionState,
        engine: &QueryEngine,
        lease: &SessionLease,
        configuration: &AppServerEngineFactory,
        identity: &TurnAttemptIdentity,
    ) -> Result<PreparedTaskCapabilityScopeTurn> {
        let native_origin = if state.native_source_dispatch {
            Some(
                state
                    .native_source_accepted
                    .clone()
                    .context("TASK_CAPABILITY_SCOPE_NATIVE_RUNTIME_ORIGIN_REQUIRED")?,
            )
        } else {
            ensure!(
                state.native_source_accepted.is_none(),
                "TASK_CAPABILITY_SCOPE_NATIVE_ORIGIN_CHANGED"
            );
            None
        };
        let context = match &native_origin {
            Some(observer) => observer.retain_context()?,
            None => Arc::new(
                state
                    .integration_context
                    .as_ref()
                    .context("TASK_CAPABILITY_SCOPE_NATIVE_CONTEXT_REQUIRED")?
                    .recapture_for_owned_service()?,
            ),
        };
        ensure!(
            identity.thread_id == engine.session_id(),
            "TASK_CAPABILITY_SCOPE_NATIVE_THREAD_REQUIRED"
        );
        if let Some(observer) = &native_origin {
            observer.verify_current(&context, engine)?;
        }
        let initial = initial_attempt(engine, identity)?;
        let facts = Arc::new(
            NativeTaskCapabilityScopeFactory::capture(
                context.clone(),
                engine,
                lease,
                configuration.clone(),
                Arc::new(OsCredentialBackend::new()) as Arc<dyn CredentialBackend>,
            )
            .context("TASK_CAPABILITY_SCOPE_PREP_FACTORY")?,
        );
        facts.bind_resource_host(&state.integration_connectivity)?;
        let accepted = if native_origin.is_none() {
            Some(
                facts
                    .capture_studio_accepted(&context, &initial)
                    .context("TASK_CAPABILITY_SCOPE_PREP_ACCEPTED")?,
            )
        } else {
            None
        };
        let selection = match &native_origin {
            Some(observer) => observer.initial_task_capability_scope_selection()?,
            None => IntegrationTaskCapabilityScopeSelection {
                mode: IntegrationTaskCapabilityScopeMode::InheritCurrent,
                sources: vec![],
            },
        };
        let operation = match &native_origin {
            Some(observer) => observer.initial_task_capability_scope_operation(&initial)?,
            // A revision can change while the original turn tuple stays the
            // same. Catalog receipts belong to the full accepted scope/owner.
            None => format!(
                // This operation prefix participates in persisted receipt identity.
                "source-initial-{}",
                accepted
                    .as_ref()
                    .context("TASK_CAPABILITY_SCOPE_PREP_ACCEPTED")?
                    .task_key()?
            ),
        };
        let permit = if let Some(accepted) = &accepted {
            let request = IntegrationRequest {
                contract_version: IntegrationContractVersion::ParallelV1,
                request_id: operation.clone(),
                scope: context.scope().clone(),
                operation_id: Some(operation.clone()),
                expected_revision: None,
                timeout_ms: 30_000,
                cancellation_ref: None,
                payload: Default::default(),
            };
            let permit = NativeTaskCapabilityScopeManagementPermit::from_public_control(
                state,
                engine,
                lease,
                &request,
                &accepted.task_key()?,
                &selection,
            )?;
            permit.verify(
                context.scope(),
                &accepted.task_key()?,
                &operation,
                &selection,
            )?;
            Some(permit)
        } else {
            None
        };
        let catalog = Arc::new(match NativeConnectivitySourceCatalog::observe(&context)? {
            Some(catalog) => catalog,
            None => NativeConnectivitySourceCatalog::initialize(&context, &operation)
                .context("TASK_CAPABILITY_SCOPE_PREP_CATALOG")?,
        });
        let guard = Arc::new(NativeTaskCapabilityScopeGuard::pending(
            context.clone(),
            match &native_origin {
                Some(observer) => NativeTaskCapabilityScopePendingTarget::RuntimeOperation(
                    observer.operation_id().to_owned(),
                ),
                None => NativeTaskCapabilityScopePendingTarget::StudioTurn(initial.clone()),
            },
            catalog.clone(),
            facts.clone(),
        )?);
        Ok(PreparedTaskCapabilityScopeTurn {
            runtime: self.clone(),
            context,
            facts,
            catalog,
            accepted,
            initial,
            native_origin,
            guard,
            permit,
            selection,
            operation,
        })
    }
    pub(crate) fn capture_public_control(
        self: &Arc<Self>,
        state: &ConnectionState,
        request: IntegrationRequest,
        method: NativeTaskCapabilityScopeControlMethod,
        threads: &ThreadManager,
        configuration: &AppServerEngineFactory,
    ) -> Result<PreparedTaskCapabilityScopeControl> {
        request.validate(method == NativeTaskCapabilityScopeControlMethod::Set)?;
        let reference = method.target_reference(&request)?;
        let context = Arc::new(
            state
                .integration_context
                .as_ref()
                .context("TASK_CAPABILITY_SCOPE_NATIVE_CONTEXT_REQUIRED")?
                .recapture_for_owned_service()?,
        );
        context.validate_scope(&request.scope)?;
        let engine = threads
            .engine(&reference.initial_attempt.thread_id)
            .context("TASK_CAPABILITY_SCOPE_RESIDENT_OWNER_REQUIRED")?;
        let lease = threads
            .lease(&reference.initial_attempt.thread_id)
            .context("TASK_CAPABILITY_SCOPE_RESIDENT_OWNER_REQUIRED")?;
        crate::app_server::ensure_active_thread(
            &engine,
            Some(lease),
            &reference.initial_attempt.thread_id,
        )?;
        let cached = self
            .live
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_RUNTIME_UNAVAILABLE"))?
            .get(&key(&reference)?)
            .cloned();
        let cached =
            cached.filter(|entry| entry.facts.verify_resident_owner(&context, &engine).is_ok());
        let facts = match cached {
            Some(cached) => {
                context.validate_scope(cached.context.scope())?;
                cached.facts.clone()
            }
            None => Arc::new(NativeTaskCapabilityScopeFactory::capture(
                context.clone(),
                &engine,
                lease,
                configuration.clone(),
                Arc::new(OsCredentialBackend::new()),
            )?),
        };
        facts.bind_resource_host(&state.integration_connectivity)?;
        let catalog = Arc::new(
            NativeConnectivitySourceCatalog::observe(&context)?
                .context("TASK_CAPABILITY_SCOPE_SAVED_CATALOG_REQUIRED")?,
        );
        let permit = if method == NativeTaskCapabilityScopeControlMethod::Set {
            let params: IntegrationTaskCapabilityScopeControlSetParams =
                serde_json::from_value(serde_json::Value::Object(request.payload.clone()))?;
            ensure!(
                params.params.resource_bindings.is_none()
                    || state.integration_task_resource_bindings_v1,
                "TASK_RESOURCE_BINDINGS_NOT_NEGOTIATED"
            );
            let accepted = facts.capture_control_accepted(&context, &reference)?;
            Some(
                NativeTaskCapabilityScopeManagementPermit::from_public_control(
                    state,
                    &engine,
                    lease,
                    &request,
                    &accepted.task_key()?,
                    &params.params.selection,
                )?,
            )
        } else {
            None
        };
        Ok(PreparedTaskCapabilityScopeControl {
            runtime: self.clone(),
            context,
            facts,
            catalog,
            reference,
            request,
            method,
            permit,
            owner: Arc::downgrade(&state.source_management_owner),
            cancel: state.input_ended.child_token(),
        })
    }
    pub(crate) async fn live_sdk_target(
        &self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        method: NativeTaskCapabilityScopeControlMethod,
    ) -> Result<NativeTaskCapabilityScopeControlTarget> {
        let reference = method.target_reference(request)?;
        let stored = self
            .live
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_RUNTIME_UNAVAILABLE"))?
            .get(&key(&reference)?)
            .cloned()
            .context("TASK_CAPABILITY_SCOPE_RESIDENT_OWNER_REQUIRED")?;
        context.validate_scope(stored.context.scope())?;
        NativeTaskCapabilityScopeControlTarget::capture(
            context,
            stored.binding.clone(),
            stored.facts.clone(),
            stored.catalog.clone(),
        )
        .await
    }
}
pub(crate) struct PreparedTaskCapabilityScopeControl {
    runtime: Arc<NativeTaskCapabilityScopeRuntime>,
    context: Arc<NativeIntegrationContext>,
    facts: Arc<NativeTaskCapabilityScopeFactory>,
    catalog: Arc<NativeConnectivitySourceCatalog>,
    reference: IntegrationTaskCapabilityScopeControlTarget,
    request: IntegrationRequest,
    method: NativeTaskCapabilityScopeControlMethod,
    permit: Option<Arc<NativeTaskCapabilityScopeManagementPermit>>,
    owner: std::sync::Weak<()>,
    cancel: CancellationToken,
}
impl PreparedTaskCapabilityScopeControl {
    pub(crate) async fn run(self) -> Result<serde_json::Value> {
        ensure!(
            self.owner.upgrade().is_some() && !self.cancel.is_cancelled(),
            "TASK_CAPABILITY_SCOPE_NATIVE_CALLER_EXPIRED"
        );
        let target = NativeTaskCapabilityScopeControlTarget::restore(
            &self.context,
            &self.reference,
            self.facts,
            self.catalog,
        )
        .await?
        .context("TASK_CAPABILITY_SCOPE_ORIGINAL_BINDING_NOT_OBSERVED")?;
        let result = tokio::select! {biased;
            _=self.cancel.cancelled()=>Err(anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_CALLER_EXPIRED")),
            result=tokio::time::timeout(std::time::Duration::from_millis(self.request.timeout_ms),self.method.handle_public(&self.context,&self.request,&target,self.permit.as_ref(),self.cancel.clone()))=>
                result.map_err(|_|anyhow::anyhow!("TASK_CAPABILITY_SCOPE_CONTROL_OUTCOME_UNKNOWN"))?,
        };
        ensure!(
            self.owner.upgrade().is_some() && !self.cancel.is_cancelled(),
            "TASK_CAPABILITY_SCOPE_NATIVE_CALLER_EXPIRED"
        );
        let _ = self.runtime;
        result
    }
}
impl PreparedTaskCapabilityScopeTurn {
    /// Original Studio source binding for a work record, never an authorization.
    pub(crate) fn initial_work_source(
        &self,
    ) -> Result<kcoder_types::continuous_work::WorkKnownReference> {
        ensure!(
            self.native_origin.is_none(),
            "TASK_CAPABILITY_SCOPE_FOREGROUND_REQUIRED"
        );
        let accepted = self
            .accepted
            .as_ref()
            .context("TASK_CAPABILITY_SCOPE_PREP_ACCEPTED")?;
        ensure!(
            accepted.initial_attempt() == &self.initial,
            "TASK_CAPABILITY_SCOPE_INITIAL_ATTEMPT_REQUIRED"
        );
        Ok(
            kcoder_types::continuous_work::WorkKnownReference::TaskCapabilityScope {
                initial_attempt: self.initial.clone(),
                accepted_task_key: accepted.task_key()?,
            },
        )
    }

    /// Install the same unbound guard before any accepted job can reach a model.
    pub(crate) fn guarded_engine(&self, engine: QueryEngine) -> QueryEngine {
        engine.with_native_tool_authorization(self.guard.clone())
    }
    pub(crate) async fn bind(
        self,
        engine: &QueryEngine,
        identity: &TurnAttemptIdentity,
        cancel: &CancellationToken,
    ) -> Result<()> {
        ensure!(
            !cancel.is_cancelled() && engine.state.matches_current_history_attempt(Some(identity)),
            "TASK_CAPABILITY_SCOPE_ACTUAL_ACCEPTED_SCOPE_REQUIRED"
        );
        let accepted = if let Some(observer) = &self.native_origin {
            self.facts.verify_resident_owner(&self.context, engine)?;
            observer.observe_accepted(&self.context, engine, identity)?;
            ensure!(
                &self.initial == identity,
                "TASK_CAPABILITY_SCOPE_RUNTIME_INITIAL_ATTEMPT_REQUIRED"
            );
            self.facts.install_runtime_initial(observer)?;
            self.facts.capture_control_accepted(
                &self.context,
                &IntegrationTaskCapabilityScopeControlTarget {
                    initial_attempt: self.initial.clone(),
                    runtime_operation_id: Some(observer.operation_id().to_owned()),
                },
            )?
        } else {
            self.accepted
                .context("TASK_CAPABILITY_SCOPE_PREP_ACCEPTED")?
        };
        let store = Arc::new(
            match NativeTaskCapabilityScopeBindingStore::observe(&self.context)? {
                Some(store) => store,
                None => NativeTaskCapabilityScopeBindingStore::initialize(
                    &self.context,
                    &self.operation,
                )
                .context("TASK_CAPABILITY_SCOPE_BIND_STORE")?,
            },
        );
        if let Some(permit) = &self.permit {
            self.facts.install_public_management(permit)?;
        }
        let binding = if let Some(binding) = store
            .restore(&self.context, &accepted.task_key()?, self.facts.as_ref())
            .await?
        {
            binding
        } else {
            if let Some(permit) = &self.permit {
                permit.verify(
                    self.context.scope(),
                    &accepted.task_key()?,
                    &self.operation,
                    &self.selection,
                )?;
            }
            if let Some(observer) = &self.native_origin {
                observer.verify_accepted(&self.context, engine, identity)?;
            }
            let boundary = self
                .facts
                .claim_root_boundary()
                .context("TASK_CAPABILITY_SCOPE_BIND_BOUNDARY")?;
            let witness = engine.native_tool_execution_witness();
            let binding = store
                .bind_accepted(
                    &self.context,
                    accepted,
                    &self.operation,
                    self.selection,
                    &self.catalog,
                    Some(&format!("{}-catalog", self.operation)),
                    self.facts.as_ref(),
                    &NativeTaskCapabilityScopeCallback {
                        session_id: witness.session_id(),
                        native_witness: &witness,
                    },
                )
                .await?;
            drop(boundary);
            binding
        };
        let binding = Arc::new(binding);
        self.guard
            .bind(binding.clone())
            .await
            .context("TASK_CAPABILITY_SCOPE_BIND_GUARD")?;
        if let Some(observer) = &self.native_origin {
            observer
                .verify_live_accepted_source(&self.context, engine, identity, cancel)
                .await?;
        }
        ensure!(
            !cancel.is_cancelled(),
            "TASK_CAPABILITY_SCOPE_TURN_CANCELLED"
        );
        let reference = binding.accepted().control_target();
        let mut live = self
            .runtime
            .live
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_RUNTIME_UNAVAILABLE"))?;
        ensure!(
            live.len() < MAX_LIVE_BINDINGS || live.contains_key(&key(&reference)?),
            "TASK_CAPABILITY_SCOPE_RUNTIME_CAPACITY"
        );
        live.insert(
            key(&reference)?,
            Arc::new(LiveBinding {
                context: self.context,
                facts: self.facts,
                catalog: self.catalog,
                binding,
            }),
        );
        Ok(())
    }
}
fn initial_attempt(
    engine: &QueryEngine,
    actual: &TurnAttemptIdentity,
) -> Result<TurnAttemptIdentity> {
    let store = TurnAttemptStore::open_existing(
        &engine.session_storage_dir_for(&actual.thread_id),
        &actual.thread_id,
    )?
    .context("TASK_CAPABILITY_SCOPE_ACTUAL_ACCEPTED_REQUIRED")?;
    let mut current = actual.clone();
    for _ in 0..64 {
        let record = store
            .load(&current)?
            .context("TASK_CAPABILITY_SCOPE_ACTUAL_ACCEPTED_REQUIRED")?;
        if let Some(parent) = record.parent_attempt_id {
            current.attempt_id = parent;
        } else {
            return Ok(current);
        }
    }
    anyhow::bail!("TASK_CAPABILITY_SCOPE_ACTUAL_ATTEMPT_CHAIN_REQUIRED")
}
fn key(value: &IntegrationTaskCapabilityScopeControlTarget) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

pub(crate) fn safe_source_error(error: &anyhow::Error) -> String {
    let codes = error
        .chain()
        .map(ToString::to_string)
        .filter(|value| {
            value.len() <= 96
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        })
        .take(5)
        .collect::<Vec<_>>();
    if codes.is_empty() {
        "TASK_CAPABILITY_SCOPE_UNAVAILABLE".into()
    } else {
        codes.join(":")
    }
}

#[cfg(test)]
mod tests;
