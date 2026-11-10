use super::*;
pub(crate) mod desktop;
mod emitter_sources;
mod failures;
mod native_events;
mod read_cost;
mod registered_emitter;
mod resources;
mod saved_directory;
use crate::app_server::thread_runtime::{ThreadRuntime, test_support::test_runtime};
use kcoder_config::{CredentialBackend, PrivateDirectory, Settings};
use kcoder_engine::{
    QueryEngine,
    integrations::core::{
        NativeEngineEventFrame, NativeToolAuthorization, NativeToolAuthorizationError,
        NativeToolAuthorizationPhase, NativeToolExecutionWitness,
    },
};
use kcoder_state::{
    integrations::core::IntegrationOperationUpdate, turn_attempt_store::TurnAttemptStore,
};
use kcoder_tools::ToolSource;
use serde_json::json;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

#[derive(Default)]
struct EmptyBackend;
struct ResourceWitness {
    execution: NativeToolExecutionWitness,
    source: Arc<NativeMcpSourceFact>,
}
impl CredentialBackend for EmptyBackend {
    fn describe(&self) -> String {
        "owned-task-capability-scope-fixture".into()
    }
    fn available(&self) -> bool {
        true
    }
    fn get(&self, _: &str) -> Result<Option<String>> {
        Ok(None)
    }
    fn set(&self, _: &str, _: &str) -> Result<()> {
        anyhow::bail!("fixture never writes OS secrets")
    }
    fn delete(&self, _: &str) -> Result<()> {
        anyhow::bail!("fixture never deletes OS secrets")
    }
}
type EmitterObject = (Arc<dyn kcoder_tools::Tool>, Arc<NativeMcpSourceFact>);
struct ActualFacts {
    engine: QueryEngine,
    scope: IntegrationScope,
    initial: TurnAttemptIdentity,
    session: PathBuf,
    configs: Mutex<Vec<kcoder_types::McpServerConfig>>,
    settings: Mutex<Settings>,
    emitter_sources: Mutex<BTreeMap<String, Arc<NativeMcpSourceFact>>>,
    emitter_objects: Mutex<Vec<EmitterObject>>,
    management: AtomicBool,
    boundary: AtomicBool,
    wrong_epoch: AtomicBool,
    pause_sources: AtomicBool,
    source_unavailable: AtomicBool,
    source_reads: AtomicUsize,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
impl ActualFacts {
    fn refresh_emitter_sources(&self, context: &NativeIntegrationContext) -> Result<()> {
        let settings = self.settings.lock().unwrap().clone();
        let mut stamps = self.emitter_sources.lock().unwrap();
        for config in self.configs.lock().unwrap().iter() {
            stamps.insert(
                config.name.clone(),
                Arc::new(NativeMcpSourceFact::from_resolved(
                    context,
                    &settings,
                    config,
                    None,
                    &EmptyBackend,
                )?),
            );
        }
        Ok(())
    }
    fn attempt(&self, id: &TurnAttemptIdentity) -> Result<TurnAttemptRecord> {
        TurnAttemptStore::open_existing(&self.session, &id.thread_id)?
            .context("actual native attempts missing")?
            .load(id)?
            .context("actual native Accepted missing")
    }
    fn execution(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        witness: &NativeToolExecutionWitness,
        model: bool,
    ) -> Result<NativeTaskCapabilityScopeExecution> {
        context.validate_scope(&self.scope)?;
        ensure!(
            witness.matches_state(&self.engine.state)
                && witness.session_id() == self.engine.session_id(),
            "fixture checks real emitter State/lifecycle"
        );
        if model {
            ensure!(
                self.engine
                    .state
                    .current_history_attempt_identity()
                    .as_ref()
                    == witness.attempt(),
                "fixture checks actual task-local attempt"
            );
        }
        let current = witness.attempt().map(|id| self.attempt(id)).transpose()?;
        let directory = PrivateDirectory::open_existing(&self.session)?;
        Ok(NativeTaskCapabilityScopeExecution {
            scope: self.scope.clone(),
            task_key: accepted.task_key()?,
            current_session_id: self.engine.session_id(),
            root_session_directory_identity: directory.directory_identity()?,
            root_state_epoch: if self.wrong_epoch.load(Ordering::SeqCst) {
                "wrong-native-owner-epoch".into()
            } else {
                self.scope.identity_generation.clone()
            },
            root_attempt_chain: vec![self.attempt(&self.initial)?],
            current_attempt: current,
            lineage: Vec::new(),
            native_emitter_id: format!("native-fixture-emitter:{}", self.engine.session_id()),
            emitter_source: None,
            boundary_id: self
                .boundary
                .load(Ordering::SeqCst)
                .then(|| "actual-fixture-boundary".into()),
        })
    }
}
#[async_trait]
impl NativeTaskCapabilityScopeFacts for ActualFacts {
    async fn accepted_turn(
        &self,
        context: &NativeIntegrationContext,
        id: &TurnAttemptIdentity,
    ) -> Result<NativeTaskCapabilityScopeTurnWitness> {
        context.validate_scope(&self.scope)?;
        ensure!(
            id.thread_id == self.engine.session_id(),
            "fixture actual State owner"
        );
        Ok(NativeTaskCapabilityScopeTurnWitness {
            scope: self.scope.clone(),
            session_directory_identity: PrivateDirectory::open_existing(&self.session)?
                .directory_identity()?,
            state_epoch: if self.wrong_epoch.load(Ordering::SeqCst) {
                "wrong-native-owner-epoch".into()
            } else {
                self.scope.identity_generation.clone()
            },
            record: self.attempt(id)?,
        })
    }
    async fn execution_for_tool(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<NativeTaskCapabilityScopeExecution> {
        let witness = request.execution.context("actual emitter required")?;
        let mut execution = self.execution(context, accepted, witness, true)?;
        let emitter = request
            .emitter
            .context("actual registered emitter required")?;
        execution.emitter_source = self
            .emitter_objects
            .lock()
            .unwrap()
            .iter()
            .find_map(|(actual, source)| emitter.matches_tool(actual).then(|| source.clone()));
        Ok(execution)
    }
    async fn execution_for_callback(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        callback: &NativeTaskCapabilityScopeCallback<'_>,
        purpose: NativeTaskCapabilityScopeCallbackPurpose,
    ) -> Result<NativeTaskCapabilityScopeExecution> {
        let resource = callback.native_witness.downcast_ref::<ResourceWitness>();
        let event = callback
            .native_witness
            .downcast_ref::<NativeEngineEventFrame>();
        let witness = if let Some(event) = event {
            event.execution()
        } else if let Some(resource) = resource {
            &resource.execution
        } else {
            callback
                .native_witness
                .downcast_ref::<NativeToolExecutionWitness>()
                .context("actual native callback witness required")?
        };
        ensure!(
            callback.session_id == witness.session_id(),
            "actual callback session"
        );
        let mut execution = self.execution(
            context,
            accepted,
            witness,
            matches!(
                purpose,
                NativeTaskCapabilityScopeCallbackPurpose::Admission
                    | NativeTaskCapabilityScopeCallbackPurpose::Provider
            ),
        )?;
        if let Some(resource) = resource {
            execution.emitter_source = Some(resource.source.clone());
        }
        if let Some(event) = event {
            execution.emitter_source = event.tool().and_then(|emitter| {
                self.emitter_objects
                    .lock()
                    .unwrap()
                    .iter()
                    .find_map(|(actual, source)| {
                        emitter.matches_tool(actual).then(|| source.clone())
                    })
            });
        }
        Ok(execution)
    }
    async fn sources(
        &self,
        context: &NativeIntegrationContext,
    ) -> Result<Vec<NativeMcpSourceFact>> {
        self.source_reads.fetch_add(1, Ordering::SeqCst);
        ensure!(
            !self.source_unavailable.load(Ordering::SeqCst),
            "owned native source observation unavailable"
        );
        if self.pause_sources.swap(false, Ordering::SeqCst) {
            self.entered.notify_one();
            self.release.notified().await;
        }
        let settings = self.settings.lock().unwrap().clone();
        self.configs
            .lock()
            .unwrap()
            .iter()
            .map(|config| {
                NativeMcpSourceFact::from_resolved(context, &settings, config, None, &EmptyBackend)
            })
            .collect()
    }
    async fn selection_admission(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        operation: &str,
        selection: &IntegrationTaskCapabilityScopeSelection,
    ) -> Result<super::super::task_capability_scope_control::NativeTaskCapabilityScopeAdmission>
    {
        self.authorize_selection(context, accepted, operation, selection)
            .await?;
        super::super::task_capability_scope_control::NativeTaskCapabilityScopeAuthorizationReceipt::explicit_owned_fixture(
            context, accepted, operation, selection,
        )
    }
    async fn revalidate_selection_authorization(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        authorization: &super::super::task_capability_scope_control::NativeTaskCapabilityScopeAuthorizationReceipt,
        operation: &str,
        selection: &IntegrationTaskCapabilityScopeSelection,
    ) -> Result<()> {
        self.authorize_selection(context, accepted, operation, selection)
            .await?;
        authorization.verify_native(context, accepted, operation, selection)
    }
    async fn authorize_resource_selection(
        &self,
        context: &NativeIntegrationContext,
        _: &NativeAcceptedTaskIdentity,
        _: &str,
        bindings: &[IntegrationTaskResourceBinding],
    ) -> Result<()> {
        context.validate_scope(&self.scope)?;
        ensure!(
            self.management.load(Ordering::SeqCst) && bindings.is_empty(),
            "explicit fixture can only approve an empty resource ceiling"
        );
        Ok(())
    }
    async fn verify_resource_bindings(
        &self,
        context: &NativeIntegrationContext,
        bindings: &[IntegrationTaskResourceBinding],
    ) -> Result<()> {
        context.validate_scope(&self.scope)?;
        ensure!(
            bindings.is_empty(),
            "fixture cannot manufacture a current Main resource grant"
        );
        Ok(())
    }
    async fn authorize_selection(
        &self,
        context: &NativeIntegrationContext,
        _: &NativeAcceptedTaskIdentity,
        _: &str,
        _: &IntegrationTaskCapabilityScopeSelection,
    ) -> Result<()> {
        context.validate_scope(&self.scope)?;
        ensure!(
            self.management.load(Ordering::SeqCst),
            "explicit fixture native management deny"
        );
        Ok(())
    }
    fn verify_safe_boundary(
        &self,
        context: &NativeIntegrationContext,
        _: &NativeAcceptedTaskIdentity,
        execution: &NativeTaskCapabilityScopeExecution,
    ) -> Result<()> {
        context.validate_scope(&self.scope)?;
        ensure!(
            self.boundary.load(Ordering::SeqCst)
                && execution.boundary_id.as_deref() == Some("actual-fixture-boundary"),
            "actual fixture native boundary unavailable"
        );
        Ok(())
    }
}
struct Fixture {
    temp: tempfile::TempDir,
    context: Arc<NativeIntegrationContext>,
    runtime: ThreadRuntime,
    facts: Arc<ActualFacts>,
    catalog: Arc<NativeConnectivitySourceCatalog>,
    store: Arc<NativeTaskCapabilityScopeBindingStore>,
}
impl Fixture {
    async fn new() -> Result<Self> {
        let (temp, context) = super::super::lease::tests::fixture()?;
        let context = Arc::new(context);
        let runtime = test_runtime("source-guard", &temp.path().join("workspace/history.jsonl"));
        let engine = runtime.engine();
        let profile = context.profile()?;
        profile.create_private_child(OsStr::new("source-test-sessions"))?;
        let parent = profile
            .open_entry_handle(OsStr::new("source-test-sessions"))?
            .open_child_directory()?;
        parent.create_private_child(OsStr::new(&engine.session_id()))?;
        let session = context
            .profile_path()?
            .join("source-test-sessions")
            .join(engine.session_id());
        let initial = TurnAttemptIdentity {
            thread_id: engine.session_id(),
            turn_id: "turn-source-1".into(),
            attempt_id: "attempt-source-1".into(),
        };
        TurnAttemptStore::open(&session, &engine.session_id())?
            .begin(attempt_record(initial.clone()))?;
        let facts = Arc::new(ActualFacts {
            engine,
            scope: context.scope().clone(),
            initial,
            session,
            configs: Mutex::new(vec![config("source-A"), config("source-B")]),
            settings: Mutex::new(Settings::default()),
            emitter_sources: Mutex::new(BTreeMap::new()),
            emitter_objects: Mutex::new(Vec::new()),
            management: AtomicBool::new(true),
            boundary: AtomicBool::new(true),
            wrong_epoch: AtomicBool::new(false),
            pause_sources: AtomicBool::new(false),
            source_unavailable: AtomicBool::new(false),
            source_reads: AtomicUsize::new(0),
            entered: Default::default(),
            release: Default::default(),
        });
        let catalog = Arc::new(NativeConnectivitySourceCatalog::initialize(
            &context,
            "native-source-catalog",
        )?);
        catalog.register(
            &context,
            "native-current-sources",
            &facts.sources(&context).await?,
        )?;
        facts.refresh_emitter_sources(&context)?;
        let store = Arc::new(NativeTaskCapabilityScopeBindingStore::initialize(
            &context,
            "native-task-capability-scope-bindings",
        )?);
        Ok(Self {
            temp,
            context,
            runtime,
            facts,
            catalog,
            store,
        })
    }
    async fn choices(&self) -> Result<Vec<IntegrationTaskCapabilitySourceChoice>> {
        self.catalog
            .current_choices(&self.context, &self.facts.sources(&self.context).await?)
    }
    async fn bind(
        &self,
        selection: IntegrationTaskCapabilityScopeSelection,
    ) -> Result<Arc<NativeTaskCapabilityScopeBinding>> {
        self.bind_registering(selection, None).await
    }
    async fn bind_registering(
        &self,
        selection: IntegrationTaskCapabilityScopeSelection,
        source_registration: Option<&str>,
    ) -> Result<Arc<NativeTaskCapabilityScopeBinding>> {
        let accepted = NativeAcceptedTaskIdentity::capture_studio(
            &self.context,
            &self.facts.initial,
            self.facts.as_ref(),
        )
        .await?;
        let state = self.facts.engine.state.clone();
        let scope = state.history_attempt_scope(self.facts.initial.clone())?;
        scope
            .run(async {
                let witness = self.facts.engine.native_tool_execution_witness();
                let callback = NativeTaskCapabilityScopeCallback {
                    session_id: witness.session_id(),
                    native_witness: &witness,
                };
                Ok(Arc::new(
                    self.store
                        .bind_accepted(
                            &self.context,
                            accepted,
                            "initial-native-selection",
                            selection,
                            &self.catalog,
                            source_registration,
                            self.facts.as_ref(),
                            &callback,
                        )
                        .await?,
                ))
            })
            .await
    }
    fn guard(&self) -> Result<Arc<NativeTaskCapabilityScopeGuard>> {
        Ok(Arc::new(NativeTaskCapabilityScopeGuard::pending(
            self.context.clone(),
            NativeTaskCapabilityScopePendingTarget::StudioTurn(self.facts.initial.clone()),
            self.catalog.clone(),
            self.facts.clone(),
        )?))
    }
    async fn check(
        &self,
        guard: &NativeTaskCapabilityScopeGuard,
        source: ToolSource,
        phase: NativeToolAuthorizationPhase,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        let scope = self
            .facts
            .engine
            .state
            .history_attempt_scope(self.facts.initial.clone())
            .unwrap();
        scope
            .run(async {
                let (engine, name) = emitter_engine(&self.facts.engine, &source);
                let emitter = engine.native_tool_emitter_witness(&name).unwrap();
                if let ToolSource::Mcp { server, .. } | ToolSource::Plugin { server, .. } = &source
                    && let Some(fact) = self
                        .facts
                        .emitter_sources
                        .lock()
                        .unwrap()
                        .get(server)
                        .cloned()
                {
                    self.facts
                        .emitter_objects
                        .lock()
                        .unwrap()
                        .push((emitter.tool().clone(), fact));
                }
                let witness = emitter.execution();
                let input = json!({});
                guard
                    .authorize(&NativeToolAuthorizationRequest {
                        execution: Some(witness),
                        emitter: Some(&emitter),
                        session_id: witness.session_id(),
                        tool_name: &name,
                        source,
                        input: &input,
                        read_only: true,
                        without_sandbox: false,
                        phase,
                    })
                    .await
            })
            .await
    }
    async fn commit(
        &self,
        binding: &NativeTaskCapabilityScopeBinding,
        id: &str,
        revision: u64,
    ) -> Result<IntegrationTaskCapabilityScopeSnapshot> {
        let scope = self
            .facts
            .engine
            .state
            .history_attempt_scope(self.facts.initial.clone())?;
        scope
            .run(async {
                let witness = self.facts.engine.native_tool_execution_witness();
                let callback = NativeTaskCapabilityScopeCallback {
                    session_id: witness.session_id(),
                    native_witness: &witness,
                };
                binding
                    .commit_boundary(&self.context, id, revision, self.facts.as_ref(), &callback)
                    .await
            })
            .await
    }
    async fn shutdown(self) {
        self.runtime.shutdown().await;
    }
}
fn attempt_record(identity: TurnAttemptIdentity) -> TurnAttemptRecord {
    TurnAttemptRecord {
        version: 1,
        identity,
        parent_attempt_id: None,
        retry_operation_id: None,
        accepted_at_ms: 1,
        input_context_hash: "a".repeat(64),
        request_fingerprint: Some("b".repeat(64)),
        retained_input: None,
        client_presentation: None,
        status: TurnAttemptStatus::Accepted,
        completion: None,
    }
}
fn config(name: &str) -> kcoder_types::McpServerConfig {
    serde_json::from_value(
        json!({"name":name,"transport":"stdio","command":"owned-no-server-launch"}),
    )
    .unwrap()
}
fn none() -> IntegrationTaskCapabilityScopeSelection {
    IntegrationTaskCapabilityScopeSelection {
        mode: IntegrationTaskCapabilityScopeMode::None,
        sources: Vec::new(),
    }
}
fn selected(
    sources: Vec<IntegrationTaskCapabilitySourceChoice>,
) -> IntegrationTaskCapabilityScopeSelection {
    IntegrationTaskCapabilityScopeSelection {
        mode: IntegrationTaskCapabilityScopeMode::Selected,
        sources,
    }
}
fn external(server: &str, tool: &str) -> ToolSource {
    ToolSource::Mcp {
        server: server.into(),
        tool: tool.into(),
    }
}
struct NoIoTransport;
#[async_trait]
impl kcoder_mcp::McpTransport for NoIoTransport {
    async fn send(&mut self, _: &str) -> Result<()> {
        anyhow::bail!("guard fixture performs no MCP IO")
    }
    async fn recv(&mut self) -> Result<Option<String>> {
        Ok(None)
    }
}
/// A native-feature metadata fixture; no executable substitute is installed.
struct NativeFeatureDescriptor(ToolSource);
#[async_trait]
impl kcoder_tools::Tool for NativeFeatureDescriptor {
    fn name(&self) -> String {
        "native-feature-descriptor".into()
    }
    fn source(&self) -> ToolSource {
        self.0.clone()
    }
    fn description(&self) -> String {
        "provenance-only fixture".into()
    }
    fn input_schema(&self) -> serde_json::Value {
        json!({"type":"object"})
    }
    async fn call(
        &self,
        _: serde_json::Value,
        _: &kcoder_tools::ToolContext,
    ) -> std::result::Result<kcoder_tools::ToolOutput, kcoder_tools::ToolError> {
        Err(kcoder_tools::ToolError::InvalidInput(
            "descriptor is never executable".into(),
        ))
    }
}
fn emitter_engine(base: &QueryEngine, source: &ToolSource) -> (QueryEngine, String) {
    let tool: Arc<dyn kcoder_tools::Tool> = match source {
        ToolSource::Builtin => kcoder_tools::default_registry().get("read").unwrap(),
        ToolSource::Mcp { server, tool } | ToolSource::Plugin { server, tool, .. } => {
            let handle = Arc::new(tokio::sync::Mutex::new(
                kcoder_mcp::McpClient::with_transport(Box::new(NoIoTransport)),
            ));
            let definition=serde_json::from_value(json!({"name":tool,"description":"owned actual MCP emitter","inputSchema":{"type":"object"}})).unwrap();
            let mut actual = kcoder_mcp::McpTool::new(server, handle, definition);
            if let ToolSource::Plugin { plugin, .. } = source {
                actual = actual.with_plugin_source(plugin);
            }
            Arc::new(actual)
        }
        _ => Arc::new(NativeFeatureDescriptor(source.clone())),
    };
    let name = tool.name();
    let mut registry = kcoder_tools::ToolRegistry::new();
    registry.try_register(tool).unwrap();
    (base.clone().with_turn_tools(registry), name)
}

#[tokio::test]
async fn unbound_guard_and_missing_actual_emitter_or_attempt_never_allow() -> Result<()> {
    let f = Fixture::new().await?;
    let guard = f.guard()?;
    assert!(
        f.check(
            &guard,
            ToolSource::Builtin,
            NativeToolAuthorizationPhase::Admission
        )
        .await
        .is_err()
    );
    let binding = f.bind(none()).await?;
    guard.bind(binding).await?;
    let input = json!({});
    let witness = f.facts.engine.native_tool_execution_witness();
    for execution in [None, Some(&witness)] {
        assert!(
            guard
                .authorize(&NativeToolAuthorizationRequest {
                    execution,
                    emitter: None,
                    session_id: &f.facts.engine.session_id(),
                    tool_name: "read",
                    source: ToolSource::Builtin,
                    input: &input,
                    read_only: true,
                    without_sandbox: false,
                    phase: NativeToolAuthorizationPhase::Dispatch
                })
                .await
                .is_err()
        );
    }
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn none_preserves_local_tools_but_denies_connectors_at_both_native_phases() -> Result<()> {
    let f = Fixture::new().await?;
    let guard = f.guard()?;
    guard.bind(f.bind(none()).await?).await?;
    for phase in [
        NativeToolAuthorizationPhase::Admission,
        NativeToolAuthorizationPhase::Dispatch,
    ] {
        assert!(f.check(&guard, ToolSource::Builtin, phase).await.is_ok());
        assert!(
            f.check(&guard, external("source-A", "pretend_builtin"), phase)
                .await
                .is_err()
        );
        assert!(
            f.check(
                &guard,
                ToolSource::Plugin {
                    plugin: "plugin-A".into(),
                    server: "source-A".into(),
                    tool: "read".into()
                },
                phase
            )
            .await
            .is_err()
        );
    }
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn selected_uses_native_provenance_and_allows_future_tools_only_from_same_fixed_source()
-> Result<()> {
    let f = Fixture::new().await?;
    let choice = f.choices().await?.remove(0);
    let source =
        f.catalog
            .resolve_choice(&f.context, &choice, &f.facts.sources(&f.context).await?)?;
    let other = if source.server == "source-A" {
        "source-B"
    } else {
        "source-A"
    };
    let guard = f.guard()?;
    guard.bind(f.bind(selected(vec![choice])).await?).await?;
    for phase in [
        NativeToolAuthorizationPhase::Admission,
        NativeToolAuthorizationPhase::Dispatch,
    ] {
        assert!(
            f.check(
                &guard,
                external(&source.server, "newly_discovered_after_binding"),
                phase
            )
            .await
            .is_ok()
        );
        assert!(
            f.check(&guard, external(other, "mcp__same_exposed_label"), phase)
                .await
                .is_err()
        );
        assert!(
            f.check(&guard, external("not-registered-source", "read"), phase)
                .await
                .is_err()
        );
    }
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn inherit_current_freezes_existing_sources_and_never_adopts_new_registration() -> Result<()>
{
    let f = Fixture::new().await?;
    f.facts
        .configs
        .lock()
        .unwrap()
        .retain(|config| config.name == "source-A");
    let guard = f.guard()?;
    guard
        .bind(
            f.bind(IntegrationTaskCapabilityScopeSelection {
                mode: IntegrationTaskCapabilityScopeMode::InheritCurrent,
                sources: Vec::new(),
            })
            .await?,
        )
        .await?;
    f.facts.configs.lock().unwrap().push(config("source-C"));
    f.catalog.register(
        &f.context,
        "later-current-sources",
        &f.facts.sources(&f.context).await?,
    )?;
    assert!(
        f.check(
            &guard,
            external("source-A", "later-tool"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_ok()
    );
    assert!(
        f.check(
            &guard,
            external("source-C", "later-tool"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_err()
    );
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn stage_cas_waits_for_real_boundary_and_replaying_old_ack_never_restores_old_selection()
-> Result<()> {
    let f = Fixture::new().await?;
    let binding = f.bind(selected(f.choices().await?)).await?;
    let guard = f.guard()?;
    guard.bind(binding.clone()).await?;
    f.facts.management.store(false, Ordering::SeqCst);
    assert!(
        binding
            .stage_selection(
                &f.context,
                "deny-change",
                1,
                none(),
                &f.catalog,
                f.facts.as_ref()
            )
            .await
            .is_err()
    );
    f.facts.management.store(true, Ordering::SeqCst);
    let pending = binding
        .stage_selection(
            &f.context,
            "change-to-none",
            1,
            none(),
            &f.catalog,
            f.facts.as_ref(),
        )
        .await?;
    assert_eq!(
        pending.effective_from,
        IntegrationTaskCapabilityScopeBoundary::NextToolBoundary
    );
    assert!(!pending.effective_sources.is_empty());
    assert!(
        f.check(
            &guard,
            external("source-A", "read"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_err()
    );
    f.facts.boundary.store(false, Ordering::SeqCst);
    assert!(f.commit(&binding, "commit-none", 2).await.is_err());
    f.facts.boundary.store(true, Ordering::SeqCst);
    let active = f.commit(&binding, "commit-none", 2).await?;
    assert_eq!(active.revision, 3);
    assert!(active.effective_sources.is_empty());
    assert_eq!(
        binding
            .stage_selection(
                &f.context,
                "change-to-none",
                1,
                none(),
                &f.catalog,
                f.facts.as_ref()
            )
            .await?,
        pending
    );
    assert_eq!(
        binding.snapshot(&f.context, f.facts.as_ref()).await?,
        active
    );
    assert!(
        binding
            .stage_selection(
                &f.context,
                "other-change",
                1,
                none(),
                &f.catalog,
                f.facts.as_ref()
            )
            .await
            .is_err()
    );
    assert!(
        binding
            .stage_selection(
                &f.context,
                "change-to-none",
                1,
                selected(f.choices().await?),
                &f.catalog,
                f.facts.as_ref()
            )
            .await
            .is_err()
    );
    let restored = NativeTaskCapabilityScopeBindingStore::observe(&f.context)?.unwrap();
    let restored = Arc::new(restored)
        .restore(&f.context, &binding.task_key()?, f.facts.as_ref())
        .await?
        .unwrap();
    assert_eq!(
        restored.snapshot(&f.context, f.facts.as_ref()).await?,
        active
    );
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn resource_and_app_callbacks_use_same_source_refs_and_reject_wire_like_witnesses()
-> Result<()> {
    let f = Fixture::new().await?;
    let choices = f.choices().await?;
    let source =
        f.catalog
            .resolve_choice(&f.context, &choices[0], &f.facts.sources(&f.context).await?)?;
    let other = crate::app_server::integrations::connectivity::NativeMcpSourceSelector {
        server: if source.server == "source-A" {
            "source-B".into()
        } else {
            "source-A".into()
        },
        plugin: None,
    };
    let guard = f.guard()?;
    guard
        .bind(f.bind(selected(vec![choices[0].clone()])).await?)
        .await?;
    let witness = f.facts.engine.native_tool_execution_witness();
    let resource = ResourceWitness {
        execution: f.facts.engine.native_tool_execution_witness(),
        source: f.facts.emitter_sources.lock().unwrap()[&source.server].clone(),
    };
    let callback = NativeTaskCapabilityScopeCallback {
        session_id: witness.session_id(),
        native_witness: &resource,
    };
    guard.authorize_resource_source(&callback, &source).await?;
    guard.authorize_app_source(&callback, &source).await?;
    assert!(
        guard
            .authorize_resource_source(&callback, &other)
            .await
            .is_err()
    );
    assert!(guard.authorize_app_source(&callback, &other).await.is_err());
    let fake = json!({"trusted":true});
    let callback = NativeTaskCapabilityScopeCallback {
        session_id: witness.session_id(),
        native_witness: &fake,
    };
    assert!(
        guard
            .authorize_app_source(&callback, &source)
            .await
            .is_err()
    );
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn source_disable_change_and_state_epoch_are_rechecked_at_dispatch() -> Result<()> {
    let f = Fixture::new().await?;
    let guard = f.guard()?;
    guard
        .bind(f.bind(selected(f.choices().await?)).await?)
        .await?;
    assert!(
        f.check(
            &guard,
            external("source-A", "read"),
            NativeToolAuthorizationPhase::Admission
        )
        .await
        .is_ok()
    );
    f.facts
        .settings
        .lock()
        .unwrap()
        .mcp_disabled_servers
        .push("source-A".into());
    assert!(
        f.check(
            &guard,
            external("source-A", "read"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_err()
    );
    assert!(
        f.check(
            &guard,
            external("source-B", "read"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_ok()
    );
    f.facts
        .configs
        .lock()
        .unwrap()
        .iter_mut()
        .find(|config| config.name == "source-B")
        .unwrap()
        .args
        .push("changed-native-source".into());
    assert!(
        f.check(
            &guard,
            external("source-B", "read"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_err()
    );
    f.facts.wrong_epoch.store(true, Ordering::SeqCst);
    assert!(
        f.check(
            &guard,
            ToolSource::Builtin,
            NativeToolAuthorizationPhase::Admission
        )
        .await
        .is_err()
    );
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn runtime_capture_reads_actual_private_receipt_and_studio_never_fabricates_it() -> Result<()>
{
    let f = Fixture::new().await?;
    assert!(
        NativeAcceptedTaskIdentity::capture_runtime(
            &f.context,
            "missing-native-operation",
            &f.facts.initial,
            f.facts.as_ref()
        )
        .await
        .is_err()
    );
    let studio =
        NativeAcceptedTaskIdentity::capture_studio(&f.context, &f.facts.initial, f.facts.as_ref())
            .await?;
    assert!(studio.runtime_operation_id().is_none());
    assert!(
        NativeDomainGuard::observe(
            f.context.profile()?,
            f.context.scope(),
            NativeDomain::Operations
        )?
        .is_none()
    );
    let (_domain, ledger) = NativeDomainGuard::initialize(
        f.context.profile()?,
        f.context.scope(),
        NativeDomain::Operations,
        "actual-operation-ledger",
        |directory| {
            IntegrationOperationStore::create_in(directory, OsStr::new("data"), f.context.scope())
        },
    )?;
    let request = IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "actual-source-request".into(),
        scope: f.context.scope().clone(),
        operation_id: Some("actual-runtime-task".into()),
        expected_revision: None,
        timeout_ms: 1000,
        cancellation_ref: None,
        payload: Default::default(),
    };
    let first = ledger
        .begin(&request, "P-RUNTIME", "acceptTask", 1)?
        .receipt()
        .clone();
    assert!(
        NativeAcceptedTaskIdentity::capture_runtime(
            &f.context,
            &first.operation_id,
            &f.facts.initial,
            f.facts.as_ref()
        )
        .await
        .is_err()
    );
    let first = ledger.compare_and_swap(
        &first.operation_id,
        IntegrationOperationUpdate {
            expected_revision: first.revision,
            phase: IntegrationOperationPhase::Executing,
            entity_ref: None,
            error: None,
            runtime_acceptance: None,
            observed_at_ms: 2,
        },
    )?;
    let acceptance = IntegrationRuntimeAcceptance {
        thread_id: f.facts.initial.thread_id.clone(),
        turn_id: Some(f.facts.initial.turn_id.clone()),
        task_id: None,
        state: IntegrationTaskState::Running,
    };
    ledger.compare_and_swap(
        &first.operation_id,
        IntegrationOperationUpdate {
            expected_revision: first.revision,
            phase: IntegrationOperationPhase::Accepted,
            entity_ref: Some(IntegrationEntityRef {
                kind: IntegrationEntityKind::Turn,
                id: f.facts.initial.turn_id.clone(),
                revision: None,
            }),
            error: None,
            runtime_acceptance: Some(acceptance),
            observed_at_ms: 3,
        },
    )?;
    let accepted = NativeAcceptedTaskIdentity::capture_runtime(
        &f.context,
        &first.operation_id,
        &f.facts.initial,
        f.facts.as_ref(),
    )
    .await?;
    assert_eq!(accepted.runtime_operation_id(), Some("actual-runtime-task"));
    let initial_selection = selected(f.choices().await?);
    let binding = f
        .facts
        .engine
        .state
        .history_attempt_scope(f.facts.initial.clone())?
        .run(async {
            let witness = f.facts.engine.native_tool_execution_witness();
            let callback = NativeTaskCapabilityScopeCallback {
                session_id: witness.session_id(),
                native_witness: &witness,
            };
            f.store
                .bind_accepted(
                    &f.context,
                    accepted,
                    "actual-runtime-source-selection",
                    initial_selection,
                    &f.catalog,
                    None,
                    f.facts.as_ref(),
                    &callback,
                )
                .await
        })
        .await?;
    assert_eq!(
        binding.accepted().runtime_operation_id(),
        Some("actual-runtime-task")
    );
    let binding = Arc::new(binding);
    let runtime_guard = NativeTaskCapabilityScopeGuard::pending(
        f.context.clone(),
        NativeTaskCapabilityScopePendingTarget::RuntimeOperation("actual-runtime-task".into()),
        f.catalog.clone(),
        f.facts.clone(),
    )?;
    runtime_guard.bind(binding.clone()).await?;
    assert!(
        f.check(
            &runtime_guard,
            external("source-A", "read"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_ok()
    );
    assert!(f.guard()?.bind(binding.clone()).await.is_err());
    let wrong_guard = NativeTaskCapabilityScopeGuard::pending(
        f.context.clone(),
        NativeTaskCapabilityScopePendingTarget::RuntimeOperation("different-runtime-task".into()),
        f.catalog.clone(),
        f.facts.clone(),
    )?;
    assert!(wrong_guard.bind(binding).await.is_err());
    let wrong = TurnAttemptIdentity {
        turn_id: "another-turn".into(),
        ..f.facts.initial.clone()
    };
    assert!(
        NativeAcceptedTaskIdentity::capture_runtime(
            &f.context,
            &first.operation_id,
            &wrong,
            f.facts.as_ref()
        )
        .await
        .is_err()
    );
    f.shutdown().await;
    Ok(())
}
