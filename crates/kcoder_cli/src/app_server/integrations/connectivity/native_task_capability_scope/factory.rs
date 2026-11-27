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
use kcoder_state::turn_attempt_store::TurnAttemptStore;
use kcoder_types::diagnostic_cause::{coded, coded_error};
use std::{
    ffi::OsStr,
    path::Path,
    sync::{Mutex, RwLock, Weak},
};

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
            .map_err(coded("TASK_CAPABILITY_SCOPE_REGISTRY_UNAVAILABLE"))?;
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
            .map_err(coded("TASK_CAPABILITY_SCOPE_REGISTRY_UNAVAILABLE"))?;
        let mut seen = std::collections::HashSet::new();
        let mut guards = Vec::new();
        for entry in entries.iter().filter(|entry| entry.tool.strong_count() > 0) {
            let handle = entry
                .connection
                .upgrade()
                .context("TASK_CAPABILITY_SCOPE_NATIVE_CONNECTION_ENDED")?;
            let key = Arc::as_ptr(&handle) as usize;
            if seen.insert(key) {
                guards.push(handle.try_lock_owned().map_err(coded_error(
                    "TASK_CAPABILITY_SCOPE_NATIVE_RESOURCE_BOUNDARY_BUSY",
                ))?);
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
            .map_err(coded("TASK_CAPABILITY_SCOPE_REGISTRY_UNAVAILABLE"))?;
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

struct RootAttemptChain {
    records: Vec<kcoder_state::turn_attempt_store::TurnAttemptRecord>,
    directory_identity: String,
    epoch: String,
}

#[derive(Clone, Copy)]
struct AttemptProfile<'a> {
    path: &'a Path,
    directory: &'a PrivateDirectory,
    lease_parent: Option<(&'a Path, &'a PrivateDirectory)>,
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
    /// Root-state task IDs of registered direct children whose own native
    /// gate this lease holds. Only these in-flight emitters are known.
    covered_descendants: std::collections::BTreeSet<String>,
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
    // Stream authorization reads can overlap. Registration and acquisition of
    // capability boundaries still exclude other access to the child lineage.
    children: RwLock<Vec<NativeChildNode>>,
    /// Earlier accepted bindings of this same root state. Their registered
    /// children keep running under their own original binding and gate.
    prior_owners: Mutex<Vec<Weak<NativeTaskCapabilityScopeFactory>>>,
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
        let registry = self.root.observable_mcp_tools();
        let before = registry.all();
        for tool in &before {
            NativeMcpSourceFact::from_registered_engine_tool(context, &self.root, tool)?;
        }
        let sources = self.current_sources(context)?;
        let inventory = catalog.inventory(context, &sources, &registry)?;
        // Foreground projections can rebuild builtin registries. Compare the
        // actual external registered objects, rather than a fresh projection tag.
        let after = self.root.observable_mcp_tools().all();
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
            children: RwLock::new(Vec::new()),
            prior_owners: Mutex::new(Vec::new()),
            resource_host: Mutex::new(Weak::new()),
            public_management: Mutex::new(Weak::new()),
        })
    }
    /// Record earlier live bindings for the same root state, so a new initial
    /// admission can hold (not adopt or stop) their still-accepted children's
    /// own gates instead of treating them as unknown in-flight emitters.
    pub(crate) fn retain_prior_descendant_owners<'a>(
        &self,
        prior: impl IntoIterator<Item = &'a Arc<NativeTaskCapabilityScopeFactory>>,
    ) -> Result<()> {
        let mut owners = self.prior_owners.lock().map_err(coded(
            "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_FACTS_UNAVAILABLE",
        ))?;
        for factory in prior {
            if !std::ptr::eq(Arc::as_ptr(factory), self)
                && factory.root.state.shares_state_with(&self.root.state)
            {
                owners.push(Arc::downgrade(factory));
            }
        }
        Ok(())
    }
    pub(crate) fn bind_resource_host(
        &self,
        host: &Arc<super::super::main_rpc::NativeConnectivityMainService>,
    ) -> Result<()> {
        self.verify(&self.context)?;
        let mut current = self
            .resource_host
            .lock()
            .map_err(coded("TASK_RESOURCE_MAIN_UNAVAILABLE"))?;
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
        *self
            .public_management
            .lock()
            .map_err(coded("TASK_CAPABILITY_SCOPE_NATIVE_MANAGEMENT_UNAVAILABLE"))? =
            Arc::downgrade(permit);
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
        *self
            .runtime_initial
            .lock()
            .map_err(coded("TASK_CAPABILITY_SCOPE_NATIVE_MANAGEMENT_UNAVAILABLE"))? =
            Arc::downgrade(observer);
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
            let nodes = self.children.write().map_err(coded(
                "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_FACTS_UNAVAILABLE",
            ))?;
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
                resources.push(handle.try_lock_owned().map_err(coded_error(
                    "TASK_CAPABILITY_SCOPE_NATIVE_RESOURCE_BOUNDARY_BUSY",
                ))?);
            }
        }
        let witness = Arc::new(NativeTaskCapabilityScopeBoundaryLease {
            kind: SourceBoundaryKind::Control,
            root,
            covered_descendants: Default::default(),
            _children: children,
            _resources: resources,
        });
        let mut slot = self
            .boundary
            .lock()
            .map_err(coded("TASK_CAPABILITY_SCOPE_NATIVE_BOUNDARY_UNAVAILABLE"))?;
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
        let mut covered_descendants = std::collections::BTreeSet::new();
        let mut hold_accepted = |nodes: &[NativeChildNode]| -> Result<()> {
            for node in nodes {
                if read_child_record(node)?.status == TurnAttemptStatus::Accepted {
                    children.push(node.gate.try_boundary(&node.state)?);
                    if node.parent_state.shares_state_with(&self.root.state) {
                        covered_descendants.insert(node.run.agent_id.clone());
                    }
                }
            }
            Ok(())
        };
        {
            let nodes = self.children.write().map_err(coded(
                "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_FACTS_UNAVAILABLE",
            ))?;
            hold_accepted(&nodes)?;
        }
        let prior = self
            .prior_owners
            .lock()
            .map_err(coded(
                "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_FACTS_UNAVAILABLE",
            ))?
            .iter()
            .filter_map(Weak::upgrade)
            .collect::<Vec<_>>();
        for owner in &prior {
            let nodes = owner.children.write().map_err(coded(
                "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_FACTS_UNAVAILABLE",
            ))?;
            hold_accepted(&nodes)?;
        }
        let resources = self.sources.claim_resource_gates()?;
        let witness = Arc::new(NativeTaskCapabilityScopeBoundaryLease {
            kind: SourceBoundaryKind::InitialAdmission,
            root,
            covered_descendants,
            _children: children,
            _resources: resources,
        });
        let mut slot = self
            .boundary
            .lock()
            .map_err(coded("TASK_CAPABILITY_SCOPE_NATIVE_BOUNDARY_UNAVAILABLE"))?;
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
    fn open_root_attempt_ledger(
        &self,
        thread_id: &str,
        profile: Option<AttemptProfile<'_>>,
    ) -> Result<(Arc<PrivateDirectory>, TurnAttemptStore)> {
        ensure!(
            thread_id == self.root.session_id(),
            "TASK_CAPABILITY_SCOPE_NATIVE_THREAD_REQUIRED"
        );
        let session = self.root.session_storage_dir_for(thread_id);
        let directory = open_attempt_directory(&session, thread_id, profile)?;
        let store = TurnAttemptStore::open_existing_in(directory.clone(), thread_id)?
            .context("TASK_CAPABILITY_SCOPE_NATIVE_ACCEPTED_REQUIRED")?;
        Ok((directory, store))
    }
    fn actual_accepted_turn(
        &self,
        context: &NativeIntegrationContext,
        identity: &TurnAttemptIdentity,
    ) -> Result<NativeTaskCapabilityScopeTurnWitness> {
        self.verify(context)?;
        let (directory, store) = self.open_root_attempt_ledger(&identity.thread_id, None)?;
        let record = store
            .load(identity)?
            .context("TASK_CAPABILITY_SCOPE_NATIVE_ACCEPTED_REQUIRED")?;
        // persistent_epoch already rechecks the live context and original owner.
        context.check_captured_scope(self.context.scope())?;
        let state_epoch = self.owner.persistent_epoch(context, &self.root)?;
        Ok(NativeTaskCapabilityScopeTurnWitness {
            scope: context.scope().clone(),
            session_directory_identity: directory.directory_identity()?,
            state_epoch,
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
        let execution =
            self.read_child_execution(context, accepted, witness, require_current_scope, None)?;
        self.verify(context)?;
        Ok(execution)
    }

    fn read_child_execution(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        witness: &NativeToolExecutionWitness,
        require_current_scope: bool,
        profile: Option<AttemptProfile<'_>>,
    ) -> Result<NativeTaskCapabilityScopeExecution> {
        let nodes = self.children.read().map_err(coded(
            "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_FACTS_UNAVAILABLE",
        ))?;
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
            if !path.is_empty() {
                // Read ancestors here and the leaf once after the root chain,
                // immediately before returning the current emitter attempt.
                read_known_child_record(cursor, profile)?;
            }
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
        let root = self.root_chain(context, accepted, &leaf.root_attempt, profile)?;
        let leaf_record = read_known_child_record(leaf, profile)?;
        let current_attempt = witness.attempt().map(|_| leaf_record);
        Ok(NativeTaskCapabilityScopeExecution {
            scope: context.scope().clone(),
            task_key: accepted.task_key()?,
            current_session_id: witness.session_id().into(),
            root_session_directory_identity: root.directory_identity,
            root_state_epoch: root.epoch,
            root_attempt_chain: root.records,
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
        profile: Option<AttemptProfile<'_>>,
    ) -> Result<RootAttemptChain> {
        let initial = accepted.initial_attempt();
        ensure!(
            tip.thread_id == initial.thread_id && tip.turn_id == initial.turn_id,
            "TASK_CAPABILITY_SCOPE_ACTUAL_ATTEMPT_CHAIN_REQUIRED"
        );
        let (directory, store) = self.open_root_attempt_ledger(&tip.thread_id, profile)?;
        let directory_identity = directory.directory_identity()?;
        let mut chain = Vec::new();
        let mut next = tip.clone();
        for _ in 0..64 {
            let record = store
                .load(&next)?
                .context("TASK_CAPABILITY_SCOPE_NATIVE_ACCEPTED_REQUIRED")?;
            let reached = record.identity == *initial;
            let parent = record.parent_attempt_id.clone();
            chain.push(record);
            if reached {
                if chain.len() > 1 {
                    // A continuation chain shares one ledger. At the end of
                    // the walk the current names must still resolve to it.
                    let session = self.root.session_storage_dir_for(&tip.thread_id);
                    let current = open_attempt_directory(&session, &tip.thread_id, profile)?;
                    ensure!(
                        current.directory_identity()? == directory_identity,
                        "TASK_CAPABILITY_SCOPE_NATIVE_ATTEMPT_DIRECTORY_CHANGED"
                    );
                    store.verify_binding()?;
                }
                context.check_captured_scope(self.context.scope())?;
                // Both callers bracket this ledger observation with live owner checks.
                let epoch = self.owner.observed_epoch(context)?;
                chain.reverse();
                return Ok(RootAttemptChain {
                    records: chain,
                    directory_identity,
                    epoch,
                });
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
        let nodes = self.children.read().map_err(coded(
            "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_FACTS_UNAVAILABLE",
        ))?;
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
        let origin = self.root_chain(
            context,
            accepted,
            witness.attempt().unwrap_or(accepted.initial_attempt()),
            None,
        )?;
        let current_attempt = witness
            .attempt()
            .and_then(|_| origin.records.last().cloned());
        self.verify(context)?;
        Ok(NativeTaskCapabilityScopeExecution {
            scope: context.scope().clone(),
            task_key: accepted.task_key()?,
            current_session_id: witness.session_id().into(),
            root_session_directory_identity: origin.directory_identity,
            root_state_epoch: origin.epoch.clone(),
            root_attempt_chain: origin.records,
            current_attempt,
            lineage: Vec::new(),
            native_emitter_id: origin.epoch,
            emitter_source: None,
            boundary_id: self
                .boundary
                .lock()
                .map_err(coded("TASK_CAPABILITY_SCOPE_NATIVE_BOUNDARY_UNAVAILABLE"))?
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
            let nodes = self.children.read().map_err(coded(
                "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_FACTS_UNAVAILABLE",
            ))?;
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
        let mut nodes = self.children.write().map_err(coded(
            "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_FACTS_UNAVAILABLE",
        ))?;
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

    async fn observe_child_output(
        &self,
        context: &NativeIntegrationContext,
        binding: &NativeTaskCapabilityScopeBinding,
        frame: &NativeEngineEventFrame,
    ) -> Result<(
        NativeTaskCapabilityScopeExecution,
        IntegrationTaskCapabilityScopeSnapshot,
    )> {
        let witness = frame.execution();
        ensure!(
            is_child_model_stream_frame(frame),
            "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_OUTPUT_REQUIRED"
        );
        context.check_captured_scope(self.context.scope())?;
        crate::app_server::task_spawn::blocking(|| {
            use std::time::Instant;

            let mut started = tracing::enabled!(
                target: "kcoder_child_output_read",
                tracing::Level::TRACE
            )
            .then(Instant::now);
            let mut lap = || {
                started.as_mut().map_or(0, |previous| {
                    let now = Instant::now();
                    let elapsed = now.duration_since(*previous).as_micros() as u64;
                    *previous = now;
                    elapsed
                })
            };
            let (
                result,
                [
                    scope_open_us,
                    owner_open_us,
                    records_us,
                    policy_us,
                    owner_close_us,
                ],
            ) = context.observe_live_profile(|profile| {
                let scope_open_us = lap();
                let (lease_path, lease_parent) = self.owner.verify_parent(&self.root)?;
                let owner_open_us = lap();
                let execution = self.read_child_execution(
                    context,
                    binding.accepted(),
                    witness,
                    false,
                    Some(AttemptProfile {
                        path: context.captured_profile_path(),
                        directory: profile,
                        lease_parent: Some((lease_path, &lease_parent)),
                    }),
                )?;
                let records_us = lap();
                let snapshot = binding.snapshot_for_child_output_in_profile(
                    context,
                    witness.session_id(),
                    &execution,
                    profile,
                )?;
                let policy_us = lap();
                self.owner.verify(&self.root)?;
                Ok((
                    (execution, snapshot),
                    [scope_open_us, owner_open_us, records_us, policy_us, lap()],
                ))
            })?;
            tracing::trace!(
                target: "kcoder_child_output_read",
                scope_open_us,
                owner_open_us,
                records_us,
                policy_us,
                owner_close_us,
                scope_close_us = lap(),
                output_fragments = frame.model_output_fragment_count(),
                "child_output_read"
            );
            Ok(result)
        })
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
            .map_err(coded("TASK_CAPABILITY_SCOPE_NATIVE_MANAGEMENT_UNAVAILABLE"))?
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
            .map_err(coded("TASK_RESOURCE_NATIVE_MANAGEMENT_REQUIRED"))?
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
            .map_err(coded("TASK_CAPABILITY_SCOPE_NATIVE_MANAGEMENT_UNAVAILABLE"))?
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
            .map_err(coded("TASK_CAPABILITY_SCOPE_NATIVE_BOUNDARY_UNAVAILABLE"))?
            .upgrade()
            .context("TASK_CAPABILITY_SCOPE_ACTUAL_NATIVE_BOUNDARY_REQUIRED")?;
        ensure!(
            boundary.root.matches_state(&self.root.state)
                && execution.boundary_id.as_deref() == Some(boundary.root.id()),
            "TASK_CAPABILITY_SCOPE_NATIVE_BOUNDARY_CHANGED"
        );
        // Child/App/resource gates are added with their actual native lineage;
        // unknown in-flight work cannot be assumed to share this root gate.
        // A registered child of this or an earlier binding is known: this
        // lease holds its own gate, and it keeps its original binding.
        if matches!(boundary.kind, SourceBoundaryKind::InitialAdmission) {
            ensure!(
                self.root
                    .state
                    .try_tool_emitter_activity_ids()
                    .is_some_and(|ids| ids
                        .iter()
                        .all(|id| boundary.covered_descendants.contains(id))),
                "TASK_CAPABILITY_SCOPE_NATIVE_DESCENDANT_BOUNDARY_REQUIRED"
            );
        }
        Ok(())
    }
}

fn read_known_child_record(
    node: &NativeChildNode,
    profile: Option<AttemptProfile<'_>>,
) -> Result<kcoder_state::turn_attempt_store::TurnAttemptRecord> {
    let record = read_child_record_in_profile(node, profile)?;
    ensure!(
        record.status.is_known(),
        "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_ATTEMPT_UNKNOWN"
    );
    Ok(record)
}

fn open_attempt_directory(
    session: &Path,
    thread_id: &str,
    profile: Option<AttemptProfile<'_>>,
) -> Result<Arc<PrivateDirectory>> {
    ensure!(
        session.file_name() == Some(OsStr::new(thread_id)),
        "attempt storage thread mismatch"
    );
    if let Some(profile) = profile {
        let anchors = profile
            .lease_parent
            .into_iter()
            .chain(std::iter::once((profile.path, profile.directory)));
        for (path, anchor) in anchors {
            let Ok(relative) = session.strip_prefix(path) else {
                continue;
            };
            if relative.as_os_str().is_empty() {
                return Ok(Arc::new(anchor.duplicate_handle()?));
            }
            let mut directory = None;
            for component in relative.components() {
                let std::path::Component::Normal(name) = component else {
                    anyhow::bail!("invalid attempt storage directory component");
                };
                let parent = directory.as_ref().unwrap_or(anchor);
                directory = Some(parent.open_child(name, false)?);
            }
            return Ok(Arc::new(
                directory.context("missing attempt storage directory")?,
            ));
        }
    }
    Ok(Arc::new(PrivateDirectory::open_existing(session)?))
}

fn read_child_record(
    node: &NativeChildNode,
) -> Result<kcoder_state::turn_attempt_store::TurnAttemptRecord> {
    read_child_record_in_profile(node, None)
}

fn read_child_record_in_profile(
    node: &NativeChildNode,
    profile: Option<AttemptProfile<'_>>,
) -> Result<kcoder_state::turn_attempt_store::TurnAttemptRecord> {
    ensure!(
        node.lifecycle.matches(&node.state),
        "TASK_CAPABILITY_SCOPE_NATIVE_CHILD_STATE_CHANGED"
    );
    let directory = open_attempt_directory(&node.session, &node.identity.thread_id, profile)?;
    let store = kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing_in(
        directory,
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
