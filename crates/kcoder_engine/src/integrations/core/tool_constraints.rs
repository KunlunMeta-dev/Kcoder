//! Native lifetime attenuation preserves the original installed source authority.
use super::*;
use crate::QueryEngine;
use std::sync::Arc;

/// An additional native lifetime check. It cannot create workflow facts, tool
/// permissions, an actor, a model budget or an original source authorization.
#[async_trait::async_trait]
pub trait NativeInvocationConstraint: Send + Sync {
    async fn verify(
        &self,
        execution: &NativeToolExecutionWitness,
    ) -> Result<(), NativeToolAuthorizationError>;
}

pub(super) struct ConstrainedAuthorization {
    pub(super) previous: Arc<dyn NativeToolAuthorization>,
    pub(super) constraint: Arc<dyn NativeInvocationConstraint>,
}
#[async_trait::async_trait]
impl NativeToolAuthorization for ConstrainedAuthorization {
    async fn workflow_parent_origin(
        &self,
        request: &NativeWorkflowParentRequest<'_>,
    ) -> Result<NativeWorkflowParentFacts, NativeToolAuthorizationError> {
        self.constraint.verify(request.parent_execution()).await?;
        self.previous.workflow_parent_origin(request).await
    }
    async fn authorize_child(
        &self,
        request: &NativeChildAdmissionRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.constraint.verify(request.parent_execution()).await?;
        self.previous.authorize_child(request).await
    }
    async fn observe_child_accepted(
        &self,
        request: &NativeChildAdmissionRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.constraint.verify(request.parent_execution()).await?;
        self.previous.observe_child_accepted(request).await
    }
    async fn authorize_provider(
        &self,
        execution: &NativeToolExecutionWitness,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.constraint.verify(execution).await?;
        self.previous.authorize_provider(execution).await
    }
    async fn authorize_event(
        &self,
        frame: &NativeEngineEventFrame,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.constraint.verify(frame.execution()).await?;
        self.previous.authorize_event(frame).await
    }
    async fn authorize(
        &self,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        let execution = request
            .execution
            .ok_or(NativeToolAuthorizationError::Unavailable)?;
        self.constraint.verify(execution).await?;
        self.previous.authorize(request).await
    }
}
impl QueryEngine {
    /// Preserve only the actual Workflow contribution for an already guarded
    /// native saved-code host. The source guard still owns provider/tool rights
    /// and the private pinned-definition launch; this adds no model permission.
    pub fn with_native_code_workflow_execution_constraint(
        self,
        workflow: Arc<dyn kcoder_tools::Tool>,
        constraint: Arc<dyn NativeInvocationConstraint>,
    ) -> anyhow::Result<Self> {
        let actual: &dyn std::any::Any = workflow.as_ref();
        anyhow::ensure!(
            actual.is::<kcoder_tools::workflow::WorkflowTool>(),
            "NATIVE_CODE_ACTUAL_WORKFLOW_REQUIRED"
        );
        let registry = kcoder_tools::ToolRegistry::new().register_arc(workflow.clone());
        let mut engine = self
            .with_native_invocation_constraint(constraint)?
            .with_turn_tools(registry)
            .with_native_tool_ceiling(&["Workflow".into()])?;
        anyhow::ensure!(
            engine
                .active_tool_registry()
                .get("Workflow")
                .is_some_and(|registered| Arc::ptr_eq(&registered, &workflow)),
            "NATIVE_CODE_WORKFLOW_CONTRIBUTION_UNAVAILABLE"
        );
        engine.hook_registry = engine.hook_registry.clone().disable();
        Ok(engine)
    }
    /// The fixed native code purpose cannot implicitly run user/project/plugin
    /// lifecycle commands. Its real source guard must already be installed.
    pub fn with_native_code_execution_constraint(
        self,
        constraint: Arc<dyn NativeInvocationConstraint>,
    ) -> anyhow::Result<Self> {
        let mut engine = self
            .with_native_tool_ceiling(&[])?
            .with_native_invocation_constraint(constraint)?;
        engine.hook_registry = engine.hook_registry.clone().disable();
        Ok(engine)
    }
    /// Attenuate only an already installed actual source guard. This cannot be
    /// used to turn an unguarded engine or serialized scope into authority.
    pub fn with_native_invocation_constraint(
        mut self,
        constraint: Arc<dyn NativeInvocationConstraint>,
    ) -> anyhow::Result<Self> {
        let previous = self
            .native_tool_authorization
            .take()
            .ok_or_else(|| anyhow::anyhow!("NATIVE_INVOCATION_ORIGINAL_AUTHORITY_REQUIRED"))?;
        if super::tool_authority::contains_invocation_constraint(&previous, &constraint) {
            self.native_tool_authorization = Some(previous);
            return Ok(self);
        }
        self.native_tool_authorization = Some(Arc::new(ConstrainedAuthorization {
            previous,
            constraint,
        }));
        Ok(self)
    }
}

#[cfg(test)]
mod tests;
