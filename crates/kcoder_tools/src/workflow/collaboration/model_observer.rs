//! Model intent is checked against actual resolved host facts before any provider call.
use crate::{AgentConfigurationObserver, AgentKind, AgentRuntimeSelection};
use kcoder_types::{ModelConfigurationSummary, workflow::WorkflowAgentModelSelection};
use std::sync::Arc;

#[derive(Debug)]
pub(in crate::workflow) struct RoleModelObserver {
    requested: WorkflowAgentModelSelection,
    parent: ModelConfigurationSummary,
    verifier: bool,
    inner: Option<Arc<dyn AgentConfigurationObserver>>,
}
impl RoleModelObserver {
    pub(in crate::workflow) fn for_role(
        requested: WorkflowAgentModelSelection,
        parent: Option<ModelConfigurationSummary>,
        kind: AgentKind,
        inner: Option<Arc<dyn AgentConfigurationObserver>>,
    ) -> Result<Arc<dyn AgentConfigurationObserver>, String> {
        let parent =
            parent.ok_or("workflow_model: actual pinned host configuration is unavailable")?;
        Ok(Arc::new(Self {
            requested,
            parent,
            verifier: kind == AgentKind::Verifier,
            inner,
        }))
    }
}
impl AgentConfigurationObserver for RoleModelObserver {
    fn capture(
        &self,
        configuration: ModelConfigurationSummary,
        source: &'static str,
    ) -> Result<(), String> {
        if self.verifier
            && (configuration.revision != self.parent.revision
                || configuration.model_id != self.parent.model_id
                || configuration.provider_id != self.parent.provider_id)
        {
            return Err("workflow_model: verifier must retain the actual pinned host model".into());
        }
        match &self.requested {
            WorkflowAgentModelSelection::InheritCurrent => {
                if configuration.revision != self.parent.revision
                    || configuration.model_id != self.parent.model_id
                    || configuration.provider_id != self.parent.provider_id
                {
                    return Err("workflow_model: inherited model changed before execution".into());
                }
            }
            WorkflowAgentModelSelection::Explicit {
                profile,
                provider,
                model,
                expected_revision,
            } => {
                if configuration.model_id != *model
                    || configuration.provider_id.as_ref() != profile.as_ref().or(provider.as_ref())
                    || expected_revision
                        .as_ref()
                        .is_some_and(|revision| configuration.revision != *revision)
                {
                    return Err(
                        "workflow_model: actual model does not match the explicit role selection"
                            .into(),
                    );
                }
            }
        }
        if let Some(inner) = &self.inner {
            inner.capture(configuration, source)?;
        }
        Ok(())
    }
}
pub(in crate::workflow) fn runtime(
    selection: &WorkflowAgentModelSelection,
) -> Option<AgentRuntimeSelection> {
    match selection {
        WorkflowAgentModelSelection::InheritCurrent => None,
        WorkflowAgentModelSelection::Explicit {
            profile,
            provider,
            model,
            ..
        } => Some(AgentRuntimeSelection {
            profile: profile.clone(),
            provider: provider.clone(),
            model: Some(model.clone()),
        }),
    }
}
