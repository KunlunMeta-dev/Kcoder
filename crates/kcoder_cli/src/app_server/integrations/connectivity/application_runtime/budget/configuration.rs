//! Target-owned limits are policy inputs, never a source or tool permission.
use super::*;
use kcoder_config::integrations::core::ConfiguredChannelTaskBudget;

pub(in crate::app_server::integrations::connectivity::application_runtime) struct TaskBudgetConfiguration
{
    factory: AppServerEngineFactory,
    selected: Option<ConfiguredChannelTaskBudget>,
}
impl TaskBudgetConfiguration {
    pub(in crate::app_server::integrations::connectivity::application_runtime) fn capture(
        factory: &AppServerEngineFactory,
    ) -> Result<Arc<Self>> {
        let settings = factory.current_settings()?;
        settings.integrations.core.validate()?;
        Ok(Arc::new(Self {
            factory: factory.clone(),
            selected: settings.integrations.core.channel_task_budget,
        }))
    }
    pub(in crate::app_server::integrations::connectivity::application_runtime) fn verify(
        &self,
    ) -> Result<()> {
        let settings = self.factory.current_settings()?;
        settings.integrations.core.validate()?;
        ensure!(
            settings.integrations.core.channel_task_budget == self.selected,
            "APPLICATION_TASK_BUDGET_CONFIGURATION_CHANGED"
        );
        Ok(())
    }
    pub(super) fn revision(&self, shared: &Execution) -> Result<String> {
        if let Some(configured) = &self.selected {
            hash(&(
                operation(shared)?,
                &shared.task.configuration.model.model,
                "target-owned-application-task-budget-v1",
                configured,
                "application-execution-window-v1",
            ))
        } else {
            // A new execution-window policy cannot reuse a prior admission.
            hash(&(
                operation(shared)?,
                &shared.task.configuration.model.model,
                "application-execution-window-v1",
            ))
        }
    }
    pub(super) fn limits(&self, tool_task: bool) -> BudgetLimits {
        let tokens = self.selected.as_ref().map_or(32768, |value| value.tokens);
        let calls = if tool_task {
            self.selected
                .as_ref()
                .map_or(8, |value| u64::from(value.model_calls))
        } else {
            1
        };
        let duration = self
            .selected
            .as_ref()
            .map_or(240_000, |value| value.run_millis);
        BudgetLimits {
            tokens: Some(tokens),
            model_calls: Some(calls),
            run_millis: Some(duration),
            concurrent_tasks: Some(1),
            concurrent_calls: Some(1),
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use serde_json::json;

    struct NoModel;
    impl kcoder_api::Provider for NoModel {
        fn name(&self) -> &'static str {
            "budget-configuration-no-model"
        }
        fn stream_messages(
            &self,
            _: kcoder_types::MessagesRequest,
        ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            panic!("Configuration observations cannot call a model")
        }
    }
    fn factory() -> Result<(
        crate::app_server::integrations::core::runtime_driver::test_support::Fixture,
        AppServerEngineFactory,
    )> {
        let scope =
            crate::app_server::integrations::core::runtime_driver::test_support::Fixture::new();
        let path = scope.profile.join("settings.json");
        std::fs::write(&path, b"{}")?;
        let settings = kcoder_config::Settings::default();
        let factory = AppServerEngineFactory::new(
            Arc::new(NoModel),
            kcoder_tools::ToolRegistry::new(),
            kcoder_permissions::PermissionEngine::from_settings(&settings),
            settings,
            kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
            kcoder_skills::SkillRegistry::empty(),
            kcoder_plugins::EffectivePluginSnapshot::default(),
            scope.workspace.clone(),
            None,
            false,
            kcoder_engine::WorkspaceRuntimeServices::new(
                &scope.workspace,
                "actual-current-budget-config",
            ),
            Some(path),
            scope.profile.join("short-ids"),
        )
        .with_session_configuration(
            kcoder_config::SettingsLoader::new(&scope.workspace)
                .with_config_dir(&scope.profile)
                .with_executable_dir(&scope.workspace),
            crate::Cli::parse_from(["kcoder"]),
            false,
        )?;
        Ok((scope, factory))
    }
    #[test]
    fn application_budget_uses_configured_limits_and_rejects_mid_task_change() -> Result<()> {
        let (scope, factory) = factory()?;
        let initial = TaskBudgetConfiguration::capture(&factory)?;
        initial.verify()?;
        assert_eq!(initial.limits(true).tokens, Some(32768));
        assert_eq!(initial.limits(true).model_calls, Some(8));
        assert_eq!(initial.limits(true).run_millis, Some(240000));
        assert_eq!(initial.limits(false).run_millis, Some(240000));
        assert_eq!(initial.limits(false).model_calls, Some(1));
        let path = scope.profile.join("settings.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({"integrations":{"core":{"channelTaskBudget":{
            "tokens":65536,"modelCalls":6,"runMillis":240000}}}}))?,
        )?;
        assert!(
            initial.verify().is_err(),
            "An admitted task cannot inherit a different later setting"
        );
        let configured = TaskBudgetConfiguration::capture(&factory)?;
        configured.verify()?;
        assert_eq!(configured.limits(true).tokens, Some(65536));
        assert_eq!(configured.limits(true).model_calls, Some(6));
        assert_eq!(configured.limits(false).run_millis, Some(240000));
        assert_eq!(configured.limits(false).model_calls, Some(1));
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({"integrations":{"core":{"channelTaskBudget":{
            "tokens":32768,"modelCalls":6,"runMillis":240000}}}}))?,
        )?;
        assert!(
            configured.verify().is_err(),
            "A tightened current ceiling cannot reuse the old larger policy"
        );
        std::fs::write(&path, b"{}")?;
        assert!(
            configured.verify().is_err(),
            "Removing an explicit setting revokes its admitted snapshot"
        );
        Ok(())
    }
}
