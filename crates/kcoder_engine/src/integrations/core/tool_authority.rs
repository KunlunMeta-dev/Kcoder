//! A host-supplied tool ceiling applies after every registry composition path.
use super::{
    NativeToolAuthorization, NativeToolAuthorizationError, NativeToolAuthorizationPhase,
    NativeToolAuthorizationRequest,
};
use crate::QueryEngine;
use anyhow::{Result, ensure};
use kcoder_tools::ToolRegistry;
use std::{
    collections::HashSet,
    sync::{Arc, RwLock},
};

struct IntersectedAuthorization {
    previous: Arc<dyn NativeToolAuthorization>,
    next: Arc<dyn NativeToolAuthorization>,
}

pub(super) fn contains_invocation_constraint(
    current: &Arc<dyn NativeToolAuthorization>,
    candidate: &Arc<dyn super::NativeInvocationConstraint>,
) -> bool {
    let actual: &dyn std::any::Any = current.as_ref();
    if let Some(chain) = actual.downcast_ref::<super::tool_constraints::ConstrainedAuthorization>()
    {
        return Arc::ptr_eq(&chain.constraint, candidate)
            || contains_invocation_constraint(&chain.previous, candidate);
    }
    actual
        .downcast_ref::<IntersectedAuthorization>()
        .is_some_and(|chain| {
            contains_invocation_constraint(&chain.previous, candidate)
                || contains_invocation_constraint(&chain.next, candidate)
        })
}
// Only Core's private intersection structure can expose installed children.
// An authorizer cannot claim another authorizer's identity through a hook.
fn contains_authorization(
    current: &Arc<dyn NativeToolAuthorization>,
    candidate: &Arc<dyn NativeToolAuthorization>,
) -> bool {
    if Arc::ptr_eq(current, candidate) {
        return true;
    }
    let actual: &dyn std::any::Any = current.as_ref();
    if let Some(chain) = actual.downcast_ref::<super::tool_constraints::ConstrainedAuthorization>()
    {
        return contains_authorization(&chain.previous, candidate);
    }
    actual
        .downcast_ref::<IntersectedAuthorization>()
        .is_some_and(|chain| {
            contains_authorization(&chain.previous, candidate)
                || contains_authorization(&chain.next, candidate)
        })
}

#[async_trait::async_trait]
impl NativeToolAuthorization for IntersectedAuthorization {
    fn inherited_resource_tools(
        &self,
        registered: &ToolRegistry,
    ) -> Result<Option<Vec<Arc<dyn kcoder_tools::Tool>>>, NativeToolAuthorizationError> {
        let previous = self.previous.inherited_resource_tools(registered)?;
        let next = self.next.inherited_resource_tools(registered)?;
        Ok(match (previous, next) {
            (Some(mut previous), Some(next)) => {
                previous.retain(|tool| next.iter().any(|candidate| Arc::ptr_eq(tool, candidate)));
                Some(previous)
            }
            (Some(tools), None) | (None, Some(tools)) => Some(tools),
            (None, None) => None,
        })
    }

    async fn workflow_parent_origin(
        &self,
        request: &super::NativeWorkflowParentRequest<'_>,
    ) -> Result<super::NativeWorkflowParentFacts, NativeToolAuthorizationError> {
        let previous = self.previous.workflow_parent_origin(request).await?;
        let next = self.next.workflow_parent_origin(request).await?;
        if previous != next {
            return Err(NativeToolAuthorizationError::Denied);
        }
        Ok(previous)
    }
    async fn authorize_child(
        &self,
        request: &super::NativeChildAdmissionRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.previous.authorize_child(request).await?;
        self.next.authorize_child(request).await
    }
    async fn observe_child_accepted(
        &self,
        request: &super::NativeChildAdmissionRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.previous.observe_child_accepted(request).await?;
        self.next.observe_child_accepted(request).await
    }
    async fn authorize_provider(
        &self,
        execution: &super::NativeToolExecutionWitness,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.previous.authorize_provider(execution).await?;
        self.next.authorize_provider(execution).await
    }
    async fn authorize_event(
        &self,
        frame: &super::NativeEngineEventFrame,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.previous.authorize_event(frame).await?;
        self.next.authorize_event(frame).await
    }
    async fn authorize_app_callback(
        &self,
        emitter: &super::NativeToolEmitterWitness,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.previous.authorize_app_callback(emitter).await?;
        self.next.authorize_app_callback(emitter).await
    }
    async fn authorize_resource(
        &self,
        request: &super::NativeResourceAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.previous.authorize_resource(request).await?;
        self.next.authorize_resource(request).await
    }
    async fn authorize(
        &self,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.previous.authorize(request).await?;
        self.next.authorize(request).await
    }
}

impl QueryEngine {
    /// Object-identity observation only; it grants no tool or source authority.
    pub fn has_native_tool_authorization(
        &self,
        expected: &Arc<dyn NativeToolAuthorization>,
    ) -> bool {
        self.native_tool_authorization
            .as_ref()
            .is_some_and(|current| contains_authorization(current, expected))
    }

    /// A same-context resident replacement cannot silently drop a prior guard.
    pub fn retains_native_tool_authorization_from(&self, previous: &Self) -> bool {
        previous
            .native_tool_authorization
            .as_ref()
            .is_none_or(|original| self.has_native_tool_authorization(original))
    }

    pub(crate) async fn authorize_native_tool(
        &self,
        registry: &ToolRegistry,
        tool: &Arc<dyn kcoder_tools::Tool>,
        name: &str,
        input: &serde_json::Value,
        without_sandbox: bool,
        phase: NativeToolAuthorizationPhase,
    ) -> Result<(), NativeToolAuthorizationError> {
        if ToolRegistry::name_is_disabled(
            name,
            &crate::recover_read_lock(&self.settings, "settings")
                .tools
                .disabled,
        ) {
            return Err(NativeToolAuthorizationError::Denied);
        }
        let emitter = self.capture_native_tool_emitter(registry, name, tool)?;
        if self
            .native_tool_ceiling
            .as_ref()
            .is_some_and(|ceiling| !ceiling.contains(name))
        {
            return Err(NativeToolAuthorizationError::Denied);
        }
        if self
            .agent_tool_ceiling
            .as_ref()
            .is_some_and(|ceiling| !ceiling.contains(name))
        {
            return Err(NativeToolAuthorizationError::Denied);
        }
        let Some(authority) = &self.native_tool_authorization else {
            return Ok(());
        };
        let session_id = self.state.session_id();
        let request = NativeToolAuthorizationRequest {
            execution: Some(emitter.execution()),
            emitter: Some(&emitter),
            session_id: &session_id,
            tool_name: name,
            source: emitter.source().clone(),
            input,
            read_only: tool.is_read_only(),
            without_sandbox,
            phase,
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            authority.authorize(&request),
        )
        .await
        .unwrap_or(Err(NativeToolAuthorizationError::Unavailable));
        result?;
        if !emitter.matches_registry(registry) || !emitter.execution().matches_current_engine(self)
        {
            return Err(NativeToolAuthorizationError::Denied);
        }
        Ok(())
    }

    /// Compose current authorities restrictively. A task cannot drop an earlier guard.
    pub fn with_native_tool_authorization(
        mut self,
        authorization: Arc<dyn NativeToolAuthorization>,
    ) -> Self {
        self.native_tool_authorization = Some(match self.native_tool_authorization.take() {
            Some(previous) if contains_authorization(&previous, &authorization) => previous,
            Some(previous) => Arc::new(IntersectedAuthorization {
                previous,
                next: authorization,
            }),
            None => authorization,
        });
        self
    }

    /// Install a literal native allowlist on this engine value. Empty means no tools.
    /// Later settings, discovery, role changes and registry replacement can only narrow it.
    /// Calling this again intersects the old ceiling, never widens a running task.
    pub fn with_native_tool_ceiling(mut self, allowed: &[String]) -> Result<Self> {
        ensure!(
            allowed.len() <= 4096
                && allowed.iter().all(|name| !name.is_empty()
                    && name.chars().count() <= 256
                    && !name.chars().any(char::is_control)
                    && !name.contains('*')),
            "invalid native tool ceiling"
        );
        let mut ceiling = allowed.iter().cloned().collect::<HashSet<_>>();
        if let Some(previous) = &self.native_tool_ceiling {
            ceiling.retain(|name| previous.contains(name));
        }
        self.native_tool_ceiling = Some(Arc::new(ceiling));
        // Native configuration owns its snapshot; do not shrink a peer clone's worker registry.
        self.subagent_tools = Arc::new(RwLock::new(
            self.restrict_to_native_authority(self.subagent_tools()),
        ));
        let tools = self.tools.clone();
        Ok(self.with_turn_tools(tools))
    }

    pub(crate) fn with_inherited_native_tool_ceiling(mut self, parent: &Self) -> Self {
        if parent.unattended_input {
            self = self.with_unattended_input();
        }
        // Child execution retains the parent's actual per-turn expert restriction.
        let parent_ceiling = match (&parent.native_tool_ceiling, &parent.agent_tool_ceiling) {
            (Some(native), Some(expert)) => Some(Arc::new(
                native.intersection(expert).cloned().collect::<HashSet<_>>(),
            )),
            (Some(ceiling), None) | (None, Some(ceiling)) => Some(ceiling.clone()),
            (None, None) => None,
        };
        if let Some(factory) = &parent.native_wiki_read_factory {
            self.native_wiki_read_factory = Some(factory.clone());
        }
        if let Some(authorization) = &parent.native_tool_authorization {
            self = self.with_native_tool_authorization(authorization.clone());
        }
        let Some(parent_ceiling) = &parent_ceiling else {
            return self;
        };
        let ceiling = match &self.native_tool_ceiling {
            Some(current) => Arc::new(current.intersection(parent_ceiling).cloned().collect()),
            None => parent_ceiling.clone(),
        };
        self.native_tool_ceiling = Some(ceiling);
        self.subagent_tools = Arc::new(RwLock::new(
            self.restrict_to_native_authority(self.subagent_tools()),
        ));
        let tools = self.tools.clone();
        self.with_turn_tools(tools)
    }

    pub(crate) fn restrict_to_native_tool_ceiling(&self, registry: ToolRegistry) -> ToolRegistry {
        let registry = match &self.agent_tool_ceiling {
            Some(allowed) => {
                registry.filtered_to_names(&allowed.iter().cloned().collect::<Vec<_>>())
            }
            None => registry,
        };
        self.restrict_to_native_authority(registry)
    }

    /// Preserve the permitted baseline when rebuilding caches for a future turn.
    pub(crate) fn restrict_to_native_authority(&self, registry: ToolRegistry) -> ToolRegistry {
        match &self.native_tool_ceiling {
            Some(allowed) => {
                registry.filtered_to_names(&allowed.iter().cloned().collect::<Vec<_>>())
            }
            None => registry,
        }
    }
}

#[cfg(test)]
mod tests;
