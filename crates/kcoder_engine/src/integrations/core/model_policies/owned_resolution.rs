//! Native value-owned configuration selection; it performs no model request,
//! profile write, task creation or execution-authorization grant.
use crate::{QueryEngine, recover_read_lock};
use anyhow::{Context, Result, ensure};
use kcoder_types::{ModelConfigurationBoundary, integrations::core::*};
use std::sync::{Arc, RwLock};
impl QueryEngine {
    /// Copy only a native source's verified model into a different task Engine.
    /// State, tools and execution authority remain owned by the receiving task.
    pub fn with_owned_native_model_resolution_from(
        mut self,
        source: &Self,
        resolution: &IntegrationModelResolutionResult,
    ) -> Result<Self> {
        let selected = source
            .clone()
            .with_owned_native_model_resolution(resolution)?;
        let previous = recover_read_lock(&self.settings, "settings").clone();
        let next = recover_read_lock(&selected.settings, "settings").clone();
        self.settings = Arc::new(RwLock::new(
            crate::client_model_configuration::retained_model_fields(previous, &next),
        ));
        self.provider = Arc::new(RwLock::new(selected.current_raw_provider()));
        self = self.with_client_model_configuration_from(&selected);
        ensure!(
            self.active_model_configuration_summary()?
                == selected.active_model_configuration_summary()?,
            "MODEL_NATIVE_CONFIGURATION_CHANGED"
        );
        Ok(self)
    }

    pub fn with_owned_native_model_resolution(
        mut self,
        resolution: &IntegrationModelResolutionResult,
    ) -> Result<Self> {
        let current = self.active_model_configuration_summary()?;
        let (next, provider) =
            if resolution.selection_kind == IntegrationModelSelectionKind::InheritCurrent {
                ensure!(
                    current.provider_id == resolution.model.provider_id
                        && current.model_id == resolution.model.model_id
                        && current.revision == resolution.model.revision,
                    "MODEL_NATIVE_INHERITED_CONFIGURATION_CHANGED"
                );
                (
                    recover_read_lock(&self.settings, "settings").clone(),
                    self.current_raw_provider(),
                )
            } else {
                let provider = resolution
                    .model
                    .provider_id
                    .as_deref()
                    .context("MODEL_NATIVE_PROVIDER_REQUIRED")?;
                self.resolve_client_model_configuration(&format!(
                    "{}::{}",
                    provider, resolution.model.model_id
                ))?
            };
        let actual =
            crate::model_configuration_summary(&next, ModelConfigurationBoundary::NextTurn)?;
        ensure!(
            actual.provider_id == resolution.model.provider_id
                && actual.model_id == resolution.model.model_id
                && actual.revision == resolution.model.revision
                && actual.api_format == resolution.model.api_format
                && actual.chat_protocol == resolution.model.chat_protocol,
            "MODEL_NATIVE_CONFIGURATION_CHANGED"
        );
        let previous = recover_read_lock(&self.settings, "settings").clone();
        let next = crate::client_model_configuration::retained_model_fields(previous, &next);
        let mut options =
            recover_read_lock(&self.client_model_options, "client model options").clone();
        options.bind_model(&next);
        self.settings = Arc::new(RwLock::new(next));
        self.provider = Arc::new(RwLock::new(provider));
        self.client_model_options = Arc::new(RwLock::new(options));
        if resolution.selection_kind == IntegrationModelSelectionKind::AutoPolicy {
            super::validate_integration_auto_model(&self, resolution)?;
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        integrations::core::resolve_integration_model_selection,
        test_support::engine_builder::TestEngineBuilder,
    };
    fn settings() -> kcoder_config::Settings {
        let mut settings:kcoder_config::Settings=serde_json::from_value(serde_json::json!({"active_provider":"A","model":"one","providers":{
            "A":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},"endpoint":"http://127.0.0.1:9/v1","default_model":"one","context_window_tokens":128000,"max_output_tokens":128,"output_headroom_tokens":128},
            "B":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},"endpoint":"http://127.0.0.1:9/v1","default_model":"two","context_window_tokens":128000,"max_output_tokens":128,"output_headroom_tokens":128}
        }})).unwrap();
        settings.apply_discovered_model("A", "one").unwrap();
        settings
    }
    #[tokio::test]
    async fn explicit_factory_detaches_model_arcs_and_preserves_original_state_and_authority_objects()
     {
        let root = tempfile::tempdir().unwrap();
        let base = TestEngineBuilder::new(root.path())
            .settings(settings())
            .build_with_profile_directory();
        let before = base.active_model_configuration_summary().unwrap();
        let resolution = resolve_integration_model_selection(
            &base,
            &IntegrationModelResolutionRequest {
                selection: IntegrationModelSelectionIntent::Explicit {
                    provider: "B".into(),
                    model: "two".into(),
                },
                requirements: Default::default(),
            },
        )
        .unwrap();
        let owned = base
            .clone()
            .with_owned_native_model_resolution(&resolution)
            .unwrap();
        assert_eq!(owned.model_name(), "two");
        assert_eq!(base.model_name(), "one");
        assert_eq!(base.active_model_configuration_summary().unwrap(), before);
        assert!(!Arc::ptr_eq(&base.settings, &owned.settings));
        assert!(!Arc::ptr_eq(&base.provider, &owned.provider));
        assert!(!Arc::ptr_eq(
            &base.client_model_options,
            &owned.client_model_options
        ));
        assert!(Arc::ptr_eq(&base.permissions, &owned.permissions));
        assert!(base.state.inspection_identity().matches(&owned.state));
        owned.settings.write().unwrap().max_tokens = Some(7);
        assert_eq!(base.settings.read().unwrap().max_tokens, Some(128));
    }
    #[tokio::test]
    async fn inherited_current_reuses_the_true_raw_provider_while_detaching_mutable_configuration()
    {
        let root = tempfile::tempdir().unwrap();
        let base = TestEngineBuilder::new(root.path())
            .settings(settings())
            .build_with_profile_directory();
        let raw = base.current_raw_provider();
        let resolution = resolve_integration_model_selection(
            &base,
            &IntegrationModelResolutionRequest {
                selection: IntegrationModelSelectionIntent::InheritCurrent,
                requirements: Default::default(),
            },
        )
        .unwrap();
        let owned = base
            .clone()
            .with_owned_native_model_resolution(&resolution)
            .unwrap();
        assert!(Arc::ptr_eq(&raw, &owned.current_raw_provider()));
        assert!(!Arc::ptr_eq(&base.settings, &owned.settings));
        assert_eq!(base.session_id(), owned.session_id());
    }
    #[tokio::test]
    async fn an_inexact_summary_cannot_activate_or_modify_the_original_model() {
        let root = tempfile::tempdir().unwrap();
        let base = TestEngineBuilder::new(root.path())
            .settings(settings())
            .build_with_profile_directory();
        let mut resolution = resolve_integration_model_selection(
            &base,
            &IntegrationModelResolutionRequest {
                selection: IntegrationModelSelectionIntent::VerifierLocked {
                    provider: "A".into(),
                    model: "one".into(),
                    configuration_revision: base
                        .active_model_configuration_summary()
                        .unwrap()
                        .revision,
                },
                requirements: Default::default(),
            },
        )
        .unwrap();
        resolution.model.revision = "stale-native-summary".into();
        assert!(
            base.clone()
                .with_owned_native_model_resolution(&resolution)
                .is_err()
        );
        assert_eq!(base.model_name(), "one");
    }

    #[tokio::test]
    async fn a_fresh_task_inherits_the_exact_source_model_without_inheriting_its_authority() {
        let root = tempfile::tempdir().unwrap();
        let source = TestEngineBuilder::new(root.path())
            .settings(settings())
            .build_with_profile_directory();
        source.settings.write().unwrap().max_tokens = Some(19);
        let target = TestEngineBuilder::new(root.path())
            .settings(settings())
            .build_with_profile_directory();
        let target_state = target.state.inspection_identity();
        let target_permissions = target.permissions.clone();
        let target_tools = target.tools.clone();
        let resolution = resolve_integration_model_selection(
            &source,
            &IntegrationModelResolutionRequest {
                selection: IntegrationModelSelectionIntent::InheritCurrent,
                requirements: Default::default(),
            },
        )
        .unwrap();
        assert!(
            target
                .clone()
                .with_owned_native_model_resolution(&resolution)
                .is_err()
        );
        let owned = target
            .clone()
            .with_owned_native_model_resolution_from(&source, &resolution)
            .unwrap();
        assert!(target_state.matches(&owned.state));
        assert!(!source.state.inspection_identity().matches(&owned.state));
        assert!(Arc::ptr_eq(&target_permissions, &owned.permissions));
        assert_eq!(target_tools.names(), owned.tools.names());
        assert_eq!(owned.settings.read().unwrap().max_tokens, Some(19));
        assert_eq!(target.settings.read().unwrap().max_tokens, Some(128));
        assert!(!Arc::ptr_eq(&source.settings, &owned.settings));
        assert!(Arc::ptr_eq(
            &source.current_raw_provider(),
            &owned.current_raw_provider()
        ));
        source.settings.write().unwrap().max_tokens = Some(20);
        assert!(
            target
                .with_owned_native_model_resolution_from(&source, &resolution)
                .is_err()
        );
    }
}
