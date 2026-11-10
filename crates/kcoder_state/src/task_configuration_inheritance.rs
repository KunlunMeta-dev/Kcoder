//! Configuration inheritance never transfers task history or execution authority.
use super::*;
use kcoder_types::agent_definition::{AgentTaskBinding, AgentTaskSource};

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskSuccessorConfiguration {
    model_mode: kcoder_types::ModelSelectionMode,
    selected_model: Option<String>,
    expert: Option<AgentTaskBinding>,
    tools: Option<kcoder_types::StudioToolSelections>,
}

impl TaskSuccessorConfiguration {
    fn capture(inner: &AppStateInner) -> Self {
        Self {
            model_mode: inner.model_selection_mode,
            selected_model: inner.selected_model.clone(),
            expert: inner.agent_definition.clone(),
            tools: inner.studio_tool_selection.clone(),
        }
    }

    fn install(self, inner: &mut AppStateInner) {
        inner.model_selection_mode = self.model_mode;
        inner.selected_model = self.selected_model;
        inner.agent_definition = self.expert;
        inner.studio_tool_selection = self.tools;
    }
}

impl AppState {
    /// Copy an ordinary task's selection into a fresh task before history is added.
    /// The caller still owns the idle boundary, project access and creation receipt.
    /// The new task starts its own expert revision; no turn snapshot or grant is copied.
    pub fn inherit_task_configuration_before_first_message(
        &self,
        source: &AppState,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            !Arc::ptr_eq(&self.inner, &source.inner),
            "TASK_CONFIGURATION_NEW_STATE_REQUIRED"
        );
        // Capture the small selection under one source lock, without copying transcript.
        let (configuration, cwd, source_id) = {
            let inner = source.read_inner();
            check_direct_history_fault(&inner)?;
            anyhow::ensure!(
                inner.channel_task_source.is_none()
                    && inner.agent_definition.as_ref().is_none_or(|binding| {
                        binding.source == AgentTaskSource::Expert
                            && binding.definition.is_valid()
                            && !binding.title.is_empty()
                            && binding.title.len() <= 800
                    }),
                "TASK_CONFIGURATION_LEGACY_CHANNEL_REQUIRES_MIGRATION"
            );
            (
                TaskSuccessorConfiguration::capture(&inner),
                inner.cwd.clone(),
                inner.session_id.clone(),
            )
        };
        self.install_task_successor_configuration(configuration, &cwd, &source_id)
    }

    /// Persist only selections. This snapshot carries no transcript or grants.
    pub fn task_successor_configuration(&self) -> anyhow::Result<TaskSuccessorConfiguration> {
        let inner = self.read_inner();
        check_direct_history_fault(&inner)?;
        anyhow::ensure!(
            inner.channel_task_source.is_none(),
            "TASK_CONFIGURATION_LEGACY_CHANNEL_REQUIRES_MIGRATION"
        );
        Ok(TaskSuccessorConfiguration::capture(&inner))
    }

    pub fn install_task_successor_configuration(
        &self,
        configuration: TaskSuccessorConfiguration,
        cwd: &std::path::Path,
        source_id: &str,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            configuration
                .expert
                .as_ref()
                .is_none_or(|binding| binding.source == AgentTaskSource::Expert
                    && binding.definition.is_valid()
                    && !binding.title.is_empty()
                    && binding.title.len() <= 800),
            "TASK_CONFIGURATION_EXPERT_INVALID"
        );
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        check_direct_history_fault(&inner)?;
        anyhow::ensure!(
            inner.session_id != source_id && inner.cwd == cwd,
            "TASK_CONFIGURATION_WORKSPACE_CHANGED"
        );
        anyhow::ensure!(
            !inner.conversation_started
                && inner.messages.is_empty()
                && inner.channel_task_source.is_none()
                && inner.agent_configuration_revision == 0
                && inner.agent_definition.is_none()
                && inner.selected_model.is_none()
                && inner.model_selection_mode == kcoder_types::ModelSelectionMode::default()
                && inner.studio_tool_selection.is_none(),
            "TASK_CONFIGURATION_FRESH_STATE_REQUIRED"
        );
        if inner.history_path.is_some() {
            require_history_source(&inner)?;
        }
        let previous = TaskSuccessorConfiguration::capture(&inner);
        configuration.install(&mut inner);
        if let Some(path) = inner.session_state_path.clone() {
            let state = session_persistence::PersistedSessionState::from_inner(&inner);
            let result = match inner.history_source.as_ref() {
                Some(source) => source.write_metadata(&path, || {
                    session_persistence::prepare_legacy_session_state_write(&path, state.clone())
                }),
                None => session_persistence::write_session_state(&path, &state),
            };
            if let Err(error) = result {
                if crate::history_store::is_uncertain_mutation(&error) {
                    inner.history_write_fault = Some(format!("{error:#}"));
                } else {
                    previous.install(&mut inner);
                }
                return Err(error).context("TASK_CONFIGURATION_INHERITANCE_UNCONFIRMED");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;

impl TaskSuccessorConfiguration {
    pub fn selected_model(&self) -> Option<&str> {
        self.selected_model.as_deref()
    }
    pub fn model_mode(&self) -> kcoder_types::ModelSelectionMode {
        self.model_mode
    }
    pub fn tools(&self) -> Option<kcoder_types::StudioToolSelections> {
        self.tools.clone()
    }
}
