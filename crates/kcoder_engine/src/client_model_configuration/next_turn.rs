//! Read-only model preflight shares the normal next-turn resolution semantics.
use super::*;

impl QueryEngine {
    /// Resolve a next-turn candidate without constructing an Engine or Provider.
    /// Non-model settings remain pinned to the original session composition.
    pub fn resolve_next_turn_model_settings(
        previous: Settings,
        source: &dyn ClientModelConfiguration,
        mode: ModelSelectionMode,
        selected: Option<&str>,
    ) -> Result<Settings> {
        let next = if mode == ModelSelectionMode::FollowTargetDefault {
            source
                .default_settings()?
                .context("Target default model selection is not supported by this host")?
        } else {
            source.settings(&canonical_selection(&previous, selected)?)?
        };
        validate_client_selection(&previous, &next)?;
        Ok(retained_model_fields(previous, &next))
    }
    /// Resolve the persisted selection or current target default without activating
    /// a provider, writing State, or changing the accepted session snapshot.
    pub fn next_turn_model_configuration_summary(
        &self,
    ) -> Result<kcoder_types::ModelConfigurationSummary> {
        let Some(source) = &self.client_model_configuration else {
            return self.active_model_configuration_summary();
        };
        if !self
            .current_provider()
            .supports_client_runtime_reconfiguration()
        {
            return self.active_model_configuration_summary();
        }
        let previous = recover_read_lock(&self.settings, "settings").clone();
        let mode = recover_read_lock(&self.client_model_options, "client model options")
            .model_selection_mode;
        let next = Self::resolve_next_turn_model_settings(
            previous,
            source.as_ref(),
            mode,
            self.state.selected_model().as_deref(),
        )?;
        let (next, _) = self.resolve_client_model_option_overrides(next)?;
        crate::model_configuration_summary(
            &next,
            kcoder_types::ModelConfigurationBoundary::NextTurn,
        )
    }

    pub(super) fn resolve_client_model_option_overrides(
        &self,
        mut next: Settings,
    ) -> Result<(Settings, ClientModelOptions)> {
        let mut options =
            recover_read_lock(&self.client_model_options, "client model options").clone();
        options.bind_model(&next);
        options.default_reasoning = next.model_reasoning_effort.clone();
        if let Some(reasoning) = &options.reasoning {
            next.model_reasoning_effort = Some(reasoning.clone());
        }
        if let Some(proxy) = &options.proxy {
            next.provider_proxy_url = proxy.clone();
        }
        if let Some(tier) = &options.service_tier {
            next.provider_extra_body
                .insert("service_tier".into(), serde_json::json!(tier));
        }
        self.constrain_native_input_model_settings(&mut next)?;
        Ok((next, options))
    }
}

#[cfg(test)]
mod tests;
