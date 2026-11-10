use super::{QueryEngine, recover_read_lock};
use anyhow::{Context, Result};
use kcoder_api::{Provider, ProviderFactory};
use kcoder_config::Settings;
use std::sync::Arc;

pub(super) type SummaryRuntime = (Option<String>, String, u32, Arc<dyn Provider>);

impl QueryEngine {
    pub(super) fn summary_runtime(&self) -> Result<SummaryRuntime> {
        self.summary_runtime_with_identity()
            .map(|(runtime, _)| runtime)
    }

    /// Keep the provider and its cache identity on the same settings snapshot.
    /// This identity binds generated text only, never authorization or revocation.
    pub(super) fn summary_runtime_with_identity(
        &self,
    ) -> Result<(SummaryRuntime, Option<[u8; 32]>)> {
        let settings = recover_read_lock(&self.settings, "settings").clone();
        let identity = crate::context::compact::fingerprint_serializable(&settings);
        Ok((self.summary_runtime_from_settings(&settings)?, identity))
    }

    fn summary_runtime_from_settings(&self, settings: &Settings) -> Result<SummaryRuntime> {
        if let Some(profile_name) = settings
            .summary_profile
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let profile_max_tokens = settings
                .providers
                .get(profile_name)
                .map(|profile| profile.max_output_tokens)
                .unwrap_or(settings.summary_max_tokens);
            let (model, provider) = if let Some(source) = &self.client_model_configuration {
                let mut selected = settings.clone();
                selected.apply_provider(Some(profile_name))?;
                let provider = source.provider(&selected)?;
                (selected.model, provider)
            } else {
                ProviderFactory::new(settings)
                    .build_profile(profile_name)
                    .with_context(|| format!("failed to build summary profile '{profile_name}'"))?
            };
            return Ok((
                Some(model.clone()),
                model,
                settings.summary_max_tokens.min(profile_max_tokens).max(1),
                self.observe_model_provider(
                    provider,
                    crate::native_model_requests::NativeModelRequestPurpose::Summary,
                    {
                        if self.model_request_binding.is_some() {
                            let mut selected = settings.clone();
                            selected.apply_provider(Some(profile_name))?;
                            crate::model_configuration_summary(
                                &selected,
                                kcoder_types::ModelConfigurationBoundary::SessionSnapshot,
                            )
                            .ok()
                        } else {
                            None
                        }
                    },
                ),
            ));
        }
        let configured_model = settings
            .summary_model
            .clone()
            .filter(|model| !model.trim().is_empty());
        let effective_model = configured_model
            .clone()
            .unwrap_or_else(|| settings.model.clone());
        let max_tokens = settings
            .summary_max_tokens
            .min(settings.max_tokens.unwrap_or(u32::MAX))
            .max(1);
        let configured_provider = settings
            .summary_provider
            .clone()
            .filter(|provider| !provider.trim().is_empty());
        let provider = if let Some(provider_name) = configured_provider {
            if let Some(source) = &self.client_model_configuration {
                let selected = ProviderFactory::new(settings)
                    .settings_for_named_isolated(&provider_name, &effective_model)?;
                source.provider(&selected)?
            } else {
                ProviderFactory::new(settings)
                    .build_named_isolated(&provider_name, &effective_model)
                    .with_context(|| {
                        format!(
                            "failed to build summary provider '{}' for model '{}'",
                            provider_name, effective_model
                        )
                    })?
            }
        } else {
            self.current_provider()
        };

        if self.model_request_binding.is_none() {
            return Ok((configured_model, effective_model, max_tokens, provider));
        }
        let configuration = if let Some(provider_name) = settings
            .summary_provider
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            ProviderFactory::new(settings)
                .settings_for_named_isolated(provider_name, &effective_model)
                .ok()
        } else {
            let mut selected = settings.clone();
            selected.model = effective_model.clone();
            Some(selected)
        }
        .and_then(|selected| {
            crate::model_configuration_summary(
                &selected,
                kcoder_types::ModelConfigurationBoundary::SessionSnapshot,
            )
            .ok()
        });
        let provider = self.observe_model_provider(
            provider,
            crate::native_model_requests::NativeModelRequestPurpose::Summary,
            configuration,
        );
        Ok((configured_model, effective_model, max_tokens, provider))
    }
}

#[cfg(test)]
#[path = "summary_runtime/tests.rs"]
mod tests;
