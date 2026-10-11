use super::{QueryEngine, recover_read_lock};
use anyhow::{Context, Result};
use kcoder_api::{Provider, ProviderFactory};
use std::sync::Arc;

pub(super) type SummaryRuntime = (Option<String>, String, u32, Arc<dyn Provider>);

impl QueryEngine {
    pub(super) fn summary_runtime(&self) -> Result<SummaryRuntime> {
        let settings = recover_read_lock(&self.settings, "settings");
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
                ProviderFactory::new(&settings)
                    .build_profile(profile_name)
                    .with_context(|| format!("failed to build summary profile '{profile_name}'"))?
            };
            return Ok((
                Some(model.clone()),
                model,
                settings.summary_max_tokens.min(profile_max_tokens).max(1),
                provider,
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
                let selected = ProviderFactory::new(&settings)
                    .settings_for_named_isolated(&provider_name, &effective_model)?;
                source.provider(&selected)?
            } else {
                ProviderFactory::new(&settings)
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

        Ok((configured_model, effective_model, max_tokens, provider))
    }
}

#[cfg(test)]
#[path = "summary_runtime/tests.rs"]
mod tests;
