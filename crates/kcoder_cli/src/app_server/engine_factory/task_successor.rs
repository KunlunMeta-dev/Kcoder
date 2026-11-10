//! Fresh task selections over the current target policy; no transcript or grants.
use super::*;
#[cfg(test)]
use crate::app_server::thread_runtime::task_boundary::TaskIdleReservation;
impl AppServerEngineFactory {
    #[cfg(test)]
    pub(in crate::app_server) async fn create_task_successor(
        &self,
        boundary: &TaskIdleReservation,
        source: &QueryEngine,
        configuration: kcoder_state::TaskSuccessorConfiguration,
        model_snapshot: Option<&serde_json::Value>,
        questioner: Arc<dyn UserQuestioner>,
    ) -> Result<QueryEngine> {
        boundary.verify_configuration_source(source)?;
        self.create_task_successor_after_source_check(
            source,
            configuration,
            model_snapshot,
            questioner,
        )
        .await
    }
    /// Construction follows the host's current concrete task-boundary check.
    pub fn create_task_successor_after_source_check<'a>(
        &'a self,
        source: &'a QueryEngine,
        configuration: kcoder_state::TaskSuccessorConfiguration,
        model_snapshot: Option<&'a serde_json::Value>,
        questioner: Arc<dyn UserQuestioner>,
    ) -> futures::future::BoxFuture<'a, Result<QueryEngine>> {
        Box::pin(self.create_task_successor_after_source_check_producer(
            source,
            configuration,
            model_snapshot,
            questioner,
        ))
    }
    async fn create_task_successor_after_source_check_producer(
        &self,
        source: &QueryEngine,
        configuration: kcoder_state::TaskSuccessorConfiguration,
        model_snapshot: Option<&serde_json::Value>,
        questioner: Arc<dyn UserQuestioner>,
    ) -> Result<QueryEngine> {
        anyhow::ensure!(
            source.state.cwd() == self.cwd
                && source.state.session_mode() == kcoder_state::SessionMode::Default
                && source.state.workflow_definition_id().is_none()
                && !source.native_input_requires_source_admission(),
            "TASK_SUCCESSOR_ORDINARY_TASK_REQUIRED"
        );
        let mut factory = self.refreshed().await?;
        anyhow::ensure!(
            factory.base_settings.history_enabled && factory.history_directory.is_some(),
            "TASK_SUCCESSOR_DURABLE_HISTORY_REQUIRED"
        );
        factory.base_permissions = PermissionEngine::from_settings(&factory.base_settings);
        let selected_model = configuration.selected_model().map(str::to_owned);
        let model_mode = configuration.model_mode();
        // Install the captured selection together with the other successor
        // preferences. Pre-binding tools would make this State ineligible.
        factory.bind_new_tool_selection = false;
        factory.base_settings.tools.studio = configuration.tools().unwrap_or_default();
        let state = factory.new_state()?;
        state.install_task_successor_configuration(
            configuration,
            &source.state.cwd(),
            &source.session_id(),
        )?;
        state.set_studio_work_mode_before_first_message(source.state.studio_work_mode())?;
        let engine = factory.build(state, questioner)?;
        if model_mode == kcoder_types::ModelSelectionMode::Explicit {
            let engine = engine.with_client_model_configuration_from(source);
            if let Some(snapshot) = model_snapshot {
                let proxy = source
                    .settings
                    .read()
                    .map_err(|_| anyhow::anyhow!("TASK_SUCCESSOR_SETTINGS_UNAVAILABLE"))?
                    .provider_proxy_url
                    .clone();
                engine.thaw_client_model(&serde_json::to_vec(snapshot)?, proxy)?;
                return Ok(engine);
            }
            if let Some(model) = selected_model.as_deref() {
                engine.select_client_model(model)?;
            }
            return Ok(engine);
        }
        Ok(engine)
    }
}
