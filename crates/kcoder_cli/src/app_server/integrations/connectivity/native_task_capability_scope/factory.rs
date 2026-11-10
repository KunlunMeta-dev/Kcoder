//! Actual native source facts over owned runtime/connection objects.
use super::*;
use crate::app_server::{SessionLease, engine_factory::AppServerEngineFactory};
use kcoder_config::PrivateDirectory;
use kcoder_engine::{
    QueryEngine,
    integrations::core::{
        NativeEngineEventFrame, NativeToolBoundaryWitness, NativeToolEmitterWitness,
        NativeToolExecutionWitness, NativeToolGateHandle,
    },
};
use std::sync::{Mutex, Weak};

mod ownership;
mod resources;
use ownership::NativeSessionSourceOwner;

/// This metadata follows the existing registered object; it does not keep a
/// transport alive after the owning registry/Engine drops it.
struct RegisteredSource {
    tool: Weak<dyn kcoder_tools::Tool>,
    original: Weak<dyn kcoder_tools::Tool>,
    origin: Weak<kcoder_mcp::native_origin::NativeMcpConnectionOrigin>,
    source: Arc<NativeMcpSourceFact>,
    connection: Weak<tokio::sync::Mutex<kcoder_mcp::McpClient>>,
}
struct RegisteredSources(Mutex<Vec<RegisteredSource>>);
impl RegisteredSources {
    fn capture(
        context: &NativeIntegrationContext,
        registry: &kcoder_tools::ToolRegistry,
        engine: &QueryEngine,
    ) -> Result<Self> {
        context.verify()?;
        ensure!(
            registry.names().len() <= 4096,
            "TASK_CAPABILITY_SCOPE_REGISTRY_CAPACITY"
        );
        let mut sources = Vec::new();
        for tool in registry.all() {
            if !matches!(
                tool.source(),
                kcoder_tools::ToolSource::Mcp { .. } | kcoder_tools::ToolSource::Plugin { .. }
            ) {
                continue;
            }
            // Unsupported/missing birth proof remains unknown to this guard.
            // Inventory can report it, but a current name cannot repair it.
            let original = super::super::application_inputs::business_source_tool(context, &tool)?
                .unwrap_or_else(|| tool.clone());
            let Ok(source) =
                NativeMcpSourceFact::from_registered_engine_tool(context, engine, &tool)
            else {
                continue;
            };
            let actual: &dyn std::any::Any = original.as_ref();
            let origin = actual
                .downcast_ref::<kcoder_mcp::McpTool>()
                .and_then(|tool| tool.native_origin())
                .context("TASK_CAPABILITY_SCOPE_NATIVE_CONNECTION_REQUIRED")?;
            sources.push(RegisteredSource {
                tool: Arc::downgrade(&tool),
                original: Arc::downgrade(&original),
                origin: Arc::downgrade(origin),
                source: Arc::new(source),
                connection: actual
                    .downcast_ref::<kcoder_mcp::McpTool>()
                    .unwrap()
                    .native_connection_gate(),
            });
        }
        Ok(Self(Mutex::new(sources)))
    }
    fn connection_handles(&self) -> Result<Vec<Arc<tokio::sync::Mutex<kcoder_mcp::McpClient>>>> {
        let entries = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_REGISTRY_UNAVAILABLE"))?;
        entries
            .iter()
            .filter(|entry| entry.tool.strong_count() > 0)
            .map(|entry| {
                entry
                    .connection
                    .upgrade()
                    .context("TASK_CAPABILITY_SCOPE_NATIVE_CONNECTION_ENDED")
            })
            .collect()
    }
    fn claim_resource_gates(
        &self,
    ) -> Result<Vec<tokio::sync::OwnedMutexGuard<kcoder_mcp::McpClient>>> {
        let entries = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_REGISTRY_UNAVAILABLE"))?;
        let mut seen = std::collections::HashSet::new();
        let mut guards = Vec::new();
        for entry in entries.iter().filter(|entry| entry.tool.strong_count() > 0) {
            let handle = entry
                .connection
                .upgrade()
                .context("TASK_CAPABILITY_SCOPE_NATIVE_CONNECTION_ENDED")?;
            let key = Arc::as_ptr(&handle) as usize;
            if seen.insert(key) {
                guards.push(handle.try_lock_owned().map_err(|_| {
                    anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_RESOURCE_BOUNDARY_BUSY")
                })?);
            }
        }
        Ok(guards)
    }
    fn source_for(
        &self,
        context: &NativeIntegrationContext,
        emitter: &NativeToolEmitterWitness,
        settings: &kcoder_config::Settings,
    ) -> Result<Option<Arc<NativeMcpSourceFact>>> {
        context.verify()?;
        let entries = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_REGISTRY_UNAVAILABLE"))?;
        for entry in entries.iter() {
            let Some(tool) = entry.tool.upgrade() else {
                continue;
            };
            if !emitter.matches_tool(&tool) {
                continue;
            }
            let origin = entry
                .origin
                .upgrade()
                .context("TASK_CAPABILITY_SCOPE_NATIVE_CONNECTION_ENDED")?;
            let original = super::super::application_inputs::business_source_tool(context, &tool)?
                .unwrap_or_else(|| tool.clone());
            ensure!(
                entry
                    .original
                    .upgrade()
                    .is_some_and(|registered| Arc::ptr_eq(&registered, &original)),
                "TASK_CAPABILITY_SCOPE_NATIVE_CONNECTION_CHANGED"
            );
            let object: &dyn std::any::Any = original.as_ref();
            let actual = object
                .downcast_ref::<kcoder_mcp::McpTool>()
                .context("TASK_CAPABILITY_SCOPE_NATIVE_CONNECTION_REQUIRED")?;
            ensure!(
                actual
                    .native_origin()
                    .is_some_and(|current| Arc::ptr_eq(current, &origin)),
                "TASK_CAPABILITY_SCOPE_NATIVE_CONNECTION_CHANGED"
            );
            ensure!(
                origin.matches_profile(context.profile()?)?,
                "TASK_CAPABILITY_SCOPE_NATIVE_PROFILE_CHANGED"
            );
            entry.source.verify_lease_policy(context, settings)?;
            return Ok(Some(entry.source.clone()));
        }
        Ok(None)
    }
}

/// The raw Engine snapshot shares the actual State/services but has no newly
/// installed task guard, avoiding a facts->guard->facts ownership cycle.
struct NativeChildNode {
    state: kcoder_state::AppState,
    lifecycle: kcoder_state::AppStateLifecycleIdentity,
    session: std::path::PathBuf,
    parent_state: kcoder_state::AppState,
    parent_lifecycle: kcoder_state::AppStateLifecycleIdentity,
    parent_attempt: TurnAttemptIdentity,
    identity: TurnAttemptIdentity,
    input_hash: String,
    fingerprint: String,
    run: BackgroundRunKey,
    root_attempt: TurnAttemptIdentity,
    gate: NativeToolGateHandle,
    sources: RegisteredSources,
}

enum SourceBoundaryKind {
    InitialAdmission,
    Control,
}
pub(crate) struct NativeTaskCapabilityScopeBoundaryLease {
    kind: SourceBoundaryKind,
    root: NativeToolBoundaryWitness,
    _children: Vec<NativeToolBoundaryWitness>,
    _resources: Vec<tokio::sync::OwnedMutexGuard<kcoder_mcp::McpClient>>,
}
pub(crate) struct NativeTaskCapabilityScopeFactory {
    runtime_initial: Mutex<
        Weak<crate::app_server::integrations::core::runtime_driver::NativeRuntimeAcceptedObserver>,
    >,
    context: Arc<NativeIntegrationContext>,
    root: QueryEngine,
    owner: NativeSessionSourceOwner,
    configuration: AppServerEngineFactory,
    sources: RegisteredSources,
    backend: Arc<dyn kcoder_config::CredentialBackend>,
    gate: NativeToolGateHandle,
    boundary: Mutex<Weak<NativeTaskCapabilityScopeBoundaryLease>>,
    children: Mutex<Vec<NativeChildNode>>,
    resource_host: Mutex<Weak<super::super::main_rpc::NativeConnectivityMainService>>,
    public_management: Mutex<
        Weak<crate::app_server::integrations::core::task_capability_scope_control::NativeTaskCapabilityScopeManagementPermit>,
    >,
}
impl NativeTaskCapabilityScopeFactory {
    /// Read only the actual original owner's current source/account facts and
    /// registered native objects. This does not connect, register or grant use.
    pub(crate) fn source_choices_inventory(
        &self,
        context: &NativeIntegrationContext,
        catalog: &NativeConnectivitySourceCatalog,
    ) -> Result<super::super::NativeConnectivityInventory> {
        self.verify(context)?;
        let registry = self.root.active_tool_registry();
        let native_tools = |registry: &kcoder_tools::ToolRegistry| {
            registry
                .all()
                .into_iter()
                .filter(|tool| {
                    matches!(
                        tool.source(),
                        kcoder_tools::ToolSource::Mcp { .. }
                            | kcoder_tools::ToolSource::Plugin { .. }
                    )
                })
                .collect::<Vec<_>>()
        };
        let before = native_tools(&registry);
        for tool in &before {
            NativeMcpSourceFact::from_registered_engine_tool(context, &self.root, tool)?;
        }
        let sources = self.current_sources(context)?;
        let inventory = catalog.inventory(context, &sources, &registry)?;
        // Foreground projections can rebuild builtin registries. Compare the
        // actual external registered objects, rather than a fresh projection tag.
        let after = native_tools(&self.root.active_tool_registry());
        ensure!(
            before.len() == after.len()
                && before
                    .iter()
                    .all(|tool| after.iter().any(|current| Arc::ptr_eq(tool, current))),
            "TASK_CAPABILITY_SCOPE_REGISTERED_INVENTORY_CHANGED"
        );
        self.verify(context)?;
        Ok(inventory)
    }
    pub(crate) fn capture(
        context: Arc<NativeIntegrationContext>,
        engine: &QueryEngine,
        lease: &SessionLease,
        configuration: AppServerEngineFactory,
        backend: Arc<dyn kcoder_config::CredentialBackend>,
    ) -> Result<Self> {
        context.verify()?;
        let owner = NativeSessionSourceOwner::capture(lease, engine)
            .context("TASK_CAPABILITY_SCOPE_FACTORY_OWNER")?;
        let sources = RegisteredSources::capture(&context, &engine.tools, engine)
            .context("TASK_CAPABILITY_SCOPE_FACTORY_REGISTRY")?;
        owner.verify(engine)?;
        Ok(Self {
            runtime_initial: Mutex::new(Weak::new()),
            context,
            root: engine.clone(),
            owner,
            configuration,
            sources,
            backend,
            gate: engine.native_tool_gate_handle(),
            boundary: Mutex::new(Weak::new()),
            children: Mutex::new(Vec::new()),
            resource_host: Mutex::new(Weak::new()),
            public_management: Mutex::new(Weak::new()),
        })
    }
    pub(crate) fn bind_resource_host(
        &self,
        host: &Arc<super::super::main_rpc::NativeConnectivityMainService>,
    ) -> Result<()> {
        self.verify(&self.context)?;
        let mut current = self
            .resource_host
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_RESOURCE_MAIN_UNAVAILABLE"))?;
        if let Some(original) = current.upgrade() {
            ensure!(
                Arc::ptr_eq(&original, host),
                "TASK_RESOURCE_MAIN_OWNER_CHANGED"
            );
        }
        *current = Arc::downgrade(host);
        Ok(())
    }
    /// The finite public handler owns the strong request permit. This weak
    /// installation cannot extend connection, original operation or deadline.
    pub(crate) fn install_public_management(
        &self,
        permit: &Arc<
            crate::app_server::integrations::core::task_capability_scope_control::NativeTaskCapabilityScopeManagementPermit,
        >,
    ) -> Result<()> {
        self.verify(&self.context)?;
        *self.public_management.lock().map_err(|_| {
            anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_MANAGEMENT_UNAVAILABLE")
        })? = Arc::downgrade(permit);
        Ok(())
    }
    pub(crate) fn capture_studio_accepted(
        &self,
        context: &NativeIntegrationContext,
        initial: &TurnAttemptIdentity,
    ) -> Result<NativeAcceptedTaskIdentity> {
        let witness = self.actual_accepted_turn(context, initial)?;
        validate_witness(context, initial, &witness)?;
        Ok(NativeAcceptedTaskIdentity {
            data: AcceptedData {
                scope: context.scope().clone(),
                origin: AcceptedOrigin::Studio,
                initial_attempt: initial.clone(),
                session_directory_identity: witness.session_directory_identity,
                state_epoch: witness.state_epoch,
                accepted_fingerprint: attempt_fingerprint(&witness.record)?,
            },
        })
    }
    pub(crate) fn install_runtime_initial(
        &self,
        observer: &Arc<
            crate::app_server::integrations::core::runtime_driver::NativeRuntimeAcceptedObserver,
        >,
    ) -> Result<()> {
        self.verify(&self.context)?;
        observer.verify_current(&self.context, &self.root)?;
        *self.runtime_initial.lock().map_err(|_| {
            anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_MANAGEMENT_UNAVAILABLE")
        })? = Arc::downgrade(observer);
        Ok(())
    }
    pub(crate) fn capture_control_accepted(
        &self,
        context: &NativeIntegrationContext,
        reference: &IntegrationTaskCapabilityScopeControlTarget,
    ) -> Result<NativeAcceptedTaskIdentity> {
        reference.validate()?;
        let mut accepted = self.capture_studio_accepted(context, &reference.initial_attempt)?;
        if let Some(operation) = &reference.runtime_operation_id {
            let receipt = runtime_receipt(context, operation)?;
            let acceptance = receipt
                .runtime_acceptance
                .context("TASK_CAPABILITY_SCOPE_ACCEPTANCE_REQUIRED")?;
            ensure!(
                acceptance.thread_id == reference.initial_attempt.thread_id
                    && acceptance
                        .turn_id
                        .as_ref()
                        .is_none_or(|turn| turn == &reference.initial_attempt.turn_id),
                "TASK_CAPABILITY_SCOPE_ACCEPTANCE_MISMATCH"
            );
            accepted.data.origin = AcceptedOrigin::Runtime {
                operation_id: operation.clone(),
                acceptance,
            };
        }
        Ok(accepted)
    }
    pub(crate) fn verify_resident_owner(
        &self,
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
    ) -> Result<()> {
        self.verify(context)?;
        self.owner.verify(engine)
    }
    pub(crate) fn actual_root(&self) -> &QueryEngine {
        &self.root
    }
    /// A control boundary owns exactly this binding's admitted runtimes. Peers
    /// are not adopted or cancelled. Unknown emitters cannot consume this
    /// binding because admission/dispatch requires an actual registered node.
    pub(crate) fn claim_control_boundary(
        &self,
    ) -> Result<Arc<NativeTaskCapabilityScopeBoundaryLease>> {
        self.verify(&self.context)?;
        let root = self.gate.try_boundary(&self.root.state)?;
        let mut children = Vec::new();
        let mut handles = self.sources.connection_handles()?;
        {
            let nodes = self.children.lock().map_err(|_| {
                anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_CHILD_FACTS_UNAVAILABLE")
            })?;
            for node in nodes.iter() {
                let record = read_child_record(node)?;
                if record.status == TurnAttemptStatus::Accepted {
                    children.push(node.gate.try_boundary(&node.state)?);
                }
                handles.extend(node.sources.connection_handles()?);
            }
        }
        let mut seen = std::collections::HashSet::new();
        let mut resources = Vec::new();
        for handle in handles {
            if seen.insert(Arc::as_ptr(&handle) as usize) {
                resources.push(handle.try_lock_owned().map_err(|_| {
                    anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_RESOURCE_BOUNDARY_BUSY")
                })?);
            }
        }
        let witness = Arc::new(NativeTaskCapabilityScopeBoundaryLease {
            kind: SourceBoundaryKind::Control,
            root,
            _children: children,
            _resources: resources,
        });
        let mut slot = self
            .boundary
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_BOUNDARY_UNAVAILABLE"))?;
        ensure!(
            slot.upgrade().is_none(),
            "TASK_CAPABILITY_SCOPE_NATIVE_BOUNDARY_BUSY"
        );
        *slot = Arc::downgrade(&witness);
        Ok(witness)
    }
    /// The caller holds this actual gate during the native bind/commit. The
    /// weak slot expires immediately on Drop, never on a time-based allow TTL.
    pub(crate) fn claim_root_boundary(
        &self,
    ) -> Result<Arc<NativeTaskCapabilityScopeBoundaryLease>> {
        self.verify(&self.context)?;
        let root = self.gate.try_boundary(&self.root.state)?;
        let mut children = Vec::new();
        {
            let nodes = self.children.lock().map_err(|_| {
                anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_CHILD_FACTS_UNAVAILABLE")
            })?;
            for node in nodes.iter() {
                if read_child_record(node)?.status == TurnAttemptStatus::Accepted {
                    children.push(node.gate.try_boundary(&node.state)?);
                }
            }
        }
        let resources = self.sources.claim_resource_gates()?;
        let witness = Arc::new(NativeTaskCapabilityScopeBoundaryLease {
            kind: SourceBoundaryKind::InitialAdmission,
            root,
            _children: children,
            _resources: resources,
        });
        let mut slot = self
            .boundary
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_BOUNDARY_UNAVAILABLE"))?;
        ensure!(
            slot.upgrade().is_none(),
            "TASK_CAPABILITY_SCOPE_NATIVE_BOUNDARY_BUSY"
        );
        *slot = Arc::downgrade(&witness);
        Ok(witness)
    }
    fn verify(&self, context: &NativeIntegrationContext) -> Result<()> {
        context.validate_scope(self.context.scope())?;
        self.owner.verify(&self.root)
    }
    fn actual_accepted_turn(
        &self,
        context: &NativeIntegrationContext,
        identity: &TurnAttemptIdentity,
    ) -> Result<NativeTaskCapabilityScopeTurnWitness> {
        self.verify(context)?;
        ensure!(
            identity.thread_id == self.root.session_id(),
            "TASK_CAPABILITY_SCOPE_NATIVE_THREAD_REQUIRED"
        );
        let session = self.root.session_storage_dir_for(&identity.thread_id);
        let directory = PrivateDirectory::open_existing(&session)?;
        let store = kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing(
            &session,
            &identity.thread_id,
        )?
        .context("TASK_CAPABILITY_SCOPE_NATIVE_ACCEPTED_REQUIRED")?;
        let record = store
            .load(identity)?
            .context("TASK_CAPABILITY_SCOPE_NATIVE_ACCEPTED_REQUIRED")?;
        record.validate()?;
        self.verify(context)?;
        Ok(NativeTaskCapabilityScopeTurnWitness {
            scope: context.scope().clone(),
            session_directory_identity: directory.directory_identity()?,
            state_epoch: self.owner.persistent_epoch(context, &self.root)?,
            record,
        })
    }
    fn current_sources(
        &self,
        context: &NativeIntegrationContext,
    ) -> Result<Vec<NativeMcpSourceFact>> {
        self.verify(context)?;
        let sources =
            crate::app_server::integrations::connectivity::native_sources::leased::for_engine(
                context,
                &self.configuration,
                self.backend.as_ref(),
                &self.root,
            )?;
        self.verify(context)?;
        Ok(sources)
    }
}

impl NativeTaskCapabilityScopeFactory {
    fn actual_execution(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        witness: &NativeToolExecutionWitness,
        require_current_scope: bool,
    ) -> Result<NativeTaskCapabilityScopeExecution> {
        if witness.matches_state(&self.root.state) {
            return self.root_execution(context, accepted, witness, require_current_scope);
        }
        self.verify(context)?;
        let nodes = self
            .children
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_CHILD_FACTS_UNAVAILABLE"))?;
        let leaf = nodes
            .iter()
            .find(|node| {
                witness.matches_state(&node.state)
                    && node.lifecycle.matches(&node.state)
                    && witness.session_id() == node.state.session_id()
            })
            .context("TASK_CAPABILITY_SCOPE_NATIVE_CHILD_LINEAGE_REQUIRED")?;
        if require_current_scope {
            ensure!(
                leaf.state
                    .matches_current_history_attempt(witness.attempt()),
                "TASK_CAPABILITY_SCOPE_NATIVE_ATTEMPT_SCOPE_CHANGED"
            );
        }
        ensure!(
            witness
                .attempt()
                .is_none_or(|identity| identity == &leaf.identity),
            "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_ATTEMPT_CHANGED"
        );
        let immediate = witness
            .parent()
            .context("TASK_CAPABILITY_SCOPE_NATIVE_CHILD_PARENT_REQUIRED")?;
        ensure!(
            immediate.matches_state(&leaf.parent_state)
                && immediate.agent_id() == leaf.run.agent_id
                && immediate.background_run() == Some(&leaf.run),
            "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_PARENT_CHANGED"
        );
        let mut path = Vec::new();
        let mut cursor = leaf;
        let mut seen = std::collections::BTreeSet::new();
        loop {
            ensure!(
                path.len() < 32
                    && seen.insert(cursor.state.session_id())
                    && cursor.lifecycle.matches(&cursor.state)
                    && cursor.parent_lifecycle.matches(&cursor.parent_state),
                "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_LINEAGE_CHANGED"
            );
            let record = read_child_record(cursor)?;
            ensure!(
                record.status.is_known(),
                "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_ATTEMPT_UNKNOWN"
            );
            let task = cursor
                .parent_state
                .task(&cursor.run.agent_id)
                .context("TASK_CAPABILITY_SCOPE_NATIVE_CHILD_RUN_REQUIRED")?;
            ensure!(task.background_run.as_ref()==Some(&cursor.run) && cursor.parent_state.session_id()==cursor.run.parent_session_id && matches!(task.status, kcoder_types::TaskStatus::Pending | kcoder_types::TaskStatus::Running) && cursor.parent_state.background_run_record(&cursor.run).is_some_and(|record|record.terminal.is_none() && !record.imported_history),"TASK_CAPABILITY_SCOPE_NATIVE_CHILD_RUN_CHANGED");
            path.push(NativeTaskCapabilityScopeLineageEdge {
                run: cursor.run.clone(),
                child_session_id: cursor.state.session_id(),
            });
            if cursor.parent_lifecycle.matches(&self.root.state) {
                ensure!(
                    cursor.parent_attempt == cursor.root_attempt,
                    "TASK_CAPABILITY_SCOPE_NATIVE_PARENT_ATTEMPT_CHANGED"
                );
                break;
            }
            let parent = nodes
                .iter()
                .find(|parent| {
                    cursor.parent_lifecycle.matches(&parent.state)
                        && parent.state.session_id() == cursor.run.parent_session_id
                })
                .context("TASK_CAPABILITY_SCOPE_NATIVE_CHILD_ANCESTOR_REQUIRED")?;
            ensure!(
                cursor.parent_attempt == parent.identity
                    && cursor.root_attempt == parent.root_attempt,
                "TASK_CAPABILITY_SCOPE_NATIVE_PARENT_ATTEMPT_CHANGED"
            );
            cursor = parent;
        }
        path.reverse();
        let root = self.actual_accepted_turn(context, accepted.initial_attempt())?;
        let root_chain = self.root_chain(context, accepted, &leaf.root_attempt)?;
        let current_attempt = if witness.attempt().is_some() {
            Some(read_child_record(leaf)?)
        } else {
            None
        };
        self.verify(context)?;
        Ok(NativeTaskCapabilityScopeExecution {
            scope: context.scope().clone(),
            task_key: accepted.task_key()?,
            current_session_id: witness.session_id().into(),
            root_session_directory_identity: root.session_directory_identity,
            root_state_epoch: root.state_epoch,
            root_attempt_chain: root_chain,
            current_attempt,
            lineage: path,
            native_emitter_id: leaf.state.session_id(),
            emitter_source: None,
            boundary_id: None,
        })
    }
    fn root_chain(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        tip: &TurnAttemptIdentity,
    ) -> Result<Vec<kcoder_state::turn_attempt_store::TurnAttemptRecord>> {
        let mut chain = Vec::new();
        let mut next = tip.clone();
        for _ in 0..64 {
            ensure!(
                next.thread_id == accepted.initial_attempt().thread_id
                    && next.turn_id == accepted.initial_attempt().turn_id,
                "TASK_CAPABILITY_SCOPE_ACTUAL_ATTEMPT_CHAIN_REQUIRED"
            );
            let record = self.actual_accepted_turn(context, &next)?.record;
            let reached = record.identity == *accepted.initial_attempt();
            let parent = record.parent_attempt_id.clone();
            chain.push(record);
            if reached {
                chain.reverse();
                return Ok(chain);
            }
            next.attempt_id =
                parent.context("TASK_CAPABILITY_SCOPE_ACTUAL_ATTEMPT_CHAIN_REQUIRED")?;
        }
        anyhow::bail!("TASK_CAPABILITY_SCOPE_ACTUAL_ATTEMPT_CHAIN_REQUIRED")
    }
    fn actual_source_for(
        &self,
        context: &NativeIntegrationContext,
        emitter: &NativeToolEmitterWitness,
    ) -> Result<Option<Arc<NativeMcpSourceFact>>> {
        // This concrete host proxy retains the original registered MCP object;
        // a matching name/source on an arbitrary wrapper never supplies this proof.
        if let Some(proxy) =
            emitter.downcast_tool::<crate::app_server::mcp_apps_tool::McpPresentationTool>()
        {
            let original = proxy.native_source_reader()?;
            ensure!(
                original.emitter().execution().session_id() == emitter.execution().session_id()
                    && original.emitter().execution().attempt() == emitter.execution().attempt(),
                "TASK_RESOURCE_APP_EMITTER_CHANGED"
            );
            return self.actual_source_for(context, original.emitter());
        }
        if emitter.execution().matches_state(&self.root.state) {
            return self.sources.source_for(
                context,
                emitter,
                &self.configuration.current_settings()?,
            );
        }
        let nodes = self
            .children
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_CHILD_FACTS_UNAVAILABLE"))?;
        let node = nodes
            .iter()
            .find(|node| {
                emitter.execution().matches_state(&node.state)
                    && node.lifecycle.matches(&node.state)
            })
            .context("TASK_CAPABILITY_SCOPE_NATIVE_CHILD_LINEAGE_REQUIRED")?;
        node.sources
            .source_for(context, emitter, &self.configuration.current_settings()?)
    }
    fn root_execution(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        witness: &NativeToolExecutionWitness,
        require_current_scope: bool,
    ) -> Result<NativeTaskCapabilityScopeExecution> {
        self.verify(context)?;
        ensure!(
            witness.matches_state(&self.root.state)
                && witness.session_id() == self.root.session_id()
                && witness.parent().is_none(),
            "TASK_CAPABILITY_SCOPE_ACTUAL_REGISTERED_ENGINE_REQUIRED"
        );
        if require_current_scope {
            ensure!(
                self.root
                    .state
                    .matches_current_history_attempt(witness.attempt()),
                "TASK_CAPABILITY_SCOPE_NATIVE_ATTEMPT_SCOPE_CHANGED"
            );
        }
        ensure!(
            accepted.thread_id() == self.root.session_id(),
            "TASK_CAPABILITY_SCOPE_NATIVE_TASK_OWNER_MISMATCH"
        );
        let current_attempt = witness
            .attempt()
            .map(|identity| {
                self.actual_accepted_turn(context, identity)
                    .map(|witness| witness.record)
            })
            .transpose()?;
        let mut chain = Vec::new();
        let mut next = current_attempt
            .as_ref()
            .map(|record| record.identity.clone())
            .unwrap_or_else(|| accepted.initial_attempt().clone());
        for _ in 0..64 {
            ensure!(
                next.thread_id == accepted.initial_attempt().thread_id
                    && next.turn_id == accepted.initial_attempt().turn_id,
                "TASK_CAPABILITY_SCOPE_ACTUAL_ATTEMPT_CHAIN_REQUIRED"
            );
            let record = self.actual_accepted_turn(context, &next)?.record;
            let reached = record.identity == *accepted.initial_attempt();
            let parent = record.parent_attempt_id.clone();
            chain.push(record);
            if reached {
                break;
            }
            next.attempt_id =
                parent.context("TASK_CAPABILITY_SCOPE_ACTUAL_ATTEMPT_CHAIN_REQUIRED")?;
        }
        ensure!(
            chain
                .last()
                .is_some_and(|record| record.identity == *accepted.initial_attempt()),
            "TASK_CAPABILITY_SCOPE_ACTUAL_ATTEMPT_CHAIN_REQUIRED"
        );
        chain.reverse();
        let origin = self.actual_accepted_turn(context, accepted.initial_attempt())?;
        self.verify(context)?;
        Ok(NativeTaskCapabilityScopeExecution {
            scope: context.scope().clone(),
            task_key: accepted.task_key()?,
            current_session_id: witness.session_id().into(),
            root_session_directory_identity: origin.session_directory_identity,
            root_state_epoch: origin.state_epoch.clone(),
            root_attempt_chain: chain,
            current_attempt,
            lineage: Vec::new(),
            native_emitter_id: origin.state_epoch,
            emitter_source: None,
            boundary_id: self
                .boundary
                .lock()
                .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_BOUNDARY_UNAVAILABLE"))?
                .upgrade()
                .filter(|boundary| boundary.root.matches_state(&self.root.state))
                .map(|boundary| boundary.root.id().to_owned()),
        })
    }
}
#[async_trait]
#[kcoder_async_box::shared]
impl NativeTaskCapabilityScopeFacts for NativeTaskCapabilityScopeFactory {
    async fn reconcile_pending_selection(
        &self,
        context: &NativeIntegrationContext,
        binding: &NativeTaskCapabilityScopeBinding,
    ) -> Result<()> {
        super::super::task_capability_scope_control::apply_pending_binding(context, binding, self)
            .await?;
        Ok(())
    }

    async fn prepare_child(
        &self,
        context: &NativeIntegrationContext,
        binding: &NativeTaskCapabilityScopeBinding,
        request: &kcoder_engine::integrations::core::NativeChildAdmissionRequest<'_>,
    ) -> Result<()> {
        self.verify(context)?;
        let original = request.parent_execution();
        let callback = NativeTaskCapabilityScopeCallback {
            session_id: original.session_id(),
            native_witness: original,
        };
        let execution = self
            .execution_for_callback(
                context,
                &binding.accepted,
                &callback,
                NativeTaskCapabilityScopeCallbackPurpose::ChildAdmission,
            )
            .await?;
        binding
            .accepted
            .check_execution(context, callback.session_id, &execution, false)?;
        ensure!(
            execution
                .current_attempt
                .as_ref()
                .map(|record| &record.identity)
                == original.attempt(),
            "TASK_CAPABILITY_SCOPE_ORIGINAL_PARENT_ATTEMPT_CHANGED"
        );
        binding.prepare_native_child(
            context,
            request,
            self.owner.persistent_epoch(context, &self.root)?,
        )
    }
    async fn observe_child_accepted(
        &self,
        context: &NativeIntegrationContext,
        binding: &NativeTaskCapabilityScopeBinding,
        request: &kcoder_engine::integrations::core::NativeChildAdmissionRequest<'_>,
    ) -> Result<()> {
        self.verify(context)?;
        ensure!(
            request
                .child()
                .state
                .matches_current_history_attempt(Some(request.identity())),
            "TASK_CAPABILITY_SCOPE_ACTUAL_CHILD_ACCEPTED_SCOPE_REQUIRED"
        );
        let session = request
            .child()
            .session_storage_dir_for(&request.identity().thread_id);
        let store = kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing(
            &session,
            &request.identity().thread_id,
        )?
        .context("TASK_CAPABILITY_SCOPE_ACTUAL_CHILD_ACCEPTED_REQUIRED")?;
        let record = store
            .load(request.identity())?
            .context("TASK_CAPABILITY_SCOPE_ACTUAL_CHILD_ACCEPTED_REQUIRED")?;
        ensure!(
            record.status == TurnAttemptStatus::Accepted
                && record.completion.is_none()
                && record.input_context_hash == request.input_hash()
                && record.request_fingerprint.as_deref() == Some(request.fingerprint()),
            "TASK_CAPABILITY_SCOPE_ACTUAL_CHILD_ACCEPTED_CHANGED"
        );
        let root_attempt = if request.parent_execution().matches_state(&self.root.state) {
            request
                .parent_execution()
                .attempt()
                .context("TASK_CAPABILITY_SCOPE_ORIGINAL_PARENT_ATTEMPT_REQUIRED")?
                .clone()
        } else {
            let nodes = self.children.lock().map_err(|_| {
                anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_CHILD_FACTS_UNAVAILABLE")
            })?;
            nodes
                .iter()
                .find(|node| {
                    request.parent_execution().matches_state(&node.state)
                        && node.lifecycle.matches(&node.state)
                })
                .context("TASK_CAPABILITY_SCOPE_NATIVE_PARENT_LINEAGE_REQUIRED")?
                .root_attempt
                .clone()
        };
        let sources = RegisteredSources::capture(context, &request.child().tools, request.child())?;
        binding.accept_native_child(
            context,
            request,
            self.owner.persistent_epoch(context, &self.root)?,
        )?;
        let mut nodes = self
            .children
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_CHILD_FACTS_UNAVAILABLE"))?;
        ensure!(
            nodes.len() < 128
                && !nodes.iter().any(|node| node.state.session_id()
                    == request.identity().thread_id
                    || node.run == *request.run()),
            "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_ALREADY_REGISTERED"
        );
        nodes.push(NativeChildNode {
            state: request.child().state.clone(),
            lifecycle: request.child().state.inspection_lifecycle_identity(),
            session,
            parent_state: request.parent().state.clone(),
            parent_lifecycle: request.parent().state.inspection_lifecycle_identity(),
            parent_attempt: request
                .parent_execution()
                .attempt()
                .context("TASK_CAPABILITY_SCOPE_ORIGINAL_PARENT_ATTEMPT_REQUIRED")?
                .clone(),
            identity: request.identity().clone(),
            input_hash: request.input_hash().into(),
            fingerprint: request.fingerprint().into(),
            run: request.run().clone(),
            root_attempt,
            gate: request.child().native_tool_gate_handle(),
            sources,
        });
        self.verify(context)
    }
    async fn accepted_turn(
        &self,
        context: &NativeIntegrationContext,
        identity: &TurnAttemptIdentity,
    ) -> Result<NativeTaskCapabilityScopeTurnWitness> {
        self.actual_accepted_turn(context, identity)
    }
    async fn execution_for_tool(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<NativeTaskCapabilityScopeExecution> {
        let emitter = request
            .emitter
            .context("TASK_CAPABILITY_SCOPE_REGISTERED_EMITTER_REQUIRED")?;
        ensure!(
            request
                .execution
                .is_some_and(|execution| std::ptr::eq(execution, emitter.execution())),
            "TASK_CAPABILITY_SCOPE_REGISTERED_EMITTER_MISMATCH"
        );
        let mut execution = self.actual_execution(context, accepted, emitter.execution(), true)?;
        execution.emitter_source = self.actual_source_for(context, emitter)?;
        Ok(execution)
    }
    async fn execution_for_callback(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        callback: &NativeTaskCapabilityScopeCallback<'_>,
        purpose: NativeTaskCapabilityScopeCallbackPurpose,
    ) -> Result<NativeTaskCapabilityScopeExecution> {
        let frame = callback
            .native_witness
            .downcast_ref::<NativeEngineEventFrame>();
        let tool = callback
            .native_witness
            .downcast_ref::<NativeToolEmitterWitness>();
        let witness = if let Some(frame) = frame {
            frame.execution()
        } else if let Some(tool) = tool {
            tool.execution()
        } else {
            callback
                .native_witness
                .downcast_ref::<NativeToolExecutionWitness>()
                .context("TASK_CAPABILITY_SCOPE_ACTUAL_NATIVE_CALLBACK_REQUIRED")?
        };
        ensure!(
            callback.session_id == witness.session_id(),
            "TASK_CAPABILITY_SCOPE_ACTUAL_NATIVE_CALLBACK_REQUIRED"
        );
        let mut execution = self.actual_execution(
            context,
            accepted,
            witness,
            matches!(
                purpose,
                NativeTaskCapabilityScopeCallbackPurpose::Admission
                    | NativeTaskCapabilityScopeCallbackPurpose::Provider
                    | NativeTaskCapabilityScopeCallbackPurpose::SourceBoundary
            ),
        )?;
        if let Some(tool) = tool.or_else(|| frame.and_then(NativeEngineEventFrame::tool)) {
            execution.emitter_source = self.actual_source_for(context, tool)?;
        }
        Ok(execution)
    }
    async fn sources(
        &self,
        context: &NativeIntegrationContext,
    ) -> Result<Vec<NativeMcpSourceFact>> {
        self.current_sources(context)
    }
    async fn selection_admission(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        operation: &str,
        selection: &IntegrationTaskCapabilityScopeSelection,
    ) -> Result<super::super::task_capability_scope_control::NativeTaskCapabilityScopeAdmission>
    {
        self.verify(context)?;
        let public = self
            .public_management
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_MANAGEMENT_UNAVAILABLE"))?
            .upgrade();
        let permit = public.context("TASK_CAPABILITY_SCOPE_NATIVE_MANAGEMENT_PROOF_REQUIRED")?;
        super::super::task_capability_scope_control::NativeTaskCapabilityScopeAdmission::from_public(
            context, accepted, operation, selection, &permit,
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
        self.verify(context)?;
        authorization.verify_native(context, accepted, operation, selection)?;
        ensure!(
            authorization.is_public_owner() && context.scope().organization_id.is_none(),
            "TASK_CAPABILITY_SCOPE_CURRENT_ORGANIZATION_POLICY_REQUIRED"
        );
        self.verify(context)
    }
    async fn authorize_resource_selection(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        operation: &str,
        bindings: &[IntegrationTaskResourceBinding],
    ) -> Result<()> {
        self.verify(context)?;
        let permit = self
            .public_management
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_RESOURCE_NATIVE_MANAGEMENT_REQUIRED"))?
            .upgrade()
            .context("TASK_RESOURCE_NATIVE_MANAGEMENT_REQUIRED")?;
        permit.verify_resource_intent(
            context.scope(),
            &accepted.task_key()?,
            operation,
            bindings,
        )?;
        self.check_current_resource_bindings(context, bindings)
            .await?;
        permit.verify_resource_intent(context.scope(), &accepted.task_key()?, operation, bindings)
    }
    async fn verify_resource_bindings(
        &self,
        context: &NativeIntegrationContext,
        bindings: &[IntegrationTaskResourceBinding],
    ) -> Result<()> {
        self.check_current_resource_bindings(context, bindings)
            .await
    }
    fn inherited_resource_tools(
        &self,
        context: &NativeIntegrationContext,
        bindings: &[IntegrationTaskResourceBinding],
        registered: &kcoder_tools::ToolRegistry,
    ) -> Result<Vec<Arc<dyn kcoder_tools::Tool>>> {
        self.inherited_reviewed_resource_tools(context, bindings, registered)
    }
    async fn authorize_resource_tool(
        &self,
        context: &NativeIntegrationContext,
        bindings: &[IntegrationTaskResourceBinding],
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<bool> {
        self.resource_tool(context, bindings, request).await
    }
    async fn authorize_resource_uri(
        &self,
        context: &NativeIntegrationContext,
        bindings: &[IntegrationTaskResourceBinding],
        selector: &super::super::NativeMcpSourceSelector,
        uri: &str,
    ) -> Result<bool> {
        self.resource_uri(context, bindings, selector, uri).await
    }
    async fn authorize_selection(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        operation: &str,
        selection: &IntegrationTaskCapabilityScopeSelection,
    ) -> Result<()> {
        if let Some(observer) = self
            .runtime_initial
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_MANAGEMENT_UNAVAILABLE"))?
            .upgrade()
        {
            ensure!(
                selection == &observer.initial_task_capability_scope_selection()?
                    && accepted.runtime_operation_id() == Some(observer.operation_id())
                    && operation
                        == observer
                            .initial_task_capability_scope_operation(accepted.initial_attempt())?,
                "TASK_CAPABILITY_SCOPE_RUNTIME_INITIAL_INTENT_REQUIRED"
            );
            observer.verify_accepted(context, &self.root, accepted.initial_attempt())?;
            return self.verify(context);
        }
        self.selection_admission(context, accepted, operation, selection)
            .await?;
        self.verify(context)
    }
    fn verify_safe_boundary(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        execution: &NativeTaskCapabilityScopeExecution,
    ) -> Result<()> {
        self.verify(context)?;
        ensure!(
            execution.task_key == accepted.task_key()?
                && execution.current_session_id == self.root.session_id()
                && execution.lineage.is_empty(),
            "TASK_CAPABILITY_SCOPE_NATIVE_ROOT_BOUNDARY_REQUIRED"
        );
        let boundary = self
            .boundary
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_BOUNDARY_UNAVAILABLE"))?
            .upgrade()
            .context("TASK_CAPABILITY_SCOPE_ACTUAL_NATIVE_BOUNDARY_REQUIRED")?;
        ensure!(
            boundary.root.matches_state(&self.root.state)
                && execution.boundary_id.as_deref() == Some(boundary.root.id()),
            "TASK_CAPABILITY_SCOPE_NATIVE_BOUNDARY_CHANGED"
        );
        // Child/App/resource gates are added with their actual native lineage;
        // unknown in-flight work cannot be assumed to share this root gate.
        if matches!(boundary.kind, SourceBoundaryKind::InitialAdmission) {
            ensure!(
                self.root.state.try_tool_emitter_activity_counts() == Some((0, 0)),
                "TASK_CAPABILITY_SCOPE_NATIVE_DESCENDANT_BOUNDARY_REQUIRED"
            );
        }
        Ok(())
    }
}

fn read_child_record(
    node: &NativeChildNode,
) -> Result<kcoder_state::turn_attempt_store::TurnAttemptRecord> {
    ensure!(
        node.lifecycle.matches(&node.state),
        "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_STATE_CHANGED"
    );
    let directory = PrivateDirectory::open_existing(&node.session)?;
    directory.verify_private_directory()?;
    let store = kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing(
        &node.session,
        &node.identity.thread_id,
    )?
    .context("TASK_CAPABILITY_SCOPE_ACTUAL_CHILD_ACCEPTED_REQUIRED")?;
    let record = store
        .load(&node.identity)?
        .context("TASK_CAPABILITY_SCOPE_ACTUAL_CHILD_ACCEPTED_REQUIRED")?;
    ensure!(
        record.input_context_hash == node.input_hash
            && record.request_fingerprint.as_deref() == Some(node.fingerprint.as_str()),
        "TASK_CAPABILITY_SCOPE_ACTUAL_CHILD_ACCEPTED_CHANGED"
    );
    Ok(record)
}

#[cfg(test)]
mod tests;
