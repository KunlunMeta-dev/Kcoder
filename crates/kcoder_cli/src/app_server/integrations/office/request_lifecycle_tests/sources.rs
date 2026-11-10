//! Source selection uses the existing private native lease and public-call permit.
use super::*;
use crate::app_server::integrations::{
    connectivity::{
        NativeAcceptedTaskIdentity, NativeConnectivitySourceCatalog,
        NativeTaskCapabilityScopeBinding, NativeTaskCapabilityScopeBindingStore,
        NativeTaskCapabilityScopeCallback, NativeTaskCapabilityScopeFactory,
        NativeTaskCapabilityScopeFacts, NativeTaskCapabilityScopeGuard,
        NativeTaskCapabilityScopePendingTarget,
        task_capability_scope_control::{
            NativeTaskCapabilityScopeControlMethod, NativeTaskCapabilityScopeControlTarget,
            try_apply_pending,
        },
    },
    core::task_capability_scope_control::NativeTaskCapabilityScopeManagementPermit,
};
use kcoder_types::integrations::core::*;

pub(super) struct NoCredentials;
impl kcoder_config::CredentialBackend for NoCredentials {
    fn describe(&self) -> String {
        "owned-context-lifecycle-no-credentials".into()
    }
    fn available(&self) -> bool {
        true
    }
    fn get(&self, _: &str) -> Result<Option<String>> {
        anyhow::bail!("fixture has no credential reads")
    }
    fn set(&self, _: &str, _: &str) -> Result<()> {
        anyhow::bail!("fixture has no credential writes")
    }
    fn delete(&self, _: &str) -> Result<()> {
        anyhow::bail!("fixture has no credential deletes")
    }
}
pub(super) struct Sources {
    pub facts: Arc<NativeTaskCapabilityScopeFactory>,
    pub catalog: Arc<NativeConnectivitySourceCatalog>,
    pub binding: Arc<NativeTaskCapabilityScopeBinding>,
    pub guard: Arc<NativeTaskCapabilityScopeGuard>,
}
fn request(context: &NativeIntegrationContext, operation: &str) -> IntegrationRequest {
    IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: operation.into(),
        scope: context.scope().clone(),
        operation_id: Some(operation.into()),
        expected_revision: None,
        timeout_ms: 30_000,
        cancellation_ref: None,
        payload: Default::default(),
    }
}
impl Sources {
    pub async fn capture(
        native: &Arc<NativeIntegrationContext>,
        engine: &QueryEngine,
        lease: &SessionLease,
        factory: &AppServerEngineFactory,
        identity: &TurnAttemptIdentity,
    ) -> Result<Self> {
        let facts = Arc::new(NativeTaskCapabilityScopeFactory::capture(
            native.clone(),
            engine,
            lease,
            factory.clone(),
            Arc::new(NoCredentials),
        )?);
        let catalog = Arc::new(match NativeConnectivitySourceCatalog::observe(native)? {
            Some(value) => value,
            None => NativeConnectivitySourceCatalog::initialize(native, "ctx-lifecycle-catalog")?,
        });
        let store = Arc::new(
            match NativeTaskCapabilityScopeBindingStore::observe(native)? {
                Some(value) => value,
                None => NativeTaskCapabilityScopeBindingStore::initialize(
                    native,
                    "ctx-lifecycle-bindings",
                )?,
            },
        );
        let accepted =
            NativeAcceptedTaskIdentity::capture_studio(native, identity, facts.as_ref()).await?;
        let binding = if let Some(binding) = store
            .restore(native, &accepted.task_key()?, facts.as_ref())
            .await?
        {
            Arc::new(binding)
        } else {
            let selection = IntegrationTaskCapabilityScopeSelection {
                mode: IntegrationTaskCapabilityScopeMode::None,
                sources: vec![],
            };
            let connection = ConnectionState {
                integration_context: Some(native.recapture_for_owned_service()?),
                ..Default::default()
            };
            let initial = request(native, "ctx-lifecycle-initial");
            let permit = NativeTaskCapabilityScopeManagementPermit::from_public_control(
                &connection,
                engine,
                lease,
                &initial,
                &accepted.task_key()?,
                &selection,
            )?;
            facts.install_public_management(&permit)?;
            catalog.register(
                native,
                "ctx-lifecycle-register",
                &facts.sources(native).await?,
            )?;
            let boundary = facts.claim_root_boundary()?;
            let binding = engine
                .state
                .history_attempt_scope(identity.clone())?
                .run(async {
                    let witness = engine.native_tool_execution_witness();
                    store
                        .bind_accepted(
                            native,
                            accepted,
                            "ctx-lifecycle-initial",
                            selection,
                            &catalog,
                            None,
                            facts.as_ref(),
                            &NativeTaskCapabilityScopeCallback {
                                session_id: witness.session_id(),
                                native_witness: &witness,
                            },
                        )
                        .await
                })
                .await?;
            drop(boundary);
            drop(permit);
            Arc::new(binding)
        };
        let guard = Arc::new(NativeTaskCapabilityScopeGuard::pending(
            native.clone(),
            NativeTaskCapabilityScopePendingTarget::StudioTurn(identity.clone()),
            catalog.clone(),
            facts.clone(),
        )?);
        guard.bind(binding.clone()).await?;
        Ok(Self {
            facts,
            catalog,
            binding,
            guard,
        })
    }
    pub async fn inherit(
        &self,
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        lease: &SessionLease,
    ) -> Result<Value> {
        let target = NativeTaskCapabilityScopeControlTarget::capture(
            native,
            self.binding.clone(),
            self.facts.clone(),
            self.catalog.clone(),
        )
        .await?;
        let before = self.binding.snapshot(native, self.facts.as_ref()).await?;
        assert_eq!(
            before.selection.mode,
            IntegrationTaskCapabilityScopeMode::None
        );
        assert!(before.effective_sources.is_empty());
        let selection = IntegrationTaskCapabilityScopeSelection {
            mode: IntegrationTaskCapabilityScopeMode::InheritCurrent,
            sources: vec![],
        };
        let connection = ConnectionState {
            integration_context: Some(native.recapture_for_owned_service()?),
            ..Default::default()
        };
        let mut request = request(native, "ctx-lifecycle-original-source-switch");
        request.expected_revision = Some(before.revision.to_string());
        request.payload = json!({"target":self.binding.accepted().control_target(),
            "params":{"threadId":engine.session_id(),"selection":selection}})
        .as_object()
        .unwrap()
        .clone();
        let permit = NativeTaskCapabilityScopeManagementPermit::from_public_control(
            &connection,
            engine,
            lease,
            &request,
            &self.binding.task_key()?,
            &selection,
        )?;
        let held = engine
            .native_tool_gate_handle()
            .try_boundary(&engine.state)?;
        let pending = NativeTaskCapabilityScopeControlMethod::Set
            .handle_public(
                native,
                &request,
                &target,
                Some(&permit),
                CancellationToken::new(),
            )
            .await?;
        assert_eq!(pending["snapshot"]["effectiveFrom"], "next_tool_boundary");
        drop(held);
        assert!(try_apply_pending(native, &target).await?);
        let after = self.binding.snapshot(native, self.facts.as_ref()).await?;
        assert_eq!(
            after.selection.mode,
            IntegrationTaskCapabilityScopeMode::InheritCurrent
        );
        assert_eq!(
            after.effective_from,
            IntegrationTaskCapabilityScopeBoundary::CurrentSnapshot
        );
        assert_eq!(
            after.effective_sources.len(),
            1,
            "one actual owned stdio MCP source"
        );
        let operation = self
            .binding
            .read_control_operation(native, "ctx-lifecycle-original-source-switch")?
            .unwrap();
        Ok(
            json!({"before":before,"after":after,"operationId":operation.operation_id,
            "operationPhase":operation.phase,"appliedRevision":operation.applied_revision,"intentSha256":operation.intent_sha256}),
        )
    }
}
