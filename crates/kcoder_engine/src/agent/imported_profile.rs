//! Restored children retain the original native mapping even if the parent changes model.
use super::*;
use kcoder_types::migration_agent::ImportedAgentModel;

pub(super) fn restore(
    task: &kcoder_state::Task,
    options: &mut AgentRunOptions,
    settings: &Settings,
) -> Result<(), AgentError> {
    let Some(execution) = task
        .plugin_prompt_policy
        .as_ref()
        .and_then(|policy| policy.imported_agent.as_ref())
    else {
        return Ok(());
    };
    if !execution.is_supported() || options.persona_name.is_some() {
        return Err(AgentError::Execution(
            "Invalid imported Agent execution policy".into(),
        ));
    }
    let allowed = task
        .plugin_prompt_policy
        .as_ref()
        .unwrap()
        .allowed_tools
        .as_ref()
        .ok_or_else(|| AgentError::Execution("Imported Agent native tool policy missing".into()))?;
    if options
        .tool_allowlist
        .as_ref()
        .is_some_and(|requested| requested.iter().any(|tool| !allowed.contains(tool)))
    {
        return Err(AgentError::Execution(
            "Cannot broaden an imported Agent's persisted tool restrictions".into(),
        ));
    }
    if options.tool_allowlist.is_none() {
        options.tool_allowlist = Some(allowed.clone());
    }
    let original = match &execution.model {
        ImportedAgentModel::Inherit => None,
        ImportedAgentModel::Target { provider, model } => {
            let revision = settings
                .providers
                .get(provider)
                .filter(|config| config.has_model(model))
                .and_then(|config| config.runtime_configuration_revision().ok());
            if revision.is_none()
                || revision
                    != task
                        .plugin_prompt_policy
                        .as_ref()
                        .unwrap()
                        .native_model_revision
            {
                return Err(AgentError::Execution(
                    "Imported Agent native deployment changed; review and spawn a fresh Agent"
                        .into(),
                ));
            }
            Some(kcoder_tools::AgentRuntimeSelection {
                profile: None,
                provider: Some(provider.clone()),
                model: Some(model.clone()),
            })
        }
    };
    if options
        .runtime_selection
        .as_ref()
        .is_some_and(|selection| Some(selection) != original.as_ref())
    {
        return Err(AgentError::Execution(
            "Cannot change an imported Agent's persisted native model mapping".into(),
        ));
    }
    options.runtime_selection = original;
    Ok(())
}

#[cfg(test)]
#[path = "imported_profile_tests.rs"]
mod tests;
