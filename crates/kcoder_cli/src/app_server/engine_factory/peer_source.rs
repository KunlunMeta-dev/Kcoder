//! Current permission assembly for an existing, independently proven cold source.
//! These configuration values never establish its ownership or original admission.
use super::*;
use kcoder_state::PreparedSessionMetadata;
use kcoder_types::{
    cross_session_messages::AgentMessageIntent, settings_templates::SettingsTemplateBinding,
};

pub struct PeerSourcePermissionSnapshot {
    settings: Settings,
    permissions: PermissionEngine,
    selection: Option<Vec<String>>,
}
impl PeerSourcePermissionSnapshot {
    pub fn check_send(&self, intent: &AgentMessageIntent) -> Result<()> {
        let name = "SendSessionMessage";
        anyhow::ensure!(
            self.settings.model_capabilities.tools
                && !matches!(
                    self.settings.tools.profile,
                    kcoder_config::ToolProfile::None | kcoder_config::ToolProfile::Nano
                )
                && !ToolRegistry::name_is_disabled(name, &self.settings.tools.disabled)
                && self
                    .selection
                    .as_ref()
                    .is_none_or(|names| names.iter().any(|value| value == name)),
            "peer_source_current_tool_disabled"
        );
        let input = serde_json::to_value(intent)?;
        anyhow::ensure!(
            !self.permissions.is_explicitly_denied(name, &input),
            "peer_source_current_permission_denied"
        );
        Ok(())
    }
}
impl AppServerEngineFactory {
    pub fn current_peer_source_permissions(
        &self,
        metadata: &PreparedSessionMetadata,
        template: Option<&SettingsTemplateBinding>,
        creation_permission_mode: Option<kcoder_config::PermissionMode>,
    ) -> Result<PeerSourcePermissionSnapshot> {
        anyhow::ensure!(
            metadata.session_mode() == kcoder_state::SessionMode::Default
                && !metadata.has_native_subagent_outbox()
                && metadata.channel_task_source().is_none()
                && metadata.agent_definition().is_none(),
            "peer_source_current_kind_requires_runtime"
        );
        // A real host contribution is required. A setting cannot install a sender.
        anyhow::ensure!(
            self.session_messages_host.is_some(),
            "peer_source_host_contribution_unavailable"
        );
        let store = kcoder_config::settings_templates::SettingsTemplateStore::open(
            &self.profile_paths()?.config_dir,
        )?;
        let template_path = template
            .map(|binding| store.observe_recorded_session_path(binding))
            .transpose()?;
        let configuration = match (&self.configuration, &template_path) {
            (Some(configuration), Some(path)) => {
                Some(configuration.clone().with_template(path.clone()))
            }
            (Some(configuration), None) => Some(configuration.clone()),
            (None, None) => None,
            (None, Some(_)) => anyhow::bail!("peer_source_template_configuration_unavailable"),
        };
        // Read configuration only: no credentials, plugins, MCP startup, Hooks,
        // model requests, history resume, or snapshot-budget reclamation.
        let mut settings = match &configuration {
            Some(configuration) => configuration.public_runtime_settings()?,
            None => self.base_settings.clone(),
        };
        if let Some(configuration) = &configuration {
            settings = QueryEngine::resolve_next_turn_model_settings(
                settings,
                configuration.read_only_model_source().as_ref(),
                metadata.model_selection_mode(),
                metadata.selected_model(),
            )?;
        }
        let template_permission_mode = match (&configuration, &template_path) {
            (Some(configuration), Some(path)) => {
                configuration.template_sets_permission_mode(path.clone())?
            }
            _ => false,
        };
        if self.cli_permission_mode_override()?.is_none()
            && !template_permission_mode
            && let Some(mode) = creation_permission_mode
        {
            settings.permission_mode = mode;
        }
        let selection = metadata.studio_tool_selection().and_then(|selection| {
            match metadata.studio_work_mode() {
                kcoder_types::StudioWorkMode::Kcoder => selection.kcoder.clone(),
                kcoder_types::StudioWorkMode::Kworker => selection.kworker.clone(),
            }
        });
        if let Some(binding) = template {
            anyhow::ensure!(
                store.observe_recorded_session_path(binding)?
                    == template_path.as_ref().unwrap().clone(),
                "peer_source_template_changed"
            );
        }
        let permissions = PermissionEngine::from_settings(&settings);
        Ok(PeerSourcePermissionSnapshot {
            settings,
            permissions,
            selection,
        })
    }
}
