//! Ordinary task configuration resolves the same immutable definitions as channels.
use super::{
    agent_definition_selection::AgentDefinitionSelection, agent_resources::AgentResources,
};
use anyhow::{Result, ensure};
use kcoder_engine::QueryEngine;
use kcoder_types::agent_definition::*;
use kcoder_types::diagnostic_cause::coded_chain;
use kcoder_types::integrations::core::*;

pub(in crate::app_server) fn bind(
    engine: QueryEngine,
    reference: &AgentDefinitionRef,
) -> Result<QueryEngine> {
    ensure!(reference.is_valid(), "AGENT_DEFINITION_INVALID");
    let resources = AgentResources::capture(&engine)?;
    resources.authorize("agent.definition.execute", &engine.session_id())?;
    let owner = IntegrationOwner::from(resources.scope());
    let selected = AgentDefinitionSelection::read(resources, &entity_ref(reference))?;
    let engine = install(engine, selected.definition_for_new_binding()?)?;
    engine.state.bind_agent_definition(AgentTaskBinding {
        owner,
        definition: reference.clone(),
        title: selected.definition().title.clone(),
        source: AgentTaskSource::Expert,
        source_id: None,
    })?;
    Ok(engine)
}

fn entity_ref(reference: &AgentDefinitionRef) -> IntegrationEntityRef {
    IntegrationEntityRef {
        kind: IntegrationEntityKind::Assistant,
        id: reference.id.clone(),
        revision: Some(format!(
            "{}@sha256:{}",
            reference.version, reference.definition_sha256
        )),
    }
}

/// Validate the proposed configuration without executing or changing the running Engine.
pub(in crate::app_server) fn selection(
    engine: &QueryEngine,
    reference: Option<&AgentDefinitionRef>,
) -> Result<Option<AgentTaskBinding>> {
    let Some(reference) = reference else {
        return Ok(None);
    };
    ensure!(reference.is_valid(), "AGENT_DEFINITION_INVALID");
    let resources = AgentResources::capture(engine)?;
    resources.authorize("agent.definition.execute", &engine.session_id())?;
    let owner = IntegrationOwner::from(resources.scope());
    let selected = AgentDefinitionSelection::read(resources, &entity_ref(reference))?;
    let definition = selected.definition_for_new_binding()?;
    validate_task_configuration(engine, &definition)?;
    // Validate optional instructions and tool filters without changing model or State.
    engine.clone().with_agent_definition_context(definition)?;
    Ok(Some(AgentTaskBinding {
        owner,
        definition: reference.clone(),
        title: selected.definition().title.clone(),
        source: AgentTaskSource::Expert,
        source_id: None,
    }))
}

/// Capture a fresh next-turn snapshot, including current saved personalization.
pub(in crate::app_server) fn configure(engine: QueryEngine) -> Result<QueryEngine> {
    configure_with_tool_policy(engine, true)
}

fn configure_with_tool_policy(
    engine: QueryEngine,
    use_expert_tool_selection: bool,
) -> Result<QueryEngine> {
    if engine.state.channel_task_source().is_some() {
        ensure!(
            engine.native_input_requires_source_admission(),
            "AGENT_CHANNEL_READ_ONLY"
        );
    }
    let (selection_revision, binding) = engine.state.agent_configuration();
    let Some(binding) = binding else {
        return install_turn_snapshot(
            engine,
            AgentTurnConfiguration {
                selection_revision,
                binding: None,
                personalization_revision: None,
                effective_definition: None,
                expert_tool_selection: None,
            },
            None,
        );
    };
    if binding.source == AgentTaskSource::Channel {
        ensure!(
            engine.native_input_requires_source_admission(),
            "AGENT_CHANNEL_READ_ONLY"
        );
    }
    let legacy_channel = binding.source == AgentTaskSource::Channel;
    let resources = AgentResources::capture(&engine)?;
    resources.authorize("agent.definition.execute", &engine.session_id())?;
    ensure!(
        binding.owner == IntegrationOwner::from(resources.scope()),
        "AGENT_DEFINITION_OWNER_CHANGED"
    );
    let selected = AgentDefinitionSelection::read(resources, &entity_ref(&binding.definition))?;
    let (definition, personalization_revision) = if legacy_channel {
        (selected.definition().clone(), None)
    } else {
        selected.personalized_definition()?
    };
    let resources = selected.prepare_resources(&definition, personalization_revision, None)?;
    let snapshot = AgentTurnConfiguration {
        selection_revision,
        binding: Some(binding),
        personalization_revision,
        effective_definition: Some(definition.clone()),
        expert_tool_selection: (use_expert_tool_selection && !legacy_channel)
            .then(|| engine.capture_expert_tool_selection(&definition)),
    };
    let engine = if legacy_channel {
        engine
    } else {
        install_model(engine, &definition)?
    };
    install_turn_snapshot(engine, snapshot, Some(resources))
}

pub(in crate::app_server) fn configure_for_turn(
    engine: QueryEngine,
    params: &kcoder_app_protocol::TurnStartParams,
) -> Result<QueryEngine> {
    if let Some(turn) = &params.retry_from_turn_id {
        let store = crate::app_server::turn_attempts::store(&engine, &params.thread_id)?;
        if let Some(parent) = crate::app_server::turn_attempts::latest(&store, turn)?
            && let Some(snapshot) = store.load_agent_snapshot(&parent.identity)?
        {
            let mut resources = None;
            if let Some(binding) = &snapshot.binding {
                let catalog = AgentResources::capture(&engine)?;
                ensure!(
                    binding.owner == IntegrationOwner::from(catalog.scope()),
                    "AGENT_DEFINITION_OWNER_CHANGED"
                );
                catalog.authorize("agent.definition.execute", &engine.session_id())?;
                let selected =
                    AgentDefinitionSelection::read(catalog, &entity_ref(&binding.definition))?;
                let pinned = store.load_agent_resource_snapshot(&parent.identity)?;
                if let (Some(definition), Some(pinned)) =
                    (&snapshot.effective_definition, pinned.as_ref())
                {
                    resources = Some(selected.prepare_resources(definition, None, Some(pinned))?);
                } else {
                    ensure!(
                        snapshot
                            .effective_definition
                            .as_ref()
                            .is_none_or(|definition| definition
                                .skills
                                .iter()
                                .all(|skill| !skill.enabled)),
                        "AGENT_LEGACY_RETRY_RESOURCES_UNAVAILABLE"
                    );
                }
            }
            return install_turn_snapshot(engine, snapshot, resources);
        }
        // Older failures cannot safely adopt a newly selected expert.
        ensure!(
            engine.state.agent_configuration().0 == 0,
            "AGENT_LEGACY_RETRY_CONFIGURATION_UNAVAILABLE"
        );
        return configure_with_tool_policy(engine, false);
    }
    configure(engine)
}

fn install(engine: QueryEngine, definition: AgentDefinition) -> Result<QueryEngine> {
    install_model(engine, &definition)?.with_agent_definition_context(definition)
}

fn install_model(engine: QueryEngine, definition: &AgentDefinition) -> Result<QueryEngine> {
    validate_task_configuration(&engine, definition)?;
    match &definition.model_selection {
        AgentModelSelection::Explicit { provider, model } => {
            engine.select_client_model(&format!("{provider}::{model}"))?;
        }
        AgentModelSelection::AutoPolicy { .. } => {
            anyhow::bail!("AGENT_EXPLICIT_MODEL_RESOLUTION_REQUIRED")
        }
        AgentModelSelection::InheritCurrent => {}
    }
    Ok(engine)
}

fn validate_task_configuration(engine: &QueryEngine, definition: &AgentDefinition) -> Result<()> {
    validate_task_definition(definition)?;
    let (provider, model) = match &definition.model_selection {
        AgentModelSelection::Explicit { provider, model } => (provider, model),
        AgentModelSelection::AutoPolicy { .. } => {
            anyhow::bail!("AGENT_EXPLICIT_MODEL_RESOLUTION_REQUIRED")
        }
        AgentModelSelection::InheritCurrent => return Ok(()),
    };
    let requested = format!("{provider}::{model}");
    let current_provider = engine.current_provider();
    if engine.client_model_selector() == requested
        && current_provider.name() == provider.as_str()
        && !current_provider.supports_client_runtime_reconfiguration()
    {
        return Ok(());
    }
    let (settings, _) = engine
        .resolve_client_model_configuration(&requested)
        .map_err(coded_chain("AGENT_MODEL_SELECTION_UNAVAILABLE"))?;
    let summary = kcoder_engine::model_configuration_summary(
        &settings,
        kcoder_types::ModelConfigurationBoundary::NextTurn,
    )
    .map_err(coded_chain("AGENT_MODEL_SELECTION_UNAVAILABLE"))?;
    ensure!(
        summary.provider_id.as_deref() == Some(provider.as_str()) && summary.model_id == *model,
        "AGENT_MODEL_SELECTION_UNAVAILABLE"
    );
    Ok(())
}

fn validate_task_definition(definition: &AgentDefinition) -> Result<()> {
    // Resource-bearing definitions keep their original Office/workflow admission until adapted.
    ensure!(
        definition.resources.is_empty()
            && definition.capabilities.is_empty()
            && definition.workflow_ref.is_none(),
        "AGENT_RESOURCE_ADMISSION_REQUIRED"
    );
    Ok(())
}

pub(in crate::app_server) fn binding_error_code(error: &anyhow::Error) -> &'static str {
    for cause in error.chain() {
        match cause.to_string().as_str() {
            "AGENT_DEFINITION_DISABLED" => return "AGENT_DEFINITION_DISABLED",
            "AGENT_RESOURCE_ADMISSION_REQUIRED" => return "AGENT_RESOURCE_ADMISSION_REQUIRED",
            "AGENT_EXPLICIT_MODEL_RESOLUTION_REQUIRED" => {
                return "AGENT_EXPLICIT_MODEL_RESOLUTION_REQUIRED";
            }
            "AGENT_MODEL_SELECTION_UNAVAILABLE" => return "AGENT_MODEL_SELECTION_UNAVAILABLE",
            _ => {}
        }
    }
    "AGENT_DEFINITION_UNAVAILABLE"
}

/// New input and continuation consume the same original per-attempt representation.
/// Model restoration and Native source admission remain the caller's responsibility.
fn install_turn_snapshot(
    engine: QueryEngine,
    snapshot: AgentTurnConfiguration,
    resources: Option<(
        kcoder_state::integrations::resources::AgentResourceSnapshot,
        std::path::PathBuf,
    )>,
) -> Result<QueryEngine> {
    ensure!(
        snapshot.binding.is_some() == snapshot.effective_definition.is_some()
            && (snapshot.effective_definition.is_some() || resources.is_none()),
        "AGENT_SNAPSHOT_DEFINITION_MISMATCH"
    );
    let engine = match &snapshot.effective_definition {
        Some(definition) => engine.with_agent_definition_tool_snapshot(
            definition.clone(),
            snapshot.expert_tool_selection.as_deref(),
        )?,
        None => engine.without_agent_definition_context(),
    };
    let engine = match resources {
        Some((snapshot, root)) => engine.with_agent_skill_resources(snapshot, root)?,
        None => engine,
    };
    Ok(engine.with_agent_turn_configuration(snapshot))
}
