//! Native target model selection never resolves source aliases or changes approvals.
use crate::{AgentRuntimeSelection, ToolContext, ToolError};
use kcoder_types::{
    migration_agent::{ImportedAgentExecution, ImportedAgentModel},
    plugin_prompt::PluginPromptProfile,
};

pub(crate) fn runtime(
    execution: &ImportedAgentExecution,
) -> Result<Option<AgentRuntimeSelection>, ToolError> {
    if !execution.is_supported() {
        return Err(ToolError::InvalidInput(
            "Unsupported imported Agent execution metadata".into(),
        ));
    }
    Ok(match &execution.model {
        ImportedAgentModel::Inherit => None,
        ImportedAgentModel::Target { provider, model } => Some(AgentRuntimeSelection {
            profile: None,
            provider: Some(provider.clone()),
            model: Some(model.clone()),
        }),
    })
}

pub(crate) fn validate_profile(
    profile: &PluginPromptProfile,
    ctx: &ToolContext,
) -> Result<Option<String>, ToolError> {
    let Some(execution) = &profile.imported_agent else {
        return Ok(None);
    };
    let selection = runtime(execution)?;
    let tools = profile.allowed_tools.as_ref().ok_or_else(|| {
        ToolError::InvalidInput("Imported Agent requires an explicit native tool set".into())
    })?;
    let distinct = tools.iter().collect::<std::collections::BTreeSet<_>>();
    if profile.kind != "agent"
        || !profile.argument_names.is_empty()
        || tools.len() > 64
        || distinct.len() != tools.len()
        || tools
            .iter()
            .any(|tool| !kcoder_types::migration_agent::is_imported_agent_tool(tool))
    {
        return Err(ToolError::InvalidInput(
            "Invalid imported Agent tool policy".into(),
        ));
    }
    if let Some(selection) = selection {
        let settings = ctx
            .runtime_settings
            .as_ref()
            .ok_or_else(|| ToolError::Execution("Native model configuration unavailable".into()))?
            .read()
            .map_err(|_| ToolError::Execution("Native model configuration unavailable".into()))?;
        let configured = settings
            .providers
            .get(selection.provider.as_ref().unwrap())
            .filter(|provider| provider.has_model(selection.model.as_ref().unwrap()));
        let Some(configured) = configured else {
            return Err(ToolError::InvalidInput(
                "Imported Agent target provider/model is not configured; review its native mapping"
                    .into(),
            ));
        };
        return configured
            .runtime_configuration_revision()
            .map(Some)
            .map_err(|_| ToolError::Execution("Native model configuration unavailable".into()));
    }
    Ok(None)
}
