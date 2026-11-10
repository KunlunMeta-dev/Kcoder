//! Ordinary task configuration resolves the same immutable definitions as channels.
use super::{agent_definition_selection::AgentDefinitionSelection, core::capture_scope};
use anyhow::{Result, ensure};
use kcoder_engine::QueryEngine;
use kcoder_types::{
    agent_definition::*,
    integrations::{core::*, office::*},
};

pub(in crate::app_server) fn bind(
    engine: QueryEngine,
    reference: &AgentDefinitionRef,
) -> Result<QueryEngine> {
    ensure!(reference.is_valid(), "AGENT_DEFINITION_INVALID");
    let native = capture_scope(&engine)?;
    super::office::authorize_agent_definition_action(
        &native,
        "office.assistant.execute",
        &engine.session_id(),
    )?;
    let selected = AgentDefinitionSelection::read(&native, &entity_ref(reference))?;
    let engine = install(engine, selected.definition().clone())?;
    engine.state.bind_agent_definition(AgentTaskBinding {
        owner: IntegrationOwner::from(native.scope()),
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
    let native = capture_scope(engine)?;
    super::office::authorize_agent_definition_action(
        &native,
        "office.assistant.execute",
        &engine.session_id(),
    )?;
    let selected = AgentDefinitionSelection::read(&native, &entity_ref(reference))?;
    let (definition, _) = selected.personalized_definition()?;
    validate_task_definition(&definition)?;
    // Validate optional instructions and tool filters without changing model or State.
    engine.clone().with_agent_definition_context(definition)?;
    Ok(Some(AgentTaskBinding {
        owner: IntegrationOwner::from(native.scope()),
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
    let native = capture_scope(&engine)?;
    super::office::authorize_agent_definition_action(
        &native,
        "office.assistant.execute",
        &engine.session_id(),
    )?;
    ensure!(
        binding.owner == IntegrationOwner::from(native.scope()),
        "AGENT_DEFINITION_OWNER_CHANGED"
    );
    let selected = AgentDefinitionSelection::read(&native, &entity_ref(&binding.definition))?;
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
                let native = capture_scope(&engine)?;
                ensure!(
                    binding.owner == IntegrationOwner::from(native.scope()),
                    "AGENT_DEFINITION_OWNER_CHANGED"
                );
                super::office::authorize_agent_definition_action(
                    &native,
                    "office.assistant.execute",
                    &engine.session_id(),
                )?;
                let selected =
                    AgentDefinitionSelection::read(&native, &entity_ref(&binding.definition))?;
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

fn install(engine: QueryEngine, definition: OfficeAssistantDefinition) -> Result<QueryEngine> {
    install_model(engine, &definition)?.with_agent_definition_context(definition)
}

fn install_model(
    engine: QueryEngine,
    definition: &OfficeAssistantDefinition,
) -> Result<QueryEngine> {
    validate_task_definition(definition)?;
    match &definition.model_selection {
        OfficeModelSelection::Explicit { provider, model } => {
            engine.select_client_model(&format!("{provider}::{model}"))?;
        }
        OfficeModelSelection::AutoPolicy { .. } => {
            anyhow::bail!("AGENT_EXPLICIT_MODEL_RESOLUTION_REQUIRED")
        }
        OfficeModelSelection::InheritCurrent => {}
    }
    Ok(engine)
}

fn validate_task_definition(definition: &OfficeAssistantDefinition) -> Result<()> {
    // Resource-bearing definitions keep their original Office/workflow admission until adapted.
    ensure!(
        definition.resources.is_empty()
            && definition.capabilities.is_empty()
            && definition.workflow_ref.is_none(),
        "AGENT_RESOURCE_ADMISSION_REQUIRED"
    );
    ensure!(
        !matches!(
            definition.model_selection,
            OfficeModelSelection::AutoPolicy { .. }
        ),
        "AGENT_EXPLICIT_MODEL_RESOLUTION_REQUIRED"
    );
    Ok(())
}

/// New input and continuation consume the same original per-attempt representation.
/// Model restoration and Native source admission remain the caller's responsibility.
fn install_turn_snapshot(
    engine: QueryEngine,
    snapshot: AgentTurnConfiguration,
    resources: Option<(
        kcoder_state::integrations::office::OfficeExpertResourceSnapshot,
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
