//! Native invocation identity captured by the actual Engine, never by request JSON.
use crate::QueryEngine;
use kcoder_state::{AppState, AppStateLifecycleIdentity};
use kcoder_tools::{Tool, ToolRegistry, ToolRegistryRevision, ToolSource};
use kcoder_types::{BackgroundRunKey, TurnAttemptIdentity};
use std::sync::Arc;

/// The actual registered object and its native execution frame. No JSON or
/// independent identity constructor exists; a label/source string is not this proof.
pub struct NativeToolEmitterWitness {
    execution: Arc<NativeToolExecutionWitness>,
    tool: Arc<dyn Tool>,
    registered_name: String,
    registered_source: ToolSource,
    registry_revision: ToolRegistryRevision,
    desktop_binding: crate::desktop_binding::DesktopBindings,
}
impl NativeToolEmitterWitness {
    /// Verify the current host binding, including revocation after capture.
    /// This proves no MCP source identity and never grants a desktop lease.
    pub fn authorizes_desktop_owner(
        &self,
        owner: &kcoder_types::computer_use::DesktopOwner,
    ) -> bool {
        self.execution.session_id() == owner.thread_id
            && self.execution.attempt().is_some_and(|attempt| {
                attempt.thread_id == owner.thread_id && attempt.turn_id == owner.turn_id
            })
            && self.desktop_binding.authorizes(owner)
    }
    pub fn execution(&self) -> &NativeToolExecutionWitness {
        &self.execution
    }
    pub fn tool_name(&self) -> &str {
        &self.registered_name
    }
    pub fn source(&self) -> &ToolSource {
        &self.registered_source
    }
    pub fn registry_revision(&self) -> &ToolRegistryRevision {
        &self.registry_revision
    }
    pub fn matches_tool(&self, tool: &Arc<dyn Tool>) -> bool {
        Arc::ptr_eq(&self.tool, tool)
    }
    pub fn tool(&self) -> &Arc<dyn Tool> {
        &self.tool
    }
    pub fn downcast_tool<T: Tool>(&self) -> Option<&T> {
        let tool: &dyn std::any::Any = self.tool.as_ref();
        tool.downcast_ref::<T>()
    }
    pub fn matches_registry(&self, registry: &ToolRegistry) -> bool {
        registry.revision() == self.registry_revision
            && registry
                .get(&self.registered_name)
                .is_some_and(|tool| self.matches_tool(&tool))
            && registry.source(&self.registered_name) == Some(&self.registered_source)
            && self.tool.name() == self.registered_name
            && self.tool.source() == self.registered_source
    }
}

pub struct NativeToolExecutionWitness {
    state: AppStateLifecycleIdentity,
    session_id: String,
    attempt: Option<TurnAttemptIdentity>,
    parent: Option<NativeToolParentWitness>,
}

pub struct NativeToolParentWitness {
    state: AppStateLifecycleIdentity,
    session_id: String,
    agent_id: String,
    background_run: Option<BackgroundRunKey>,
}

impl NativeToolExecutionWitness {
    pub fn matches_state(&self, state: &AppState) -> bool {
        self.state.matches(state)
    }
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
    pub fn attempt(&self) -> Option<&TurnAttemptIdentity> {
        self.attempt.as_ref()
    }
    pub fn parent(&self) -> Option<&NativeToolParentWitness> {
        self.parent.as_ref()
    }
    pub(crate) fn matches_engine_owner(&self, engine: &QueryEngine) -> bool {
        self.matches_state(&engine.state)
            && match (
                self.parent.as_ref(),
                engine.subagent_runtime_control.as_ref().as_ref(),
            ) {
                (None, None) => true,
                (Some(witness), Some(parent)) => {
                    witness.matches_state(&parent.parent_state)
                        && witness.agent_id == parent.agent_id
                        && witness.background_run == parent.expected_background_run
                }
                _ => false,
            }
    }
    pub(crate) fn matches_current_engine(&self, engine: &QueryEngine) -> bool {
        self.matches_engine_owner(engine)
            && engine
                .state
                .matches_current_history_attempt(self.attempt.as_ref())
    }
}
impl NativeToolParentWitness {
    pub fn matches_state(&self, state: &AppState) -> bool {
        self.state.matches(state)
    }
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }
    pub fn background_run(&self) -> Option<&BackgroundRunKey> {
        self.background_run.as_ref()
    }
}

impl QueryEngine {
    /// Capture only an object exposed by this actual Engine's current registry.
    /// Tool calls capture their already-frozen request registry through the private path below.
    pub fn native_tool_emitter_witness(&self, name: &str) -> Option<NativeToolEmitterWitness> {
        let registry = self.active_tool_registry();
        let tool = registry.get(name)?;
        self.capture_native_tool_emitter(&registry, name, &tool)
            .ok()
    }
    pub(crate) fn capture_native_tool_emitter(
        &self,
        registry: &ToolRegistry,
        name: &str,
        tool: &Arc<dyn Tool>,
    ) -> Result<NativeToolEmitterWitness, super::NativeToolAuthorizationError> {
        self.capture_native_tool_emitter_in_frame(
            registry,
            name,
            tool,
            Arc::new(self.native_tool_execution_witness()),
        )
    }
    pub(crate) fn capture_native_tool_emitter_in_frame(
        &self,
        registry: &ToolRegistry,
        name: &str,
        tool: &Arc<dyn Tool>,
        execution: Arc<NativeToolExecutionWitness>,
    ) -> Result<NativeToolEmitterWitness, super::NativeToolAuthorizationError> {
        if !execution.matches_current_engine(self) {
            return Err(super::NativeToolAuthorizationError::Denied);
        }
        let source = registry
            .source(name)
            .cloned()
            .ok_or(super::NativeToolAuthorizationError::Unavailable)?;
        let witness = NativeToolEmitterWitness {
            execution,
            tool: tool.clone(),
            registered_name: name.into(),
            registered_source: source,
            registry_revision: registry.revision(),
            desktop_binding: self.desktop_binding.clone(),
        };
        if witness.matches_registry(registry) {
            Ok(witness)
        } else {
            Err(super::NativeToolAuthorizationError::Denied)
        }
    }
    /// Capture this emitter's native identity. A witness is evidence, never a grant;
    /// the native authority still verifies the actual Accepted record and full lineage.
    pub fn native_tool_execution_witness(&self) -> NativeToolExecutionWitness {
        NativeToolExecutionWitness {
            state: self.state.inspection_lifecycle_identity(),
            session_id: self.state.session_id(),
            attempt: self.state.current_history_attempt_identity(),
            parent: self
                .subagent_runtime_control
                .as_ref()
                .as_ref()
                .map(|parent| NativeToolParentWitness {
                    state: parent.parent_state.inspection_lifecycle_identity(),
                    session_id: parent.parent_state.session_id(),
                    agent_id: parent.agent_id.clone(),
                    background_run: parent.expected_background_run.clone(),
                }),
        }
    }
}

/// Read-only access to an actual Engine gate. It does not extend Engine lifetime
/// and cannot authorize a source change on its own.
pub struct NativeToolGateHandle {
    state: AppStateLifecycleIdentity,
    gate: std::sync::Weak<tokio::sync::RwLock<()>>,
}
/// A real exclusive tool gate remains held for this witness's entire lifetime.
/// No serialized boundary label or caller boolean can manufacture it.
pub struct NativeToolBoundaryWitness {
    state: AppStateLifecycleIdentity,
    _guard: tokio::sync::OwnedRwLockWriteGuard<()>,
    id: String,
}
impl NativeToolGateHandle {
    pub fn try_boundary(
        &self,
        state: &AppState,
    ) -> Result<NativeToolBoundaryWitness, super::NativeToolAuthorizationError> {
        if !self.state.matches(state) {
            return Err(super::NativeToolAuthorizationError::Denied);
        }
        let gate = self
            .gate
            .upgrade()
            .ok_or(super::NativeToolAuthorizationError::Unavailable)?;
        let guard = gate
            .try_write_owned()
            .map_err(|_| super::NativeToolAuthorizationError::Unavailable)?;
        if !self.state.matches(state) {
            return Err(super::NativeToolAuthorizationError::Denied);
        }
        Ok(NativeToolBoundaryWitness {
            state: self.state.clone(),
            _guard: guard,
            id: uuid::Uuid::new_v4().to_string(),
        })
    }
}
impl NativeToolBoundaryWitness {
    pub fn matches_state(&self, state: &AppState) -> bool {
        self.state.matches(state)
    }
    pub fn id(&self) -> &str {
        &self.id
    }
}
impl QueryEngine {
    pub fn native_tool_gate_handle(&self) -> NativeToolGateHandle {
        NativeToolGateHandle {
            state: self.state.inspection_lifecycle_identity(),
            gate: Arc::downgrade(&self.tool_execution_gate),
        }
    }
}
